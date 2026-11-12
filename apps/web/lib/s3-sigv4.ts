/**
 * AWS Signature Version 4 预签名（H3 / ADR-0128 §3 / ADR-0129 §3）。
 *
 * 只做一件事：把一个对象地址变成一条**带签名的 URL**。不做对象模型、不做分片、
 * 不做重试——那些是 SDK 的活，这里不需要。签名规则是冻结的，所以这几十行
 * 可以对着 AWS 官方测试向量逐项锁死（见 `s3-sigv4.test.ts`）。
 *
 * 只跑在服务端：用了 `node:crypto`。浏览器永远拿不到密钥，也拿不到签名函数。
 *
 * 规范里最容易错的三处，这里都单独成函数：
 *   1. URI 编码（`~` 不编码、`/` 看场合、大写十六进制）；
 *   2. 查询串排序（先按键、再按值，**按编码后**的字符串排）；
 *   3. 空载荷用 `UNSIGNED-PAYLOAD` 而不是空串的 sha256——预签名 URL 的载荷
 *      不在签名里，浏览器上传时才能直接 PUT 字节。
 */

import { createHash, createHmac } from "node:crypto";

export const SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";
/** 预签名 URL 的载荷哈希：字节在签名时还不存在，S3 认这个值 */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const MIN_EXPIRES_SECONDS = 1;
/** 规范上限：7 天。再长就是长期凭据了，不该出现在 IR 里 */
export const MAX_EXPIRES_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_EXPIRES_SECONDS = 10 * 60;

export type SigV4Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  /** 临时凭据才需要；有它就得进查询串，否则签名对不上 */
  sessionToken?: string;
};

export type S3Target = {
  /** `https://s3.us-east-1.amazonaws.com` 或 `http://127.0.0.1:9000`，不带结尾斜杠 */
  endpoint: string;
  bucket: string;
  /** 原始 key（未编码）。列桶时为空串 */
  key: string;
  /**
   * path-style（`host/bucket/key`）还是 virtual-hosted（`bucket.host/key`）。
   * AWS 两种都认；MinIO 与自建网关只认 path-style。
   */
  pathStyle: boolean;
};

export type PresignInput = {
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  target: S3Target;
  region: string;
  credentials: SigV4Credentials;
  /** 1 秒到 7 天；越界直接报错，不悄悄夹取 */
  expiresSeconds?: number;
  now?: Date;
  service?: string;
  /** 额外查询参数（`list-type=2`、`prefix=…`）；不许带 `X-Amz-` 前缀 */
  query?: [string, string][];
  /** 默认 `UNSIGNED-PAYLOAD`；只有服务端已知字节时才传真实哈希 */
  payloadHash?: string;
};

/**
 * AWS 的 URI 编码。
 *
 * 只保留 `A-Z a-z 0-9 - _ . ~`，其余按 UTF-8 字节写成 `%XX`（大写）。
 * 注意 `~` 不在 RFC 3986 的保留集里，但 AWS 明确不编码它；空格是 `%20` 不是 `+`。
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    if (
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      char === "-" ||
      char === "_" ||
      char === "." ||
      char === "~"
    ) {
      encoded += char;
    } else if (char === "/" && !encodeSlash) {
      encoded += char;
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return encoded;
}

/** `2026-11-12T10:00:00.000Z` → `20261112T100000Z` + `20261112` */
export function amzDateOf(date: Date): { amzDate: string; dateStamp: string } {
  const amzDate = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** 规范化查询串：先编码，再按键、按值排序 */
export function canonicalQueryString(params: [string, string][]): string {
  return params
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as [string, string])
    .sort((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 头值规范化：去首尾空白，中间连续空白压成一个空格 */
function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export type CanonicalRequestInput = {
  method: string;
  /** 原始路径（未编码），例如 `/test$file.text`；由本函数编码 */
  path: string;
  query: [string, string][];
  /** 头名大小写不敏感；只有进 SignedHeaders 的才写进来 */
  headers: Record<string, string>;
  payloadHash: string;
};

/** 规范化请求：签名四步里的第一步，也是最容易写错的一步 */
export function canonicalRequest(input: CanonicalRequestInput): string {
  const names = Object.keys(input.headers)
    .map((name) => name.toLowerCase())
    .sort(compare);
  const headers = names
    .map((name) => {
      const key = Object.keys(input.headers).find((item) => item.toLowerCase() === name)!;
      return `${name}:${canonicalHeaderValue(input.headers[key]!)}\n`;
    })
    .join("");
  return [
    input.method.toUpperCase(),
    uriEncode(input.path, false),
    canonicalQueryString(input.query),
    headers,
    names.join(";"),
    input.payloadHash,
  ].join("\n");
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function stringToSign(input: {
  amzDate: string;
  scope: string;
  canonicalRequest: string;
}): string {
  return [
    SIGV4_ALGORITHM,
    input.amzDate,
    input.scope,
    sha256Hex(input.canonicalRequest),
  ].join("\n");
}

/**
 * 派生签名密钥：`AWS4+SK` → 日期 → 区域 → 服务 → `aws4_request`。
 *
 * 四层 HMAC 的意义是「同一把 SK 在不同区域 / 服务下派生出不同的密钥」，
 * 漏一层不会报错，只会让签名对不上——所以这里逐层写清。
 */
export function signingKey(input: {
  secretAccessKey: string;
  dateStamp: string;
  region: string;
  service: string;
}): Buffer {
  let key = createHmac("sha256", `AWS4${input.secretAccessKey}`)
    .update(input.dateStamp, "utf8")
    .digest();
  for (const part of [input.region, input.service, "aws4_request"]) {
    key = createHmac("sha256", key).update(part, "utf8").digest();
  }
  return key;
}

export function signatureOf(input: {
  secretAccessKey: string;
  dateStamp: string;
  region: string;
  service: string;
  stringToSign: string;
}): string {
  return createHmac("sha256", signingKey(input))
    .update(input.stringToSign, "utf8")
    .digest("hex");
}

/**
 * 对象地址：只拼 scheme / host / path，不带查询串。
 *
 * 同时返回**原始路径**与**编码后路径**：前者进规范化请求（`canonicalRequest`
 * 自己会编码一次），后者进 URL。两者混用会双重编码——中文 key 会变成
 * `%25E4…`，服务端算出来的签名对不上，直接 403。
 */
export function objectUrlOf(target: S3Target): { url: string; path: string; encodedPath: string } {
  const endpoint = new URL(target.endpoint);
  const host = endpoint.host;
  const basePath = endpoint.pathname.replace(/\/+$/, "");
  const rawKeyPath = target.key ? `/${target.key}` : "";
  const encodedKeyPath = target.key
    ? `/${target.key.split("/").map((part) => uriEncode(part)).join("/")}`
    : "";
  if (target.pathStyle) {
    return {
      url: `${endpoint.protocol}//${host}${basePath}/${target.bucket}${encodedKeyPath}`,
      path: `${basePath}/${target.bucket}${rawKeyPath}`,
      encodedPath: `${basePath}/${target.bucket}${encodedKeyPath}`,
    };
  }
  return {
    url: `${endpoint.protocol}//${target.bucket}.${host}${basePath}${encodedKeyPath || "/"}`,
    path: `${basePath}${rawKeyPath || "/"}`,
    encodedPath: `${basePath}${encodedKeyPath || "/"}`,
  };
}

/** 预签名：把地址、凭据、有效期拼成一条可以直接给浏览器用的 URL */
export function presignUrl(input: PresignInput): string {
  const expires = input.expiresSeconds ?? DEFAULT_EXPIRES_SECONDS;
  if (!Number.isInteger(expires) || expires < MIN_EXPIRES_SECONDS || expires > MAX_EXPIRES_SECONDS) {
    throw new Error(
      `预签名有效期必须是 ${MIN_EXPIRES_SECONDS} 秒到 ${MAX_EXPIRES_SECONDS / 86400} 天之间的整数`,
    );
  }
  if (!input.target.bucket) throw new Error("缺少 bucket");
  if (!input.credentials.accessKeyId || !input.credentials.secretAccessKey) {
    throw new Error("缺少 Access Key / Secret Key");
  }

  const service = input.service ?? "s3";
  const { amzDate, dateStamp } = amzDateOf(input.now ?? new Date());
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const { url, path } = objectUrlOf(input.target);
  const host = new URL(url).host;
  const extra = input.query ?? [];
  if (extra.some(([name]) => name.toLowerCase().startsWith("x-amz-"))) {
    throw new Error("额外查询参数不能带 X-Amz- 前缀：那是签名自己的字段");
  }

  const query: [string, string][] = [
    ["X-Amz-Algorithm", SIGV4_ALGORITHM],
    ["X-Amz-Credential", `${input.credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", "host"],
    ...(input.credentials.sessionToken
      ? ([["X-Amz-Security-Token", input.credentials.sessionToken]] as [string, string][])
      : []),
    ...extra,
  ];

  const signature = signatureOf({
    secretAccessKey: input.credentials.secretAccessKey,
    dateStamp,
    region: input.region,
    service,
    stringToSign: stringToSign({
      amzDate,
      scope,
      canonicalRequest: canonicalRequest({
        method: input.method,
        path,
        query,
        headers: { host },
        payloadHash: input.payloadHash ?? UNSIGNED_PAYLOAD,
      }),
    }),
  });

  return `${url}?${canonicalQueryString(query)}&X-Amz-Signature=${signature}`;
}
