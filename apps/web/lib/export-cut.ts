import type { AILabel } from "@loomina/ir";
import type { RenderCompliance } from "./compliance";
import type { CoverArt } from "./cover";
import {
  AI_LABEL,
  aiLabelRecordFor,
  badgeOffsets,
  badgePlacementOf,
  type AiLabelRecord,
  type BadgePlacement,
} from "./ai-label";
import {
  PLATFORM_SPEC_VERSION,
  platformSpecOf,
  validatePlatform,
  type PlatformCheck,
  type PlatformId,
} from "./platforms";
import {
  SAFE_AREA,
  resolveSubtitleStyle,
  type EditView,
  type SubtitleStyle,
  type SubtitleStyleId,
} from "./edit";

// 导出（E6 / D2 / D3 / G1，ADR-0086 / ADR-0087）
//
// 这里只产出「自包含文件」：预览 HTML、OTIO 时间线、发布包 JSON、SRT。
// mp4 渲染走 `app/api/render`（ADR-0091）：浏览器先排版成 PNG，服务端 ffmpeg 编码。

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function seconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

// ── SRT ────────────────────────────────────────────────────────

function srtTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const secs = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

/** 字幕轨：断句后的每一条，绝对时间，一条一行 */
export function buildSrt(view: EditView): string {
  const cues = view.cues
    .filter((cue) => cue.text.trim().length > 0)
    .map((cue) => ({
      startMs: cue.startMs,
      endMs: cue.startMs + cue.durationMs,
      text: cue.text.trim(),
    }));
  cues.sort((a, b) => a.startMs - b.startMs);
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.text}\n`,
    )
    .join("\n");
}

// ── ASS（D4）──────────────────────────────────────────────────

function assTime(ms: number): string {
  // ASS 用「时:分:秒.厘秒」，只保留两位小数
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const secs = Math.floor((safe % 60_000) / 1000);
  const centis = Math.floor((safe % 1000) / 10);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

/**
 * ASS 字幕（D4）：与 SRT 同一份 cue，带样式头。
 *
 * 样式按成片页的字幕档位换算：字号用画面高度的百分比，
 * ASS 里 PlayResX/Y 设成成片尺寸，两边的比例才对得上。
 */
export function buildAss(
  view: EditView,
  styleId: SubtitleStyleId | SubtitleStyle = view.subtitleStyle,
): string {
  const style = resolveSubtitleStyle(styleId);
  const width = 1080;
  const height = 1920;
  // cqw 是「画面宽度的百分比」；ASS 的 Fontsize 以 PlayResY 为基准，换算到高度上
  const fontSize = Math.round((style.fontSizeCqw / 100) * width * (height / width));
  const marginV = Math.round((style.bottomPct / 100) * height);
  const outline = Math.max(1, Math.round((style.strokeCqw / 100) * width));
  const marginH = Math.round((SAFE_AREA.sidePct / 100) * width);

  const cues = view.cues
    .filter((cue) => cue.text.trim().length > 0)
    .map((cue) => ({
      startMs: cue.startMs,
      endMs: cue.startMs + cue.durationMs,
      text: cue.text.trim(),
    }))
    .sort((a, b) => a.startMs - b.startMs);

  const header = `[Script Info]
; 织光机 Loomina · ASS 字幕（D4）
; AI 生成内容：本片由 AI 生成（${AI_LABEL.standard}）
Title: ${view.title}
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,PingFang SC,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,1,0,1,${outline},0,2,${marginH},${marginH},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = cues
    .map(
      (cue) =>
        `Dialogue: 0,${assTime(cue.startMs)},${assTime(cue.endMs)},Default,,0,0,0,,${cue.text.replace(/\r?\n/g, "\\N")}`,
    )
    .join("\n");

  return `${header}${events}${events ? "\n" : ""}`;
}

// ── OTIO 时间线 ────────────────────────────────────────────────

const OTIO_RATE = 24;

function frames(ms: number): number {
  return Math.max(1, Math.round((ms * OTIO_RATE) / 1000));
}

function rationalTime(ms: number) {
  return { OTIO_SCHEMA: "RationalTime.1", value: frames(ms), rate: OTIO_RATE };
}

function timeRange(durationMs: number) {
  return {
    OTIO_SCHEMA: "TimeRange.1",
    start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: OTIO_RATE },
    duration: rationalTime(durationMs),
  };
}

/**
 * OTIO 交换格式（ADR-0001 / ADR-0004）：剪辑软件能读的 JSON。
 *
 * 视频轨一条、对白音轨一条；素材地址原样带出（data URI 也能读，只是文件会大）。
 */
export function buildOtio(view: EditView): object {
  const videoTrack = {
    OTIO_SCHEMA: "Track.1",
    name: "V1 画面",
    kind: "Video",
    children: view.clips.map((clip) => ({
      OTIO_SCHEMA: "Clip.2",
      name: `SH-${String(clip.shotNo).padStart(2, "0")} · take ${clip.takeNo}`,
      source_range: timeRange(clip.durationMs),
      media_reference: {
        OTIO_SCHEMA: "ExternalReference.1",
        target_url: clip.uri ?? clip.stillUri ?? "",
        available_range: timeRange(clip.durationMs),
        metadata: {
          loom: {
            shotId: clip.shotId,
            takeId: clip.takeId,
            still: clip.uri ? undefined : clip.stillUri,
          },
        },
      },
      metadata: {
        loom: {
          startMs: clip.startMs,
          durationMs: clip.durationMs,
          takeStatus: clip.takeStatus,
        },
      },
    })),
  };

  const audioTrack = {
    OTIO_SCHEMA: "Track.1",
    name: "A1 对白",
    kind: "Audio",
    children: view.clips.flatMap((clip) =>
      clip.lines
        .filter((line) => line.audioUri)
        .map((line) => ({
          OTIO_SCHEMA: "Clip.2",
          name: line.characterName,
          source_range: timeRange(line.durationMs),
          media_reference: {
            OTIO_SCHEMA: "ExternalReference.1",
            target_url: line.audioUri ?? "",
            available_range: timeRange(line.durationMs),
          },
          metadata: {
            loom: { lineId: line.id, shotId: clip.shotId },
          },
        })),
    ),
  };

  return {
    OTIO_SCHEMA: "Timeline.1",
    name: view.title,
    metadata: {
      loom: {
        version: view.version,
        totalMs: view.totalMs,
        aiLabel: aiLabelRecordFor(view),
        exportedAt: new Date().toISOString(),
      },
    },
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "成片",
      children: [videoTrack, audioTrack],
    },
  };
}

// ── 自包含预览 HTML（L1）───────────────────────────────────────

export type PreviewClip = {
  id: string;
  label: string;
  startMs: number;
  durationMs: number;
  video?: string;
  still?: string;
  /** 相对这一片段的起点 */
  subtitles: { startMs: number; endMs: number; text: string }[];
  /** 相对这一片段的起点 */
  audio: { startMs: number; uri: string; text: string }[];
};

export function previewClips(view: EditView): PreviewClip[] {
  return view.clips.map((clip) => ({
    id: clip.id,
    label: `SH-${String(clip.shotNo).padStart(2, "0")} · ${clip.takeNo} 版`,
    startMs: clip.startMs,
    durationMs: clip.durationMs,
    video: clip.uri,
    still: clip.stillUri,
    subtitles: clip.lines.flatMap((line) =>
      line.cues.map((cue) => ({
        startMs: cue.startMs - clip.startMs,
        endMs: cue.startMs - clip.startMs + cue.durationMs,
        text: cue.text,
      })),
    ),
    audio: clip.lines.flatMap((line) =>
      line.audioUri
        ? [{ startMs: line.audioStartMs - clip.startMs, uri: line.audioUri, text: line.text }]
        : [],
    ),
  }));
}

/** 把读模型变成一页能直接双击打开的播放页；素材全部内嵌，不依赖服务器 */
export function buildPreviewHtml(
  view: EditView,
  styleId: SubtitleStyleId | SubtitleStyle = view.subtitleStyle,
  platform: PlatformId = "generic",
): string {
  const style = resolveSubtitleStyle(styleId);
  const placement = badgePlacementOf(platform);
  const offsets = badgeOffsets(placement);
  const badgePosition = Object.entries(offsets)
    .map(([side, value]) => `${side}:${value}`)
    .join("; ");
  const record = aiLabelRecordFor(view);
  const data = {
    title: view.title,
    totalMs: view.totalMs,
    clips: previewClips(view),
  };

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="ai-generated" content="true">
<meta name="ai-label-standard" content="${AI_LABEL.standard}">
<meta name="ai-label-version" content="${record.version}">
<meta name="ai-label-content-hash" content="${record.contentHash}">
<meta name="ai-label-badge" content="${placement.corner}">
<title>${escapeHtml(view.title)} · 预览</title>
<style>
:root { color-scheme: dark; --bg:#0C0C0D; --surface:#131316; --line:#2B2B2F; --text:#F2F2EF; --muted:#7B7C7F; --pick:#E0442E; }
* { box-sizing: border-box; }
html, body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 "PingFang SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif; }
body { min-height:100%; display:flex; flex-direction:column; align-items:center; padding:24px 16px calc(24px + env(safe-area-inset-bottom,0px)); gap:16px; }
header { width:100%; max-width:420px; display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
h1 { margin:0; font-size:14px; font-weight:600; letter-spacing:.02em; }
header span { color:var(--muted); font-size:11px; font-variant-numeric:tabular-nums; }
.stage { position:relative; width:min(420px,100%); aspect-ratio:9/16; background:#000; border:1px solid var(--line); overflow:hidden; }
.stage video { width:100%; height:100%; object-fit:cover; display:none; }
.stage img { width:100%; height:100%; object-fit:cover; display:none; }
.placeholder { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:12px; background:repeating-linear-gradient(45deg,#111,#111 12px,#151515 12px,#151515 24px); }
.stage .safe { position:absolute; inset:${SAFE_AREA.topPct}% ${SAFE_AREA.sidePct}% ${SAFE_AREA.bottomPct}%; border:1px dashed rgba(242,242,239,.12); display:none; pointer-events:none; }
.stage.show-safe .safe { display:block; }
.subtitle { position:absolute; left:${SAFE_AREA.sidePct}%; right:${SAFE_AREA.sidePct}%; bottom:${style.bottomPct}%; text-align:center; font-size:${style.fontSizeCqw}cqw; line-height:1.38; font-weight:600; color:#fff; text-shadow:0 0 ${style.strokeCqw}cqw #000, 0 0 ${style.strokeCqw}cqw #000, 0 ${style.strokeCqw * 0.5}cqw ${style.strokeCqw * 1.2}cqw #000; letter-spacing:.02em; }
.ai-badge { position:absolute; ${badgePosition}; z-index:3; padding:3px 6px; border:1px solid rgba(255,255,255,.16); background:rgba(0,0,0,.58); color:rgba(255,255,255,.82); font-size:10px; line-height:1.2; letter-spacing:.08em; pointer-events:none; }
.controls { width:100%; max-width:420px; display:flex; flex-direction:column; gap:10px; }
.row { display:flex; align-items:center; gap:10px; }
button { background:var(--surface); color:var(--text); border:1px solid var(--line); font:inherit; font-size:12px; padding:7px 14px; cursor:pointer; }
button:hover { border-color:var(--muted); }
button:focus-visible { outline:2px solid var(--pick); outline-offset:2px; }
button.primary { background:var(--pick); border-color:var(--pick); color:#fff; }
input[type=range] { flex:1; accent-color:var(--pick); }
.time { color:var(--muted); font-size:11px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.clip { color:var(--muted); font-size:11px; }
.note { max-width:420px; color:var(--muted); font-size:11px; line-height:1.6; }
@media (prefers-reduced-motion: reduce) { * { animation:none !important; transition:none !important; } }
</style>
</head>
<body>
<header><h1>${escapeHtml(view.title)}</h1><span>${view.clips.length} 镜 · ${seconds(view.totalMs)}s</span></header>
<div class="stage" id="stage">
  <video id="video" playsinline></video>
  <img id="still" alt="">
  <div class="placeholder" id="placeholder">这一镜还没有画面</div>
  <div class="safe"></div>
  <div class="subtitle" id="subtitle"></div>
  <div class="ai-badge" aria-label="AI 生成内容标识" data-corner="${placement.corner}">AI 生成</div>
</div>
<div class="controls">
  <div class="row"><span class="time" id="clock">00:00.0</span><input id="seek" type="range" min="0" max="${view.totalMs}" value="0" aria-label="进度"><span class="time" id="total">${seconds(view.totalMs)}s</span></div>
  <div class="row"><button id="play" class="primary" type="button">播放</button><button id="restart" type="button">重来</button><span class="clip" id="clip"></span></div>
  <p class="note">这是初剪预览：按时间线顺序播放，字幕用「${escapeHtml(style.label)}」样式。导出文件里不含第三方播放器，双击就能看；画面素材按原样内嵌。</p>
</div>
<script>
const DATA = ${safeJson(data)};
const video = document.getElementById("video");
const still = document.getElementById("still");
const placeholder = document.getElementById("placeholder");
const subtitle = document.getElementById("subtitle");
const playBtn = document.getElementById("play");
const seek = document.getElementById("seek");
const clock = document.getElementById("clock");
const clipLabel = document.getElementById("clip");
let elapsed = 0;
let playing = false;
let current = -1;
let tickHandle = 0;
let audioNodes = [];
let audioFired = [];

function fmt(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const d = Math.floor((ms % 1000) / 100);
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + d;
}
function clipAt(ms) {
  for (let i = DATA.clips.length - 1; i >= 0; i--) {
    const c = DATA.clips[i];
    if (ms >= c.startMs && ms < c.startMs + c.durationMs) return i;
  }
  return DATA.clips.length - 1;
}
function stopAudio() {
  for (const node of audioNodes) { try { node.pause(); } catch (e) {} }
  audioNodes = [];
}
function render() {
  const index = clipAt(elapsed);
  const clip = DATA.clips[index];
  if (!clip) return;
  if (index !== current) {
    current = index;
    stopAudio();
    audioFired = clip.audio.map(() => false);
    if (clip.video) {
      video.style.display = "block"; still.style.display = "none"; placeholder.style.display = "none";
      if (video.src !== clip.video) video.src = clip.video;
      video.currentTime = Math.max(0, Math.min((elapsed - clip.startMs) / 1000, Math.max(0, clip.durationMs / 1000 - 0.05)));
      if (playing) video.play().catch(() => {});
    } else {
      video.pause(); video.style.display = "none";
      if (clip.still) {
        still.style.display = "block"; placeholder.style.display = "none";
        if (still.src !== clip.still) still.src = clip.still;
      } else {
        still.style.display = "none"; placeholder.style.display = "flex";
      }
    }
    clipLabel.textContent = clip.label;
  }
  const inClip = elapsed - clip.startMs;
  const cue = clip.subtitles.find((s) => inClip >= s.startMs && inClip < s.endMs);
  subtitle.textContent = cue ? cue.text : "";
  if (playing) {
    clip.audio.forEach((a, i) => {
      if (!audioFired[i] && inClip >= a.startMs) {
        audioFired[i] = true;
        const node = new Audio(a.uri);
        audioNodes.push(node);
        node.play().catch(() => {});
      }
    });
  }
  seek.value = String(Math.round(elapsed));
  clock.textContent = fmt(elapsed);
}
function stop() {
  playing = false;
  playBtn.textContent = "播放";
  if (tickHandle) { clearInterval(tickHandle); tickHandle = 0; }
  stopAudio();
  video.pause();
}
function tick() {
  elapsed += 50;
  if (elapsed >= DATA.totalMs) { elapsed = DATA.totalMs; render(); stop(); return; }
  render();
}
function play() {
  if (elapsed >= DATA.totalMs) elapsed = 0;
  playing = true;
  playBtn.textContent = "暂停";
  if (video.src) video.play().catch(() => {});
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(tick, 50);
}
playBtn.addEventListener("click", () => { if (playing) { stop(); } else { play(); } });
document.getElementById("restart").addEventListener("click", () => {
  stop(); elapsed = 0; current = -1; video.removeAttribute("src"); video.load(); render();
});
seek.addEventListener("input", () => {
  const was = playing;
  stop();
  elapsed = Number(seek.value);
  current = -1;
  render();
  if (was) play();
});
render();
</script>
</body>
</html>`;
}

// ── 发布包（G1）────────────────────────────────────────────────

export type PublishOptions = {
  title: string;
  description: string;
  topics: string[];
  style: SubtitleStyleId;
  /** 草稿 / 定稿 */
  kind: "draft" | "final";
  /** 已经生成过的封面（G6）：发布包里记文件名与用的哪一帧，不内嵌二进制 */
  coverArt?: CoverArt;
  /** 目标平台（G7）；缺省抖音 */
  platform?: PlatformId;
  /** 导出前预检证据（G8）；发布包里留一份，便于回溯 */
  compliance?: RenderCompliance;
  /** 已经导出的成片（G1）；没渲染过就不写，别编一个假路径 */
  video?: {
    fileName: string;
    bytes: number;
    quality: "draft" | "final";
    renderedAt: string;
  };
};

export type PublishVideo = NonNullable<PublishOptions["video"]>;

export type PublishPackage = {
  formatVersion: 1;
  kind: PublishOptions["kind"];
  createdAt: string;
  platform: PlatformId;
  platformName: string;
  specVersion: string;
  platformChecks: PlatformCheck[];
  /** 成片文件信息；没渲染过就是 null，并写明为什么 */
  video: PublishVideo | null;
  videoNote: string;
  cover?: string;
  /** 封面出图记录（G6）：文件名、字节数、第几镜第几毫秒；没生成就没有 */
  coverArt?: CoverArt;
  title: string;
  description: string;
  topics: string[];
  durationSec: number;
  music: {
    title: string;
    mood: string;
    gainDb: number;
    duckDb: number;
    ducking: boolean;
    licenseRef: string;
  }[];
  aiLabel: AILabel;
  /** 这一版剪辑的内容指纹与角标位置（H5）：标识记录随发布包一起走 */
  aiLabelRecord?: AiLabelRecord;
  /** 角标实际摆在哪个角、离边多远；平台改版时这里能看出按哪版摆的 */
  aiLabelBadge?: BadgePlacement;
  /** 导出前的合规预检指纹与确认状态 */
  compliance?: RenderCompliance;
  subtitleStyle: SubtitleStyleId;
  /** 实际画出来的字号 / 底边距离 / 描边（D3）：调过版式时与档位默认值不同 */
  subtitleLayout: { fontSizeCqw: number; bottomPct: number; strokeCqw: number };
  subtitles: string;
  shots: { shotNo: number; takeNo: number; startMs: number; durationMs: number }[];
  /** 哪些地方还没做完：导入平台前该知道 */
  warnings: string[];
};

/**
 * 发布包（G1）：标题、简介、话题、封面、字幕、成片信息与 AI 标注，一起打包成一份 JSON。
 *
 * 视频仍是引用而不是二进制：成片 MP4 由成片页单独导出（`/api/render`），
 * 这里只记文件名、字节数、档位与渲染时间；没渲染过就写 `null` 并说明，
 * 不塞假路径（ADR-0102）。
 */
export function buildPublishPackage(
  view: EditView,
  options: PublishOptions,
): PublishPackage {
  const cover = view.clips.find((clip) => clip.stillUri)?.stillUri;
  const warnings: string[] = [];
  if (view.noPicture > 0) warnings.push(`${view.noPicture} 个片段没有画面`);
  if (view.withVoice === 0) warnings.push("整条片子还没有配音");
  if (view.missing > 0) warnings.push(`剧本里还有 ${view.missing} 镜没进时间线`);
  const platform = options.platform ?? "douyin";
  const spec = platformSpecOf(platform);
  const topics = options.topics.map((topic) => topic.trim()).filter(Boolean);
  const title = options.title.trim() || view.title;
  const validation = validatePlatform(spec, {
    durationMs: view.totalMs,
    width: 1080,
    height: 1920,
    fps: 30,
    codec: "H.264",
    title,
    topics,
    ...(options.video ? { fileBytes: options.video.bytes } : {}),
  });
  if (!validation.ok) {
    warnings.push(
      `${spec.name} 规格还有 ${validation.blocked} 项硬阻断：${
        validation.checks.find((check) => check.status === "block")?.detail ?? ""
      }`,
    );
  }
  const video = options.video ?? null;
  if (!video) warnings.push("还没有导出过成片 MP4：发布包的视频位是空的");

  return {
    formatVersion: 1,
    kind: options.kind,
    createdAt: new Date().toISOString(),
    platform,
    platformName: spec.name,
    specVersion: PLATFORM_SPEC_VERSION,
    platformChecks: validation.checks,
    video,
    videoNote: video
      ? `${video.quality === "final" ? "定稿" : "草稿"}成片 ${video.fileName}（${(video.bytes / 1024 / 1024).toFixed(1)} MB）已在本机导出；发布包只记文件信息，不内嵌二进制。`
      : "发布包是清单，不含视频文件；先在成片页导出一次 MP4（草稿或定稿），再回来打发布包，视频位会带上文件名、字节数与档位。",
    ...(cover ? { cover } : {}),
    ...(options.coverArt ? { coverArt: options.coverArt } : {}),
    title,
    description: options.description.trim(),
    topics,
    durationSec: view.totalSec,
    music: view.music.map((cue) => ({
      title: cue.title,
      mood: cue.mood,
      gainDb: cue.gainDb,
      duckDb: cue.duckDb,
      ducking: cue.ducking,
      licenseRef: cue.licenseRef,
    })),
    aiLabel: AI_LABEL,
    aiLabelRecord: aiLabelRecordFor(view),
    aiLabelBadge: badgePlacementOf(platform),
    ...(options.compliance ? { compliance: options.compliance } : {}),
    subtitleStyle: options.style,
    subtitleLayout: {
      fontSizeCqw: view.subtitleStyle.fontSizeCqw,
      bottomPct: view.subtitleStyle.bottomPct,
      strokeCqw: view.subtitleStyle.strokeCqw,
    },
    subtitles: buildSrt(view),
    shots: view.clips.map((clip) => ({
      shotNo: clip.shotNo,
      takeNo: clip.takeNo,
      startMs: clip.startMs,
      durationMs: clip.durationMs,
    })),
    warnings,
  };
}

/** 触发一次本地下载：不经过服务器，导出即落盘 */
export function downloadFile(name: string, text: string, mime: string) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻回收会让部分浏览器取消下载，留一拍
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 文件名里不留路径分隔符与奇怪字符 */
export function safeFileName(title: string, suffix: string): string {
  const base = title.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "loomina";
  return `${base}-${suffix}`;
}
