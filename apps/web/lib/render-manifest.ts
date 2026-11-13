/**
 * 成片 mp4 的渲染清单（E6）。
 *
 * 浏览器负责「把字幕、占位图与角标画成透明 PNG」——这台机器的 ffmpeg 没编进
 * drawtext / subtitles 滤镜，中文只能先在 canvas 里排好再交给 ffmpeg 叠加。
 * 服务端只做校验、拼滤镜与编码，不信任客户端给的尺寸与时长。
 */

import {
  DEFAULT_FRAME,
  DEFAULT_GRADE,
  FrameSchema,
  GradeSchema,
  ShotFocusSchema,
  TRANSITION_KINDS,
  type Frame,
  type FrameAspect,
  type Grade,
  type ShotFocus,
  type TransitionKind,
} from "@loomina/ir";
import {
  S3_PREFIX,
  isRemoteAssetUri,
  isStoredAssetUri,
  mimeForExtension,
  storedAssetRef,
} from "./asset-uri";
import { scanText, type RenderCompliance } from "./compliance";
import { aiContentHashOf, materialOfManifest } from "./ai-label";
import { isDefaultFrame } from "./render-effects";

/** 输出档位（H13）：草稿先看节奏，定稿才交付。 */
export type RenderQuality = "draft" | "final";

export const RENDER_PROFILES: Record<
  RenderQuality,
  {
    label: string;
    width: number;
    height: number;
    fps: number;
    crf: number;
    preset: string;
    audioBitrate: string;
  }
> = {
  draft: {
    label: "草稿",
    width: 540,
    height: 960,
    fps: 24,
    crf: 30,
    preset: "ultrafast",
    audioBitrate: "96k",
  },
  final: {
    label: "定稿",
    width: 1080,
    height: 1920,
    fps: 30,
    crf: 20,
    preset: "veryfast",
    audioBitrate: "128k",
  },
};

/**
 * 各画幅的成片尺寸（E5 / ADR-0170）。
 *
 * 短边固定：草稿 540、定稿 1080。横屏把长边摊到宽上，方形两边相等。
 * 短边固定而不是长边固定，是为了让「换画幅」只改形状、不改清晰度——
 * 定稿永远短边 1080，各平台对短边有要求（G7 的 720 下限）。
 */
export const FRAME_SIZES: Record<
  RenderQuality,
  Record<FrameAspect, { width: number; height: number }>
> = {
  draft: {
    "9:16": { width: 540, height: 960 },
    "16:9": { width: 960, height: 540 },
    "1:1": { width: 540, height: 540 },
  },
  final: {
    "9:16": { width: 1080, height: 1920 },
    "16:9": { width: 1920, height: 1080 },
    "1:1": { width: 1080, height: 1080 },
  },
};

export function frameSize(
  quality: RenderQuality,
  aspect: FrameAspect,
): { width: number; height: number } {
  return FRAME_SIZES[quality][aspect];
}

/** 定稿尺寸：旧调用方与平台规格仍按 1080×1920 写 */
export const RENDER_WIDTH = RENDER_PROFILES.final.width;
export const RENDER_HEIGHT = RENDER_PROFILES.final.height;
export const RENDER_FPS = RENDER_PROFILES.final.fps;
/** 单条成片上限：与 MVP 的 60–180 秒体量一致 */
export const RENDER_MAX_MS = 180_000;
export const RENDER_MAX_CLIPS = 60;
export const RENDER_MAX_OVERLAYS = 120;
export const RENDER_MAX_AUDIO = 120;
/** 单个 media 的上限（解码后的字节数） */
export const RENDER_MAX_ASSET_BYTES = 30 * 1024 * 1024;
/** 整份请求的上限，避免一次渲染把内存与临时盘顶满 */
export const RENDER_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export type RenderClip = {
  durationMs: number;
  /** data:video/... 或 data:image/...；两者都没有就是 remote / 占位 */
  media?: string;
  mediaKind?: "video" | "image";
  /** 受控下载的远端素材；域名必须在 RENDER_ALLOWED_HOSTS 里 */
  remote?: string;
  /** 远端被跳过时用的静态图（data:image/…） */
  fallback?: string;
  /** 这一段的画面本身就是占位图，不是真实素材 */
  placeholder?: boolean;
  /** 占位图的文案，例如「SH-01 还没有画面」 */
  label?: string;
  /**
   * 接缝上的淡入（E4 / ADR-0169）：从这一段开头淡进来。
   * 不改变时长——上一段在这里已经结束，两段不重叠。
   */
  fadeIn?: RenderFade;
  /** 接缝上的淡出：到这一段末尾淡出去 */
  fadeOut?: RenderFade;
  /**
   * 裁切时留住画面的哪一点（E5 / ADR-0170）。只在 `frame.fit === "crop"` 时有意义；
   * 不写就是居中。
   */
  focus?: ShotFocus;
};

/** 一次淡入 / 淡出：多久、淡到什么颜色 */
export type RenderFade = {
  durationMs: number;
  kind: TransitionKind;
};

export type RenderOverlay = {
  /** data:image/png;base64,... 透明全画幅 */
  image: string;
  startMs: number;
  endMs: number;
};

export type RenderAudio = {
  /** data:audio/... */
  audio?: string;
  /** 受控下载的远端音轨；域名同样走白名单 */
  remote?: string;
  startMs: number;
  /** 这一句多长；ducking 的时间窗靠它，不知道就不压 */
  durationMs?: number;
};

/** 配乐床（C4 / C12）：音乐在台词下按 duckDb 自动压低 */
export type RenderMusic = {
  /** data:audio/... */
  audio?: string;
  /** 受控下载的远端音轨；域名同样走白名单 */
  remote?: string;
  startMs: number;
  endMs: number;
  gainDb: number;
  duckDb: number;
  ducking: boolean;
  loop: boolean;
};

export type RenderManifest = {
  title: string;
  /** 草稿 / 定稿（H13）：决定分辨率、帧率与编码档位 */
  quality: RenderQuality;
  width: number;
  height: number;
  fps: number;
  totalMs: number;
  clips: RenderClip[];
  overlays: RenderOverlay[];
  audio: RenderAudio[];
  music: RenderMusic[];
  /**
   * AI 标识（H5 / ADR-0138）：显式与隐式必须同时为真，
   * `contentHash` 是这一版剪辑的指纹，服务端会重算一遍再比对。
   */
  aiLabel: {
    explicit: true;
    implicit: true;
    standard: "AI生成";
    version: 1;
    contentHash: string;
  };
  /** 成片页的合规预检证据（G8）；服务端会再扫一遍清单文案 */
  compliance: RenderCompliance;
  /**
   * 调色（E4 / ADR-0169）：作用在拼好的画面上、字幕与角标之前。
   * 不传就是不调色，成片与以前的渲染逐字节同构。
   */
  grade?: Grade;
  /**
   * 画幅与适配（E5 / ADR-0170）：不传就是 9:16 + 留边，
   * 与以前的渲染逐字节同构。
   */
  frame?: Frame;
};

export type DataUriParts = { mime: string; base64: string; bytes: number };

const DATA_URI = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

export function parseDataUri(uri: string): DataUriParts | null {
  const match = DATA_URI.exec(uri.trim());
  if (!match) return null;
  const base64 = match[2]!.replace(/\s+/g, "");
  // 4 个 base64 字符 = 3 字节；末尾的 = 要扣掉
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return {
    mime: match[1]!.toLowerCase(),
    base64,
    bytes: Math.floor((base64.length * 3) / 4) - padding,
  };
}

export function isVideoMime(mime: string): boolean {
  return ["video/mp4", "video/webm", "video/quicktime"].includes(mime);
}

export function isImageMime(mime: string): boolean {
  return ["image/png", "image/jpeg", "image/webp"].includes(mime);
}

export function isAudioMime(mime: string): boolean {
  return [
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/wav",
    "audio/x-wav",
    "audio/ogg",
    "audio/webm",
  ].includes(mime);
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function assetBytes(uri: string): number {
  return parseDataUri(uri)?.bytes ?? 0;
}

/**
 * 一段的淡入 / 淡出（E4）。
 *
 * 转场是画面事实，不合法就拒收而不是悄悄丢掉：作者设了淡到黑、成片却是硬切，
 * 这种「看着成功其实不一样」比一次失败更难发现。
 * 单侧不能超过这一段的一半——两侧加起来会超过整段时长，画面就一直在淡。
 */
function fadeOf(
  value: unknown,
  key: "fadeIn" | "fadeOut",
  index: number,
  durationMs: number,
): { fadeIn?: RenderFade } | { fadeOut?: RenderFade } | { error: string } {
  if (value === undefined) return {};
  const fade = value as Record<string, unknown> | null;
  const label = `第 ${index + 1} 段的${key === "fadeIn" ? "淡入" : "淡出"}`;
  if (!fade || typeof fade !== "object") return { error: `${label}不是对象` };
  if (!(TRANSITION_KINDS as readonly string[]).includes(String(fade.kind))) {
    return { error: `${label}颜色不合法` };
  }
  if (!integer(fade.durationMs) || fade.durationMs < 100 || fade.durationMs > durationMs / 2) {
    return { error: `${label}时长不合法（100ms 到这一段的一半）` };
  }
  const parsed: RenderFade = {
    durationMs: fade.durationMs,
    kind: fade.kind as TransitionKind,
  };
  return key === "fadeIn" ? { fadeIn: parsed } : { fadeOut: parsed };
}

/**
 * 画幅（E5）：整块按 `FrameSchema` 解析，不合法就拒收。
 * 不传就是 9:16 + 留边——旧客户端送来的清单没有这个字段，行为与以前一致。
 */
function frameOf(value: unknown): { frame: Frame } | { error: string } {
  if (value === undefined) return { frame: DEFAULT_FRAME };
  const parsed = FrameSchema.safeParse(value);
  if (!parsed.success) {
    return { error: `画幅不合法：${parsed.error.issues[0]?.message ?? "未知原因"}` };
  }
  return { frame: parsed.data };
}

/**
 * 裁切焦点（E5）：0–1 之外的值会把裁切框整个推到画面外。
 * 不传就是居中；`fit` 不是裁切时也照收，换回来时焦点还在。
 */
function focusOf(value: unknown, index: number): { focus?: ShotFocus } | { error: string } {
  if (value === undefined) return {};
  const parsed = ShotFocusSchema.safeParse(value);
  if (!parsed.success) {
    return { error: `第 ${index + 1} 段的裁切焦点不合法` };
  }
  return { focus: parsed.data };
}

/**
 * 调色（E4）：整块按 `GradeSchema` 解析，不合法就拒收。
 * 不传就是不调色——旧客户端送来的清单没有这个字段，行为与以前一致。
 */
function gradeOf(value: unknown): { grade?: Grade } | { error: string } {
  if (value === undefined) return {};
  const parsed = GradeSchema.safeParse(value);
  if (!parsed.success) {
    return { error: `调色不合法：${parsed.error.issues[0]?.message ?? "未知原因"}` };
  }
  return { grade: parsed.data };
}

/**
 * 素材地址的 mime 与请求体积（H3 / ADR-0128）。
 *
 * - `data:` URI：mime 与解码后字节数都在地址里；
 * - `loomina://assets/…`：mime 由扩展名反推，**请求体积记 0**——
 *   字节已经在本机资产库里，清单里只有一行地址，渲染路由直接读盘。
 */
export function inspectAsset(uri: string): { mime: string; bytes: number } | null {
  const parts = parseDataUri(uri);
  if (parts) return { mime: parts.mime, bytes: parts.bytes };
  const ref = storedAssetRef(uri);
  if (ref) return { mime: mimeForExtension(ref.extension), bytes: 0 };
  // 对象存储（H3）：mime 由 key 的扩展名反推，字节也不在请求里
  if (isRemoteAssetUri(uri)) {
    const key = uri.trim().slice(S3_PREFIX.length);
    const extension = key.split(".").pop() ?? "";
    return extension ? { mime: mimeForExtension(extension), bytes: 0 } : null;
  }
  return null;
}

/** 地址是不是「渲染路由能读到的素材」：data URI、本机资产库或对象存储 */
export function isReadableAsset(uri: string): boolean {
  return inspectAsset(uri) !== null;
}

export { isStoredAssetUri };

/**
 * 校验客户端送来的清单。返回人话错误，路由直接回 400。
 *
 * 这里刻意不自动「修」清单：缺口、超长、非 data URI 都要用户知道为什么会失败，
 * 悄悄补一帧或截一段会让导出的片子与时间线对不上。
 */
export function validateRenderManifest(
  input: unknown,
): { ok: true; manifest: RenderManifest } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "清单不是对象" };
  const raw = input as Record<string, unknown>;

  if (typeof raw.title !== "string" || !raw.title.trim()) {
    return { ok: false, error: "缺少标题" };
  }
  const quality: RenderQuality = raw.quality === "draft" ? "draft" : "final";
  const profile = RENDER_PROFILES[quality];
  const frameResult = frameOf(raw.frame);
  if ("error" in frameResult) return { ok: false, error: frameResult.error };
  const frame = frameResult.frame;
  const size = frameSize(quality, frame.aspect);
  if (raw.width !== size.width || raw.height !== size.height) {
    return {
      ok: false,
      error: `${profile.label}${frame.aspect}只支持 ${size.width}×${size.height}`,
    };
  }
  if (raw.fps !== profile.fps) {
    return { ok: false, error: `${profile.label}只支持 ${profile.fps}fps` };
  }
  if (!integer(raw.totalMs) || raw.totalMs < 300 || raw.totalMs > RENDER_MAX_MS) {
    return { ok: false, error: `全长必须在 0.3–${RENDER_MAX_MS / 1000} 秒之间` };
  }

  const clips = raw.clips;
  if (!Array.isArray(clips) || clips.length === 0) {
    return { ok: false, error: "时间线里没有片段" };
  }
  if (clips.length > RENDER_MAX_CLIPS) {
    return { ok: false, error: `片段最多 ${RENDER_MAX_CLIPS} 个` };
  }

  let cursor = 0;
  const checkedClips: RenderClip[] = [];
  for (const [index, item] of clips.entries()) {
    if (!item || typeof item !== "object") return { ok: false, error: `第 ${index + 1} 段不是对象` };
    const clip = item as Record<string, unknown>;
    if (!integer(clip.durationMs) || clip.durationMs < 100) {
      return { ok: false, error: `第 ${index + 1} 段时长不合法` };
    }
    if (cursor + clip.durationMs > RENDER_MAX_MS) {
      return { ok: false, error: `第 ${index + 1} 段超出全长上限` };
    }
    const kind = clip.mediaKind === "video" ? "video" : clip.mediaKind === "image" ? "image" : null;
    if (!kind) return { ok: false, error: `第 ${index + 1} 段缺少 mediaKind` };

    const remote = typeof clip.remote === "string" ? clip.remote.trim() : "";
    if (remote && !isHttpUrl(remote)) {
      return { ok: false, error: `第 ${index + 1} 段的远端地址不是 http(s)` };
    }
    if (remote && remote.length > 2048) {
      return { ok: false, error: `第 ${index + 1} 段的远端地址太长` };
    }
    if (remote && !clip.fallback) {
      return { ok: false, error: `第 ${index + 1} 段的远端素材需要一张兜底图` };
    }
    if (typeof clip.fallback === "string") {
      const fallback = inspectAsset(clip.fallback);
      if (!fallback || !isImageMime(fallback.mime)) {
        return { ok: false, error: `第 ${index + 1} 段的兜底图必须是图片` };
      }
      if (fallback.bytes > RENDER_MAX_ASSET_BYTES) {
        return { ok: false, error: `第 ${index + 1} 段的兜底图超过 30 MB` };
      }
    }

    if (clip.media !== undefined) {
      if (typeof clip.media !== "string") return { ok: false, error: "媒体不是字符串" };
      const parts = inspectAsset(clip.media);
      if (!parts) {
        return { ok: false, error: `第 ${index + 1} 段的媒体不是可读素材（data URI 或本机资产库）` };
      }
      if (parts.bytes > RENDER_MAX_ASSET_BYTES) {
        return { ok: false, error: `第 ${index + 1} 段的媒体超过 30 MB` };
      }
      if (kind === "video" && !isVideoMime(parts.mime)) {
        return { ok: false, error: `第 ${index + 1} 段标成视频但不是视频格式` };
      }
      if (kind === "image" && !isImageMime(parts.mime)) {
        return { ok: false, error: `第 ${index + 1} 段标成图片但不是图片格式` };
      }
    } else if (!remote) {
      return { ok: false, error: `第 ${index + 1} 段既没有媒体也没有远端地址` };
    }

    const fadeIn = fadeOf(clip.fadeIn, "fadeIn", index, clip.durationMs);
    if ("error" in fadeIn) return { ok: false, error: fadeIn.error };
    const fadeOut = fadeOf(clip.fadeOut, "fadeOut", index, clip.durationMs);
    if ("error" in fadeOut) return { ok: false, error: fadeOut.error };
    const focus = focusOf(clip.focus, index);
    if ("error" in focus) return { ok: false, error: focus.error };

    checkedClips.push({
      durationMs: clip.durationMs,
      media: typeof clip.media === "string" ? clip.media : undefined,
      mediaKind: kind,
      remote: remote || undefined,
      fallback: typeof clip.fallback === "string" ? clip.fallback : undefined,
      placeholder: clip.placeholder === true,
      label: typeof clip.label === "string" ? clip.label.slice(0, 60) : undefined,
      ...fadeIn,
      ...fadeOut,
      ...focus,
    });
    cursor += clip.durationMs;
    if (cursor > raw.totalMs) return { ok: false, error: "片段总时长超过全长" };
  }
  if (cursor !== raw.totalMs) {
    return { ok: false, error: `片段总时长 ${cursor}ms 与全长 ${raw.totalMs}ms 对不上` };
  }

  const overlays = raw.overlays;
  if (!Array.isArray(overlays) || overlays.length > RENDER_MAX_OVERLAYS) {
    return { ok: false, error: `叠加层最多 ${RENDER_MAX_OVERLAYS} 个` };
  }
  const checkedOverlays: RenderOverlay[] = [];
  for (const [index, item] of overlays.entries()) {
    if (!item || typeof item !== "object") return { ok: false, error: `叠加层 ${index + 1} 不是对象` };
    const overlay = item as Record<string, unknown>;
    if (typeof overlay.image !== "string") return { ok: false, error: "叠加层不是图片" };
    const parts = inspectAsset(overlay.image);
    if (!parts || parts.mime !== "image/png") {
      return { ok: false, error: `叠加层 ${index + 1} 必须是 PNG` };
    }
    if (parts.bytes > RENDER_MAX_ASSET_BYTES) {
      return { ok: false, error: `叠加层 ${index + 1} 超过 30 MB` };
    }
    if (!integer(overlay.startMs) || !integer(overlay.endMs) || overlay.endMs <= overlay.startMs) {
      return { ok: false, error: `叠加层 ${index + 1} 的时间不合法` };
    }
    if (overlay.endMs > raw.totalMs) {
      return { ok: false, error: `叠加层 ${index + 1} 超出全长` };
    }
    checkedOverlays.push({
      image: overlay.image,
      startMs: overlay.startMs,
      endMs: overlay.endMs,
    });
  }

  const audio = raw.audio;
  if (!Array.isArray(audio) || audio.length > RENDER_MAX_AUDIO) {
    return { ok: false, error: `音轨最多 ${RENDER_MAX_AUDIO} 条` };
  }
  const checkedAudio: RenderAudio[] = [];
  for (const [index, item] of audio.entries()) {
    if (!item || typeof item !== "object") return { ok: false, error: `音轨 ${index + 1} 不是对象` };
    const track = item as Record<string, unknown>;
    const remote = typeof track.remote === "string" ? track.remote.trim() : "";
    if (remote && !isHttpUrl(remote)) {
      return { ok: false, error: `音轨 ${index + 1} 的远端地址不是 http(s)` };
    }
    if (typeof track.audio === "string") {
      const parts = inspectAsset(track.audio);
      if (!parts || !isAudioMime(parts.mime)) {
        return { ok: false, error: `音轨 ${index + 1} 必须是音频（data URI 或本机资产库）` };
      }
      if (parts.bytes > RENDER_MAX_ASSET_BYTES) {
        return { ok: false, error: `音轨 ${index + 1} 超过 30 MB` };
      }
    } else if (!remote) {
      return { ok: false, error: `音轨 ${index + 1} 既没有音频也没有远端地址` };
    }
    if (!integer(track.startMs) || track.startMs > raw.totalMs) {
      return { ok: false, error: `音轨 ${index + 1} 的起点不合法` };
    }
    if (
      track.durationMs !== undefined &&
      (!integer(track.durationMs) || track.durationMs <= 0)
    ) {
      return { ok: false, error: `音轨 ${index + 1} 的时长不合法` };
    }
    checkedAudio.push({
      audio: typeof track.audio === "string" ? track.audio : undefined,
      remote: remote || undefined,
      startMs: track.startMs,
      ...(track.durationMs !== undefined ? { durationMs: track.durationMs } : {}),
    });
  }

  const musicRaw = raw.music ?? [];
  if (!Array.isArray(musicRaw) || musicRaw.length > 4) {
    return { ok: false, error: "配乐床最多 4 条" };
  }
  const checkedMusic: RenderMusic[] = [];
  for (const [index, item] of musicRaw.entries()) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: `配乐 ${index + 1} 不是对象` };
    }
    const track = item as Record<string, unknown>;
    const remote = typeof track.remote === "string" ? track.remote.trim() : "";
    if (remote && !isHttpUrl(remote)) {
      return { ok: false, error: `配乐 ${index + 1} 的远端地址不是 http(s)` };
    }
    if (typeof track.audio === "string") {
      const parts = inspectAsset(track.audio);
      if (!parts || !isAudioMime(parts.mime)) {
        return { ok: false, error: `配乐 ${index + 1} 必须是音频（data URI 或本机资产库）` };
      }
      if (parts.bytes > RENDER_MAX_ASSET_BYTES) {
        return { ok: false, error: `配乐 ${index + 1} 超过 30 MB` };
      }
    } else if (!remote) {
      return { ok: false, error: `配乐 ${index + 1} 既没有音频也没有远端地址` };
    }
    if (
      !integer(track.startMs) ||
      !integer(track.endMs) ||
      track.endMs <= track.startMs ||
      track.endMs > raw.totalMs
    ) {
      return { ok: false, error: `配乐 ${index + 1} 的时间不合法` };
    }
    const gainDb = typeof track.gainDb === "number" ? track.gainDb : -18;
    const duckDb = typeof track.duckDb === "number" ? track.duckDb : 15;
    if (!Number.isFinite(gainDb) || gainDb < -40 || gainDb > 0) {
      return { ok: false, error: `配乐 ${index + 1} 的增益超出 -40–0 dB` };
    }
    if (!Number.isFinite(duckDb) || duckDb < 12 || duckDb > 18) {
      return { ok: false, error: `配乐 ${index + 1} 的 ducking 深度超出 12–18 dB` };
    }
    checkedMusic.push({
      audio: typeof track.audio === "string" ? track.audio : undefined,
      remote: remote || undefined,
      startMs: track.startMs,
      endMs: track.endMs,
      gainDb,
      duckDb,
      ducking: track.ducking !== false,
      loop: track.loop !== false,
    });
  }

  const totalBytes =
    checkedClips.reduce(
      (sum, clip) =>
        sum +
        (clip.media ? assetBytes(clip.media) : 0) +
        (clip.fallback ? assetBytes(clip.fallback) : 0),
      0,
    ) +
    checkedOverlays.reduce((sum, overlay) => sum + assetBytes(overlay.image), 0) +
    checkedAudio.reduce((sum, track) => sum + (track.audio ? assetBytes(track.audio) : 0), 0) +
    checkedMusic.reduce((sum, track) => sum + (track.audio ? assetBytes(track.audio) : 0), 0);
  if (totalBytes > RENDER_MAX_TOTAL_BYTES) {
    return { ok: false, error: "素材总量超过 200 MB，先删掉一些片段再渲染" };
  }

  const aiLabel = raw.aiLabel as Record<string, unknown> | undefined;
  if (!aiLabel || aiLabel.explicit !== true || aiLabel.implicit !== true) {
    return { ok: false, error: "缺少 AI 标注" };
  }
  if (
    aiLabel.version !== 1 ||
    typeof aiLabel.contentHash !== "string" ||
    !/^[0-9a-f]{8}$/.test(aiLabel.contentHash)
  ) {
    return { ok: false, error: "AI 标注缺少内容指纹：回成片页重新导出" };
  }

  // 隐式标识要和这一份清单真的对得上：指纹按清单重算，改过素材或时长却没
  // 更新指纹的请求直接拒绝（H5 / ADR-0138）。占位图是服务端画的，不参与取材。
  const expectedHash = aiContentHashOf(materialOfManifest({ title: raw.title.trim(), totalMs: raw.totalMs, clips: checkedClips }));
  if (aiLabel.contentHash !== expectedHash) {
    return { ok: false, error: "AI 标注的内容指纹与清单对不上：回成片页重新导出" };
  }

  // 合规证据：必须来自成片页的预检，不能在清单里塞个空对象蒙混
  const complianceRaw =
    raw.compliance && typeof raw.compliance === "object"
      ? (raw.compliance as Record<string, unknown>)
      : null;
  if (!complianceRaw || complianceRaw.ok !== true) {
    return { ok: false, error: "缺少合规预检：回成片页重新检查后再导出" };
  }
  if (
    typeof complianceRaw.checkedAt !== "string" ||
    !complianceRaw.checkedAt ||
    typeof complianceRaw.signature !== "string" ||
    !/^[0-9a-f]{8}$/.test(complianceRaw.signature) ||
    typeof complianceRaw.reviewAcknowledged !== "boolean" ||
    !integer(complianceRaw.findings)
  ) {
    return { ok: false, error: "合规预检证据不完整：回成片页重新检查" };
  }

  // 纵深防御：标题与占位文案用同一套规则再扫一遍，不信任客户端
  const scanned = [
    { text: raw.title.trim(), path: "成片标题" },
    ...checkedClips
      .filter((clip) => clip.label)
      .map((clip) => ({ text: clip.label!, path: "片段文案" })),
  ].flatMap((unit) => scanText(unit.text, unit.path));
  const blocked = scanned.filter((finding) => finding.severity === "block");
  if (blocked.length > 0) {
    return { ok: false, error: `内容安全：${blocked[0]!.message}` };
  }
  if (
    scanned.some((finding) => finding.severity === "review") &&
    complianceRaw.reviewAcknowledged !== true
  ) {
    return { ok: false, error: "成片清单里有需要人工确认的内容：回成片页预检并勾选确认" };
  }

  // 调色（E4）：整块校验；不传就是不调色
  const gradeResult = gradeOf(raw.grade);
  if ("error" in gradeResult) return { ok: false, error: gradeResult.error };

  return {
    ok: true,
    manifest: {
      title: raw.title.trim().slice(0, 80),
      quality,
      width: size.width,
      height: size.height,
      fps: profile.fps,
      totalMs: raw.totalMs,
      clips: checkedClips,
      overlays: checkedOverlays,
      audio: checkedAudio,
      music: checkedMusic,
      ...(gradeResult.grade ? { grade: gradeResult.grade } : {}),
      ...(isDefaultFrame(frame) ? {} : { frame }),
      aiLabel: {
        explicit: true,
        implicit: true,
        standard: "AI生成",
        version: 1,
        contentHash: expectedHash,
      },
      compliance: {
        ok: true,
        checkedAt: complianceRaw.checkedAt,
        signature: complianceRaw.signature,
        reviewAcknowledged: complianceRaw.reviewAcknowledged,
        findings: complianceRaw.findings,
      },
    },
  };
}

/** 下载文件名：去掉路径分隔符，保留中文 */
export function renderFileName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safe || "成片"}-成片.mp4`;
}

/**
 * 无字幕版的文件名（E6）：在两版之间一眼能分出来，不覆盖带字幕那版。
 * 只认 `.mp4` 结尾，别把「-成片」误当成扩展名。
 */
export function noSubtitleFileName(fileName: string): string {
  return fileName.replace(/\.mp4$/i, "") + "-无字幕.mp4";
}
