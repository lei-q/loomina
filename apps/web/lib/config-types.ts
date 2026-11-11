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

/** 用户当前要求的默认模型；环境变量没配时用它 */
export const SEED_MODELS: Record<Modality, string | undefined> = {
  text: "deepseek-v4.1-flash-1017",
  image: "gpt-image-2-c",
  video: "minimax-h3",
  tts: "seedance-2.0",
  asr: undefined,
};

export type VideoApiName = "treecloud" | "litellm";

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
  /** 商用条款 / 能力备注：供应商给的事实，代码测不出来，只能人工记（B12） */
  terms?: string;
};

export type ConfigFile = {
  version: 1;
  providers: ProviderRecord[];
  models: ModelRecord[];
  /** 每种模态至少一个默认；没有该模态模型时缺省 */
  defaults: Partial<Record<Modality, string>>;
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
};

export function modalityOf(value: unknown): Modality | null {
  return MODALITIES.includes(value as Modality) ? (value as Modality) : null;
}

/** 模型 id 里允许的字符；冒号用来分隔供应商与模型 */
export function isModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value);
}
