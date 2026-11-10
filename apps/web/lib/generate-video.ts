import {
  TreecloudClient,
  TreecloudVideoAdapter,
  loadEnvFile,
  treecloudEnvFrom,
  videoCostCny,
  videoPrice,
} from "@loomina/gateway";
import { buildVideoPrompt, type ShotPromptMaterial } from "@loomina/pipeline";
import type { Id } from "@loomina/ir";
import { envPath } from "@/lib/server-env";

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
};

export function videoPriceInfo(): VideoPriceInfo {
  const config = treecloudEnvFrom(loadEnvFile(envPath()));
  const quote = config.videoResolution
    ? videoPrice(config.videoModel, config.videoResolution)
    : undefined;
  return {
    model: config.videoModel,
    ...(config.videoResolution ? { resolution: config.videoResolution } : {}),
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

export async function generateShotVideo(
  request: ShotVideoRequest,
): Promise<GeneratedVideo> {
  const config = treecloudEnvFrom(loadEnvFile(envPath()));
  // 单次 HTTP 超时收到 60 秒：轮询本身是短请求，卡住的往往是连接
  const client = new TreecloudClient({
    ...config,
    timeoutMs: 60_000,
    pollIntervalMs: POLL_INTERVAL_MS,
    pollTimeoutMs: POLL_TIMEOUT_MS,
  });
  const adapter = new TreecloudVideoAdapter(client);
  const prompt = buildVideoPrompt(request.shot);

  const { jobId } = await adapter.submit({
    // 这一镜在服务端已经是"某一镜的 take"，用语义 id 占位只为溯源
    shotId: "video" as Id,
    prompt,
    durationMs: request.durationMs,
    imageUri: request.firstFrame,
    ...(config.videoResolution ? { resolution: config.videoResolution } : {}),
  });

  const job = await adapter.wait(jobId);
  if (job.status !== "succeeded") {
    throw new Error(
      job.status === "failed"
        ? `供应商生成失败：${job.error ?? "未说明原因"}`
        : `等了 ${Math.round(POLL_TIMEOUT_MS / 1000)} 秒还没出片（${job.status}），稍后重试`,
    );
  }
  const output = job.output ?? (await adapter.fetch(jobId));

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
