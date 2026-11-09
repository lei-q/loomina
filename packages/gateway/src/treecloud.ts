import type { Id } from "@loomina/ir";
import type {
  ImageAdapter,
  ImageInput,
  ImageOutput,
  VideoAdapter,
  VideoApiName,
  VideoInput,
  VideoJob,
  VideoJobStatus,
  VideoOutput,
} from "./types";

type Json = Record<string, unknown>;

export interface TreecloudConfig {
  baseUrl: string;
  apiKey: string;
  videoModel: string;
  imageModel: string;
  videoResolution?: string;
  imageSize?: string;
  /** 视频接口路由；不填按 treecloud，遇到 404/405 自动换另一条。 */
  videoApi?: VideoApiName;
  fetcher?: typeof fetch;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  maxRetriesOn429?: number;
  /** 单次 HTTP 请求超时。实测图片接口会挂到 300s，必须自己收口。 */
  timeoutMs?: number;
  /** 每次请求后的回调，用来打进度。只传方法与路径，不传请求体与密钥。 */
  onAttempt?: (info: string) => void;
}

export class TreecloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "TreecloudError";
  }
}

/**
 * 视频接口没有统一标准，两家中转站的路由就不一样：
 *   treecloud（自研）  POST /v1/videos/generations      GET /v1/videos/generations/{id}
 *   litellm（代理）    POST /v1/videos                  GET /v1/videos/{id}
 *
 * 换路由不能靠猜。先按配置的走；拿到 404/405（明确表示这条路由不存在，
 * 且没有副作用）再换另一条，并记住结果。
 */
export interface VideoEndpoints {
  create: string;
  status: (jobId: string) => string;
}

const enc = (id: string) => encodeURIComponent(id);

export const VIDEO_ENDPOINTS: Record<VideoApiName, VideoEndpoints> = {
  treecloud: {
    create: "/v1/videos/generations",
    status: (jobId) => `/v1/videos/generations/${enc(jobId)}`,
  },
  litellm: {
    create: "/v1/videos",
    status: (jobId) => `/v1/videos/${enc(jobId)}`,
  },
};

function isRouteMismatch(error: unknown): boolean {
  return error instanceof TreecloudError && (error.status === 404 || error.status === 405);
}

/**
 * 中转站客户端。
 *
 * 已知契约（2026-11-09 实测，见 docs/MODEL-GATEWAY.md）：
 *   POST /v1/images/generations            OpenAI 兼容 {model, prompt, size, n}
 *   POST /v1/videos/generations            {model, prompt, resolution, seconds, content[]}
 *   GET  /v1/videos/generations/{id}       返回 {id, status, ...}
 */
export class TreecloudClient {
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(readonly config: TreecloudConfig) {
    this.fetcher = config.fetcher ?? fetch;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  async request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Json> {
    const url = this.config.baseUrl + path;
    const maxRetries = this.config.maxRetriesOn429 ?? 2;
    const timeoutMs = this.config.timeoutMs ?? 120_000;

    for (let attempt = 0; ; attempt += 1) {
      const method = init.method ?? "GET";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await this.fetcher(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new TreecloudError(
            408,
            "client_timeout",
            `${method} ${path} 超过 ${timeoutMs}ms 未返回，已中止`,
          );
        }
        throw new TreecloudError(
          0,
          "network_error",
          error instanceof Error ? error.message.slice(0, 300) : String(error),
        );
      } finally {
        clearTimeout(timer);
      }
      this.config.onAttempt?.(`${method} ${path} -> ${response.status}`);

      const text = await response.text();
      if (response.ok) {
        if (!text.trim()) return {};
        try {
          return JSON.parse(text) as Json;
        } catch {
          throw new TreecloudError(
            response.status,
            "invalid_json",
            "网关返回了非 JSON 响应",
            requestIdOf(response),
          );
        }
      }

      if (response.status === 429 && attempt < maxRetries && !isQuotaExceeded(text)) {
        await this.sleep(retryAfterMs(response) ?? 1000 * (attempt + 1));
        continue;
      }

      throw parseError(response.status, text, requestIdOf(response), this.config.apiKey);
    }
  }
}

export interface TreecloudImageOptions {
  model?: string;
  size?: string;
}

export class TreecloudImageAdapter implements ImageAdapter {
  private readonly now: () => string;
  private counter = 0;

  constructor(
    private readonly client: TreecloudClient,
    private readonly options: TreecloudImageOptions = {},
  ) {
    this.now = client.config.now ?? (() => new Date().toISOString());
  }

  async generate(input: ImageInput): Promise<ImageOutput> {
    const model = this.options.model ?? this.client.config.imageModel;
    const size = input.size ?? this.options.size ?? this.client.config.imageSize;

    const payload = await this.client.request("/v1/images/generations", {
      method: "POST",
      body: {
        model,
        prompt: input.prompt,
        n: 1,
        ...(size ? { size } : {}),
      },
    });

    const uri = imageUriOf(payload);
    if (!uri) {
      throw new TreecloudError(
        502,
        "image_response_invalid",
        "图片接口没有返回可用地址（url 或 b64_json）",
      );
    }

    this.counter += 1;
    return {
      assetId: `tc-img-${this.counter}` as Id,
      uri,
      provenance: {
        modelId: model,
        prompt: input.prompt,
        referenceAssetIds: input.referenceAssetIds ?? [],
        createdAt: this.now(),
      },
    };
  }
}

export interface TreecloudVideoOptions {
  model?: string;
  resolution?: string;
}

interface JobState {
  input: VideoInput;
  output?: VideoOutput;
  lastStatus: VideoJobStatus;
  error?: string;
}

export class TreecloudVideoAdapter implements VideoAdapter {
  private readonly now: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jobs = new Map<string, JobState>();
  private apiName: VideoApiName;

  constructor(
    private readonly client: TreecloudClient,
    private readonly options: TreecloudVideoOptions = {},
  ) {
    this.now = client.config.now ?? (() => new Date().toISOString());
    this.sleep =
      client.config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.apiName = client.config.videoApi ?? "treecloud";
  }

  /** 当前实际生效的路由；探针会把这条信息写进报告。 */
  get activeApi(): VideoApiName {
    return this.apiName;
  }

  async submit(input: VideoInput): Promise<{ jobId: string }> {
    const model = this.options.model ?? this.client.config.videoModel;
    const resolution =
      input.resolution ?? this.options.resolution ?? this.client.config.videoResolution;

    const body = {
      model,
      prompt: input.prompt ?? "",
      ...(resolution ? { resolution } : {}),
      seconds: Math.max(1, Math.round(input.durationMs / 1000)),
      ...(input.imageUri
        ? { content: [{ type: "image_url", image_url: { url: input.imageUri } }] }
        : {}),
    };

    let payload: Json;
    try {
      payload = await this.client.request(VIDEO_ENDPOINTS[this.apiName].create, {
        method: "POST",
        body,
      });
    } catch (error) {
      const alternate = this.alternateApi();
      if (!alternate || !isRouteMismatch(error)) throw error;
      payload = await this.client.request(VIDEO_ENDPOINTS[alternate].create, {
        method: "POST",
        body,
      });
      this.apiName = alternate;
      this.client.config.onAttempt?.(`视频接口切换为 ${alternate}`);
    }

    const jobId = String(payload.id ?? "");
    if (!jobId) {
      throw new TreecloudError(502, "video_response_invalid", "视频接口没有返回任务 id");
    }

    const status = mapVideoStatus(payload.status);
    this.jobs.set(jobId, { input, lastStatus: status });

    return { jobId };
  }

  async poll(jobId: string): Promise<VideoJob> {
    const state = this.jobs.get(jobId);
    let payload: Json;
    try {
      payload = await this.client.request(VIDEO_ENDPOINTS[this.apiName].status(jobId));
    } catch (error) {
      const alternate = this.alternateApi();
      if (!alternate || !isRouteMismatch(error)) throw error;
      payload = await this.client.request(VIDEO_ENDPOINTS[alternate].status(jobId));
      this.apiName = alternate;
    }

    const status = mapVideoStatus(payload.status);
    const error = errorMessageOf(payload);

    if (!state) {
      return { jobId, status, ...(error ? { error } : {}) };
    }

    state.lastStatus = status;
    if (status === "failed") state.error = error ?? "供应商未说明失败原因";

    if (status === "succeeded") {
      state.output = outputOf(jobId, payload, state.input, this.now());
      return { jobId, status, output: state.output };
    }

    return { jobId, status, ...(error ? { error } : {}) };
  }

  private alternateApi(): VideoApiName | undefined {
    return this.apiName === "treecloud" ? "litellm" : "treecloud";
  }

  async fetch(jobId: string): Promise<VideoOutput> {
    const state = this.jobs.get(jobId);
    if (state?.output) return state.output;

    const job = await this.poll(jobId);
    if (job.output) return job.output;
    throw new TreecloudError(
      409,
      "video_not_ready",
      `任务 ${jobId} 尚未成功（${job.status}）`,
    );
  }

  /**
   * 等待任务结束：轮询到 succeeded / failed，或超时。
   * 给探针和批量跑用；业务链路应该由队列驱动，不该阻塞等待。
   */
  async wait(jobId: string): Promise<VideoJob> {
    const interval = this.client.config.pollIntervalMs ?? 5000;
    const timeout = this.client.config.pollTimeoutMs ?? 10 * 60 * 1000;
    const deadline = Date.now() + timeout;

    for (;;) {
      const job = await this.poll(jobId);
      if (job.status === "succeeded" || job.status === "failed") return job;
      if (Date.now() >= deadline) {
        return { jobId, status: job.status, error: `轮询超时（${timeout}ms）` };
      }
      await this.sleep(interval);
    }
  }
}

const STATUS_MAP: Record<string, VideoJobStatus> = {
  queued: "queued",
  pending: "queued",
  submitted: "queued",
  created: "queued",
  running: "running",
  processing: "running",
  in_progress: "running",
  inprogress: "running",
  succeeded: "succeeded",
  success: "succeeded",
  completed: "succeeded",
  done: "succeeded",
  failed: "failed",
  failure: "failed",
  error: "failed",
  canceled: "failed",
  cancelled: "failed",
  expired: "failed",
};

export function mapVideoStatus(raw: unknown): VideoJobStatus {
  if (typeof raw !== "string") return "queued";
  return STATUS_MAP[raw.toLowerCase()] ?? "running";
}

export function imageUriOf(payload: Json): string | undefined {
  const data = payload.data;
  const first = Array.isArray(data) ? (data[0] as Json | undefined) : undefined;
  if (first) {
    if (typeof first.url === "string" && first.url) return first.url;
    if (typeof first.b64_json === "string" && first.b64_json) {
      return `data:image/png;base64,${first.b64_json}`;
    }
  }
  return undefined;
}

export function videoUriOf(payload: Json): string | undefined {
  const direct = [payload.url, payload.video_url, payload.output_url];
  for (const value of direct) {
    if (typeof value === "string" && value) return value;
  }

  const output = payload.output;
  if (typeof output === "string" && output) return output;
  if (isJson(output)) {
    if (typeof output.url === "string" && output.url) return output.url;
    if (typeof output.video_url === "string" && output.video_url) return output.video_url;
  }

  const data = payload.data;
  if (Array.isArray(data)) {
    const first = data[0];
    if (typeof first === "string" && first) return first;
    if (isJson(first)) return videoUriOf(first);
  } else if (isJson(data)) {
    return videoUriOf(data);
  }

  const outputs = payload.outputs;
  if (Array.isArray(outputs)) {
    const first = outputs[0];
    if (typeof first === "string" && first) return first;
    if (isJson(first)) return videoUriOf(first);
  }

  return undefined;
}

function outputOf(
  jobId: string,
  payload: Json,
  input: VideoInput,
  createdAt: string,
): VideoOutput {
  const uri = videoUriOf(payload);
  if (!uri) {
    throw new TreecloudError(
      502,
      "video_response_invalid",
      `任务 ${jobId} 已成功但没有返回视频地址`,
    );
  }

  const seconds = typeof payload.seconds === "number" ? payload.seconds : undefined;
  const model = typeof payload.model === "string" ? payload.model : undefined;

  return {
    assetId: `tc-vid-${jobId}` as Id,
    uri,
    durationMs: seconds ? seconds * 1000 : input.durationMs,
    provenance: {
      modelId: model ?? "treecloud-video",
      prompt: input.prompt,
      referenceAssetIds: input.imageAssetId ? [input.imageAssetId] : [],
      createdAt,
    },
    ...costOf(payload),
  };
}

function costOf(payload: Json): { costCny?: number } {
  const usage = payload.usage;
  if (!isJson(usage)) return {};
  for (const key of ["cost_cny", "costCny", "cost", "total_cny"]) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return { costCny: value };
  }
  return {};
}

function errorMessageOf(payload: Json): string | undefined {
  const error = payload.error;
  if (typeof error === "string") return error;
  if (isJson(error) && typeof error.message === "string") return error.message;
  if (typeof payload.message === "string" && payload.message) return payload.message;
  return undefined;
}

function parseError(status: number, text: string, requestId: string | undefined, apiKey: string) {
  let code = `http_${status}`;
  let message = text.slice(0, 500) || `HTTP ${status}`;

  try {
    const parsed = JSON.parse(text) as Json;
    const error = parsed.error;
    if (isJson(error)) {
      if (typeof error.code === "string" || typeof error.code === "number") {
        code = String(error.code);
      } else if (typeof error.type === "string") {
        code = error.type;
      }
      if (typeof error.message === "string") message = error.message;
      const param = error.param;
      if (typeof param === "string" && param) message = `${message} (param=${param})`;
    } else if (typeof parsed.code === "string" || typeof parsed.code === "number") {
      code = String(parsed.code);
      if (typeof parsed.message === "string") message = parsed.message;
    }
  } catch {
    // 非 JSON 错误体，保留原始文本摘要
  }

  // 兜底：错误信息里绝不能带出密钥
  if (apiKey) message = message.split(apiKey).join("<redacted>");

  return new TreecloudError(status, code, message, requestId);
}

function requestIdOf(response: Response): string | undefined {
  return (
    response.headers.get("x-request-id") ??
    response.headers.get("X-Request-ID") ??
    undefined
  ) ?? undefined;
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/**
 * 配额耗尽与限流都返回 429，但语义相反：
 * 限流等一会儿就好，配额耗尽等多久都没用，重试只是浪费时间。
 * 实测代码 17003 = AI token quota exceeded。
 */
export function isQuotaExceeded(text: string): boolean {
  if (!text) return false;
  return /"code"\s*:\s*"?17003"?/.test(text) || /quota exceeded/i.test(text);
}

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
