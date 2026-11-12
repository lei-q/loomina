/**
 * S3 兼容对象存储（H3 / ADR-0128 §3 / ADR-0129 §3）。
 *
 * 只做四件事：写、读、删、列。全部走**预签名 URL**——服务端拿着 AK/SK 签一条
 * 短期地址，再用普通 `fetch` 发请求。不引 `@aws-sdk/client-s3`，也不引 `aws4`：
 * 签名在 `s3-sigv4.ts` 里，对着 AWS 官方测试向量锁过。
 *
 * 地址形状是 `s3://<bucket>/<key>`。key 里保留 `/`（按内容寻址的哈希做文件名，
 * 目录按项目 / 日期分，方便在控制台上看），每一段单独编码。
 *
 * 只在 Node 运行时里用。
 */

import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { assetStoreDir, sha256Of, type AssetStore, type StoredAsset } from "@/lib/asset-store";
import { MAX_ASSET_BYTES, extensionForMime, mimeForExtension } from "@/lib/asset-uri";
import { presignUrl, uriEncode, type S3Target } from "@/lib/s3-sigv4";

export const S3_PREFIX = "s3://";
/** 单次请求的超时：上传 200 MB 的素材也要够用 */
const REQUEST_TIMEOUT_MS = 120_000;
/** 列桶一页最多 1000 个（S3 上限） */
const LIST_PAGE_LIMIT = 1000;
const MAX_LIST_PAGES = 100;

export type S3Config = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  sessionToken?: string;
};

export type S3ObjectRef = { bucket: string; key: string };

/** `s3://bucket/key` → 引用；不是这个形状返回 null */
export function s3ObjectRef(uri: string): S3ObjectRef | null {
  if (!uri.startsWith(S3_PREFIX)) return null;
  const rest = uri.slice(S3_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const bucket = rest.slice(0, slash);
  // key 里不允许再出现控制字符；别的都交给编码
  if (/[\u0000-\u001f\u007f]/.test(bucket) || /[\u0000-\u001f\u007f]/.test(rest)) return null;
  return { bucket, key: rest.slice(slash + 1) };
}

export function s3UriOf(bucket: string, key: string): string {
  return `${S3_PREFIX}${bucket}/${key}`;
}

/** 内容寻址的 key：`<prefix>/<前两位>/<sha256>.<ext>`，分两级免得一个目录几十万文件 */
export function s3KeyOf(hash: string, extension: string, prefix = "assets"): string {
  const clean = prefix.replace(/^\/+|\/+$/g, "");
  return clean ? `${clean}/${hash.slice(0, 2)}/${hash}.${extension}` : `${hash.slice(0, 2)}/${hash}.${extension}`;
}

/** key 里最后一段的扩展名 → mime */
function mimeOfKey(key: string): string {
  const extension = key.split(".").pop() ?? "";
  return mimeForExtension(extension);
}

function targetOf(config: S3Config, bucket: string, key: string): S3Target {
  return { endpoint: config.endpoint, bucket, key, pathStyle: config.pathStyle };
}

function signedUrl(
  config: S3Config,
  input: {
    method: "GET" | "PUT" | "DELETE" | "HEAD";
    bucket: string;
    key: string;
    expiresSeconds: number;
    query?: [string, string][];
  },
): string {
  return presignUrl({
    method: input.method,
    target: targetOf(config, input.bucket, input.key),
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    },
    expiresSeconds: input.expiresSeconds,
    ...(input.query ? { query: input.query } : {}),
  });
}

/** 浏览器读素材用的短期地址；调用方决定有效期 */
export function presignedGetUrl(config: S3Config, uri: string, expiresSeconds = 600): string | null {
  const ref = s3ObjectRef(uri);
  if (!ref) return null;
  return signedUrl(config, { method: "GET", ...ref, expiresSeconds });
}

async function request(
  url: string,
  init: RequestInit,
  what: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${what}失败（${response.status}）${body ? `：${body.slice(0, 200)}` : ""}`);
    }
    return response;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${what}超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`);
    throw error instanceof Error ? error : new Error(`${what}失败`);
  } finally {
    clearTimeout(timer);
  }
}

/** 把 XML 里的一小段取出来；S3 的 ListObjectsV2 只需要这几个字段 */
function tagValues(xml: string, tag: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) found.push(decodeXml(match[1]!));
  return found;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export type S3ListEntry = { uri: string; bytes: number; mtimeMs: number };

/** 列桶（ListObjectsV2 分页拉完）；只回我们自己的 `assets/` 前缀 */
export async function listS3Objects(
  config: S3Config,
  options: { prefix?: string; now?: Date } = {},
): Promise<S3ListEntry[]> {
  const prefix = options.prefix ?? "assets/";
  const found: S3ListEntry[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const query: [string, string][] = [
      ["list-type", "2"],
      ["prefix", prefix],
      ["max-keys", String(LIST_PAGE_LIMIT)],
      ...(token ? ([["continuation-token", token]] as [string, string][]) : []),
    ];
    const url = signedUrl(config, {
      method: "GET",
      bucket: config.bucket,
      key: "",
      expiresSeconds: 300,
      query,
    });
    const response = await request(url, { method: "GET" }, "列桶");
    const xml = await response.text();
    const keys = tagValues(xml, "Key");
    const sizes = tagValues(xml, "Size");
    const times = tagValues(xml, "LastModified");
    keys.forEach((key, index) => {
      if (!key || key.endsWith("/")) return;
      const modified = times[index] ? Date.parse(times[index]!) : NaN;
      found.push({
        uri: s3UriOf(config.bucket, key),
        bytes: Number(sizes[index] ?? 0),
        mtimeMs: Number.isFinite(modified) ? modified : 0,
      });
    });
    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
    const next = tagValues(xml, "NextContinuationToken")[0];
    if (!truncated || !next) break;
    token = next;
  }
  return found.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * 上传：先算内容哈希 → key 由哈希决定 → 内容相同就复用。
 *
 * 用 `HEAD` 判存在（省一次上传）。对象存储里同一个 key 一定是同一段字节，
 * 所以「已存在」可以直接当成功，不需要比对内容。
 */
export async function putS3Object(
  config: S3Config,
  input: { bytes: Uint8Array; mime: string; prefix?: string },
): Promise<StoredAsset> {
  if (input.bytes.byteLength === 0) throw new Error("素材是空的");
  if (input.bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error(`素材超过 ${MAX_ASSET_BYTES / 1024 / 1024} MB 上限`);
  }
  const sha256 = sha256Of(input.bytes);
  const extension = extensionForMime(input.mime);
  const key = s3KeyOf(sha256, extension, input.prefix);
  const uri = s3UriOf(config.bucket, key);

  const headUrl = signedUrl(config, {
    method: "HEAD",
    bucket: config.bucket,
    key,
    expiresSeconds: 60,
  });
  const exists = await fetch(headUrl, { method: "HEAD" }).then(
    (response) => response.ok,
    () => false,
  );
  if (!exists) {
    const putUrl = signedUrl(config, {
      method: "PUT",
      bucket: config.bucket,
      key,
      expiresSeconds: 300,
    });
    await request(
      putUrl,
      {
        method: "PUT",
        headers: { "Content-Type": input.mime },
        // `Uint8Array<ArrayBufferLike>` 不被 BodyInit 认；转成真正的 ArrayBuffer 视图
        body: input.bytes.buffer.slice(
          input.bytes.byteOffset,
          input.bytes.byteOffset + input.bytes.byteLength,
        ) as ArrayBuffer,
      },
      "上传素材",
    );
  }
  return { uri, bytes: input.bytes.byteLength, sha256, mime: input.mime };
}

export async function readS3Object(
  config: S3Config,
  uri: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const ref = s3ObjectRef(uri);
  if (!ref) return null;
  try {
    const url = signedUrl(config, { method: "GET", ...ref, expiresSeconds: 60 });
    const response = await request(url, { method: "GET" }, "读素材");
    const buffer = new Uint8Array(await response.arrayBuffer());
    const header = response.headers.get("content-type");
    return {
      bytes: buffer,
      mime: header && header !== "application/octet-stream" ? header.split(";")[0]!.trim() : mimeOfKey(ref.key),
    };
  } catch {
    return null;
  }
}

export async function removeS3Object(config: S3Config, uri: string): Promise<boolean> {
  const ref = s3ObjectRef(uri);
  if (!ref) return false;
  try {
    const url = signedUrl(config, { method: "DELETE", ...ref, expiresSeconds: 60 });
    await request(url, { method: "DELETE" }, "删素材");
    return true;
  } catch {
    return false;
  }
}

/**
 * 把远端素材拉到本机临时目录，给 ffmpeg 用。
 *
 * 渲染与切帧都要求「本地文件路径」，对象存储里的字节得先落盘。
 * 按内容哈希命名、已存在就跳过——同一个 take 渲染两次只下载一次。
 */
export async function materializeS3Object(
  config: S3Config,
  uri: string,
  options: { dir?: string } = {},
): Promise<string | null> {
  const ref = s3ObjectRef(uri);
  if (!ref) return null;
  const extension = ref.key.split(".").pop() ?? "bin";
  const name = `${sha256HexOf(ref.key)}.${extension}`;
  const dir = options.dir ?? path.join(assetStoreDir(), "cache");
  const file = path.join(/* turbopackIgnore: true */ dir, name);
  const existing = await readFile(file).catch(() => null);
  if (existing) return file;

  const read = await readS3Object(config, uri);
  if (!read) return null;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, read.bytes, { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => {});
  await rename(temp, file);
  return file;
}

/** 只是给缓存文件起个稳定名字，不参与签名 */
function sha256HexOf(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0") + Buffer.from(value).toString("hex").slice(0, 24);
}

/** 对象存储的 `AssetStore` 实现：与 `localAssetStore` 同一套接口 */
export function s3AssetStore(config: S3Config, prefix = "assets"): AssetStore {
  return {
    read: (uri) => readS3Object(config, uri),
    put: ({ bytes, mime }) => putS3Object(config, { bytes, mime, prefix }),
    remove: (uri) => removeS3Object(config, uri),
    list: () => listS3Objects(config, { prefix: `${prefix}/` }),
  };
}

/** 给界面看的一句话：不带凭据，只到主机与桶 */
export function describeS3(config: S3Config): string {
  let host = config.endpoint;
  try {
    host = new URL(config.endpoint).host;
  } catch {
    // 地址写错时原样显示，界面会同时给出校验错误
  }
  return `${host} / ${config.bucket} · ${config.region}${config.pathStyle ? " · path-style" : ""}`;
}

export { uriEncode };
