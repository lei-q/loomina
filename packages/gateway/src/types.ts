import type { Id, Provenance } from "@loomina/ir";

export interface ImageInput {
  shotId: Id;
  prompt: string;
  referenceAssetIds?: Id[];
  /** 例如 "1024x1536"（竖屏 2:3）。不给就用适配器默认值。 */
  size?: string;
}

export interface ImageOutput {
  assetId: Id;
  uri: string;
  provenance: Provenance;
  /** 本次调用真实花费（若供应商返回了 usage）。缺失表示未知。 */
  costCny?: number;
}

export interface VideoInput {
  shotId: Id;
  /** 首帧图资产；纯文生视频时为空。 */
  imageAssetId?: Id;
  durationMs: number;
  prompt?: string;
  /** 首帧图的可访问地址。真实适配器需要它才能做图生视频。 */
  imageUri?: string;
  /** 例如 "480p" / "720p" / "768p" / "2k"。不给就用适配器默认值。 */
  resolution?: string;
}

export interface VideoOutput {
  assetId: Id;
  uri: string;
  durationMs: number;
  provenance: Provenance;
  /** 本次调用真实花费（若供应商返回了 usage）。缺失表示未知。 */
  costCny?: number;
}

export type VideoJobStatus = "queued" | "running" | "succeeded" | "failed";

/** 视频接口路由家族。不同中转站路由不同，见 docs/MODEL-GATEWAY.md。 */
export type VideoApiName = "treecloud" | "litellm";

export interface VideoJob {
  jobId: string;
  status: VideoJobStatus;
  output?: VideoOutput;
  error?: string;
  /** 供应商建议的重试间隔（429 时有用）。 */
  retryAfterMs?: number;
}

/**
 * 模型网关接口（准则 P8）。
 * 业务代码只依赖这些接口；换供应商只换实现。
 */
export interface ImageAdapter {
  generate(input: ImageInput): Promise<ImageOutput>;
}

export interface VideoAdapter {
  submit(input: VideoInput): Promise<{ jobId: string }>;
  poll(jobId: string): Promise<VideoJob>;
  fetch(jobId: string): Promise<VideoOutput>;
}
