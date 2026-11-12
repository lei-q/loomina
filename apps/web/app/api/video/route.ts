import { NextResponse } from "next/server";
import { ConfigError } from "@loomina/gateway";
import { VideoGenerationError, generateShotVideo } from "@/lib/generate-video";
import { recordHealthEvent } from "@/lib/health-events";
import { PromptBlockedError } from "@/lib/moderation";
import { withLongJobSlot } from "@/lib/long-job";
import { readPromptOverride } from "@/lib/prompt-override";
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
  modelId?: unknown;
  /** 作者手改过的提示词（ADR-0148） */
  prompt?: unknown;
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

  const modelId = typeof body.modelId === "string" ? body.modelId : undefined;
  const override = readPromptOverride(body.prompt);
  if (override.error) return bad(override.error);
  try {
    // 出视频排进同一条长任务队列（H2 / ADR-0135）：渲染或出图正在跑时等一等。
    // 供应商那边的任务本来就要轮询几十秒，排队不会额外增加多少总时长。
    const result = await withLongJobSlot(
      "video",
      shot.description.slice(0, 20) || "一镜",
      () =>
        generateShotVideo(
          { shot, firstFrame, durationMs, ...(override.prompt ? { prompt: override.prompt } : {}) },
          modelId,
        ),
    );
    // 健康检查（H11）：只记成没成，不记提示词
    void recordHealthEvent({
      at: new Date().toISOString(),
      modality: "video",
      ...(modelId ? { modelId } : {}),
      ok: true,
    });
    return NextResponse.json(result);
  } catch (error) {
    // 适配器已经做过 <redacted>；这里只补一句人话 + 原始原因
    const message =
      error instanceof Error ? error.message.slice(0, 300) : "生成失败";
    const status =
      error instanceof PromptBlockedError
        ? 400
        : error instanceof ConfigError
          ? 500
          : 502;
    const code =
      error instanceof PromptBlockedError
        ? "prompt_blocked"
        : error instanceof VideoGenerationError
          ? error.code
          : error instanceof ConfigError
            ? "config"
            : "unknown";
    // 400 是这次请求本身的参数（比如提示词被审核拦下），不算供应商的账
    if (status !== 400) {
      void recordHealthEvent({
        at: new Date().toISOString(),
        modality: "video",
        ...(modelId ? { modelId } : {}),
        ok: false,
        code,
      });
    }
    return NextResponse.json(
      {
        error: message,
        code,
        moderation:
          error instanceof PromptBlockedError ? error.moderation : undefined,
        // 只有「确定没在跑」的失败才让客户端自动重交（B6）
        retryable: error instanceof VideoGenerationError ? error.retryable : false,
      },
      { status },
    );
  }
}
