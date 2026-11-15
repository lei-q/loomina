import type { Id } from "@loomina/ir";
import type {
  ChatAdapter,
  ChatInput,
  ChatOutput,
  ImageAdapter,
  ImageInput,
  ImageOutput,
  ImageReference,
  SpeechAdapter,
  SpeechInput,
  SpeechOutput,
  TranscriptionAdapter,
  TranscriptionInput,
  TranscriptionOutput,
  TranscriptionSegment,
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
  /** TTS 模型（ADR-0085）；没配就不出声，界面如实说 */
  ttsModel?: string;
  /** 默认音色；角色没单独指定时用它 */
  ttsVoice?: string;
  /** ASR 模型（ADR-0087）；没配就不识别，界面如实说 */
  asrModel?: string;
  /** 文本模型（ADR-0088）；没配就不生成故事，界面如实说 */
  textModel?: string;
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
  /**
   * 取成片字节的端点（可选）。
   *
   * 有的代理（实测 litellm）任务成功时**只回状态、不回地址**，
   * 成片要从 `/{id}/content` 拿。没有这个端点时就沿用旧的「必须有 url」路径。
   */
  content?: (jobId: string) => string;
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
    // 实测（2026-11-15）：completed 的响应体里没有 url，成片在 /content
    content: (jobId) => `/v1/videos/${enc(jobId)}/content`,
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

  /**
   * 取一段二进制（成片字节）。
   *
   * 与 `request` 分开：那个按 JSON 解析，这里要原始字节。非 2xx 返回 undefined，
   * 由调用方决定怎么报——不把「没拿到」包装成成功。
   */
  async binary(path: string): Promise<Uint8Array | undefined> {
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${this.config.apiKey}` },
      });
      this.config.onAttempt?.(`GET ${path} -> ${response.status}`);
      if (!response.ok) return undefined;
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.byteLength > 0 ? bytes : undefined;
    } catch {
      return undefined;
    }
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  async request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Json> {
    const maxRetries = this.config.maxRetriesOn429 ?? 2;

    for (let attempt = 0; ; attempt += 1) {
      const response = await this.send(path, init);
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

  /**
   * 二进制响应（TTS 直接回音频字节，ADR-0085）。
   *
   * 成功时不解析 JSON；失败时把错误体当文本读，错误信息仍然只报状态与原因。
   */
  async requestBytes(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ bytes: Uint8Array; mime: string }> {
    const maxRetries = this.config.maxRetriesOn429 ?? 2;

    for (let attempt = 0; ; attempt += 1) {
      const response = await this.send(path, init);
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { bytes, mime: mimeOf(response) };
      }

      const text = await response.text();
      if (response.status === 429 && attempt < maxRetries && !isQuotaExceeded(text)) {
        await this.sleep(retryAfterMs(response) ?? 1000 * (attempt + 1));
        continue;
      }
      throw parseError(response.status, text, requestIdOf(response), this.config.apiKey);
    }
  }

  /** 一次 HTTP 调用：管超时、网络错误与进度回调，不判状态码。 */
  private async send(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Response> {
    const url = this.config.baseUrl + path;
    const timeoutMs = this.config.timeoutMs ?? 120_000;
    const method = init.method ?? "GET";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 表单上传（ASR）不能自带 Content-Type：boundary 由运行时生成
    const form = init.body instanceof FormData;

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          ...(init.body === undefined || form ? {} : { "Content-Type": "application/json" }),
        },
        body:
          init.body === undefined
            ? undefined
            : form
              ? (init.body as FormData)
              : JSON.stringify(init.body),
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
    return response;
  }
}

export interface TreecloudImageOptions {
  model?: string;
  size?: string;
  /**
   * 参考图走哪条路（B2 / ADR-0162）：
   * - `edits`（默认）：`POST /v1/images/edits`，multipart 带 `image[]`；
   * - `off`：不尝试参考图，直接纯文生图。
   *
   * 实测 2026-11-13 该代理支持单张与多张 `image[]`，并且 `size` 照常生效。
   */
  references?: "edits" | "off";
}

/** 单张参考图的上限：`images/edits` 是 multipart，太大只会拖慢或直接被拒 */
export const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
export const MAX_REFERENCES = 4;

function referenceForm(
  model: string,
  prompt: string,
  size: string | undefined,
  references: ImageReference[],
): FormData {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("n", "1");
  if (size) form.append("size", size);
  references.forEach((reference, index) => {
    const bytes = new Uint8Array(reference.bytes);
    form.append("image[]", new Blob([bytes], { type: reference.mime }), `ref-${index + 1}.png`);
  });
  return form;
}

/**
 * 视频首帧：`POST /v1/videos` 的 multipart 形式（ADR-0249）。
 *
 * 供应商文档（UHub / console.jtreecloud.com）规定：
 * - `input_reference` 可以是 JSON 数组、JSON 对象或 multipart 文件；
 * - **数组 = 参考图，单个文件 / 单个对象 = 首帧**；
 * - data URI 必须带 MIME，不能是裸 base64。
 *
 * 实测：JSON 对象会被 litellm 当文件流读（`'dict' object has no attribute 'read'`），
 * 只有 multipart 文件 part 能真正生效——产物第 0 帧与输入图一致。
 *
 * 返回 null 表示这张图不是 data URI（例如 http / 资产库地址），
 * 调用方退回旧的 `content[].image_url` 形态，不在网关卡里猜怎么读远端字节。
 */
function videoFrameForm(
  model: string,
  prompt: string,
  imageUri: string,
  seconds: number,
  resolution: string | undefined,
  size: string | undefined,
): FormData | null {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(imageUri);
  if (!match) return null;

  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("seconds", String(seconds));
  const explicit = size?.trim();
  const derived = VIDEO_SIZE_OF[normalizeResolution(resolution)];
  if (explicit) form.append("size", explicit);
  else if (derived) form.append("size", derived);
  else if (resolution) form.append("resolution", resolution.toUpperCase());

  const bytes = new Uint8Array(Buffer.from(match[2]!, "base64"));
  form.append(
    "input_reference",
    new Blob([bytes], { type: match[1]! }),
    `first-frame.${match[1]!.includes("jpeg") ? "jpg" : "png"}`,
  );
  return form;
}

/** 竖屏 9:16：文档要求 `size` 用 `宽x高`，否则 480p 会出横屏。 */
const VIDEO_SIZE_OF: Record<string, string> = {
  "480p": "480x854",
  "720p": "720x1280",
  "768p": "768x1366",
  "1080p": "1080x1920",
  "2k": "1440x2560",
};

function normalizeResolution(resolution: string | undefined): string {
  return (resolution ?? "").trim().toLowerCase();
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

    const usable = (input.references ?? []).filter(
      (reference) => reference.bytes.byteLength > 0 && reference.bytes.byteLength <= MAX_REFERENCE_BYTES,
    );
    const references = (this.options.references ?? "edits") === "off"
      ? []
      : usable.slice(0, MAX_REFERENCES);

    // 有参考图就走 edits：真的把字节发给供应商，而不是只记进溯源（ADR-0029 → ADR-0162）。
    // 代理明确说这条端点不支持时退回纯文生图，并把 referenceMode 如实写回——
    // 换了供应商不至于整条出图路径都坏掉，界面也能看出这一张没吃到参考图。
    let usedReferences = references;
    let payload: Json;
    if (references.length > 0) {
      try {
        payload = await this.client.request("/v1/images/edits", {
          method: "POST",
          body: referenceForm(model, input.prompt, size, references),
        });
      } catch (error) {
        if (!isReferenceUnsupported(error)) throw error;
        usedReferences = [];
        payload = await this.client.request("/v1/images/generations", {
          method: "POST",
          body: {
            model,
            prompt: input.prompt,
            n: 1,
            ...(size ? { size } : {}),
          },
        });
      }
    } else {
      payload = await this.client.request("/v1/images/generations", {
        method: "POST",
        body: {
          model,
          prompt: input.prompt,
          n: 1,
          ...(size ? { size } : {}),
        },
      });
    }

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
      referenceMode: usedReferences.length > 0 ? "edits" : "prompt-only",
      referenceCount: usedReferences.length,
    };
  }
}

export interface TreecloudSpeechOptions {
  /** 覆盖 env 里的 TTS_MODEL */
  model?: string;
  /** 默认音色；ENV 的 TTS_VOICE 也走这里 */
  voice?: string;
  /** 请求供应商回什么格式；mp3 最通用 */
  format?: "mp3" | "wav" | "opus" | "aac" | "flac";
}

/**
 * 配音适配器（ADR-0085）。
 *
 * 契约按 OpenAI 兼容写法实测（docs/MODEL-GATEWAY.md）：
 *   POST /v1/audio/speech  {model, input, voice, response_format} → 二进制音频
 *
 * 没有配 TTS_MODEL 时直接报 tts_not_configured：这不是网络错误，
 * 重试几次也不会好，界面应该据此说「还没配配音模型」而不是「生成失败」。
 */
export class TreecloudSpeechAdapter implements SpeechAdapter {
  private readonly now: () => string;
  private counter = 0;

  constructor(
    private readonly client: TreecloudClient,
    private readonly options: TreecloudSpeechOptions = {},
  ) {
    this.now = client.config.now ?? (() => new Date().toISOString());
  }

  /** 现在有没有可用的 TTS 模型；界面据此决定要不要露「出声」按钮。 */
  get configured(): boolean {
    return Boolean(this.options.model ?? this.client.config.ttsModel);
  }

  async speak(input: SpeechInput): Promise<SpeechOutput> {
    const model = input.model ?? this.options.model ?? this.client.config.ttsModel;
    if (!model) {
      throw new TreecloudError(
        500,
        "tts_not_configured",
        "没有配配音模型：在 secrity.env 里加上 TTS_MODEL（例如 qwen-audio-3.0-tts-flash）之后才能出声",
      );
    }
    const voice = input.voice ?? this.options.voice ?? this.client.config.ttsVoice;
    const text = input.text.trim();
    if (!text) {
      throw new TreecloudError(400, "tts_empty_text", "这一句是空的，没有可念的内容");
    }

    // speed 与 instructions 是 OpenAI 兼容字段：供应商不支持时会忽略，
    // 不会报错，也不会改变念出来的字（ADR-0124 §4）
    const speed =
      input.speed !== undefined && Number.isFinite(input.speed)
        ? Math.min(2, Math.max(0.5, input.speed))
        : undefined;
    const instructions = input.instructions?.trim();
    const { bytes, mime } = await this.client.requestBytes("/v1/audio/speech", {
      method: "POST",
      body: {
        model,
        input: text,
        response_format: this.options.format ?? "mp3",
        ...(voice ? { voice } : {}),
        ...(speed !== undefined ? { speed } : {}),
        ...(instructions ? { instructions } : {}),
      },
    });
    if (bytes.length === 0) {
      throw new TreecloudError(502, "speech_empty", "语音接口返回了空音频");
    }

    this.counter += 1;
    return {
      assetId: `tc-tts-${this.counter}` as Id,
      bytes,
      mime,
      provenance: {
        modelId: model,
        prompt: text,
        referenceAssetIds: [],
        createdAt: this.now(),
      },
    };
  }
}

export interface TreecloudChatOptions {
  /** 覆盖 env 里的 TEXT_MODEL */
  model?: string;
}

/**
 * 文本模型适配器（ADR-0088）。
 *
 * OpenAI 兼容：`POST /v1/chat/completions`，只带 `model / messages / max_tokens`。
 * **不传 temperature**：实测代理对 Anthropic 模型只接受默认值，传了直接 400。
 *
 * 没配 TEXT_MODEL 时直接报 `text_not_configured`：这是配置问题，重试不会好。
 */
export class TreecloudChatAdapter implements ChatAdapter {
  private readonly now: () => string;

  constructor(
    private readonly client: TreecloudClient,
    private readonly options: TreecloudChatOptions = {},
  ) {
    this.now = client.config.now ?? (() => new Date().toISOString());
  }

  /** 现在有没有可用的文本模型；界面据此决定要不要露「生成」按钮。 */
  get configured(): boolean {
    return Boolean(this.options.model ?? this.client.config.textModel);
  }

  async complete(input: ChatInput): Promise<ChatOutput> {
    const model = this.options.model ?? this.client.config.textModel;
    if (!model) {
      throw new TreecloudError(
        500,
        "text_not_configured",
        "没有配文本模型：在 secrity.env 里加上 TEXT_MODEL（例如 claude-sonnet-5-5）之后才能生成",
      );
    }
    if (input.messages.length === 0) {
      throw new TreecloudError(400, "chat_empty_messages", "没有可发给模型的内容");
    }

    const payload = await this.client.request("/v1/chat/completions", {
      method: "POST",
      body: {
        model,
        messages: input.messages,
        ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
      },
    });

    const text = contentOf(payload);
    if (!text.trim()) {
      throw new TreecloudError(502, "chat_empty_text", "文本模型返回了空内容");
    }
    const usage = payload.usage;
    return {
      text,
      provenance: {
        modelId: typeof payload.model === "string" ? payload.model : model,
        referenceAssetIds: [],
        createdAt: this.now(),
      },
      ...(isJson(usage)
        ? {
            usage: {
              promptTokens: numberOrUndefined(usage.prompt_tokens),
              completionTokens: numberOrUndefined(usage.completion_tokens),
            },
          }
        : {}),
    };
  }
}

/** 有些代理把 content 回成 [{type:"text",text:"…"}]，两种都收。 */
function contentOf(payload: Json): string {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (!isJson(first)) return "";
  const message = first.message;
  if (!isJson(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isJson(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export interface TreecloudTranscriptionOptions {
  /** 覆盖 env 里的 ASR_MODEL */
  model?: string;
  /** 默认 zh */
  language?: string;
}

/**
 * 语音识别适配器（ADR-0087）。
 *
 * 契约按 OpenAI 兼容写法：`POST /v1/audio/transcriptions`，
 * multipart 字段 `file / model / language / response_format`。
 * 用 `verbose_json` 拿分段时间轴；供应商不给 segments 就返回空数组，不猜。
 *
 * 没配 ASR_MODEL 时直接报 `asr_not_configured`：这是配置问题，重试不会好。
 */
export class TreecloudTranscriptionAdapter implements TranscriptionAdapter {
  private readonly now: () => string;

  constructor(
    private readonly client: TreecloudClient,
    private readonly options: TreecloudTranscriptionOptions = {},
  ) {
    this.now = client.config.now ?? (() => new Date().toISOString());
  }

  get configured(): boolean {
    return Boolean(this.options.model ?? this.client.config.asrModel);
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionOutput> {
    const model = input.model ?? this.options.model ?? this.client.config.asrModel;
    if (!model) {
      throw new TreecloudError(
        500,
        "asr_not_configured",
        "没有配识别模型：在 secrity.env 里加上 ASR_MODEL（例如 qwen-audio-3.0-asr-flash）之后才能识别",
      );
    }
    if (input.bytes.length === 0) {
      throw new TreecloudError(400, "asr_empty_audio", "这条音轨是空的");
    }

    const form = new FormData();
    // 复制一份到普通的 ArrayBuffer：Uint8Array 的底层也可能是 SharedArrayBuffer，
    // 那种类型不能直接交给 Blob（TS 会拦，浏览器也不认）。
    const bytes = new Uint8Array(input.bytes);
    form.append(
      "file",
      new Blob([bytes], { type: input.mime }),
      input.filename ?? "line",
    );
    form.append("model", model);
    form.append("language", input.language ?? this.options.language ?? "zh");
    form.append("response_format", "verbose_json");

    const payload = await this.client.request("/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });

    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) {
      throw new TreecloudError(
        502,
        "transcript_empty",
        "识别接口没有返回文字（音轨可能是静音或格式不支持）",
      );
    }

    const rawSegments = Array.isArray(payload.segments) ? payload.segments : [];
    const segments: TranscriptionSegment[] = rawSegments.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const segment = item as { text?: unknown; start?: unknown; end?: unknown };
      const segmentText = typeof segment.text === "string" ? segment.text.trim() : "";
      const start = typeof segment.start === "number" ? segment.start : 0;
      const end = typeof segment.end === "number" ? segment.end : start;
      if (!segmentText) return [];
      return [
        {
          text: segmentText,
          startMs: Math.max(0, Math.round(start * 1000)),
          endMs: Math.max(0, Math.round(end * 1000)),
        },
      ];
    });

    return {
      text,
      segments,
      provenance: {
        modelId: model,
        referenceAssetIds: [],
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
    const seconds = Math.max(1, Math.round(input.durationMs / 1000));

    // 首帧走 multipart 的 `input_reference` 文件 part（ADR-0249）。
    // 文档口径：数组 = 参考图，单个文件 / 单个对象 = 首帧；litellm 会把 JSON 对象
    // 当成文件流读（`'dict' object has no attribute 'read'`），所以 JSON 路不通。
    const form = input.imageUri
      ? videoFrameForm(
          model,
          input.prompt ?? "",
          input.imageUri,
          seconds,
          resolution,
          input.size,
        )
      : null;
    const body = form ?? {
      model,
      prompt: input.prompt ?? "",
      ...(input.size ? { size: input.size } : {}),
      ...(resolution ? { resolution } : {}),
      seconds,
      // 非 data URI（http / 资产库地址）沿用旧形态：网关不替远端下载图片。
      ...(input.imageUri && !form
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
      state.output = await outputOf(jobId, payload, state.input, this.now(), () =>
        this.downloadContent(jobId),
      );
      return { jobId, status, output: state.output };
    }

    return { jobId, status, ...(error ? { error } : {}) };
  }

  /**
   * 从 content 端点取成片，落成 data URI。
   *
   * 只在任务成功但响应体没有地址时调用。拿不到（端点不存在 / 非 2xx）就返回
   * undefined，让上层照旧报 `video_response_invalid`——不把「没拿到」说成成功。
   */
  private async downloadContent(jobId: string): Promise<string | undefined> {
    const endpoints = VIDEO_ENDPOINTS[this.apiName];
    if (!endpoints.content) return undefined;
    const bytes = await this.client.binary(endpoints.content(jobId));
    if (!bytes) return undefined;
    return `data:video/mp4;base64,${Buffer.from(bytes).toString("base64")}`;
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

async function outputOf(
  jobId: string,
  payload: Json,
  input: VideoInput,
  createdAt: string,
  download: () => Promise<string | undefined>,
): Promise<VideoOutput> {
  // 先看响应体里有没有地址；没有就问 content 端点（有的代理只回状态）
  const uri = videoUriOf(payload) ?? (await download());
  if (!uri) {
    throw new TreecloudError(
      502,
      "video_response_invalid",
      `任务 ${jobId} 已成功但没有返回视频地址（content 端点也没拿到字节）`,
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

/**
 * 代理明确表示「这条端点不收参考图」时返回 true。
 *
 * 只认这几种：端点不存在（404 / 405）、明确说参数或接口不支持（400 + unsupported /
 * not supported / image request rejected）。超时、429、5xx 一律不退回——
 * 那些是偶发故障，悄悄换成纯文生图只会让作者以为参考图生效了。
 */
function isReferenceUnsupported(error: unknown): boolean {
  if (!(error instanceof TreecloudError)) return false;
  if (error.status === 404 || error.status === 405) return true;
  if (error.status !== 400) return false;
  const text = `${error.code} ${error.message}`.toLowerCase();
  return (
    text.includes("unsupported") ||
    text.includes("not support") ||
    text.includes("not_support") ||
    text.includes("image request rejected") ||
    text.includes("unknown parameter") ||
    text.includes("unrecognized")
  );
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

/** 二进制响应的类型：去掉 charset 之类的参数，只留 MIME 本体。 */
function mimeOf(response: Response): string {
  const raw = response.headers.get("content-type") ?? "";
  const mime = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime.startsWith("audio/")) return mime;
  // 有的中转站会把音频当 octet-stream 回；按 mp3 收，浏览器多半能放
  if (mime === "application/octet-stream" || mime === "") return "audio/mpeg";
  return mime;
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
