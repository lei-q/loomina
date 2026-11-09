import { readFileSync } from "node:fs";

export type EnvMap = Record<string, string>;

/**
 * 解析 KEY=VALUE 形式的 env 文件。
 *
 * 刻意不 source、不 eval：密钥里可能含 shell 元字符，
 * 执行它会带来不必要的风险；这里只做纯文本解析。
 */
export function parseEnvFile(text: string): EnvMap {
  const out: EnvMap = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function loadEnvFile(path: string): EnvMap {
  return parseEnvFile(readFileSync(path, "utf8"));
}

export interface TreecloudEnv {
  baseUrl: string;
  apiKey: string;
  videoModel: string;
  imageModel: string;
  videoResolution?: string;
  imageSize?: string;
  videoApi?: "treecloud" | "litellm";
}

export class ConfigError extends Error {}

/**
 * 从 env 映射里取网关配置。
 * 报错只说缺哪个变量，绝不回显值。
 */
export function treecloudEnvFrom(env: EnvMap): TreecloudEnv {
  const baseUrl = (env.BASE_URL ?? "").replace(/\/+$/, "");
  const apiKey = env.API_KEY ?? "";
  const videoModel = env.VIDEO_MODEL ?? env.MODEL_NAME ?? "";

  if (!baseUrl) throw new ConfigError("缺少 BASE_URL");
  if (!apiKey) throw new ConfigError("缺少 API_KEY");
  if (!videoModel) throw new ConfigError("缺少 MODEL_NAME 或 VIDEO_MODEL");

  const videoApi = env.VIDEO_API === "litellm" ? "litellm" : env.VIDEO_API === "treecloud" ? "treecloud" : undefined;

  const config: TreecloudEnv = {
    baseUrl,
    apiKey,
    videoModel,
    imageModel: env.IMAGE_MODEL ?? (videoApi === "litellm" ? "gpt-image-2" : "gpt-image-2-c"),
    videoResolution: env.VIDEO_RESOLUTION || undefined,
    imageSize: env.IMAGE_SIZE || undefined,
    videoApi,
  };
  return config;
}

/** 打印配置摘要时用：值本身永不出现在输出里。 */
export function describeEnv(config: TreecloudEnv): string {
  return [
    `baseUrl=${config.baseUrl}`,
    `apiKey=<${config.apiKey.length} chars>`,
    `videoModel=${config.videoModel}`,
    `imageModel=${config.imageModel}`,
    `videoApi=${config.videoApi ?? "(自动)"}`,
    `videoResolution=${config.videoResolution ?? "(默认)"}`,
    `imageSize=${config.imageSize ?? "(默认)"}`,
  ].join(" ");
}
