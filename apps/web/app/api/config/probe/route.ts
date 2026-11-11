import { NextResponse } from "next/server";
import { probeProvider } from "@/lib/app-config";

/**
 * 供应商连通性探测（H22）。
 *
 * 只读 `GET /v1/models`，不触发生成、不花钱；返回里不含密钥，
 * 供应商回显的文本会先替换掉密钥再截断。
 */
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { providerId?: unknown } | null;
  const providerId = typeof body?.providerId === "string" ? body.providerId.trim() : "";
  if (!providerId) return NextResponse.json({ error: "缺少 providerId" }, { status: 400 });
  try {
    return NextResponse.json(await probeProvider(providerId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "探测失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
