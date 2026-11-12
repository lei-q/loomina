/**
 * 资产库的运行时选择（H3 / ADR-0128 §1）。
 *
 * 上层（路由、渲染、切帧）只调这里，不关心字节在盘上还是在对象存储里。
 * 每次都重新读配置：改完设置页不用重启就能生效，代价是一次小文件读。
 */

import { loadConfig } from "@/lib/app-config";
import { localAssetStore, localPathOf, type AssetStore } from "@/lib/asset-store";
import { storedAssetRef } from "@/lib/asset-uri";
import {
  materializeS3Object,
  s3AssetStore,
  s3ObjectRef,
  type S3Config,
} from "@/lib/s3-store";
import { resolveStorage, type StorageResolution } from "@/lib/storage-config";
import { loadEnvFile } from "@loomina/gateway";
import { envPath } from "@/lib/server-env";

function env(): Record<string, string> {
  try {
    return loadEnvFile(envPath());
  } catch {
    return {};
  }
}

/** 当前生效的存储配置（含脱敏视图） */
export async function activeStorage(): Promise<StorageResolution> {
  const loaded = await loadConfig();
  return resolveStorage(loaded.config.storage, env());
}

/** 当前生效的 `AssetStore` 实现 */
export async function activeStore(): Promise<AssetStore> {
  const storage = await activeStorage();
  if (storage.config) return s3AssetStore(storage.config);
  return localAssetStore;
}

/**
 * 地址 → 服务端可读的本地文件路径（ffmpeg 只吃路径）。
 *
 * - `loomina://` → 盘上的文件；
 * - `s3://` → 拉到 `.loomina/assets/cache/`，同一个 key 只下载一次；
 * - 其余（data URI、https）→ null，调用方自己处理。
 */
export async function materializeAsset(uri: string): Promise<string | null> {
  const trimmed = uri.trim();
  if (storedAssetRef(trimmed)) return localPathOf(trimmed);
  if (!s3ObjectRef(trimmed)) return null;
  const storage = await activeStorage();
  const config = storage.config;
  if (!config) return null;
  return materializeS3Object(config, trimmed);
}

/** 浏览器读素材用的地址：对象存储给一条预签名 URL，本机给 `/api/asset/…` */
export async function browserAssetUrl(uri: string, expiresSeconds = 600): Promise<string | null> {
  const trimmed = uri.trim();
  if (!s3ObjectRef(trimmed)) return null;
  const storage = await activeStorage();
  if (!storage.config) return null;
  const { presignedGetUrl } = await import("@/lib/s3-store");
  return presignedGetUrl(storage.config, trimmed, expiresSeconds);
}

export type { S3Config };
