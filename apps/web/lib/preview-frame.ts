/**
 * 帧级找点（E7.2 / ADR-0129）。
 *
 * E7.1 的拖动只能到镜准确、镜内近似：`<video>` 只能从最近的关键帧之后解码。
 * 这一层把「第几毫秒」交给服务端的 ffmpeg 精确切帧，浏览器只拿一张 JPEG。
 *
 * 这里的函数都是纯的（`probeFrameCapability` 除外，它发一次探测请求），
 * 换算、节流与探测都能单测。
 */

import { isStoredAssetUri } from "@/lib/asset-uri";

/** 切出来的帧宽（像素）：预演框最高 620px，9:16 就是 350 宽 */
export const FRAME_WIDTH = 360;
/** 拖动时两次切帧至少隔 60ms：约每秒 16 张，够跟手又不会把 ffmpeg 排满 */
export const FRAME_THROTTLE_MS = 60;
/** 上限留到封面出图（1080）：预演默认仍只取 360，大图只在封面那条路用 */
/** 逐帧步进的一步：源片帧率不进 IR，按渲染用的 30fps 估 */
export const FRAME_STEP_MS = 33;
export const FRAME_MIN_WIDTH = 120;
export const FRAME_MAX_WIDTH = 1080;
/** 探测结果缓存 5 分钟：ffmpeg 装没装不会在一分钟内变 */
export const FRAME_PROBE_TTL_MS = 5 * 60 * 1000;

/** 服务端 ffmpeg 能不能切帧。切不了就退回 E7.1，并且如实说明原因 */
export type FrameCapability =
  | { tier: "frame"; ffmpeg: string }
  | { tier: "approx"; reason: string };

export function clampFrameWidth(width: number): number {
  if (!Number.isFinite(width)) return FRAME_WIDTH;
  return Math.min(FRAME_MAX_WIDTH, Math.max(FRAME_MIN_WIDTH, Math.round(width)));
}

/**
 * 取整到毫秒并夹在 `[0, maxMs]`。
 * 没有 `maxMs` 时只保证非负——片长在服务端由 ffmpeg 自己判断。
 */
export function frameMs(atMs: number, maxMs?: number): number {
  const value = Number.isFinite(atMs) ? Math.max(0, Math.round(atMs)) : 0;
  if (maxMs === undefined || !Number.isFinite(maxMs)) return value;
  return Math.min(value, Math.max(0, Math.round(maxMs)));
}

/** 第 `atMs` 毫秒的切帧地址 */
export function frameUrlOf(uri: string, atMs: number, width = FRAME_WIDTH): string {
  const params = new URLSearchParams({
    asset: uri,
    at: String(frameMs(atMs)),
    w: String(clampFrameWidth(width)),
  });
  return `/api/preview/frame?${params.toString()}`;
}

/** 去重用的键：同一处只切一次 */
export function frameKeyOf(uri: string, atMs: number): string {
  return `${uri}@${frameMs(atMs)}`;
}

/**
 * 上一帧 / 下一帧。夹在 `[0, maxMs]` 里，不会退到上一镜。
 * 一步是 `FRAME_STEP_MS`（33ms），源片不是 30fps 时步进只是近似。
 */
export function stepFrame(
  atMs: number,
  direction: -1 | 1,
  maxMs?: number,
  stepMs = FRAME_STEP_MS,
): number {
  const base = frameMs(atMs, maxMs);
  return frameMs(base + direction * Math.max(1, Math.round(stepMs)), maxMs);
}

/**
 * 能不能对这一镜切帧。
 *
 * 只认资产库里的片子：`loomina://`（本机）与 `s3://`（对象存储）。
 * `data:` 的片子有几十 MB，塞不进查询串，而且它本来就该先迁进资产库
 * （H3 / ADR-0128）；`https://` 要另开一条受控下载的路。
 */
export function canPreviewFrames(uri?: string): boolean {
  return Boolean(uri && (isStoredAssetUri(uri) || uri.startsWith("s3://")));
}

export type FrameThrottle = {
  /** 要第 `key` 处的帧；60ms 内多次调用只发最后一次 */
  request(key: string, fire: () => void): void;
  cancel(): void;
  /** 忘掉上一次发出去的键：请求失败后允许重试同一处 */
  forget(): void;
};

type TimerHandle = unknown;

/**
 * 拖动节流：立刻发第一次，之后 60ms 内的请求合并成一次（尾随）。
 *
 * 不合并的话，一次拖动会发出上百个 ffmpeg 进程；合并之后最坏情况
 * 是每秒 16 次，而人眼在拖动时看不出差别。
 */
export function createFrameThrottle(
  options: {
    throttleMs?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => TimerHandle;
    clearTimer?: (handle: TimerHandle) => void;
  } = {},
): FrameThrottle {
  const throttleMs = options.throttleMs ?? FRAME_THROTTLE_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: TimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let lastKey: string | undefined;
  let lastAt = Number.NEGATIVE_INFINITY;
  let timer: TimerHandle | undefined;
  let pending: { key: string; fire: () => void } | undefined;

  const flush = () => {
    timer = undefined;
    const job = pending;
    pending = undefined;
    if (!job) return;
    lastKey = job.key;
    lastAt = now();
    job.fire();
  };

  return {
    request(key, fire) {
      if (key === lastKey) return;
      pending = { key, fire };
      if (timer !== undefined) return;
      const wait = Math.max(0, throttleMs - (now() - lastAt));
      if (wait === 0) {
        flush();
        return;
      }
      timer = setTimer(flush, wait);
    },
    cancel() {
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
      pending = undefined;
    },
    forget() {
      lastKey = undefined;
      lastAt = Number.NEGATIVE_INFINITY;
    },
  };
}

/** 能切到的最晚时刻：一小时。再往后多半是查询串算错了，不是真要找点 */
export const FRAME_MAX_AT_MS = 60 * 60 * 1000;

export type FrameRequest = { asset: string; atMs: number; width: number };

export type FrameRequestResult =
  | { ok: true; value: FrameRequest }
  | { ok: false; error: string };

/**
 * 校验切帧请求。地址只认资产库（`loomina://` 本机、`s3://` 对象存储）：
 * `data:` 有几十 MB，塞不进查询串；远端地址要另开一条受控下载的路
 * （渲染路由已经有，不在这一层重复）。
 */
export function parseFrameRequest(params: URLSearchParams): FrameRequestResult {
  const asset = params.get("asset")?.trim() ?? "";
  if (!asset) return { ok: false, error: "没给素材地址" };
  if (!canPreviewFrames(asset)) {
    return { ok: false, error: "帧级找点只认资产库里的片子：先把素材迁进资产库" };
  }
  const rawAt = params.get("at");
  if (rawAt === null || rawAt.trim() === "") return { ok: false, error: "没给要找的时刻" };
  const at = Number(rawAt);
  if (!Number.isFinite(at) || at < 0) return { ok: false, error: "时刻得是 0 或正数（毫秒）" };
  if (at > FRAME_MAX_AT_MS) {
    return { ok: false, error: `时刻超过 ${FRAME_MAX_AT_MS / 60000} 分钟：多半是算错了` };
  }
  const rawWidth = params.get("w");
  const width = rawWidth === null || rawWidth.trim() === "" ? FRAME_WIDTH : Number(rawWidth);
  if (!Number.isFinite(width)) return { ok: false, error: "宽度得是数字" };
  return { ok: true, value: { asset, atMs: Math.round(at), width: clampFrameWidth(width) } };
}

/**
 * ffmpeg 切一帧的参数。
 *
 * `-ss` 放在 `-i` 之前：现代 ffmpeg 会先按索引跳到附近再解码丢弃，
 * 结果仍然是**精确到帧**的，比放在后面快得多。
 * 输出走管道（`-`），不落临时文件——一帧 60–120 KB，直接进内存。
 */
export function frameArgsOf(input: { src: string; atMs: number; width: number }): string[] {
  const width = clampFrameWidth(input.width);
  return [
    "-v",
    "error",
    "-ss",
    (frameMs(input.atMs) / 1000).toFixed(3),
    "-i",
    input.src,
    "-frames:v",
    "1",
    "-an",
    "-sn",
    "-dn",
    // 宽定死、高按比例取偶数（mjpeg 不接受奇数高度）
    "-vf",
    `scale=${width}:-2`,
    "-f",
    "image2",
    "-vcodec",
    "mjpeg",
    "-q:v",
    "4",
    "pipe:1",
  ];
}

let probeCache: { at: number; value: FrameCapability } | undefined;

/** 测试用：清掉探测缓存 */
export function resetFrameProbeForTests(): void {
  probeCache = undefined;
}

/**
 * 问一次服务端能不能切帧。结果在进程里缓存 5 分钟，
 * 预演反复开关不会每次都问。
 */
export async function probeFrameCapability(
  options: {
    force?: boolean;
    now?: number;
    fetcher?: typeof fetch;
  } = {},
): Promise<FrameCapability> {
  const at = options.now ?? Date.now();
  if (!options.force && probeCache && at - probeCache.at < FRAME_PROBE_TTL_MS) {
    return probeCache.value;
  }
  const fetcher = options.fetcher ?? fetch;
  let value: FrameCapability;
  try {
    const response = await fetcher("/api/preview/frame?probe=1", { cache: "no-store" });
    const body = (await response.json()) as {
      tier?: unknown;
      ffmpeg?: unknown;
      reason?: unknown;
    };
    value =
      body.tier === "frame"
        ? { tier: "frame", ffmpeg: typeof body.ffmpeg === "string" ? body.ffmpeg : "" }
        : {
            tier: "approx",
            reason:
              typeof body.reason === "string" && body.reason
                ? body.reason
                : "这台机器切不了帧，先用时间轴近似",
          };
  } catch {
    value = { tier: "approx", reason: "问不到切帧服务，先用时间轴近似" };
  }
  probeCache = { at, value };
  return value;
}
