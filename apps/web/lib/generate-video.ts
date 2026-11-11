import {
  TreecloudClient,
  TreecloudError,
  TreecloudVideoAdapter,
  videoCostCny,
  videoPrice,
} from "@loomina/gateway";
import { buildVideoPrompt, type ShotPromptMaterial } from "@loomina/pipeline";
import type { Id } from "@loomina/ir";
import { gatewayConfigOf, resolveModel } from "@/lib/app-config";

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
    ...(quote ? { cnyPerSecond: quote.cnyPerSecond } : {}),
  };
}

export type GeneratedVideo = {
  uri: string;
  model: string;
  prompt: string;
  durationMs: number;
  /** 真实花费（元）；供应商没报、价目表又查不到时就缺省，不编造 */
  cny?: number;
};

export type ShotVideoRequest = {
  shot: ShotPromptMaterial;
  /** 首帧的地址（data URI 或 http(s)） */
  firstFrame: string;
  durationMs: number;
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

export async function generateShotVideo(
  request: ShotVideoRequest,
  modelId?: string,
): Promise<GeneratedVideo> {
  const config = gatewayConfigOf(await resolveModel("video", modelId));
  // 单次 HTTP 超时收到 60 秒：轮询本身是短请求，卡住的往往是连接
  const client = new TreecloudClient({
    ...config,
    timeoutMs: 60_000,
    pollIntervalMs: POLL_INTERVAL_MS,
    pollTimeoutMs: POLL_TIMEOUT_MS,
  });
  const adapter = new TreecloudVideoAdapter(client);
  const prompt = buildVideoPrompt(request.shot);

  const { jobId } = await adapter
    .submit({
      // 这一镜在服务端已经是"某一镜的 take"，用语义 id 占位只为溯源
      shotId: "video" as Id,
      prompt,
      durationMs: request.durationMs,
      imageUri: request.firstFrame,
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
      (config.videoResolution
        ? videoCostCny(output.provenance.modelId, config.videoResolution, request.durationMs)
        : undefined),
  };
}
