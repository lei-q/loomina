import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ConfigError, loadEnvFile, type EnvMap, type TreecloudConfig } from "@loomina/gateway";
import {
  MODALITIES,
  MODALITY_LABEL,
  SEED_MODELS,
  isModelId,
  modalityOf,
  type ConfigFile,
  type ConfigSaveInput,
  type ModelRecord,
  type Modality,
  type ProviderRecord,
  type PublicConfig,
  type VideoApiName,
} from "@/lib/config-types";
import { envPath } from "@/lib/server-env";

/**
 * 供应商与模型配置（H22 / ADR-0094）。
 *
 * 配置落本机 `.loomina/config.json`（目录 0700、文件 0600），密钥只在这里与
 * 服务端内存里出现；`toPublicConfig` 之后连字段都不剩，浏览器拿不到。
 * 没有配置文件时从 secrity.env 生成一个临时视图，第一次保存才落盘。
 */

const MAX_PROVIDERS = 20;
const MAX_MODELS = 100;
const MAX_KEY = 500;

export function projectRoot(): string {
  const cwd = process.cwd();
  if (existsSync(path.join(/* turbopackIgnore: true */ cwd, "apps", "web"))) return cwd;
  const up = path.resolve(/* turbopackIgnore: true */ cwd, "..", "..");
  if (existsSync(path.join(/* turbopackIgnore: true */ up, "apps", "web"))) return up;
  return cwd;
}

export function configFilePath(): string {
  const override = process.env.LOOMINA_CONFIG?.trim();
  if (override) return path.resolve(/* turbopackIgnore: true */ process.cwd(), override);
  return path.join(/* turbopackIgnore: true */ projectRoot(), ".loomina", "config.json");
}

function readEnv(): EnvMap {
  try {
    return loadEnvFile(envPath());
  } catch {
    return {};
  }
}

function envVideoApi(env: EnvMap): VideoApiName | undefined {
  return env.VIDEO_API === "litellm"
    ? "litellm"
    : env.VIDEO_API === "treecloud"
      ? "treecloud"
      : undefined;
}

function modelIdFor(providerId: string, model: string, used: Set<string>): string {
  const base = `${providerId}:${model}`.replace(/\s+/g, "-");
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

/** 环境变量 → 临时配置视图。不写盘，密钥也留在 env 里。 */
function seedFromEnv(env: EnvMap): ConfigFile {
  const baseUrl = (env.BASE_URL ?? "").replace(/\/+$/, "");
  if (!baseUrl) return { version: 1, providers: [], models: [], defaults: {} };

  const provider: ProviderRecord = {
    id: "env",
    name: "默认供应商（secrity.env）",
    baseUrl,
    // 不把密钥复制进来：需要时按 id 回读 env，这样临时视图和落盘配置都不会带密钥
    ...(envVideoApi(env) ? { videoApi: envVideoApi(env) } : {}),
  };

  const used = new Set<string>();
  const models: ModelRecord[] = [];
  const defaults: Partial<Record<Modality, string>> = {};
  const add = (
    modality: Modality,
    model: string | undefined,
    extra: Partial<Pick<ModelRecord, "resolution" | "voice">> = {},
  ) => {
    if (!model) return;
    const id = modelIdFor(provider.id, model, used);
    models.push({
      id,
      providerId: provider.id,
      modality,
      model,
      label: `${provider.name} / ${model}`,
      ...extra,
    });
    defaults[modality] = id;
  };

  add("text", env.TEXT_MODEL || SEED_MODELS.text);
  add("image", env.IMAGE_MODEL || SEED_MODELS.image);
  add(
    "video",
    env.VIDEO_MODEL || env.MODEL_NAME || SEED_MODELS.video,
    env.VIDEO_RESOLUTION ? { resolution: env.VIDEO_RESOLUTION } : undefined,
  );
  add("tts", env.TTS_MODEL || SEED_MODELS.tts, env.TTS_VOICE ? { voice: env.TTS_VOICE } : undefined);
  add("asr", env.ASR_MODEL);

  return { version: 1, providers: [provider], models, defaults };
}

async function loadFromDisk(file: string): Promise<ConfigFile | null> {
  try {
    const text = await readFile(file, "utf8");
    const parsed = JSON.parse(text) as ConfigFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.providers) || !Array.isArray(parsed.models)) {
      throw new ConfigError(`配置文件格式不对：${file}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      `读不了配置文件 ${file}：${error instanceof Error ? error.message : "未知错误"}`,
    );
  }
}

export type LoadedConfig = {
  config: ConfigFile;
  path: string;
  saved: boolean;
};

export async function loadConfig(): Promise<LoadedConfig> {
  const file = configFilePath();
  const onDisk = await loadFromDisk(file);
  if (onDisk) return { config: onDisk, path: file, saved: true };
  return { config: seedFromEnv(readEnv()), path: file, saved: false };
}

function bad(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * 校验并补全保存请求。
 *
 * 默认模型是硬约束：某模态有模型却没有可用默认时，取第一个并写回，
 * 不让界面出现「有模型但不知道用哪个」的中间态。
 */
export function normalizeConfig(
  input: unknown,
  previous: ConfigFile,
): { ok: true; config: ConfigFile } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return bad("配置不是对象");
  const raw = input as Partial<ConfigSaveInput>;

  if (!Array.isArray(raw.providers)) return bad("providers 必须是数组");
  if (raw.providers.length > MAX_PROVIDERS) return bad(`供应商最多 ${MAX_PROVIDERS} 个`);
  if (!Array.isArray(raw.models)) return bad("models 必须是数组");
  if (raw.models.length > MAX_MODELS) return bad(`模型最多 ${MAX_MODELS} 个`);

  const providers: ProviderRecord[] = [];
  const providerIds = new Set<string>();
  for (const [index, item] of raw.providers.entries()) {
    if (!item || typeof item !== "object") return bad(`第 ${index + 1} 个供应商不是对象`);
    const id = typeof item.id === "string" ? item.id.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
      return bad(`供应商 ${index + 1} 的 id 只能用小写字母、数字和连字符（≤40）`);
    }
    if (providerIds.has(id)) return bad(`供应商 id 重复：${id}`);
    providerIds.add(id);

    const name = typeof item.name === "string" ? item.name.trim().slice(0, 40) : "";
    if (!name) return bad(`供应商 ${index + 1} 缺少名字`);

    const baseUrl = normalizeBaseUrl(item.baseUrl);
    if (!baseUrl) {
      return bad(`供应商「${name}」的 Base URL 必须是 http(s)，且不能带账号、查询串或锚点`);
    }

    const previousKey = previous.providers.find((p) => p.id === id)?.apiKey;
    let apiKey: string | undefined;
    if (item.apiKey === undefined) apiKey = previousKey;
    else if (typeof item.apiKey === "string") apiKey = item.apiKey.trim().slice(0, MAX_KEY);
    else return bad(`供应商「${name}」的密钥不是字符串`);

    const videoApi =
      item.videoApi === "litellm" || item.videoApi === "treecloud" ? item.videoApi : undefined;

    providers.push({
      id,
      name,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(videoApi ? { videoApi } : {}),
    });
  }

  const models: ModelRecord[] = [];
  const modelIds = new Set<string>();
  const signatures = new Set<string>();
  for (const [index, item] of raw.models.entries()) {
    if (!item || typeof item !== "object") return bad(`第 ${index + 1} 个模型不是对象`);
    const modality = modalityOf(item.modality);
    if (!modality) return bad(`第 ${index + 1} 个模型的模态不认识`);

    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!isModelId(id)) return bad(`第 ${index + 1} 个模型的 id 不合法`);
    if (modelIds.has(id)) return bad(`模型 id 重复：${id}`);
    modelIds.add(id);

    const providerId = typeof item.providerId === "string" ? item.providerId.trim() : "";
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return bad(`模型「${id}」指向不存在的供应商「${providerId}」`);

    const model = typeof item.model === "string" ? item.model.trim().slice(0, 120) : "";
    if (!model) return bad(`模型「${id}」缺少真实模型名`);

    // 同一供应商、同一模态下的同一个真实模型只留一条，免得下拉里出现两个一样的
    const signature = `${providerId}|${modality}|${model}`;
    if (signatures.has(signature)) {
      return bad(`模型「${provider.name} / ${model}」重复，删掉其中一条`);
    }
    signatures.add(signature);

    const label =
      typeof item.label === "string" && item.label.trim()
        ? item.label.trim().slice(0, 80)
        : `${provider.name} / ${model}`;

    const resolution =
      modality === "video" && typeof item.resolution === "string"
        ? item.resolution.trim().slice(0, 20) || undefined
        : undefined;
    const voice =
      modality === "tts" && typeof item.voice === "string"
        ? item.voice.trim().slice(0, 40) || undefined
        : undefined;
    // 商用条款 / 能力备注：自由文本，只在能力矩阵里显示；空串等于没写
    const terms =
      typeof item.terms === "string" ? item.terms.trim().slice(0, 240) || undefined : undefined;

    models.push({
      id,
      providerId,
      modality,
      model,
      label,
      ...(resolution ? { resolution } : {}),
      ...(voice ? { voice } : {}),
      ...(terms ? { terms } : {}),
    });
  }

  const rawDefaults = raw.defaults && typeof raw.defaults === "object" ? raw.defaults : {};
  const defaults: Partial<Record<Modality, string>> = {};
  for (const modality of MODALITIES) {
    const options = models.filter((m) => m.modality === modality);
    if (options.length === 0) continue;
    const wanted = (rawDefaults as Record<string, unknown>)[modality];
    const match = options.find((m) => m.id === wanted);
    if (!match) return bad(`${MODALITY_LABEL[modality]}模型必须指定一个默认`);
    defaults[modality] = match.id;
  }

  return { ok: true, config: { version: 1, providers, models, defaults } };
}

export async function saveConfig(
  input: unknown,
): Promise<{ config: ConfigFile; path: string }> {
  const current = await loadConfig();
  const normalized = normalizeConfig(input, current.config);
  if (!normalized.ok) throw new ConfigError(normalized.error);

  const file = current.path;
  await mkdir(/* turbopackIgnore: true */ path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(normalized.config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
  return { config: normalized.config, path: file };
}

export function toPublicConfig(loaded: LoadedConfig, env: EnvMap = readEnv()): PublicConfig {
  const { config, path: file, saved } = loaded;
  const providers = config.providers.map((provider) => {
    const { apiKey, ...rest } = provider;
    const fromEnv = !apiKey && provider.id === "env" && Boolean(env.API_KEY);
    return {
      ...rest,
      hasKey: Boolean(apiKey || fromEnv),
      keyFromEnv: fromEnv,
    };
  });

  const catalog = {} as PublicConfig["catalog"];
  for (const modality of MODALITIES) {
    catalog[modality] = config.models
      .filter((model) => model.modality === modality)
      .map((model) => ({
        id: model.id,
        label: model.label,
        model: model.model,
        providerName: providers.find((p) => p.id === model.providerId)?.name ?? model.providerId,
      }));
  }

  return { providers, models: config.models, defaults: config.defaults, catalog, path: file, saved };
}

export type ResolvedModel = {
  config: ConfigFile;
  provider: ProviderRecord;
  model: ModelRecord;
  apiKey: string;
};

function envApiKey(env: EnvMap, provider: ProviderRecord): string {
  return provider.apiKey || (provider.id === "env" ? (env.API_KEY ?? "") : "");
}

/** 页面没选就取该模态的默认；选了但不属于该模态就报错，不悄悄回落。 */
export async function resolveModel(
  modality: Modality,
  requestedId?: string,
): Promise<ResolvedModel> {
  const loaded = await loadConfig();
  const options = loaded.config.models.filter((model) => model.modality === modality);
  const wanted = requestedId?.trim();
  let model: ModelRecord | undefined;
  if (wanted) {
    model = options.find((item) => item.id === wanted);
    if (!model) {
      throw new ConfigError(
        `所选${MODALITY_LABEL[modality]}模型不存在：去 /settings 检查，或切回默认`,
      );
    }
  } else {
    model =
      options.find((item) => item.id === loaded.config.defaults[modality]) ?? options[0];
  }
  if (!model) {
    throw new ConfigError(
      `还没有配置${MODALITY_LABEL[modality]}模型：去 /settings 添加一个并设为默认`,
    );
  }

  const provider = loaded.config.providers.find((item) => item.id === model.providerId);
  if (!provider) {
    throw new ConfigError(`模型「${model.label}」指向的供应商不存在：去 /settings 重新选择`);
  }
  if (!provider.baseUrl) throw new ConfigError(`供应商「${provider.name}」缺少 Base URL`);

  return {
    config: loaded.config,
    provider,
    model,
    apiKey: envApiKey(readEnv(), provider),
  };
}

/** 把选中的模型套进网关配置的对应槽位；其它槽位保留各自默认。 */
export function gatewayConfigOf(resolved: ResolvedModel): TreecloudConfig {
  const env = readEnv();
  const { config, provider, model, apiKey } = resolved;
  const defaultModel = (modality: Modality) =>
    config.models.find((item) => item.id === config.defaults[modality])?.model;
  const defaultRecord = (modality: Modality) =>
    config.models.find((item) => item.id === config.defaults[modality]);

  return {
    baseUrl: provider.baseUrl,
    apiKey,
    videoModel:
      model.modality === "video" ? model.model : (defaultModel("video") ?? ""),
    imageModel:
      model.modality === "image" ? model.model : (defaultModel("image") ?? ""),
    videoResolution:
      model.modality === "video" ? (model.resolution ?? env.VIDEO_RESOLUTION) : env.VIDEO_RESOLUTION,
    imageSize: env.IMAGE_SIZE || undefined,
    videoApi: provider.videoApi ?? envVideoApi(env),
    ttsModel:
      model.modality === "tts" ? model.model : defaultModel("tts"),
    ttsVoice:
      model.modality === "tts"
        ? (model.voice ?? env.TTS_VOICE)
        : (defaultRecord("tts")?.voice ?? env.TTS_VOICE),
    asrModel:
      model.modality === "asr" ? model.model : defaultModel("asr"),
    textModel:
      model.modality === "text" ? model.model : defaultModel("text"),
  };
}

export type ProbeResult = {
  ok: boolean;
  status?: number;
  modelCount?: number;
  message: string;
};

/** 只读探测：`GET /v1/models`，不触发生成、不花钱。 */
export async function probeProvider(providerId: string): Promise<ProbeResult> {
  const loaded = await loadConfig();
  const provider = loaded.config.providers.find((item) => item.id === providerId);
  if (!provider) return { ok: false, message: "供应商不存在" };
  const key = envApiKey(readEnv(), provider);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${provider.baseUrl}/v1/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const snippet = redact(text, key).slice(0, 200);
      return {
        ok: false,
        status: response.status,
        message: `供应商返回 ${response.status}${snippet ? `：${snippet}` : ""}`,
      };
    }
    let count: number | undefined;
    try {
      const payload = JSON.parse(text) as { data?: unknown };
      count = Array.isArray(payload.data) ? payload.data.length : undefined;
    } catch {
      // 不是 JSON 也算连通；只是列不出模型数
    }
    return {
      ok: true,
      status: response.status,
      ...(count !== undefined ? { modelCount: count } : {}),
      message: count !== undefined ? `连通，列出 ${count} 个模型` : "连通",
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      message: aborted
        ? "探测超时（10 秒）"
        : redact(error instanceof Error ? error.message : String(error), key).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

function redact(text: string, key: string): string {
  if (!key) return text;
  return text.split(key).join("<redacted>");
}
