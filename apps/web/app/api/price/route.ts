import { NextResponse } from "next/server";
import { ConfigError } from "@loomina/gateway";
import { imagePrice } from "@/lib/generate-image";

/**
 * 出图价目（ADR-0035）。
 *
 * 只回模型名与单价：客户端要拿它显示"这一格多少钱"并在提交前拦住超预算，
 * 但单价不该编进 bundle，所以每次开机问一次服务端就好。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(imagePrice());
  } catch (error) {
    const message =
      error instanceof ConfigError ? error.message : "取不到价目";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
