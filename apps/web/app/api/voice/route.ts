import { NextResponse } from "next/server";
import { ConfigError, TreecloudError } from "@loomina/gateway";
import { speakLine, voiceInfo } from "@/lib/generate-voice";

/**
 * 出声（ADR-0085）。
 *
 * GET  看看有没有配配音模型——不触发生成、不花钱
 * POST 把一句台词念成一条音轨，回 data URI
 *
 * 供应商配额不通时界面还有「贴一条音轨」兜底，所以失败只要如实说话。
 */
export const runtime = "nodejs";
export const maxDuration = 60;

/** 一句台词的文字上限：超过这个数多半是整段稿子贴进来了 */
const TEXT_MAX = 300;

/** 音色标识上限，和 IR 里 `VOICE_PROFILE_MAX` 对齐 */
const VOICE_MAX = 40;

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET() {
  try {
    return NextResponse.json(await voiceInfo());
  } catch (error) {
    const message =
      error instanceof ConfigError ? error.message : "读不到配音配置";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    text?: unknown;
    voice?: unknown;
    modelId?: unknown;
  } | null;
  if (!body) return bad("请求体不是 JSON");

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return bad("这一句是空的，没有可念的内容");
  if (text.length > TEXT_MAX) return bad(`一次只念一句：${TEXT_MAX} 字以内`);

  const voice = typeof body.voice === "string" ? body.voice.trim() : "";
  if (voice.length > VOICE_MAX) return bad(`音色名太长了：${VOICE_MAX} 字以内`);
  const modelId = typeof body.modelId === "string" ? body.modelId : undefined;

  try {
    return NextResponse.json(
      await speakLine({ text, ...(voice ? { voice } : {}), modelId }),
    );
  } catch (error) {
    const message =
      error instanceof TreecloudError || error instanceof ConfigError
        ? error.message
        : error instanceof Error
          ? error.message.slice(0, 300)
          : "出声失败";
    // 没配模型是配置问题，不是供应商挂了：回 500，界面才能分开说
    const status =
      error instanceof ConfigError ||
      (error instanceof TreecloudError && error.code === "tts_not_configured")
        ? 500
        : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
