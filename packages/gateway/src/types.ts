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

export interface SpeechInput {
  /** 要念的这一句（不含角色名与括号说明） */
  text: string;
  /** 音色标识，例如 "Cherry"；不填用适配器默认值 */
  voice?: string;
  /** 覆盖默认 TTS 模型 */
  model?: string;
  /**
   * 语速（C2 / ADR-0124）：映射到请求体的 `speed`。
   * 供应商忽略时行为与不传一致——这里不假设它一定生效。
   */
  speed?: number;
  /**
   * 表演说明（C2 / ADR-0124）：情绪与句尾走向拼成一句中文，映射到 `instructions`。
   * 与 `speed` 同一口径：传了不一定生效，但不会改变念出来的字。
   */
  instructions?: string;
}

export interface SpeechOutput {
  assetId: Id;
  /** 音频字节。时长不由网关猜：交给浏览器读完再写回（ADR-0085） */
  bytes: Uint8Array;
  mime: string;
  provenance: Provenance;
  costCny?: number;
}

export interface TranscriptionInput {
  bytes: Uint8Array;
  mime: string;
  filename?: string;
  /** 默认 zh */
  language?: string;
  /** 覆盖默认 ASR 模型 */
  model?: string;
}

export interface TranscriptionSegment {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptionOutput {
  text: string;
  /** 供应商给的分段时间轴；没给就是空数组，不猜（ADR-0087） */
  segments: TranscriptionSegment[];
  provenance: Provenance;
  costCny?: number;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatInput {
  messages: ChatMessage[];
  /** 输出上限；不填用供应商默认值 */
  maxTokens?: number;
}

export interface ChatOutput {
  text: string;
  provenance: Provenance;
  /** 供应商给了 usage 才带；没有就不猜 */
  usage?: { promptTokens?: number; completionTokens?: number };
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

export interface SpeechAdapter {
  speak(input: SpeechInput): Promise<SpeechOutput>;
}

export interface TranscriptionAdapter {
  transcribe(input: TranscriptionInput): Promise<TranscriptionOutput>;
}

/** 文本模型（ADR-0088）：故事入口只依赖这一条可替换的接口。 */
export interface ChatAdapter {
  complete(input: ChatInput): Promise<ChatOutput>;
}
