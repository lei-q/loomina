import type { Id, Provenance } from "@loomina/ir";

export interface ImageInput {
  shotId: Id;
  prompt: string;
  referenceAssetIds?: Id[];
}

export interface ImageOutput {
  assetId: Id;
  uri: string;
  provenance: Provenance;
}

export interface VideoInput {
  shotId: Id;
  imageAssetId: Id;
  durationMs: number;
  prompt?: string;
}

export interface VideoOutput {
  assetId: Id;
  uri: string;
  durationMs: number;
  provenance: Provenance;
}

export type VideoJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface VideoJob {
  jobId: string;
  status: VideoJobStatus;
  output?: VideoOutput;
  error?: string;
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
