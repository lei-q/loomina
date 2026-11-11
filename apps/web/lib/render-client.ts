"use client";

import {
  SUBTITLE_STYLES,
  type EditClip,
  type EditView,
  type SubtitleStyleId,
} from "./edit";
import type { RenderCompliance } from "./compliance";
import {
  RENDER_PROFILES,
  isAudioMime,
  isImageMime,
  isVideoMime,
  parseDataUri,
  renderFileName,
  type RenderAudio,
  type RenderClip,
  type RenderManifest,
  type RenderMusic,
  type RenderOverlay,
  type RenderQuality,
} from "./render-manifest";
import type { LoudnessReport } from "./render-audio";

export type RenderBuild = {
  manifest: RenderManifest;
  /** 用占位图顶上的片段数（远端是否取到由服务端决定） */
  placeholders: number;
};

export type RenderResult = {
  bytes: number;
  fileName: string;
  remoteSkipped: number;
  placeholders: number;
  loudness?: LoudnessReport;
};

const FONT_STACK =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

function canvas(width: number, height: number): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.width = width;
  el.height = height;
  return el;
}

type Visual = {
  media?: string;
  mediaKind?: "video" | "image";
  remote?: string;
  /** 远端被白名单拒绝时用的图 */
  fallback?: string;
};

function visualOf(clip: EditClip): Visual {
  const candidates: { uri?: string; kind: "video" | "image" }[] = [
    { uri: clip.uri, kind: "video" },
    { uri: clip.stillUri, kind: "image" },
  ];
  for (const { uri, kind } of candidates) {
    if (!uri) continue;
    if (/^https?:\/\//i.test(uri)) {
      return { remote: uri, mediaKind: kind };
    }
    const parts = parseDataUri(uri);
    if (!parts) continue;
    if (kind === "video" && isVideoMime(parts.mime)) return { media: uri, mediaKind: "video" };
    if (kind === "image" && isImageMime(parts.mime)) return { media: uri, mediaKind: "image" };
  }
  return {};
}

/** 占位画面：没有视频也没有首尾帧时，至少让成片里看得出这是哪一镜 */
function drawPlaceholder(clip: EditClip, width: number, height: number): string {
  const el = canvas(width, height);
  const ctx = el.getContext("2d")!;
  const scale = width / RENDER_PROFILES.final.width;
  ctx.fillStyle = "#111113";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#1c1c20";
  ctx.lineWidth = 2;
  for (let x = -height; x < width; x += 28) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + height, height);
    ctx.stroke();
  }
  ctx.fillStyle = "#4A4B4E";
  ctx.font = `400 ${Math.round(34 * scale)}px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`SH-${String(clip.shotNo).padStart(2, "0")} 还没有画面`, width / 2, height / 2);
  return el.toDataURL("image/png");
}

/** 字幕与角标都画成透明全画幅 PNG：ffmpeg 这台机器没有 drawtext / subtitles */
function subtitleOverlays(
  view: EditView,
  styleId: SubtitleStyleId,
  width: number,
  height: number,
): RenderOverlay[] {
  const style = SUBTITLE_STYLES[styleId];
  const el = canvas(width, height);
  const ctx = el.getContext("2d")!;
  const fontSize = (width * style.fontSizeCqw) / 100;
  const stroke = (width * style.strokeCqw) / 100;
  const bottom = height * (1 - style.bottomPct / 100);

  return view.cues.map((cue) => {
    ctx.clearRect(0, 0, width, height);
    ctx.font = `600 ${fontSize}px ${FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineJoin = "round";
    ctx.lineWidth = stroke;
    ctx.strokeStyle = "#000";
    ctx.fillStyle = "#fff";
    ctx.strokeText(cue.text, width / 2, bottom);
    ctx.fillText(cue.text, width / 2, bottom);
    return {
      image: el.toDataURL("image/png"),
      startMs: cue.startMs,
      endMs: Math.min(view.totalMs, cue.startMs + Math.max(300, cue.durationMs)),
    };
  });
}

/** 显式标识：右下角「AI 生成」，与成片页、预览 HTML 同一位置 */
function badgeOverlay(totalMs: number, width: number, height: number): RenderOverlay {
  const el = canvas(width, height);
  const ctx = el.getContext("2d")!;
  const scale = width / RENDER_PROFILES.final.width;
  ctx.clearRect(0, 0, width, height);
  const text = "AI 生成";
  const fontSize = Math.round(30 * scale);
  ctx.font = `500 ${fontSize}px ${FONT_STACK}`;
  const badgeWidth = ctx.measureText(text).width + 28 * scale;
  const badgeHeight = fontSize + 20 * scale;
  const x = width - 24 * scale - badgeWidth;
  const y = height - 24 * scale - badgeHeight;

  ctx.fillStyle = "rgba(0,0,0,0.58)";
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, badgeWidth, badgeHeight, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + badgeWidth / 2, y + badgeHeight / 2 + 1);
  return { image: el.toDataURL("image/png"), startMs: 0, endMs: totalMs };
}

export function buildRenderManifest(
  view: EditView,
  styleId: SubtitleStyleId,
  compliance: RenderCompliance,
  quality: RenderQuality = "final",
): RenderBuild {
  const profile = RENDER_PROFILES[quality];
  const ordered = [...view.clips].sort((a, b) => a.startMs - b.startMs);
  let placeholders = 0;

  const clips: RenderClip[] = ordered.map((clip) => {
    const visual = visualOf(clip);
    const label = `SH-${String(clip.shotNo).padStart(2, "0")}`;
    if (visual.remote) {
      return {
        durationMs: clip.durationMs,
        remote: visual.remote,
        mediaKind: visual.mediaKind ?? "video",
        fallback: drawPlaceholder(clip, profile.width, profile.height),
        label,
      };
    }
    if (visual.media) {
      return { durationMs: clip.durationMs, media: visual.media, mediaKind: visual.mediaKind };
    }
    placeholders += 1;
    return {
      durationMs: clip.durationMs,
      media: drawPlaceholder(clip, profile.width, profile.height),
      mediaKind: "image" as const,
      placeholder: true,
      label,
    };
  });

  const audio: RenderAudio[] = [];
  for (const clip of ordered) {
    for (const line of clip.lines) {
      if (!line.audioUri) continue;
      if (/^https?:\/\//i.test(line.audioUri)) {
        audio.push({ remote: line.audioUri, startMs: line.startMs, durationMs: line.durationMs });
        continue;
      }
      const parts = parseDataUri(line.audioUri);
      if (!parts || !isAudioMime(parts.mime)) continue;
      audio.push({ audio: line.audioUri, startMs: line.startMs, durationMs: line.durationMs });
    }
  }

  const music: RenderMusic[] = [];
  for (const cue of view.music) {
    if (!cue.uri) continue;
    const endMs = Math.min(view.totalMs, cue.startMs + cue.durationMs);
    if (endMs <= cue.startMs) continue;
    const common = {
      startMs: cue.startMs,
      endMs,
      gainDb: cue.gainDb,
      duckDb: cue.duckDb,
      ducking: cue.ducking,
      loop: cue.loop,
    };
    if (/^https?:\/\//i.test(cue.uri)) {
      music.push({ remote: cue.uri, ...common });
      continue;
    }
    const parts = parseDataUri(cue.uri);
    if (!parts || !isAudioMime(parts.mime)) continue;
    music.push({ audio: cue.uri, ...common });
  }

  const overlays = [
    badgeOverlay(view.totalMs, profile.width, profile.height),
    ...subtitleOverlays(view, styleId, profile.width, profile.height),
  ];
  return {
    manifest: {
      title: view.title,
      quality,
      width: profile.width,
      height: profile.height,
      fps: profile.fps,
      totalMs: view.totalMs,
      clips,
      overlays,
      audio,
      music,
      aiLabel: { explicit: true, implicit: true, standard: "AI生成" },
      compliance,
    },
    placeholders,
  };
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 导出成片 MP4（E6）：浏览器排版 → 服务端任务队列 → 轮询 → 下载（H2）。
 *
 * 提交只拿到任务号；之后每秒问一次状态，排队位置、编码进度与失败原因都原样显示。
 * 失败时把服务端的人话带回来，不吞成「导出失败」。
 */

type JobState = {
  jobId: string;
  status: "queued" | "running" | "done" | "error";
  stage: string;
  progress: number;
  position: number;
  fileName?: string;
  bytes?: number;
  remoteSkipped: number;
  placeholders: number;
  loudness?: LoudnessReport;
  error?: string;
};

async function errorOf(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

const POLL_MS = 1000;
const JOB_TIMEOUT_MS = 11 * 60 * 1000;

export async function exportMp4(
  view: EditView,
  styleId: SubtitleStyleId,
  compliance: RenderCompliance,
  quality: RenderQuality,
  onStage?: (stage: string) => void,
): Promise<RenderResult> {
  onStage?.("正在排版字幕与占位画面…");
  const { manifest } = buildRenderManifest(view, styleId, compliance, quality);

  onStage?.("正在提交渲染任务…");
  const submit = await fetch("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manifest),
  });
  if (!submit.ok) {
    throw new Error(await errorOf(submit, `提交渲染失败（${submit.status}）`));
  }
  const job = (await submit.json()) as JobState;

  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let state = job;
  while (state.status !== "done") {
    if (state.status === "error") throw new Error(state.error || "渲染失败");
    if (Date.now() > deadline) throw new Error("渲染超时，请重新导出");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));

    const poll = await fetch(`/api/render?job=${encodeURIComponent(job.jobId)}`, {
      cache: "no-store",
    });
    if (!poll.ok) {
      throw new Error(await errorOf(poll, `查询渲染进度失败（${poll.status}）`));
    }
    state = (await poll.json()) as JobState;

    if (state.status === "queued") {
      onStage?.(
        state.position > 0 ? `排队中（第 ${state.position} 位）…` : "排队中，马上开始…",
      );
    } else if (state.status === "running") {
      onStage?.(
        `${state.stage}${state.progress > 0 ? ` · ${state.progress}%` : ""}…`,
      );
    }
  }

  onStage?.("正在取回成片…");
  const file = await fetch(
    `/api/render?job=${encodeURIComponent(job.jobId)}&download=1`,
    { cache: "no-store" },
  );
  if (!file.ok) {
    throw new Error(await errorOf(file, `下载成片失败（${file.status}）`));
  }

  const remoteSkipped = Number(
    file.headers.get("x-loomina-remote-skipped") ?? state.remoteSkipped ?? 0,
  );
  const usedPlaceholders = Number(
    file.headers.get("x-loomina-placeholders") ?? state.placeholders ?? 0,
  );
  const blob = await file.blob();
  const fileName = state.fileName || renderFileName(view.title);
  download(blob, fileName);
  return {
    bytes: blob.size,
    fileName,
    remoteSkipped,
    placeholders: usedPlaceholders,
    ...(state.loudness ? { loudness: state.loudness } : {}),
  };
}
