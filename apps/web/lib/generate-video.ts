import {
  TreecloudClient,
  TreecloudError,
  TreecloudVideoAdapter,
  videoCostCny,
  videoPrice,
} from "@loomina/gateway";
import { buildVideoPrompt, type ShotPromptMaterial } from "@loomina/pipeline";
import type { FrameAspect, Id } from "@loomina/ir";
import { gatewayConfigOf, resolveModel } from "@/lib/app-config";
import { assertPromptAllowed, type PromptModeration } from "@/lib/moderation";
import { fitVideoFrame } from "@/lib/reference-compress";
import { VIDEO_FRAME_SOFT_BYTES, frameSizeOf } from "@/lib/reference-fit";

/**
 * 服务端出视频（ADR-0083）。
 *
 * 关键帧先行：首帧已经定住画面，视频只补运动。供应商返回的是任务 id，
 * 这里在一条路由里等到出片——客户端只发一次请求、拿一个地址。
 * 密钥仍然只在服务端：浏览器拿到的是视频地址或 data URI。
 */

export type VideoPriceInfo = {
  model: string;
  resolution?: string;
  /** 价目表里的单价（元 / 秒）；没有这个模型就不给（ADR-0033） */
  cnyPerSecond?: number;
  /** 配置页里的模型 id */
  modelId?: string;
};

export async function videoPriceInfo(modelId?: string): Promise<VideoPriceInfo> {
  const { model } = await resolveModel("video", modelId);
  const resolution = model.resolution;
  const quote = resolution ? videoPrice(model.model, resolution) : undefined;
  return {
    model: model.model,
    modelId: model.id,
    ...(resolution ? { resolution } : {}),
    ...(model.perSecondCny !== undefined
      ? { cnyPerSecond: model.perSecondCny }
      : quote
        ? { cnyPerSecond: quote.cnyPerSecond }
        : {}),
  };
}

export type GeneratedVideo = {
  uri: string;
  model: string;
  prompt: string;
  durationMs: number;
  /** 真实花费（元）；供应商没报、价目表又查不到时就缺省，不编造 */
  cny?: number;
  /** 提交前的提示词审核结果（H6，ADR-0105） */
  moderation: PromptModeration;
};

export type ShotVideoRequest = {
  shot: ShotPromptMaterial;
  /** 首帧的地址（data URI 或 http(s)） */
  firstFrame: string;
  durationMs: number;
  /** 作者手改过的提示词（ADR-0148）：给了就用它，不再拼默认那段 */
  prompt?: string;
  /** 成片画幅（E5 / ADR-0251）：首帧按这一档对齐，视频输出跟着走 */
  aspect?: FrameAspect;
};

/** 轮询节奏与路由的 maxDuration 对齐：240 秒等不到就如实失败。 */
const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 240_000;

export type VideoFailureCode =
  | "submit"
  | "poll"
  | "provider_failed"
  | "timeout";

/**
 * B6：只对「确定没有在跑、重交是安全的」失败标记 retryable。
 *
 * - 提交阶段 429 / 5xx：任务没建立，重交安全；
 * - 供应商明确 failed：这一条已经结束，重交不会覆盖一个还在跑的任务；
 * - 轮询超时：任务可能还在跑，自动重交会多花一笔，所以不重试；
 * - 提交成功后轮询报错：任务已经在了，重交同样会多花一笔。
 */
export class VideoGenerationError extends Error {
  constructor(
    message: string,
    readonly code: VideoFailureCode,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "VideoGenerationError";
  }
}

function submitRetryable(error: unknown): boolean {
  if (!(error instanceof TreecloudError)) return false;
  return error.status === 429 || error.status >= 500;
}

/**
 * 首帧对齐画幅并压到限值内（ADR-0249 / ADR-0250）。
 *
 * 两件事一起做：
 * 1. **对齐 9:16**——供应商的输出比例跟随首帧，2:3 的键帧会出 2:3 的成片；
 * 2. **压体积**——首帧作为 multipart 的单个 part 提交，代理限 1024 KB。
 *
 * 不是 data URI（http(s) 地址）就不动：那种不占 part 体积，也不由我们改。
 */
async function frameForSubmit(
  firstFrame: string | undefined,
  aspect: FrameAspect | undefined,
): Promise<string | undefined> {
  if (!firstFrame || !firstFrame.startsWith("data:")) return firstFrame;
  const parts = /^data:([^;]+);base64,(.*)$/s.exec(firstFrame);
  if (!parts) return firstFrame;
  const bytes = new Uint8Array(Buffer.from(parts[2]!, "base64"));
  const fitted = await fitVideoFrame(
    bytes,
    parts[1]!,
    VIDEO_FRAME_SOFT_BYTES,
    frameSizeOf(aspect),
  );
  if (!fitted.fitted) return firstFrame;
  return `data:${fitted.mime};base64,${Buffer.from(fitted.bytes).toString("base64")}`;
}

export async function generateShotVideo(
  request: ShotVideoRequest,
  modelId?: string,
): Promise<GeneratedVideo> {
  const resolved = await resolveModel("video", modelId);
  const config = gatewayConfigOf(resolved);
  // 单次 HTTP 超时收到 60 秒：轮询本身是短请求，卡住的往往是连接
  const client = new TreecloudClient({
    ...config,
    timeoutMs: 60_000,
    pollIntervalMs: POLL_INTERVAL_MS,
    pollTimeoutMs: POLL_TIMEOUT_MS,
  });
  const adapter = new TreecloudVideoAdapter(client);
  const prompt = request.prompt ?? buildVideoPrompt(request.shot);
  // H6：硬阻断在提交前就停，任务不会建立，也就不会计费
  const moderation = assertPromptAllowed(prompt, "video");

  // 首帧以 data URI 塞进请求的单个 part，代理限 1024 KB（base64 后膨胀 4/3）。
  // 超过就压到 768 KB 以内；压不动仍照发——让供应商如实拒绝，不在这里假装成功。
  const frameSize = frameSizeOf(request.aspect);
  const firstFrame = await frameForSubmit(request.firstFrame, request.aspect);

  const { jobId } = await adapter
    .submit({
      // 这一镜在服务端已经是"某一镜的 take"，用语义 id 占位只为溯源
      shotId: "video" as Id,
      prompt,
      durationMs: request.durationMs,
      imageUri: firstFrame,
      // 供应商按首帧比例出片；size 只是把目标画幅明确写出去（ADR-0251）
      size: frameSize.size,
      ...(config.videoResolution ? { resolution: config.videoResolution } : {}),
    })
    .catch((error: unknown) => {
      throw new VideoGenerationError(
        error instanceof Error ? error.message : "提交任务失败",
        "submit",
        submitRetryable(error),
      );
    });

  const job = await adapter.wait(jobId).catch((error: unknown) => {
    throw new VideoGenerationError(
      error instanceof Error ? error.message : "等片时连接断了",
      "poll",
      false,
    );
  });
  if (job.status !== "succeeded") {
    if (job.status === "failed") {
      throw new VideoGenerationError(
        `供应商生成失败：${job.error ?? "未说明原因"}`,
        "provider_failed",
        true,
      );
    }
    throw new VideoGenerationError(
      `等了 ${Math.round(POLL_TIMEOUT_MS / 1000)} 秒还没出片（${job.status}）。任务可能还在跑，先别急着重交，免得多花一笔。`,
      "timeout",
      false,
    );
  }
  const output =
    job.output ??
    (await adapter.fetch(jobId).catch((error: unknown) => {
      throw new VideoGenerationError(
        error instanceof Error ? error.message : "取片失败",
        "poll",
        false,
      );
    }));

  return {
    uri: output.uri,
    model: output.provenance.modelId,
    prompt,
    durationMs: output.durationMs || request.durationMs,
    cny:
      output.costCny ??
      (resolved.model.perSecondCny !== undefined
        ? Math.round((request.durationMs / 1000) * resolved.model.perSecondCny * 100) / 100
        : config.videoResolution
          ? videoCostCny(output.provenance.modelId, config.videoResolution, request.durationMs)
          : undefined),
    moderation,
  };
}
