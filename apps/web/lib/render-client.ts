"use client";

import {
  SUBTITLE_STYLES,
  type EditClip,
  type EditView,
  type SubtitleStyleId,
} from "./edit";
import {
  RENDER_FPS,
  RENDER_HEIGHT,
  RENDER_WIDTH,
  isAudioMime,
  isImageMime,
  isVideoMime,
  parseDataUri,
  renderFileName,
  type RenderAudio,
  type RenderClip,
  type RenderManifest,
  type RenderOverlay,
} from "./render-manifest";

export type RenderBuild = {
  manifest: RenderManifest;
  /** 远端视频 / 音轨没有进成片：交给界面如实说 */
  remoteSkipped: number;
  /** 用占位图顶上的片段数 */
  placeholders: number;
};

export type RenderResult = {
  bytes: number;
  fileName: string;
  remoteSkipped: number;
  placeholders: number;
};

const FONT_STACK =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

function canvas(): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.width = RENDER_WIDTH;
  el.height = RENDER_HEIGHT;
  return el;
}

function dataUriOf(clip: EditClip): { media?: string; mediaKind?: "video" | "image" } {
  const candidates: { uri?: string; kind: "video" | "image" }[] = [
    { uri: clip.uri, kind: "video" },
    { uri: clip.stillUri, kind: "image" },
  ];
  for (const { uri, kind } of candidates) {
    if (!uri) continue;
    const parts = parseDataUri(uri);
    if (!parts) continue;
    if (kind === "video" && isVideoMime(parts.mime)) return { media: uri, mediaKind: "video" };
    if (kind === "image" && isImageMime(parts.mime)) return { media: uri, mediaKind: "image" };
  }
  return {};
}

function hasRemoteVisual(clip: EditClip): boolean {
  const uri = clip.uri ?? clip.stillUri;
  return Boolean(uri && /^https?:\/\//i.test(uri));
}

/** 占位画面：没有视频也没有首尾帧时，至少让成片里看得出这是哪一镜 */
function drawPlaceholder(clip: EditClip): string {
  const el = canvas();
  const ctx = el.getContext("2d")!;
  ctx.fillStyle = "#111113";
  ctx.fillRect(0, 0, RENDER_WIDTH, RENDER_HEIGHT);
  ctx.strokeStyle = "#1c1c20";
  ctx.lineWidth = 2;
  for (let x = -RENDER_HEIGHT; x < RENDER_WIDTH; x += 28) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + RENDER_HEIGHT, RENDER_HEIGHT);
    ctx.stroke();
  }
  ctx.fillStyle = "#4A4B4E";
  ctx.font = `400 34px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`SH-${String(clip.shotNo).padStart(2, "0")} 还没有画面`, RENDER_WIDTH / 2, RENDER_HEIGHT / 2);
  return el.toDataURL("image/png");
}

/** 字幕与角标都画成透明全画幅 PNG：ffmpeg 这台机器没有 drawtext / subtitles */
function subtitleOverlays(view: EditView, styleId: SubtitleStyleId): RenderOverlay[] {
  const style = SUBTITLE_STYLES[styleId];
  const el = canvas();
  const ctx = el.getContext("2d")!;
  const fontSize = (RENDER_WIDTH * style.fontSizeCqw) / 100;
  const stroke = (RENDER_WIDTH * style.strokeCqw) / 100;
  const bottom = RENDER_HEIGHT * (1 - style.bottomPct / 100);

  return view.cues.map((cue) => {
    ctx.clearRect(0, 0, RENDER_WIDTH, RENDER_HEIGHT);
    ctx.font = `600 ${fontSize}px ${FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineJoin = "round";
    ctx.lineWidth = stroke;
    ctx.strokeStyle = "#000";
    ctx.fillStyle = "#fff";
    ctx.strokeText(cue.text, RENDER_WIDTH / 2, bottom);
    ctx.fillText(cue.text, RENDER_WIDTH / 2, bottom);
    return {
      image: el.toDataURL("image/png"),
      startMs: cue.startMs,
      endMs: Math.min(view.totalMs, cue.startMs + Math.max(300, cue.durationMs)),
    };
  });
}

/** 显式标识：右下角「AI 生成」，与成片页、预览 HTML 同一位置 */
function badgeOverlay(totalMs: number): RenderOverlay {
  const el = canvas();
  const ctx = el.getContext("2d")!;
  ctx.clearRect(0, 0, RENDER_WIDTH, RENDER_HEIGHT);
  const text = "AI 生成";
  const fontSize = 30;
  ctx.font = `500 ${fontSize}px ${FONT_STACK}`;
  const width = ctx.measureText(text).width + 28;
  const height = fontSize + 20;
  const x = RENDER_WIDTH - 24 - width;
  const y = RENDER_HEIGHT - 24 - height;

  ctx.fillStyle = "rgba(0,0,0,0.58)";
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + width / 2, y + height / 2 + 1);
  return { image: el.toDataURL("image/png"), startMs: 0, endMs: totalMs };
}

export function buildRenderManifest(
  view: EditView,
  styleId: SubtitleStyleId,
): RenderBuild {
  const ordered = [...view.clips].sort((a, b) => a.startMs - b.startMs);
  let remoteSkipped = 0;
  let placeholders = 0;

  const clips: RenderClip[] = ordered.map((clip) => {
    const visual = dataUriOf(clip);
    if (!visual.media) {
      placeholders += 1;
      if (hasRemoteVisual(clip)) remoteSkipped += 1;
      return {
        durationMs: clip.durationMs,
        media: drawPlaceholder(clip),
        mediaKind: "image" as const,
        label: `SH-${String(clip.shotNo).padStart(2, "0")}`,
      };
    }
    return { durationMs: clip.durationMs, media: visual.media, mediaKind: visual.mediaKind };
  });

  const audio: RenderAudio[] = [];
  for (const clip of ordered) {
    for (const line of clip.lines) {
      if (!line.audioUri) continue;
      const parts = parseDataUri(line.audioUri);
      if (!parts || !isAudioMime(parts.mime)) {
        if (/^https?:\/\//i.test(line.audioUri)) remoteSkipped += 1;
        continue;
      }
      audio.push({ audio: line.audioUri, startMs: line.startMs });
    }
  }

  const overlays = [badgeOverlay(view.totalMs), ...subtitleOverlays(view, styleId)];
  return {
    manifest: {
      title: view.title,
      width: RENDER_WIDTH,
      height: RENDER_HEIGHT,
      fps: RENDER_FPS,
      totalMs: view.totalMs,
      clips,
      overlays,
      audio,
      aiLabel: { explicit: true, implicit: true, standard: "AI生成" },
    },
    remoteSkipped,
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
 * 导出成片 MP4（E6）：浏览器排版 → 服务端 ffmpeg 编码 → 下载。
 *
 * 没有进度事件可听（服务端一次请求），所以调用方只能显示阶段文案；
 * 失败时把服务端的人话原样带回来，不吞成「导出失败」。
 */
export async function exportMp4(
  view: EditView,
  styleId: SubtitleStyleId,
  onStage?: (stage: string) => void,
): Promise<RenderResult> {
  onStage?.("正在排版字幕与占位画面…");
  const { manifest, remoteSkipped, placeholders } = buildRenderManifest(view, styleId);

  onStage?.("正在渲染 1080×1920（通常 20–90 秒）…");
  const response = await fetch("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manifest),
  });

  if (!response.ok) {
    let message = `渲染失败（${response.status}）`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // 非 JSON 错误就别再套一层「解析失败」
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  const fileName = renderFileName(view.title);
  download(blob, fileName);
  return { bytes: blob.size, fileName, remoteSkipped, placeholders };
}
