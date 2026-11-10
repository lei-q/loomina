import { NextResponse } from "next/server";
import { ConfigError, TreecloudError } from "@loomina/gateway";
import { generateShotVideo } from "@/lib/generate-video";
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
};

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body) return bad("请求体不是 JSON");

  const shot = parseShotMaterial(body.shot);
  if (typeof shot === "string") return bad(shot);

  const firstFrame = typeof body.firstFrame === "string" ? body.firstFrame.trim() : "";
  if (!firstFrame) return bad("先有首帧，才能让它动起来");
  if (!/^(https?:\/\/|data:(image|video)\/)/i.test(firstFrame)) {
    return bad("首帧要先有地址：http(s):// 或 data:image/ 开头");
  }
  if (firstFrame.length > FIRST_FRAME_MAX) return bad("首帧太大了：12 MB 以内");

  const rawDuration = typeof body.durationMs === "number" ? body.durationMs : 3000;
  const durationMs = Math.min(8000, Math.max(1000, Math.round(rawDuration)));

  try {
    return NextResponse.json(
      await generateShotVideo({ shot, firstFrame, durationMs }),
    );
  } catch (error) {
    // 适配器已经做过 <redacted>；这里只补一句人话 + 原始原因
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
