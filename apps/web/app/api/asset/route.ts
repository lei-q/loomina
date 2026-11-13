import { NextResponse } from "next/server";
import { ConfigError, TreecloudError } from "@loomina/gateway";
import { SHEET_ANGLES, type SheetView } from "@loomina/ir";
import { generateCastImage, type CastImageRequest } from "@/lib/generate-image";
import { recordHealthEvent } from "@/lib/health-events";
import { PromptBlockedError } from "@/lib/moderation";
import { withLongJobSlot } from "@/lib/long-job";
import { readPromptOverride } from "@/lib/prompt-override";
import { name, parseLook, parseShotMaterial, text } from "@/lib/request-shape";

/** 出图是 20–45 秒的事，别让它跑在 edge 的短超时里。 */
export const runtime = "nodejs";
export const maxDuration = 180;

type Body = {
  kind?: unknown;
  character?: { name?: unknown; appearance?: unknown; mustNotChange?: unknown };
  angle?: unknown;
  frame?: unknown;
  /** 作者手改过的提示词（ADR-0148）：给了就用它，不再拼默认那段 */
  prompt?: unknown;
  /** 主镜请求：`description` 是场景描述，会整句进提示词（ADR-0063） */
  location?: { name?: unknown; description?: unknown };
  prop?: { name?: unknown; description?: unknown };
  /** 画面风格参数（B7 / I5，ADR-0165）：定妆 / 主镜 / 道具的提示词最后一句 */
  look?: unknown;
  /**
   * 参考图（B2 / ADR-0162）：调用方点名要随这一张发出去的资产。
   * 只收地址与标签，字节由服务端从资产库读——浏览器不需要把图再传一遍。
   */
  references?: unknown;
  shot?: {
    description?: unknown;
    shotSize?: unknown;
    camera?: { angle?: unknown; movement?: unknown; focalMm?: unknown };
    characters?: unknown;
    location?: { name?: unknown };
    props?: unknown;
  };
};

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * 参考图清单（B2 / ADR-0162）：最多 4 张，只要地址与标签。
 *
 * 地址必须是资产库 / 对象存储 / data URI 之一；别的形态（比如 http 外链）
 * 不读，避免服务端被当成任意 URL 的代理。读不到字节的由下游如实回 missing。
 */
function referencesOf(
  value: unknown,
): { assetId: string; uri: string; label: string }[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "参考图格式不对";
  const refs: { assetId: string; uri: string; label: string }[] = [];
  for (const item of value.slice(0, 4)) {
    if (!item || typeof item !== "object") return "参考图格式不对";
    const record = item as { assetId?: unknown; uri?: unknown; label?: unknown };
    const uri = typeof record.uri === "string" ? record.uri.trim() : "";
    if (!uri) return "参考图缺少地址";
    if (!/^(loomina:\/\/|s3:\/\/|data:image\/)/i.test(uri)) {
      return "参考图只能来自资产库（loomina:// 或 s3://）或 data URI";
    }
    const assetId = typeof record.assetId === "string" ? record.assetId.slice(0, 120) : uri;
    const label = typeof record.label === "string" ? record.label.slice(0, 40) : "参考图";
    refs.push({ assetId, uri, label });
  }
  return refs;
}

/** 队列里显示的人话：出的哪一张（H2 / ADR-0135） */
function labelOf(request: CastImageRequest): string {
  if (request.kind === "sheet") return `${request.character.name} 的三视图（${request.angle}）`;
  if (request.kind === "master") return `「${request.location.name}」主镜`;
  if (request.kind === "prop") return `「${request.prop.name}」参考图`;
  return `${request.frame === "last" ? "尾帧" : "首帧"}：${request.shot.description.slice(0, 20) || "一镜"}`;
}

function parse(body: Body | null): CastImageRequest | string {
  if (!body) return "请求体不是 JSON";

  if (body.kind === "sheet") {
    const who = name(body.character?.name);
    if (!who) return "缺少角色名";
    if (!SHEET_ANGLES.includes(body.angle as SheetView)) return "角度不认识";
    const mustNotChange = Array.isArray(body.character?.mustNotChange)
      ? body.character.mustNotChange
          .filter((item): item is string => typeof item === "string")
          .slice(0, 12)
          .map((item) => item.slice(0, 40))
      : [];
    return {
      kind: "sheet",
      character: {
        name: who,
        appearance: text(body.character?.appearance, 300),
        mustNotChange,
      },
      angle: body.angle as SheetView,
      ...(parseLook(body.look) ? { look: parseLook(body.look)! } : {}),
    };
  }

  if (body.kind === "master") {
    const where = name(body.location?.name);
    if (!where) return "缺少场景名";
    return {
      kind: "master",
      location: { name: where, description: text(body.location?.description, 200) },
      ...(parseLook(body.look) ? { look: parseLook(body.look)! } : {}),
    };
  }

  if (body.kind === "prop") {
    const what = name(body.prop?.name);
    if (!what) return "缺少道具名";
    return {
      kind: "prop",
      prop: { name: what, description: text(body.prop?.description, 300) },
      ...(parseLook(body.look) ? { look: parseLook(body.look)! } : {}),
    };
  }

  if (body.kind === "keyframe") {
    const frame = body.frame ?? "first";
    if (frame !== "first" && frame !== "last") return "关键帧不认识";
    const shot = parseShotMaterial(body.shot);
    if (typeof shot === "string") return shot;
    return { kind: "keyframe", frame, shot };
  }

  return "不认识的资产类型";
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as (Body & { modelId?: unknown }) | null;
  const parsed = parse(body);
  if (typeof parsed === "string") return bad(parsed);

  const modelId = typeof body?.modelId === "string" ? body.modelId : undefined;
  const override = readPromptOverride(body?.prompt);
  if (override.error) return bad(override.error);
  const refs = referencesOf(body?.references);
  if (typeof refs === "string") return bad(refs);
  try {
    // 出图也排进同一条长任务队列（H2 / ADR-0135）：渲染正在跑时等它跑完，
    // 别让 ffmpeg 与出图同时抢 CPU。队列只影响排队，失败语义不变。
    const result = await withLongJobSlot("image", labelOf(parsed), () =>
      generateCastImage(parsed, modelId, override.prompt, refs),
    );
    void recordHealthEvent({
      at: new Date().toISOString(),
      modality: "image",
      ...(modelId ? { modelId } : {}),
      ok: true,
    });
    return NextResponse.json(result);
  } catch (error) {
    // 错误信息里不含密钥（适配器已做 <redacted>）；只回一句人话 + 原始原因
    const message =
      error instanceof TreecloudError || error instanceof ConfigError
        ? error.message
        : error instanceof Error
          ? error.message.slice(0, 300)
          : "生成失败";
    // 提示词审核拦下的是一次参数问题：回 400，界面按「先改描述」处理
    const status =
      error instanceof PromptBlockedError
        ? 400
        : error instanceof ConfigError
          ? 500
          : 502;
    // 400 是这次请求本身的参数问题，不算供应商的账
    if (status !== 400) {
      void recordHealthEvent({
        at: new Date().toISOString(),
        modality: "image",
        ...(modelId ? { modelId } : {}),
        ok: false,
        code:
          error instanceof TreecloudError
            ? error.code
            : error instanceof ConfigError
              ? "config"
              : "unknown",
      });
    }
    return NextResponse.json(
      {
        error: message,
        ...(error instanceof PromptBlockedError
          ? { code: "prompt_blocked", moderation: error.moderation }
          : {}),
      },
      { status },
    );
  }
}
