/**
 * 资产地址（H3 / ADR-0128）。
 *
 * 素材地址有两种形状，读的一方永远只认字符串：
 *
 * - `data:image/png;base64,…` —— 旧项目与示例素材，字节就在事件日志里；
 * - `loomina://assets/<sha256>.<ext>` —— 本机资产库，字节在 `.loomina/assets/`。
 *
 * 这个文件必须保持纯函数、**不碰 node:fs**：浏览器组件与 Node 路由都会 import 它。
 */

export const ASSET_STORE_PREFIX = "loomina://assets/";
/** 对象存储地址（H3）：`s3://<bucket>/<key>` */
export const S3_PREFIX = "s3://";

/** 单文件上限：视频 take 的合理上限（ADR-0128）。超过直接拒绝，不写半个文件 */
export const MAX_ASSET_BYTES = 200 * 1024 * 1024;

const STORED_URI = /^loomina:\/\/assets\/([0-9a-f]{64})\.([a-z0-9]{1,8})$/;

/**
 * 扩展名按「一种 mime 一个后缀」定，保证扩展名能反推出唯一的 mime。
 * `audio/webm` 用 `weba`：`webm` 留给视频，否则读回来分不清是音频还是视频。
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
};

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  weba: "audio/webm",
};

/** 认不出的类型给 `bin`：地址仍然成立，只是浏览器与 ffmpeg 得自己嗅探 */
export function extensionForMime(mime: string): string {
  return EXTENSION_BY_MIME[mime.trim().toLowerCase()] ?? "bin";
}

export function mimeForExtension(extension: string): string {
  return MIME_BY_EXTENSION[extension.trim().toLowerCase()] ?? "application/octet-stream";
}

export type StoredAssetRef = { hash: string; extension: string };

/** `loomina://assets/…` → `{ hash, extension }`；不是资产库地址就返回 null */
export function storedAssetRef(uri: string): StoredAssetRef | null {
  const match = STORED_URI.exec(uri.trim());
  if (!match) return null;
  return { hash: match[1]!, extension: match[2]! };
}

export function isStoredAssetUri(uri: string): boolean {
  return storedAssetRef(uri) !== null;
}

/** 对象存储地址（`s3://桶/路径`）。形状校验在 `s3-store.ts` 里做，这里只认前缀 */
export function isRemoteAssetUri(uri: string): boolean {
  return uri.trim().startsWith(S3_PREFIX);
}

export function storedAssetUri(hash: string, extension: string): string {
  return `${ASSET_STORE_PREFIX}${hash}.${extension}`;
}

/**
 * 浏览器要用的地址：资产库地址换成 `/api/asset/<hash>.<ext>`，
 * 对象存储地址换成 `/api/storage?uri=…`（服务端签一条短期 GET），
 * 其余原样返回。
 *
 * 组件里所有 `<img>` / `<video>` / `<audio>` 的 src 都要过这一层，
 * 否则迁移过的素材在界面上就是一张裂图。
 */
export function assetHref(uri?: string): string | undefined {
  if (!uri) return undefined;
  const ref = storedAssetRef(uri);
  if (ref) return `/api/asset/${ref.hash}.${ref.extension}`;
  if (uri.startsWith(S3_PREFIX)) return `/api/storage?uri=${encodeURIComponent(uri)}`;
  return uri;
}
