/**
 * 对象存储的启用与脱敏（H3 / ADR-0128 §7 / ADR-0129 §3）。
 *
 * 三条规矩：
 *   1. 凭据只从 `.loomina/config.json`（0600）或服务端环境变量读；
 *   2. 回给浏览器的只有「配没配、连的是哪个主机与桶」，**没有 AK/SK**；
 *   3. 配置不完整就退回本机资产库，并把原因写成人话，不假装已启用。
 *
 * `LOOMINA_ASSET_STORE` 只是显式开关：`local` 强制本机，`s3` 要求配置齐全，
 * 不设时「配了就用对象存储」。
 */

import type { EnvMap } from "@loomina/gateway";
import type { PublicStorage, StorageRecord } from "@/lib/config-types";
import type { S3Config } from "@/lib/s3-store";

export type StorageResolution = {
  /** 实际要用的实现；`undefined` 表示本机资产库 */
  config?: S3Config;
  active: "local" | "s3";
  /** 为什么没用对象存储；只有配置有问题时才有 */
  note?: string;
  public: PublicStorage;
};

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** 环境变量里的对象存储配置（部署时用，不进配置文件） */
function fromEnv(env: EnvMap): StorageRecord | undefined {
  const endpoint = env.LOOMINA_S3_ENDPOINT?.trim();
  const bucket = env.LOOMINA_S3_BUCKET?.trim();
  const accessKeyId = env.LOOMINA_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.LOOMINA_S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  return {
    kind: "s3",
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    region: env.LOOMINA_S3_REGION?.trim() || "us-east-1",
    accessKeyId,
    secretAccessKey,
    pathStyle: env.LOOMINA_S3_PATH_STYLE === "1" || env.LOOMINA_S3_PATH_STYLE === "true",
    ...(env.LOOMINA_S3_SESSION_TOKEN?.trim()
      ? { sessionToken: env.LOOMINA_S3_SESSION_TOKEN.trim() }
      : {}),
  };
}

export function resolveStorage(
  record: StorageRecord | undefined,
  env: EnvMap,
): StorageResolution {
  const forced = env.LOOMINA_ASSET_STORE?.trim().toLowerCase();
  const fromEnvRecord = fromEnv(env);
  const chosen = fromEnvRecord ?? record;
  const source: "file" | "env" | null = fromEnvRecord ? "env" : record ? "file" : null;

  const local = (note?: string): StorageResolution => ({
    active: "local",
    ...(note ? { note } : {}),
    public: {
      configured: Boolean(chosen),
      kind: chosen ? "s3" : null,
      endpoint: chosen?.endpoint ?? null,
      endpointHost: chosen ? hostOf(chosen.endpoint) : null,
      bucket: chosen?.bucket ?? null,
      region: chosen?.region ?? null,
      pathStyle: chosen ? chosen.pathStyle : null,
      source,
      active: "local",
      ...(note ? { note } : {}),
    },
  });

  if (forced === "local") return local(chosen ? "LOOMINA_ASSET_STORE=local：显式用本机资产库" : undefined);
  if (!chosen) {
    return local(
      forced === "s3" ? "LOOMINA_ASSET_STORE=s3，但没有可用的对象存储配置" : undefined,
    );
  }

  const config: S3Config = {
    endpoint: chosen.endpoint,
    bucket: chosen.bucket,
    region: chosen.region,
    accessKeyId: chosen.accessKeyId,
    secretAccessKey: chosen.secretAccessKey,
    pathStyle: chosen.pathStyle,
    ...(chosen.sessionToken ? { sessionToken: chosen.sessionToken } : {}),
  };

  return {
    config,
    active: "s3",
    public: {
      configured: true,
      kind: "s3",
      endpoint: chosen.endpoint,
      endpointHost: hostOf(chosen.endpoint),
      bucket: chosen.bucket,
      region: chosen.region,
      pathStyle: chosen.pathStyle,
      source,
      active: "s3",
    },
  };
}

/** 只给界面的那部分：能力接口与设置页共用 */
export function publicStorageOf(resolution: StorageResolution): PublicStorage {
  return resolution.public;
}
