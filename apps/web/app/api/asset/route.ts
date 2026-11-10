import { NextResponse } from "next/server";
import { ConfigError, TreecloudError } from "@loomina/gateway";
import { SHEET_ANGLES, type SheetView } from "@loomina/ir";
import { generateCastImage, type CastImageRequest } from "@/lib/generate-image";

/** 出图是 20–45 秒的事，别让它跑在 edge 的短超时里。 */
export const runtime = "nodejs";
export const maxDuration = 180;

type Body = {
  kind?: unknown;
  character?: { name?: unknown; appearance?: unknown; mustNotChange?: unknown };
  angle?: unknown;
  location?: { name?: unknown };
  prop?: { name?: unknown; description?: unknown };
};

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** 只切掉两侧空白；名字全空就当作没填。 */
function name(value: unknown): string {
  return text(value, 40).trim();
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
    };
  }

  if (body.kind === "master") {
    const where = name(body.location?.name);
    if (!where) return "缺少场景名";
    return { kind: "master", location: { name: where } };
  }

  if (body.kind === "prop") {
    const what = name(body.prop?.name);
    if (!what) return "缺少道具名";
    return {
      kind: "prop",
      prop: { name: what, description: text(body.prop?.description, 300) },
    };
  }

  return "不认识的资产类型";
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Body | null;
  const parsed = parse(body);
  if (typeof parsed === "string") return bad(parsed);

  try {
    return NextResponse.json(await generateCastImage(parsed));
  } catch (error) {
    // 错误信息里不含密钥（适配器已做 <redacted>）；只回一句人话 + 原始原因
    const message =
      error instanceof TreecloudError || error instanceof ConfigError
        ? error.message
        : error instanceof Error
          ? error.message.slice(0, 300)
          : "生成失败";
    const status = error instanceof ConfigError ? 500 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
