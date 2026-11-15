/**
 * 供应商与模型配置的共用形状（H22 / ADR-0094）。
 *
 * 这个文件不带任何 Node 依赖：服务端的读写逻辑在 `app-config.ts`，
 * 浏览器只拿到脱敏后的 `PublicConfig`，密钥永远不在这里出现。
 */

export const MODALITIES = ["text", "image", "video", "tts", "asr"] as const;
export type Modality = (typeof MODALITIES)[number];

export const MODALITY_LABEL: Record<Modality, string> = {
  text: "文本",
  image: "图像",
  video: "视频",
  tts: "配音",
  asr: "识别",
};

export const MODALITY_HINT: Record<Modality, string> = {
  text: "故事、剧本改编",
  image: "定妆、场景主镜、关键帧",
  video: "图生视频 take",
  tts: "台词出声",
  asr: "音轨转文字",
};

/**
 * 用户当前要求的默认模型；环境变量没配时用它。
 *
 * `image` 用不带 `-c` 后缀的：2026-11-15 实测带 `-c` 的分组在上游全部 503
 * （`The upstream image response could not be validated`，代理的计费配置坏了）。
 */
export const SEED_MODELS: Record<Modality, string | undefined> = {
  text: "deepseek-v4.1-flash-1017",
  image: "gpt-image-2",
  video: "wan3.0-video-unfiltered",
  // 2026-11-15：原先写的是 seedance-2.0——那是视频模型，`/v1/audio/speech` 只会报错。
  // 代理的模型清单里音频模态是 qwen-audio-3.0-tts-*；上游部署当前仍报 URL 错（ADR-0247）。
  tts: "qwen-audio-3.0-tts-flash",
  // ASR 同理：清单里有 qwen-audio-3.0-asr-*，但上游部署未通，保持「未配置」让界面如实说（ADR-0087）。
  asr: undefined,
};

/**
 * 视频接口族（model_adapter 概念）：**类型本身归 gateway**，这里只转出去。
 * web 的配置层要用它，但重复定义一份迟早会与 gateway 的实际适配器分叉。
 */
import type { VideoApiName } from "@loomina/gateway";
export type { VideoApiName };

export type ProviderRecord = {
  id: string;
  name: string;
  /** 不带结尾斜杠 */
  baseUrl: string;
  /** 只在服务端；PUT 时缺省表示「沿用已保存的密钥」 */
  apiKey?: string;
  videoApi?: VideoApiName;
};

export type ModelRecord = {
  /** 全局唯一，例如 `env:deepseek-v4.1-flash-1017` */
  id: string;
  providerId: string;
  modality: Modality;
  /** 发给供应商的真实模型名 */
  model: string;
  label: string;
  /** 视频分辨率，例如 768p */
  resolution?: string;
  /** 配音默认音色 */
  voice?: string;
  /**
   * 按用量计价的单价（H4）：文本是元 / 百万 token，配音是元 / 千字。
   *
   * 供应商的 `/v1/models` 不给 chat 与 tts 的价格（R28 / R39），
   * 只能由作者按账单填；不填就是不知道，账上只数次数、不写金额。
   */
  unitPriceCny?: number;
  /**
   * 自定义图价（元 / 张，H22）：填了就盖过价目表。
   *
   * 价目表只收公开按张计价的通道；走 token 或别的结算方式的图模型
   * 由作者按账单填，填了预算拦截与报价才算得出钱。
   */
  perImageCny?: number;
  /** 自定义视频价（元 / 秒，H22）：填了就盖过价目表，按 token 结算的模型也能报价 */
  perSecondCny?: number;
  /** 商用条款 / 能力备注：供应商给的事实，代码测不出来，只能人工记（B12） */
  terms?: string;
};

/**
 * 对象存储配置（H3 / ADR-0128 §7）。
 *
 * 密钥只落在 `.loomina/config.json`（0600）或服务端环境变量里，
 * `PublicStorage` 是脱敏后的形状：浏览器只该知道「配没配、连的是谁」。
 */
export type StorageRecord = {
  kind: "s3";
  /** 不带结尾斜杠，例如 `https://s3.us-east-1.amazonaws.com` */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO 与自建网关只认 path-style */
  pathStyle: boolean;
  /** 临时凭据才需要 */
  sessionToken?: string;
};

export type PublicStorage = {
  configured: boolean;
  kind: "s3" | null;
  /** 完整 Endpoint：校验时就不许带账号密码，所以它不是凭据 */
  endpoint: string | null;
  /** 只给主机名，能力接口与标题栏用 */
  endpointHost: string | null;
  bucket: string | null;
  region: string | null;
  pathStyle: boolean | null;
  /** 配置从哪来：文件 / 环境变量 */
  source: "file" | "env" | null;
  /** 现在实际在用的资产库实现 */
  active: "local" | "s3";
  /** 已配置但没启用时的原因 */
  note?: string;
};

export type ConfigFile = {
  version: 1;
  providers: ProviderRecord[];
  models: ModelRecord[];
  /** 每种模态至少一个默认；没有该模态模型时缺省 */
  defaults: Partial<Record<Modality, string>>;
  /** 对象存储；缺省表示只用本机资产库 */
  storage?: StorageRecord;
};

export type PublicProvider = Omit<ProviderRecord, "apiKey"> & {
  /** 是否已有可用密钥（来自配置文件或 secrity.env），不暴露内容 */
  hasKey: boolean;
  /** 密钥是否来自 secrity.env（而不是本配置文件） */
  keyFromEnv: boolean;
};

export type PublicConfig = {
  providers: PublicProvider[];
  models: ModelRecord[];
  defaults: Partial<Record<Modality, string>>;
  /** 模态 → 选项，方便页面直接渲染下拉 */
  catalog: Record<Modality, { id: string; label: string; model: string; providerName: string }[]>;
  /** 配置文件的绝对路径；只用于界面显示，不含密钥 */
  path: string;
  /** 配置文件是否已落盘；false 表示当前是环境变量生成的临时视图 */
  saved: boolean;
  /** 对象存储（H3）；只到「配没配、连的是谁」 */
  storage: PublicStorage;
};

export type ConfigSaveInput = {
  providers: {
    id: string;
    name: string;
    baseUrl: string;
    /** undefined = 沿用旧密钥；空字符串 = 清空 */
    apiKey?: string;
    videoApi?: VideoApiName;
  }[];
  models: (Omit<ModelRecord, "label"> & { label?: string })[];
  defaults: Partial<Record<Modality, string>>;
  /** `null` = 清掉对象存储配置，回到本机资产库 */
  storage?: Partial<StorageRecord> | null;
};

export function modalityOf(value: unknown): Modality | null {
  return MODALITIES.includes(value as Modality) ? (value as Modality) : null;
}

/** 模型 id 里允许的字符；冒号用来分隔供应商与模型 */
export function isModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value);
}

/**
 * 对象存储的连接参数（H3）。
 *
 * 形状放在这里而不是 `s3-store.ts`：`storage-config` 属于纯计算层，
 * 它要构造这个类型，不该为此反向依赖 assets（M4）。
 */
export type S3Config = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  sessionToken?: string;
};
