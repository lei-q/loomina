import { NextResponse } from "next/server";
import { ConfigError } from "@loomina/gateway";
import { FRAME_ASPECTS, ProjectSkillSchema, type FrameAspect, type ProjectSkill } from "@loomina/ir";
import { z } from "zod";
import { readAssetBytes } from "@/lib/asset-store";
import { VideoGenerationError, generateShotVideo } from "@/lib/generate-video";
import { recordHealthEvent } from "@/lib/health-events";
import { PromptBlockedError } from "@/lib/moderation";
import { withLongJobSlot } from "@/lib/long-job";
import { readPromptOverride } from "@/lib/prompt-override";
import { parseShotMaterial } from "@/lib/request-shape";

/**
 * 出视频（ADR-0083）。
 *
 * 关键帧先行：客户端把首帧与镜头原料发上来，路由提交任务并轮询到出片。
 * 供应商配额不通时界面还有「贴视频地址导入」兜底，所以这里的失败
 * 只要如实说话，不必兜住什么。
 */
export const runtime = "nodejs";
export const maxDuration = 300;

/** 首帧可以是 data URI，也可以是一个能公网访问的地址。 */
const FIRST_FRAME_MAX = 12_000_000;

type Body = {
  shot?: unknown;
  firstFrame?: unknown;
  durationMs?: unknown;
  modelId?: unknown;
  /** 作者手改过的提示词（ADR-0148） */
  prompt?: unknown;
  /** 成片画幅（E5 / ADR-0251）：9:16 / 16:9 / 1:1，缺省按 9:16 */
  aspect?: unknown;
  /** 作者技能（C18）：按「视频」阶段拼进提示词 */
  skills?: unknown;
};

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function skillsOf(value: unknown): ProjectSkill[] | string {
  if (value === undefined) return [];
  const parsed = z.array(ProjectSkillSchema).max(20).safeParse(value);
  if (!parsed.success) return "技能的格式不对";
  return parsed.data;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body) return bad("请求体不是 JSON");

  const shot = parseShotMaterial(body.shot);
  if (typeof shot === "string") return bad(shot);

  const firstFrame = typeof body.firstFrame === "string" ? body.firstFrame.trim() : "";
  if (!firstFrame) return bad("先有首帧，才能让它动起来");
  if (!/^(https?:\/\/|data:(image|video)\/|loomina:\/\/|s3:\/\/)/i.test(firstFrame)) {
    return bad("首帧要先有地址：http(s)://、data:image/ 或资产库地址");
  }
  // 资产库里的首帧不能原样发给供应商：它只是本机的一个地址。
  // 读回字节换成 data URI；读不到就如实说，不发一个空地址出去（H3 / ADR-0128）。
  let firstFrameUri = firstFrame;
  if (!/^(https?:\/\/|data:)/i.test(firstFrame)) {
    const file = await readAssetBytes(firstFrame);
    if (!file) return bad("首帧读不到字节：资产库里这个地址不存在或已损坏");
    if (file.bytes.byteLength > FIRST_FRAME_MAX) return bad("首帧太大了：12 MB 以内");
    firstFrameUri = `data:${file.mime};base64,${Buffer.from(file.bytes).toString("base64")}`;
  }
  if (firstFrameUri.length > FIRST_FRAME_MAX) return bad("首帧太大了：12 MB 以内");

  const rawDuration = typeof body.durationMs === "number" ? body.durationMs : 3000;
  const durationMs = Math.min(8000, Math.max(1000, Math.round(rawDuration)));

  const aspect =
    typeof body.aspect === "string" && (FRAME_ASPECTS as readonly string[]).includes(body.aspect)
      ? (body.aspect as FrameAspect)
      : undefined;
  if (body.aspect !== undefined && aspect === undefined) {
    return bad(`画幅只能是 ${FRAME_ASPECTS.join(" / ")}`);
  }

  const skills = skillsOf(body.skills);
  if (typeof skills === "string") return bad(skills);

  const modelId = typeof body.modelId === "string" ? body.modelId : undefined;
  const override = readPromptOverride(body.prompt);
  if (override.error) return bad(override.error);
  try {
    // 出视频排进同一条长任务队列（H2 / ADR-0135）：渲染或出图正在跑时等一等。
    // 供应商那边的任务本来就要轮询几十秒，排队不会额外增加多少总时长。
    const result = await withLongJobSlot(
      "video",
      shot.description.slice(0, 20) || "一镜",
      () =>
        generateShotVideo(
          {
            shot,
            firstFrame: firstFrameUri,
            durationMs,
            ...(aspect ? { aspect } : {}),
            ...(skills.length ? { skills } : {}),
            ...(override.prompt ? { prompt: override.prompt } : {}),
          },
          modelId,
        ),
    );
    // 健康检查（H11）：只记成没成，不记提示词
    void recordHealthEvent({
      at: new Date().toISOString(),
      modality: "video",
      ...(modelId ? { modelId } : {}),
      ok: true,
    });
    return NextResponse.json(result);
  } catch (error) {
    // 适配器已经做过 <redacted>；这里只补一句人话 + 原始原因
    const message =
      error instanceof Error ? error.message.slice(0, 300) : "生成失败";
    const status =
      error instanceof PromptBlockedError
        ? 400
        : error instanceof ConfigError
          ? 500
          : 502;
    const code =
      error instanceof PromptBlockedError
        ? "prompt_blocked"
        : error instanceof VideoGenerationError
          ? error.code
          : error instanceof ConfigError
            ? "config"
            : "unknown";
    // 400 是这次请求本身的参数（比如提示词被审核拦下），不算供应商的账
    if (status !== 400) {
      void recordHealthEvent({
        at: new Date().toISOString(),
        modality: "video",
        ...(modelId ? { modelId } : {}),
        ok: false,
        code,
      });
    }
    return NextResponse.json(
      {
        error: message,
        code,
        moderation:
          error instanceof PromptBlockedError ? error.moderation : undefined,
        // 只有「确定没在跑」的失败才让客户端自动重交（B6）
        retryable: error instanceof VideoGenerationError ? error.retryable : false,
      },
      { status },
    );
  }
}
