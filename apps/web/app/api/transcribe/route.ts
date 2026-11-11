import { NextResponse } from "next/server";
import { ConfigError, TreecloudError } from "@loomina/gateway";
import { transcribeInfo, transcribeLine } from "@/lib/transcribe-line";

/**
 * 识别（ADR-0087）。
 *
 * GET  看看有没有配识别模型——不触发识别、不花钱
 * POST 把一句台词的内嵌音轨送去识别，回文字与分段时间
 *
 * 结果只是建议：写回台词由用户在声音页点「用这句替换」，
 * 这一层不替用户改 IR，也不动时长（音轨才是时长的准）。
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  try {
    return NextResponse.json(transcribeInfo());
  } catch (error) {
    const message =
      error instanceof ConfigError ? error.message : "读不到识别配置";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    uri?: unknown;
  } | null;
  if (!body) {
    return NextResponse.json({ error: "请求体不是 JSON" }, { status: 400 });
  }

  const uri = typeof body.uri === "string" ? body.uri : "";
  if (!uri.trim()) {
    return NextResponse.json({ error: "这一句还没有音轨" }, { status: 400 });
  }

  try {
    return NextResponse.json(await transcribeLine({ uri }));
  } catch (error) {
    const message =
      error instanceof TreecloudError || error instanceof ConfigError
        ? error.message
        : error instanceof Error
          ? error.message.slice(0, 300)
          : "识别失败";
    // 没配模型是配置问题，不是供应商挂了：回 500，界面才能分开说；
    // 空音轨这类参数问题回 400，其余上游失败统一 502。
    const status =
      error instanceof ConfigError ||
      (error instanceof TreecloudError && error.code === "asr_not_configured")
        ? 500
        : error instanceof TreecloudError
          ? error.status === 400
            ? 400
            : 502
          : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
