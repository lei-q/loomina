import { NextResponse } from "next/server";
import { ConfigError, TreecloudError } from "@loomina/gateway";
import { SHEET_ANGLES, type SheetView } from "@loomina/ir";
import { generateSheetPanel } from "@/lib/generate-image";

/** 出图是 20–45 秒的事，别让它跑在 edge 的短超时里。 */
export const runtime = "nodejs";
export const maxDuration = 180;

type Body = {
  character?: { name?: unknown; appearance?: unknown; mustNotChange?: unknown };
  angle?: unknown;
};

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Body | null;
  const name = text(body?.character?.name, 40).trim();
  const angle = body?.angle;

  if (!name) {
    return NextResponse.json({ error: "缺少角色名" }, { status: 400 });
  }
  if (!SHEET_ANGLES.includes(angle as SheetView)) {
    return NextResponse.json({ error: "角度不认识" }, { status: 400 });
  }

  const mustNotChange = Array.isArray(body?.character?.mustNotChange)
    ? body.character.mustNotChange
        .filter((item): item is string => typeof item === "string")
        .slice(0, 12)
        .map((item) => item.slice(0, 40))
    : [];

  try {
    const result = await generateSheetPanel({
      character: {
        name,
        appearance: text(body?.character?.appearance, 300),
        mustNotChange,
      },
      angle: angle as SheetView,
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
    const status = error instanceof ConfigError ? 500 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
