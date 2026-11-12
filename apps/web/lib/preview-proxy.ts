/**
 * 540p 代理视频（E7 / ADR-0127 §3）。
 *
 * 1080p 原片逐帧 seek 会让解码器排队，拖动时卡；预览只需要「看节奏」，
 * 用草稿档同规格的 540 宽代理就够。代理只进 `.loomina/assets/proxies/`，
 * 不进 IR、不算资产、不参与导出——它是可随时删掉重建的缓存。
 *
 * 这一层的纯函数（缓存名、ffmpeg 参数、请求校验）与路由分开，方便单测。
 */

import { isStoredAssetUri } from "@/lib/asset-uri";

/** 代理宽度：与 `RENDER_PROFILES.draft` 的 540 对齐，竖幅就是 540×960 */
export const PROXY_WIDTH = 540;
/** 生成代理的时限：一条 3 秒的片子本地转码通常 1–3 秒，给到 120 秒只可能是卡死 */
export const PROXY_TIMEOUT_MS = 120_000;

/** 能不能为这条素材生成代理：只认资产库（本机或对象存储） */
export function canProxy(uri?: string): boolean {
  return Boolean(uri && (isStoredAssetUri(uri) || uri.startsWith("s3://")));
}

/** 浏览器取代理的地址 */
export function proxyUrlOf(uri: string): string {
  return `/api/preview/proxy?${new URLSearchParams({ asset: uri }).toString()}`;
}

/**
 * 缓存文件名：按**地址**哈希，不按内容。
 *
 * 地址已经带内容哈希（`loomina://` 是 sha256，`s3://` 的 key 也是），
 * 所以同一段字节永远落到同一个文件名；换素材就是换地址、换文件名。
 */
export function proxyCacheName(uri: string, hash: (value: string) => string): string {
  return `${hash(uri.trim())}.${PROXY_WIDTH}.mp4`;
}

export type ProxyRequestResult = { ok: true; asset: string } | { ok: false; error: string };

/**
 * 解析浏览器的 `Range: bytes=…`，取第一段。
 *
 * 视频拖动时浏览器不会整段下载，只问要的那几 KB；不支持 Range 会让它
 * 反复从头拉，代理就白省了解码。末尾开区间按 RFC 9110 处理。
 */
export function proxyRangeOf(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)/.exec(header.trim());
  if (!match) return null;
  const first = match[1] ?? "";
  const last = match[2] ?? "";
  if (!first && !last) return null;
  let start: number;
  let end: number;
  if (!first) {
    const suffix = Number(last);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - Math.floor(suffix));
    end = size - 1;
  } else {
    start = Number(first);
    end = last ? Number(last) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start >= size || start > end) return null;
    end = Math.min(end, size - 1);
  }
  return { start: Math.floor(start), end: Math.floor(end) };
}

export function parseProxyRequest(params: URLSearchParams): ProxyRequestResult {
  const asset = params.get("asset")?.trim() ?? "";
  if (!asset) return { ok: false, error: "没给素材地址" };
  if (!canProxy(asset)) {
    return { ok: false, error: "代理只认资产库里的片子：先把素材迁进资产库" };
  }
  return { ok: true, asset };
}

/**
 * 生成代理的 ffmpeg 参数。
 *
 * - 宽定 540、高按比例取偶数；
 * - 24fps 与草稿档一致，转码更快、拖动更轻；
 * - `-an`：预演本来就把 `<video>` 静音，声音走单独的台词音轨；
 * - ultrafast / crf 30：代理只服务眼睛，不值得多花 CPU；
 * - `+faststart`：让浏览器拿到元数据就能起播。
 */
export function proxyArgsOf(input: { src: string; out: string }): string[] {
  return [
    "-v",
    "error",
    "-y",
    "-i",
    input.src,
    "-vf",
    `scale=${PROXY_WIDTH}:-2`,
    "-r",
    "24",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "30",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    input.out,
  ];
}
