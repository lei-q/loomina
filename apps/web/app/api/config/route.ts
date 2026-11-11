import { NextResponse } from "next/server";
import { ConfigError } from "@loomina/gateway";
import { loadConfig, saveConfig, toPublicConfig } from "@/lib/app-config";

/**
 * 供应商与模型配置（H22 / ADR-0094）。
 *
 * GET  返回脱敏配置：有密钥标记，没有密钥内容
 * PUT  保存整份配置；`apiKey` 缺省表示沿用已保存的密钥
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(toPublicConfig(await loadConfig()), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "读不到配置";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "请求体不是 JSON" }, { status: 400 });
  try {
    const saved = await saveConfig(body);
    return NextResponse.json(
      toPublicConfig({ ...saved, saved: true }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存失败";
    return NextResponse.json({ error: message }, { status: error instanceof ConfigError ? 400 : 500 });
  }
}
