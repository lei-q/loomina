import { NextResponse } from "next/server";
import { ConfigError } from "@loomina/gateway";
import { imagePrice } from "@/lib/generate-image";
import { videoPriceInfo } from "@/lib/generate-video";

/**
 * 出图与出视频的价目（ADR-0035 / ADR-0083）。
 *
 * 只回模型名与单价：客户端要拿它显示"这一格多少钱"并在提交前拦住超预算，
 * 但单价不该编进 bundle，所以每次开机问一次服务端就好。
 * `video` 是新增的一层；顶层仍保留出图的字段，旧调用方不必改。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ ...imagePrice(), video: videoPriceInfo() });
  } catch (error) {
    const message =
      error instanceof ConfigError ? error.message : "取不到价目";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
