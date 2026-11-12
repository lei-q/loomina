"use client";

import { isStoredAssetUri } from "@/lib/asset-uri";

/**
 * 把刚拿到的大素材先放进本机资产库（H3 / ADR-0128）。
 *
 * 生成结果常常是几 MB 的 data URI：直接写进事件日志会让撤销、回滚、重放
 * 全都变慢，所以生成路径统一先过这里。小图（≤ 128 KB）留在日志里——
 * 一个 HTTP 往返换几 KB 不值得，也让测试与示例保持原样。
 *
 * 失败不抛错：素材还在手上，退回 data URI 仍然可用；界面不会因为
 * 资产库写不进去而丢掉刚花钱生成的东西。
 *
 * `force` 用于设置页的显式迁移：那里的承诺是「把日志里的都搬走」，
 * 不该因为一张小图没到阈值就留在原地。
 */
const INLINE_LIMIT = 128 * 1024;

export async function persistAsset(
  uri: string,
  options: { force?: boolean } = {},
): Promise<string> {
  if (!uri.startsWith("data:") || isStoredAssetUri(uri)) return uri;
  if (!options.force && uri.length <= INLINE_LIMIT) return uri;
  // 配了对象存储就进桶（`s3://`），否则进本机资产库（`loomina://`）。
  // 两条路失败都退回原 data URI：素材还在手上，界面不会因此丢东西。
  for (const endpoint of ["/api/storage", "/api/asset/store"]) {
    const stored = await post(endpoint, uri);
    if (stored) return stored;
  }
  return uri;
}

async function post(endpoint: string, uri: string): Promise<string | null> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri }),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { uri?: string };
    return typeof payload.uri === "string" ? payload.uri : null;
  } catch {
    return null;
  }
}
