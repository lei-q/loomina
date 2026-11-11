/**
 * 成片 mp4 的渲染清单（E6）。
 *
 * 浏览器负责「把字幕、占位图与角标画成透明 PNG」——这台机器的 ffmpeg 没编进
 * drawtext / subtitles 滤镜，中文只能先在 canvas 里排好再交给 ffmpeg 叠加。
 * 服务端只做校验、拼滤镜与编码，不信任客户端给的尺寸与时长。
 */

import { scanText, type RenderCompliance } from "./compliance";

export const RENDER_WIDTH = 1080;
export const RENDER_HEIGHT = 1920;
export const RENDER_FPS = 30;
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
  width: number;
  height: number;
  fps: number;
  totalMs: number;
  clips: RenderClip[];
  overlays: RenderOverlay[];
  audio: RenderAudio[];
  music: RenderMusic[];
  aiLabel: { explicit: true; implicit: true; standard: "AI生成" };
  /** 成片页的合规预检证据（G8）；服务端会再扫一遍清单文案 */
  compliance: RenderCompliance;
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
  if (raw.width !== RENDER_WIDTH || raw.height !== RENDER_HEIGHT) {
    return { ok: false, error: `只支持 ${RENDER_WIDTH}×${RENDER_HEIGHT}` };
  }
  if (raw.fps !== RENDER_FPS) return { ok: false, error: `只支持 ${RENDER_FPS}fps` };
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
      const fallback = parseDataUri(clip.fallback);
      if (!fallback || !isImageMime(fallback.mime)) {
        return { ok: false, error: `第 ${index + 1} 段的兜底图必须是图片 data URI` };
      }
      if (fallback.bytes > RENDER_MAX_ASSET_BYTES) {
        return { ok: false, error: `第 ${index + 1} 段的兜底图超过 30 MB` };
      }
    }

    if (clip.media !== undefined) {
      if (typeof clip.media !== "string") return { ok: false, error: "媒体不是字符串" };
      const parts = parseDataUri(clip.media);
      if (!parts) {
        return { ok: false, error: `第 ${index + 1} 段的媒体不是 data URI` };
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

    checkedClips.push({
      durationMs: clip.durationMs,
      media: typeof clip.media === "string" ? clip.media : undefined,
      mediaKind: kind,
      remote: remote || undefined,
      fallback: typeof clip.fallback === "string" ? clip.fallback : undefined,
      placeholder: clip.placeholder === true,
      label: typeof clip.label === "string" ? clip.label.slice(0, 60) : undefined,
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
    const parts = parseDataUri(overlay.image);
    if (!parts || parts.mime !== "image/png") {
      return { ok: false, error: `叠加层 ${index + 1} 必须是 PNG data URI` };
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
      const parts = parseDataUri(track.audio);
      if (!parts || !isAudioMime(parts.mime)) {
        return { ok: false, error: `音轨 ${index + 1} 必须是音频 data URI` };
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
      const parts = parseDataUri(track.audio);
      if (!parts || !isAudioMime(parts.mime)) {
        return { ok: false, error: `配乐 ${index + 1} 必须是音频 data URI` };
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

  return {
    ok: true,
    manifest: {
      title: raw.title.trim().slice(0, 80),
      width: RENDER_WIDTH,
      height: RENDER_HEIGHT,
      fps: RENDER_FPS,
      totalMs: raw.totalMs,
      clips: checkedClips,
      overlays: checkedOverlays,
      audio: checkedAudio,
      music: checkedMusic,
      aiLabel: {
        explicit: true,
        implicit: true,
        standard: "AI生成",
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
