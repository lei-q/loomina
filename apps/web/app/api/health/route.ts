import { NextResponse } from "next/server";
import { buildHealthReport } from "@/lib/health";

/**
 * 健康检查（H11）。
 *
 * `GET /api/health` 用 5 分钟内的探测缓存；`?probe=1` 强制重新探测。
 * 返回里没有 Base URL、密钥或提示词；失败率只到「哪个模型几次」。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("probe") === "1";
  try {
    return NextResponse.json(await buildHealthReport(force), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "健康检查失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
