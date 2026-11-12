"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { StageGate } from "@/components/stage-gate";
import { ComplianceCheckpoints } from "@/components/compliance-checkpoints";
import { MusicCurvePanel } from "@/components/music-curve-panel";
import { TopBar } from "@/components/top-bar";
import {
  DEFAULT_SUBTITLE_CHARS,
  SAFE_AREA,
  SUBTITLE_CHARS,
  SUBTITLE_STYLES,
  isCustomSubtitleLayout,
  subtitleStyleOf,
  timecode,
  toEditView,
  type SubtitleChars,
  type SubtitleStyle,
  type SubtitleStyleId,
} from "@/lib/edit";
import {
  buildOtio,
  buildPreviewHtml,
  buildPublishPackage,
  buildAss,
  buildSrt,
  downloadFile,
  safeFileName,
} from "@/lib/export-cut";
import {
  preflightProject,
  renderComplianceOf,
  type ComplianceCheck,
} from "@/lib/compliance";
import {
  reviewSummaryOf,
  type ReviewSubject,
} from "@/lib/asset-review";
import { shotLabel, spendOf, toStageView } from "@/lib/read-model";
import { cancelRender, exportMp4 } from "@/lib/render-client";
import { hydrateView } from "@/lib/asset-hydrate";
import { assetHref } from "@/lib/asset-uri";
import { RENDER_PROFILES, type RenderQuality } from "@/lib/render-manifest";
import { stageStateOf } from "@/lib/stage-flow";
import type { LoudnessReport } from "@/lib/render-audio";
import {
  PLATFORM_SPECS,
  PLATFORM_SPEC_VERSION,
  formatSize,
  platformSpecOf,
  validatePlatform,
  type PlatformCheck,
  type PlatformId,
} from "@/lib/platforms";
import { badgeCornerLabel, badgePlacementOf } from "@/lib/ai-label";
import { useWorkbench } from "@/lib/workbench-store";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, string> = {
  approved: "留用",
  draft: "草稿",
  rejected: "已淘汰",
};

function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  webm: "audio/webm",
};

/** 本地音乐读成 data URI，并量出真实时长；读不出时长就不收 */
function readMusicFile(file: File): Promise<{
  uri: string;
  mime: string;
  durationMs: number;
}> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = file.type || AUDIO_MIME[extension] || "";
  if (!mime.startsWith("audio/")) {
    return Promise.reject(new Error("这不是音频文件：选 mp3 / m4a / wav。"));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("这个文件读不出来。"));
    reader.onload = () => {
      const uri = typeof reader.result === "string" ? reader.result : "";
      if (!uri.startsWith("data:audio/")) {
        reject(new Error("这个文件读不成音频 data URI。"));
        return;
      }
      const audio = new Audio();
      const timer = window.setTimeout(() => {
        audio.removeAttribute("src");
        reject(new Error("读不出音频时长：换一个文件，或先转成 mp3。"));
      }, 10_000);
      audio.preload = "metadata";
      audio.onloadedmetadata = () => {
        window.clearTimeout(timer);
        const durationMs = Math.round(audio.duration * 1000);
        audio.removeAttribute("src");
        if (!Number.isFinite(durationMs) || durationMs < 500) {
          reject(new Error("这条音频太短或时长读不出来。"));
          return;
        }
        resolve({ uri, mime, durationMs });
      };
      audio.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("浏览器解不开这条音频：换 mp3 / m4a / wav 再试。"));
      };
      audio.src = uri;
    };
    reader.readAsDataURL(file);
  });
}

const CHECK_STATUS: Record<ComplianceCheck["status"], string> = {
  pass: "通过",
  review: "需确认",
  block: "未通过",
};

function PlatformRow({ check }: { check: PlatformCheck }) {
  return (
    <li className="flex items-start gap-2 border-b border-line py-1.5 last:border-b-0">
      <span
        aria-hidden
        className={cn(
          "mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full",
          check.status === "pass"
            ? "bg-line-2"
            : check.status === "review"
              ? "bg-muted"
              : "bg-pick",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[9.5px] text-text">{check.label}</span>
          {check.reference && (
            <span className="text-[8px] tracking-[.06em] text-muted-2">参考</span>
          )}
        </div>
        <p className="mt-0.5 text-[8.5px] leading-[1.6] text-muted-2">{check.detail}</p>
      </div>
    </li>
  );
}

/**
 * 生成结果复核（H6 / ADR-0132）。
 *
 * 提示词在发出前已经扫过（ADR-0105），像素与视频没有模型审核服务，只能人看。
 * 这里把「会进成片的每一条生成结果」摆出来，逐条标「已看 / 不可用」；
 * 「不可用」会拦住导出，「还没看」只提醒——示例项目不该一上来就卡死。
 */
function ReviewPanel({
  subjects,
  readOnly,
  onReview,
}: {
  subjects: ReviewSubject[];
  readOnly: boolean;
  onReview: (assetId: string, status: "passed" | "rejected" | null) => void;
}) {
  if (subjects.length === 0) return null;
  return (
    <ul className="mt-1.5 border-t border-line">
      {subjects.map((subject) => {
        const status = subject.review?.status;
        return (
          <li
            key={subject.assetId}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line py-1.5 last:border-b-0"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[2px] border border-line bg-bg">
              {subject.kind === "video" && subject.uri ? (
                <video
                  src={assetHref(subject.uri)}
                  muted
                  playsInline
                  preload="metadata"
                  className="h-full w-full object-cover"
                />
              ) : subject.kind === "image" && subject.uri ? (
                <img
                  src={assetHref(subject.uri)}
                  alt={subject.where}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-[8px] text-muted-2">{subject.kind === "audio" ? "音" : "空"}</span>
              )}
            </span>
            <span className="min-w-0 flex-1 text-[9.5px] text-text">{subject.where}</span>
            {!subject.exists ? (
              <span className="shrink-0 text-[8.5px] text-pick">资产不存在</span>
            ) : (
              !subject.hasMedia && (
                <span className="shrink-0 text-[8.5px] text-pick">没有文件</span>
              )
            )}
            {subject.review?.status === "rejected" && subject.review.note && (
              <span className="shrink-0 text-[8.5px] text-muted-2">{subject.review.note}</span>
            )}
            <span className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => onReview(subject.assetId, status === "passed" ? null : "passed")}
                disabled={readOnly || !subject.exists}
                title={status === "passed" ? "取消「已看」，回到还没看" : "看过这一条，没问题"}
                className={cn(
                  "rounded-token border px-1.5 py-0.5 text-[8.5px] transition-colors duration-[var(--dur)] disabled:opacity-40",
                  status === "passed"
                    ? "border-line-2 text-text"
                    : "border-line text-muted hover:border-line-2 hover:text-text",
                )}
              >
                已看
              </button>
              <button
                type="button"
                onClick={() => onReview(subject.assetId, status === "rejected" ? null : "rejected")}
                disabled={readOnly || !subject.exists}
                title={status === "rejected" ? "取消「不可用」" : "这一条不能用：会拦住导出"}
                className={cn(
                  "rounded-token border px-1.5 py-0.5 text-[8.5px] transition-colors duration-[var(--dur)] disabled:opacity-40",
                  status === "rejected"
                    ? "border-pick text-pick"
                    : "border-line text-muted hover:border-line-2 hover:text-text",
                )}
              >
                不可用
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function CheckRow({ check }: { check: ComplianceCheck }) {
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <span
        aria-hidden
        className={cn(
          "mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full",
          check.status === "pass"
            ? "bg-line-2"
            : check.status === "review"
              ? "bg-muted"
              : "bg-pick",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[10px] text-text">{check.label}</span>
          <span
            className={cn(
              "text-[8.5px] tracking-[.08em]",
              check.status === "block" ? "text-pick" : "text-muted-2",
            )}
          >
            {CHECK_STATUS[check.status]}
          </span>
        </div>
        <p className="mt-0.5 text-[9px] leading-[1.6] text-muted-2">{check.detail}</p>
      </div>
    </li>
  );
}

/** `+1.2s` / `−0.5s`：挪动量的短写 */
function signedMs(ms: number): string {
  const sign = ms > 0 ? "+" : "−";
  return `${sign}${(Math.abs(ms) / 1000).toFixed(1)}s`;
}

/**
 * 一句台词的一条叠加层微调（E1 / ADR-0131）。
 *
 * 用按钮而不是拖动条：叠加层的意义是「对一下口型 / 让开画面」，
 * 几十毫秒的精度用键盘与按钮反而更好点；Shift 一下走 5 格。
 */
function TrackNudge({
  label,
  offsetMs,
  readOnly,
  onShift,
  onReset,
}: {
  label: string;
  offsetMs: number;
  readOnly: boolean;
  onShift: (delta: number, big: boolean) => void;
  onReset: () => void;
}) {
  const step = (delta: number) => (event: React.MouseEvent) => {
    if (readOnly) return;
    onShift(delta, event.shiftKey);
  };
  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        type="button"
        onClick={step(-100)}
        disabled={readOnly}
        title={`${label}前挪 100ms（按住 Shift 挪 500ms）`}
        className="rounded-token border border-line px-1 py-0.5 text-[9px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
      >
        ‹
      </button>
      <button
        type="button"
        onClick={step(100)}
        disabled={readOnly}
        title={`${label}后挪 100ms（按住 Shift 挪 500ms）`}
        className="rounded-token border border-line px-1 py-0.5 text-[9px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
      >
        ›
      </button>
      <button
        type="button"
        onClick={onReset}
        disabled={readOnly || offsetMs === 0}
        title={`${label}归位`}
        className="rounded-token border border-line px-1 py-0.5 text-[9px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
      >
        ↺
      </button>
    </span>
  );
}

/**
 * 成片页（ADR-0086）：时间线、初剪与导出。
 *
 * 这里放的是「已经定下来的 take」——换 take 是成片层面的决定，
 * 所以写的是整条 `timeline.updated`，而不是再去动分镜。
 */
export function EditScreen() {
  const project = useWorkbench((state) => state.project);
  const hydrate = useWorkbench((state) => state.hydrate);
  const readOnly = useWorkbench((state) => state.readOnly);
  const storageError = useWorkbench((state) => state.storageError);
  const editError = useWorkbench((state) => state.editError);
  const autoCutTimeline = useWorkbench((state) => state.autoCutTimeline);
  const setTimelineTake = useWorkbench((state) => state.setTimelineTake);
  const removeTimelineItem = useWorkbench((state) => state.removeTimelineItem);
  const moveTimelineItem = useWorkbench((state) => state.moveTimelineItem);
  const editSubtitles = useWorkbench((state) => state.editSubtitles);
  const setSubtitleLayout = useWorkbench((state) => state.setSubtitleLayout);
  const shiftLineTrack = useWorkbench((state) => state.shiftLineTrack);
  const reviewAsset = useWorkbench((state) => state.reviewAsset);
  const addMusic = useWorkbench((state) => state.addMusic);
  const updateMusic = useWorkbench((state) => state.updateMusic);
  const removeMusic = useWorkbench((state) => state.removeMusic);
  const fillMusicByCurve = useWorkbench((state) => state.fillMusicByCurve);
  const upsertMotif = useWorkbench((state) => state.upsertMotif);
  const removeMotif = useWorkbench((state) => state.removeMotif);
  const setBudget = useWorkbench((state) => state.setBudget);
  const recordPublish = useWorkbench((state) => state.recordPublish);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  // 删片段要两步：时间线上的一段背后是一整条 take（E1）
  const [deletingClip, setDeletingClip] = useState<string | null>(null);
  const [showSafe, setShowSafe] = useState(true);
  /** 正在手改断句的是哪一句台词；undefined 表示没打开（D2） */
  const [cueLineId, setCueLineId] = useState<string>();
  const [cueDraft, setCueDraft] = useState<string[]>([]);
  const [maxChars, setMaxChars] = useState<SubtitleChars>(DEFAULT_SUBTITLE_CHARS);
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState("");
  const [topics, setTopics] = useState("短剧,AI创作");
  const [platform, setPlatform] = useState<PlatformId>("douyin");
  const [notice, setNotice] = useState("");
  const [rendering, setRendering] = useState(false);
  const [renderStage, setRenderStage] = useState("");
  /** 正在跑的渲染任务号：有它才能取消（H2） */
  const [renderJobId, setRenderJobId] = useState<string>();
  const [quality, setQuality] = useState<RenderQuality>("draft");
  /** 要不要把字幕烧进画面。默认带；关掉导出一版无字幕的，给要自己加字幕的平台 */
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  /** 最近一次成功导出的成片：发布包用它填视频位，不重置、不伪造 */
  const [lastRender, setLastRender] = useState<{
    fileName: string;
    bytes: number;
    quality: RenderQuality;
    renderedAt: string;
    /** 这一次渲染花了多少毫秒（H4）：本机渲染不按文件收费，但机器时间是成本 */
    renderMs?: number;
  }>();
  const [loudness, setLoudness] = useState<LoudnessReport>();
  const [musicFile, setMusicFile] = useState<{
    name: string;
    size: number;
    uri: string;
    mime: string;
    durationMs: number;
  }>();
  const [musicMood, setMusicMood] = useState("紧张");
  const [musicLicense, setMusicLicense] = useState("");
  const [musicBusy, setMusicBusy] = useState(false);
  const [musicError, setMusicError] = useState("");
  const musicPreviewRef = useRef<HTMLAudioElement>(null);
  /** 确认的是哪一版预检：文案一改，指纹变，确认自动失效 */
  const [ackSignature, setAckSignature] = useState<string>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const fired = useRef<Set<string>>(new Set());

  const view = useMemo(() => toEditView(project, { maxChars }), [project, maxChars]);
  const stage = useMemo(() => toStageView(project), [project]);
  const spend = useMemo(() => spendOf(project), [project]);

  // 导出前检查（G8）：标题 / 简介 / 话题也算发布内容，改一个字就要重看
  const report = useMemo(
    () =>
      preflightProject(project, {
        title,
        description,
        topics,
        durationMs: view.totalMs,
        platform,
        ...(lastRender ? { fileBytes: lastRender.bytes } : {}),
      }),
    [project, title, description, topics, view.totalMs, platform, lastRender],
  );
  // 生成结果复核（H6）：会进成片的每一条，逐条给作者看
  const review = useMemo(() => reviewSummaryOf(project), [project]);
  const platformValidation = useMemo(
    () =>
      validatePlatform(platformSpecOf(platform), {
        durationMs: view.totalMs,
        width: 1080,
        height: 1920,
        fps: 30,
        codec: "H.264",
        title,
        topics: topics.split(/[,，\s]+/).filter(Boolean),
        // 导出过才有实际体积与码率；没有就是「导出后再核」
        ...(lastRender ? { fileBytes: lastRender.bytes } : {}),
      }),
    [platform, view.totalMs, title, topics, lastRender],
  );
  const acknowledged = report.review > 0 && ackSignature === report.signature;
  const gateOpen = report.ok && (report.review === 0 || acknowledged);
  // 角标位置跟着目标平台走（H5）：预览、播放器与成片三处共用同一张表
  const badgePlacement = badgePlacementOf(platform);
  const editGate = useMemo(() => stageStateOf(project, "edit"), [project]);
  const finalAllowed = editGate.gate === "confirmed";
  const profile = RENDER_PROFILES[quality];
  const gateReason = !report.ok
    ? `还有 ${report.blocked} 处硬阻断：改完文案再导出。`
    : report.review > 0 && !acknowledged
      ? `有 ${report.review} 处需要人工确认：读完后勾选确认。`
      : "";

  // 版式（D3）以项目为准：档位来自 IR，调过的三项也来自 IR，刷新与换设备都跟着走
  const styleId: SubtitleStyleId = project.subtitleLayout.preset;
  const style: SubtitleStyle = subtitleStyleOf(styleId, project.subtitleLayout);
  const styleCustom = isCustomSubtitleLayout(project.subtitleLayout);
  const current =
    view.clips.find(
      (clip) =>
        elapsed >= clip.startMs && elapsed < clip.startMs + clip.durationMs,
    ) ?? view.clips.at(-1);
  const selected =
    view.clips.find((clip) => clip.id === selectedId) ?? current ?? view.clips[0];
  const selectedIndex = selected
    ? view.clips.findIndex((clip) => clip.id === selected.id)
    : -1;
  const currentCue = view.cues.find(
    (cue) =>
      elapsed >= cue.startMs && elapsed < cue.startMs + cue.durationMs,
  );
  const progress = view.totalMs > 0 ? (elapsed / view.totalMs) * 100 : 0;

  useEffect(() => {
    if (view.clips.length === 0) return;
    if (!selectedId || !view.clips.some((clip) => clip.id === selectedId)) {
      setSelectedId(view.clips[0]!.id);
    }
  }, [view.clips, selectedId]);

  // 播放进度：50ms 一跳，够字幕对上，也不至于让界面一直重排
  useEffect(() => {
    if (!playing) return;
    const handle = window.setInterval(() => {
      setElapsed((prev) => {
        const next = prev + 50;
        if (next >= view.totalMs) {
          setPlaying(false);
          return view.totalMs;
        }
        return next;
      });
    }, 50);
    return () => window.clearInterval(handle);
  }, [playing, view.totalMs]);

  // 画面：当前片段有视频就播，没有就定住首帧
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    if (playing) void element.play().catch(() => {});
    else element.pause();
  }, [playing, current?.id]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    if (!playing) {
      element.pause();
      return;
    }
    for (const clip of view.clips) {
      for (const line of clip.lines) {
        if (!line.audioUri) continue;
        // 按配音实际落点播（E1 / ADR-0131）：挪过的句子不该在原处响
        if (elapsed < line.audioStartMs || elapsed >= line.audioStartMs + line.durationMs) continue;
        if (fired.current.has(line.id)) continue;
        fired.current.add(line.id);
        element.src = assetHref(line.audioUri)!;
        void element.play().catch(() => {});
      }
    }
  }, [elapsed, playing, view.clips]);

  const seekTo = (ms: number) => {
    fired.current.clear();
    setElapsed(Math.max(0, Math.min(ms, view.totalMs)));
    if (audioRef.current) audioRef.current.pause();
  };

  const restart = () => {
    setPlaying(false);
    seekTo(0);
  };

  const editingLine = useMemo(
    () => view.clips.flatMap((clip) => clip.lines).find((line) => line.id === cueLineId),
    [view.clips, cueLineId],
  );

  const openCueEditor = (lineId: string) => {
    const line = view.clips.flatMap((clip) => clip.lines).find((item) => item.id === lineId);
    if (!line) return;
    setCueLineId(lineId);
    setCueDraft(line.cues.map((cue) => cue.text));
  };

  /** 保存手改断句：时长按字数分，整句时长不变（D2） */
  const saveCues = () => {
    if (!editingLine) return;
    const texts = cueDraft.map((text) => text.trim());
    if (texts.some((text) => text.length === 0)) {
      setNotice("每条字幕都要有字：空的那条并到上一行，或删掉。");
      return;
    }
    const totalChars = texts.reduce((sum, text) => sum + text.length, 0);
    const cues = texts.map((text) => ({
      text,
      durationMs: Math.max(1, Math.round((editingLine.durationMs * text.length) / Math.max(1, totalChars))),
    }));
    if (editSubtitles(editingLine.id, cues)) {
      setCueLineId(undefined);
      setNotice("字幕已按你改的断句：SRT、ASS、预览与渲染都跟着变。");
    }
  };

  const restoreCues = () => {
    if (!editingLine) return;
    if (editSubtitles(editingLine.id, null)) {
      setCueLineId(undefined);
      setNotice("已恢复自动断句。");
    }
  };

  const chooseMusic = async (file: File | undefined) => {
    if (!file) return;
    setMusicBusy(true);
    setMusicError("");
    try {
      if (file.size > 18 * 1024 * 1024) {
        throw new Error("文件超过 18 MB：换一段短一点的配乐。");
      }
      const result = await readMusicFile(file);
      setMusicFile({ name: file.name, size: file.size, ...result });
    } catch (error) {
      setMusicFile(undefined);
      setMusicError(error instanceof Error ? error.message : "这条音乐读不进来。");
    } finally {
      setMusicBusy(false);
    }
  };

  const commitMusic = () => {
    if (!musicFile) {
      setMusicError("先选一个音频文件。");
      return;
    }
    if (!musicLicense.trim()) {
      setMusicError("写清授权来源：曲库名、授权书编号，或「自己录制」。");
      return;
    }
    const ok = addMusic({
      uri: musicFile.uri,
      mime: musicFile.mime,
      title: musicFile.name.replace(/\.[^.]+$/, ""),
      mood: musicMood,
      durationMs: musicFile.durationMs,
      licenseRef: musicLicense,
    });
    if (ok) {
      setMusicFile(undefined);
      setMusicLicense("");
      setMusicError("");
      setNotice("配乐已加入：导出时会按台词窗自动 ducking。");
    }
  };

  const toggleMusicPreview = () => {
    const element = musicPreviewRef.current;
    const cue = view.music[0];
    if (!element || !cue?.uri) return;
    if (element.paused) {
      const src = assetHref(cue.uri);
      if (src && element.getAttribute("src") !== src) element.src = src;
      element.currentTime = 0;
      element.volume = Math.pow(10, cue.gainDb / 20);
      void element.play().catch(() => setMusicError("浏览器没能播放这条音乐。"));
    } else {
      element.pause();
    }
  };

  const exportPreview = async () => {
    if (!gateOpen) {
      setNotice(gateReason);
      return;
    }
    // 预览必须自包含（P20）：资产库里的素材先读回字节换成 data URI
    setNotice("正在把素材收进预览…");
    const { view: hydrated, failed } = await hydrateView(view);
    const html = buildPreviewHtml(hydrated, style, platform);
    const size = new Blob([html]).size;
    downloadFile(safeFileName(view.title, "预览.html"), html, "text/html");
    setNotice(
      `预览已导出：${(size / 1024 / 1024).toFixed(1)} MB。双击打开就能播；素材是内嵌的。${
        failed > 0 ? `有 ${failed} 个素材没读回来，预览里仍指向本机地址。` : ""
      }`,
    );
  };

  const exportVideo = async () => {
    if (rendering) return;
    if (!gateOpen) {
      setNotice(gateReason);
      return;
    }
    if (quality === "final" && !finalAllowed) {
      setNotice("定稿渲染要先在页面底部确认这一版成片；还没确认时只能导出草稿。");
      return;
    }
    setRendering(true);
    setNotice("");
    // 本机渲染的机器时间（H4）：不折成钱，但账单里要看得见
    const renderStartedAt = Date.now();
    try {
      const result = await exportMp4(
        view,
        style,
        renderComplianceOf(report, acknowledged),
        quality,
        setRenderStage,
        { subtitles: burnSubtitles, platform, onJob: setRenderJobId },
      );
      const mb = formatSize(result.bytes);
      const notes: string[] = [];
      if (result.placeholders > 0) notes.push(`${result.placeholders} 个片段用占位图`);
      if (result.remoteSkipped > 0) notes.push(`${result.remoteSkipped} 个远端素材没下载`);
      setLoudness(result.loudness);
      if (result.loudness) notes.push(result.loudness.detail);
      setLastRender({
        fileName: result.fileName,
        bytes: result.bytes,
        quality,
        renderedAt: new Date().toISOString(),
        renderMs: Date.now() - renderStartedAt,
      });
      setNotice(
        `${profile.label}成片已导出：${mb} MB · ${profile.width}×${profile.height} / ${profile.fps}fps · ${
          burnSubtitles ? "带字幕" : "无字幕"
        }与「AI 生成」角标${notes.length > 0 ? `。${notes.join("；")}` : ""}。`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "渲染失败");
    } finally {
      setRendering(false);
      setRenderStage("");
      setRenderJobId(undefined);
    }
  };

  const cancelRenderJob = async () => {
    if (!renderJobId) return;
    const ok = await cancelRender(renderJobId);
    setNotice(
      ok
        ? "已取消这一条渲染：没有交付半成品，重新点导出即可。"
        : "这条任务可能已经结束了，刷新一下状态。",
    );
  };

  const exportOtio = async () => {
    if (!gateOpen) {
      setNotice(gateReason);
      return;
    }
    // OTIO 要能被剪辑软件直接打开：资产库地址先换成内嵌字节（P20 自包含）
    const { view: hydrated, failed } = await hydrateView(view);
    const otio = buildOtio(hydrated);
    downloadFile(
      safeFileName(view.title, "时间线.otio"),
      JSON.stringify(otio, null, 2),
      "application/json",
    );
    setNotice(
      `时间线已按 OTIO 导出：可以拿到剪辑软件里继续剪。${
        failed > 0 ? `有 ${failed} 个素材没读回来，时间线里仍指向本机地址。` : ""
      }`,
    );
  };

  const exportSrt = () => {
    if (!gateOpen) {
      setNotice(gateReason);
      return;
    }
    downloadFile(safeFileName(view.title, "字幕.srt"), buildSrt(view), "text/plain");
    setNotice("字幕已导出（SRT）：时间按初剪的绝对时间。");
  };

  const exportAss = () => {
    if (!gateOpen) {
      setNotice(gateReason);
      return;
    }
    downloadFile(
      safeFileName(view.title, "字幕.ass"),
      buildAss(view, style),
      "text/plain",
    );
    setNotice(
      `字幕已导出（ASS）：带「${style.label}」样式，字号与底边距离和成片页一致，剪辑软件里不用再调。`,
    );
  };

  const exportPackage = async () => {
    if (!gateOpen) {
      setNotice(gateReason);
      return;
    }
    // 封面也是素材：资产库地址先换成内嵌字节，发布包里不留本机路径
    const { view: hydrated, failed } = await hydrateView(view);
    const pack = buildPublishPackage(hydrated, {
      title,
      description,
      topics: topics.split(/[,，\s]+/),
      style: styleId,
      kind: lastRender?.quality ?? quality,
      platform,
      compliance: renderComplianceOf(report, acknowledged),
      ...(lastRender ? { video: lastRender } : {}),
    });
    downloadFile(
      safeFileName(view.title, "发布包.json"),
      JSON.stringify(pack, null, 2),
      "application/json",
    );
    const recorded = recordPublish({
      platform,
      quality: lastRender?.quality,
      fileName: lastRender?.fileName,
      bytes: lastRender?.bytes,
      ...(lastRender?.renderMs !== undefined ? { renderMs: lastRender.renderMs } : {}),
      contentHash: pack.aiLabelRecord?.contentHash,
    });
    const tail = recorded ? "已记进项目的发布记录。" : "项目是只读的，这次没有记进发布记录。";
    setNotice(
      `${
        pack.warnings.length > 0
          ? `发布包已导出。${tail}还有几件事没齐：${pack.warnings.join("；")}。`
          : `发布包已导出：标题、简介、话题、封面、字幕、成片信息与 AI 标注都在里面。${tail}`
      }${failed > 0 ? `有 ${failed} 个素材没读回来，封面仍是本机地址。` : ""}`,
    );
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
      <TopBar
        title={view.title}
        version={view.version}
        stage="成片"
        spentCny={spend.spent}
        budgetCny={project.budgetCny}
        unpriced={spend.unpriced}
        spendBreakdown={spend}
        storageError={storageError}
        readOnly={readOnly}
        onBudgetChange={setBudget}
      />

      {editError && (
        <p className="shrink-0 px-6 pb-1 pt-2 text-[10.5px] leading-[1.6] text-pick">{editError}</p>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-[1080px]">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <div>
              <h1 className="text-[13px] tracking-[.06em] text-text">成片</h1>
              <p className="mt-1 text-[10.5px] leading-[1.6] text-muted-2">
                初剪按剧本顺序排好每一镜；换 take 之后，这里的时间线就是最终决定。
              </p>
            </div>
            <dl className="tnum flex flex-wrap items-baseline gap-5 text-[10.5px]">
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-2">全长</dt>
                <dd className="text-muted">{view.totalSec.toFixed(1)}s</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-2">片段</dt>
                <dd className="text-muted">{view.clips.length}</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-2">字幕</dt>
                <dd className="text-muted">{view.cues.length} 条</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-2">没画面</dt>
                <dd className={view.noPicture > 0 ? "text-pick" : "text-muted"}>
                  {view.noPicture}
                </dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-2">有配音</dt>
                <dd className="text-muted">{view.withVoice} 镜</dd>
              </div>
            </dl>
          </div>

          {view.clips.length === 0 ? (
            <section className="mt-10 flex flex-col items-center gap-4 border border-dashed border-line px-6 py-12 text-center">
              <p className="max-w-[420px] text-[11.5px] leading-[1.8] text-muted">
                时间线还是空的。初剪会按剧本顺序铺开每一镜：优先用「留用」的 take，
                没有留用就用最新一条没被淘汰的；一条可用的都没有的镜头会先跳过并告诉你。
              </p>
              <button
                type="button"
                onClick={() => {
                  autoCutTimeline();
                  seekTo(0);
                }}
                disabled={Boolean(readOnly)}
                className="rounded-token border border-pick bg-pick px-4 py-1.5 text-[11px] text-white transition-opacity duration-[var(--dur)] hover:opacity-90 disabled:opacity-40"
              >
                自动初剪
              </button>
              <p className="text-[9.5px] text-muted-2">
                已经有 take 的镜头：{stage.shots.filter((shot) => shot.takes.length > 0).length} /{" "}
                {stage.shots.length}
              </p>
            </section>
          ) : (
            <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
              {/* 播放器 */}
              <section aria-label="成片预览">
                <div
                  className="relative w-full overflow-hidden border border-line bg-black"
                  style={{ aspectRatio: "9 / 16", containerType: "inline-size" }}
                >
                  {current?.uri ? (
                    <video
                      key={current.id}
                      ref={videoRef}
                      src={assetHref(current.uri)}
                      muted
                      playsInline
                      preload="metadata"
                      onLoadedMetadata={(event) => {
                        const offset = (elapsed - current.startMs) / 1000;
                        try {
                          event.currentTarget.currentTime = Math.max(0, offset);
                        } catch {
                          // 解不开的素材没必要拦播放
                        }
                      }}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : current?.stillUri ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={assetHref(current.stillUri)}
                      alt={`${shotLabel(current.shotNo)} 的画面`}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center bg-[repeating-linear-gradient(45deg,#111,#111_12px,#151515_12px,#151515_24px)] text-[10.5px] text-muted-2">
                      {shotLabel(current?.shotNo ?? 0)} 还没有画面
                    </div>
                  )}

                  {showSafe && (
                    <div
                      className="pointer-events-none absolute border border-dashed border-white/15"
                      style={{
                        top: `${SAFE_AREA.topPct}%`,
                        bottom: `${SAFE_AREA.bottomPct}%`,
                        left: `${SAFE_AREA.sidePct}%`,
                        right: `${SAFE_AREA.sidePct}%`,
                      }}
                    >
                      <span className="absolute -top-4 left-0 text-[8.5px] text-white/35">
                        安全区
                      </span>
                    </div>
                  )}

                  {currentCue && (
                    <p
                      className="absolute text-center font-semibold text-white"
                      style={{
                        left: `${SAFE_AREA.sidePct}%`,
                        right: `${SAFE_AREA.sidePct}%`,
                        bottom: `${style.bottomPct}%`,
                        fontSize: `${style.fontSizeCqw}cqw`,
                        lineHeight: 1.38,
                        letterSpacing: ".02em",
                        textShadow: `0 0 ${style.strokeCqw}cqw #000, 0 0 ${style.strokeCqw}cqw #000, 0 ${style.strokeCqw * 0.5}cqw ${style.strokeCqw * 1.2}cqw #000`,
                      }}
                    >
                      {currentCue.text}
                    </p>
                  )}

                  <span
                    className={cn(
                      "absolute rounded-token bg-black/55 px-1.5 py-0.5 text-[8.5px] text-white/80",
                      // 镜号与锁定标是编辑用的，不是画面的一部分：角标占了上排就让它们下移
                      badgePlacement.corner === "tl" ? "bottom-2 left-2" : "left-2 top-2",
                    )}
                  >
                    {current ? `${shotLabel(current.shotNo)} · ${current.takeNo} 版` : ""}
                  </span>
                  {current?.locked && (
                    <span
                      className={cn(
                        "absolute rounded-token bg-black/55 px-1.5 py-0.5 text-[8.5px] text-white/80",
                        badgePlacement.corner === "tr" ? "bottom-2 right-2" : "right-2 top-2",
                      )}
                    >
                      已锁定
                    </span>
                  )}
                  <span
                    aria-label="AI 生成内容标识"
                    className={cn(
                      "pointer-events-none absolute rounded-token border border-white/15 bg-black/55 px-1.5 py-0.5 text-[8.5px] tracking-[.08em] text-white/80",
                      badgePlacement.corner === "tl" && "left-2 top-2",
                      badgePlacement.corner === "tr" && "right-2 top-2",
                      badgePlacement.corner === "bl" && "bottom-2 left-2",
                      badgePlacement.corner === "br" && "bottom-2 right-2",
                    )}
                  >
                    AI 生成
                  </span>
                </div>

                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPlaying((prev) => !prev)}
                    className="rounded-token border border-line px-3 py-1 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-line-2"
                  >
                    {playing ? "暂停" : "播放"}
                  </button>
                  <button
                    type="button"
                    onClick={restart}
                    className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                  >
                    重来
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowSafe((prev) => !prev)}
                    aria-pressed={showSafe}
                    className={cn(
                      "rounded-token border px-2.5 py-1 text-[10.5px] transition-colors duration-[var(--dur)]",
                      showSafe
                        ? "border-line-2 text-text"
                        : "border-line text-muted hover:border-line-2",
                    )}
                  >
                    安全区
                  </button>
                  <span className="tnum ml-auto text-[9.5px] text-muted-2">
                    {timecode(elapsed)} / {timecode(view.totalMs)}
                  </span>
                </div>

                <input
                  type="range"
                  min={0}
                  max={view.totalMs}
                  step={50}
                  value={elapsed}
                  onChange={(event) => seekTo(Number(event.target.value))}
                  aria-label="播放进度"
                  className="mt-2 w-full accent-[var(--pick)]"
                />

                <audio ref={audioRef} className="hidden" />
              </section>

              {/* 时间线与导出 */}
              <div className="min-w-0">
                <section aria-label="时间线">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-[11px] tracking-[.06em] text-text">时间线</h2>
                    <button
                      type="button"
                      onClick={() => {
                        autoCutTimeline();
                        seekTo(0);
                      }}
                      disabled={Boolean(readOnly)}
                      title="按剧本顺序重新排一遍：优先留用，其次最新草稿"
                      className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
                    >
                      重新初剪
                    </button>
                  </div>

                  <div className="mt-2 flex h-[46px] w-full overflow-hidden rounded-token border border-line bg-surface">
                    {view.clips.map((clip) => (
                      <button
                        key={clip.id}
                        type="button"
                        onClick={() => {
                          setSelectedId(clip.id);
                          seekTo(clip.startMs);
                        }}
                        title={`${shotLabel(clip.shotNo)} · ${fmtSec(clip.durationMs)}`}
                        style={{
                          width: `${(clip.durationMs / Math.max(1, view.totalMs)) * 100}%`,
                        }}
                        className={cn(
                          "flex min-w-[2px] items-center justify-center overflow-hidden border-r border-bg text-[8.5px] transition-colors duration-[var(--dur)] last:border-r-0",
                          selected?.id === clip.id
                            ? "bg-pick/25 text-text"
                            : clip.hasPicture
                              ? "bg-line-2/60 text-muted hover:bg-line-2"
                              : "bg-[repeating-linear-gradient(45deg,#17171a,#17171a_6px,#111_6px,#111_12px)] text-muted-2 hover:bg-line",
                        )}
                      >
                        {shotLabel(clip.shotNo)}
                      </button>
                    ))}
                  </div>

                  <div className="mt-1 flex justify-between text-[8.5px] text-muted-2">
                    <span>0s</span>
                    <span className="tnum">{view.totalSec.toFixed(1)}s</span>
                  </div>

                  <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-[11px] tracking-[.06em] text-text">字幕</h2>
                    <label className="flex items-center gap-2 text-[9.5px] text-muted-2">
                      每行字数
                      <select
                        value={maxChars}
                        onChange={(event) =>
                          setMaxChars(Number(event.target.value) as SubtitleChars)
                        }
                        className="rounded-token border border-line bg-transparent px-1.5 py-0.5 text-[10px] text-text focus:border-line-2 focus:outline-none"
                      >
                        {SUBTITLE_CHARS.map((count) => (
                          <option key={count} value={count} className="bg-surface">
                            {count} 字
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {/* 按绝对时间定位：字幕被挪过时，条上能看见它离开原来的位置（E1） */}
                  <div className="relative mt-2 h-[26px] w-full overflow-hidden rounded-token border border-line bg-surface">
                    {view.cues.map((cue) => (
                      <button
                        key={cue.id}
                        type="button"
                        onClick={() => {
                          seekTo(cue.startMs);
                          openCueEditor(cue.lineId);
                        }}
                        title={`${timecode(cue.startMs)} · ${cue.characterName}：${cue.text}${cue.manual ? "（手改过）" : ""} · 点开改断句`}
                        style={{
                          left: `${(cue.startMs / Math.max(1, view.totalMs)) * 100}%`,
                          width: `${(cue.durationMs / Math.max(1, view.totalMs)) * 100}%`,
                        }}
                        className={cn(
                          "absolute top-0 flex h-full min-w-[2px] items-center justify-center overflow-hidden border-r border-bg px-0.5 text-[8px] transition-colors duration-[var(--dur)]",
                          elapsed >= cue.startMs &&
                            elapsed < cue.startMs + cue.durationMs
                            ? "bg-text/20 text-text"
                            : "bg-line/50 text-muted hover:bg-line-2",
                        )}
                      >
                        <span className="truncate">
                          {cue.manual && <span className="mr-0.5 text-text">·</span>}
                          {cue.text}
                        </span>
                      </button>
                    ))}
                    {view.cues.length === 0 && (
                      <span className="flex h-full items-center px-2 text-[9px] text-muted-2">
                        时间线里还没有台词
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[8.5px] leading-[1.6] text-muted-2">
                    按标点断句，时间按字数分；改字数档位，断句会立刻重排。点一条字幕跳到那一句，同时打开手改。
                  </p>

                  {editingLine && (
                    <div className="mt-2 rounded-token border border-line bg-surface/60 p-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-[10px] text-text">
                          手改断句 · {editingLine.characterName}
                          {editingLine.manual && (
                            <span className="ml-1 text-[9px] text-muted-2">（已手改）</span>
                          )}
                        </span>
                        <span className="tnum text-[9px] text-muted-2">
                          整句 {fmtSec(editingLine.durationMs)}
                        </span>
                      </div>
                      <p className="mt-1 text-[9px] leading-[1.6] text-muted-2">
                        原句：{editingLine.text}
                      </p>
                      <div className="mt-1.5 flex flex-col gap-1">
                        {cueDraft.map((text, index) => (
                          <div key={index} className="flex items-center gap-1">
                            <span className="tnum w-3 shrink-0 text-[9px] text-muted-2">
                              {index + 1}
                            </span>
                            <input
                              value={text}
                              onChange={(event) =>
                                setCueDraft((prev) =>
                                  prev.map((item, at) => (at === index ? event.target.value : item)),
                                )
                              }
                              maxLength={200}
                              className="min-w-0 flex-1 rounded-token border border-line bg-transparent px-1.5 py-0.5 text-[10px] text-text focus:border-line-2 focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setCueDraft((prev) => {
                                  const cut = Math.max(1, Math.ceil(text.length / 2));
                                  return [
                                    ...prev.slice(0, index),
                                    text.slice(0, cut).trim(),
                                    text.slice(cut).trim(),
                                    ...prev.slice(index + 1),
                                  ];
                                })
                              }
                              disabled={text.trim().length < 2}
                              title="从中间拆成两条"
                              className="shrink-0 rounded-token border border-line px-1 py-0.5 text-[9px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
                            >
                              拆
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setCueDraft((prev) =>
                                  prev.length <= 1
                                    ? prev
                                    : [
                                        ...prev.slice(0, index - 1),
                                        `${prev[index - 1] ?? ""}${text}`,
                                        ...prev.slice(index + 1),
                                      ],
                                )
                              }
                              disabled={index === 0 || cueDraft.length <= 1}
                              title="并到上一条"
                              className="shrink-0 rounded-token border border-line px-1 py-0.5 text-[9px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
                            >
                              并
                            </button>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={saveCues}
                          disabled={readOnly}
                          className="rounded-token border border-line-2 bg-text/10 px-2 py-0.5 text-[9.5px] text-text transition-colors duration-[var(--dur)] hover:bg-text/20 disabled:opacity-40"
                        >
                          保存断句
                        </button>
                        <button
                          type="button"
                          onClick={() => setCueLineId(undefined)}
                          className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                        >
                          不改了
                        </button>
                        {editingLine.manual && (
                          <button
                            type="button"
                            onClick={restoreCues}
                            disabled={readOnly}
                            className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
                          >
                            恢复自动断句
                          </button>
                        )}
                        <span className="text-[8.5px] text-muted-2">
                          时长按字数分，整句总长不变
                        </span>
                      </div>
                    </div>
                  )}

                  {view.missing > 0 && (
                    <p className="mt-1 text-[9.5px] text-muted-2">
                      剧本里还有 {view.missing} 镜没进时间线（多半是没有可用 take）。
                    </p>
                  )}

                  {view.noPicture > 0 && (
                    <p className="mt-1 text-[9.5px] text-muted-2">
                      {view.noPicture} 个片段三样都没有（视频 / 首帧 / 尾帧）：时间线照留位置，画面位先空着。
                    </p>
                  )}
                </section>

                {selected && (
                  <section aria-label="换这一镜的 take" className="mt-5 border-t border-line pt-4">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <h2 className="text-[11px] tracking-[.06em] text-text">
                        {shotLabel(selected.shotNo)} 用哪一版
                      </h2>
                      <span className="text-[9.5px] text-muted-2">
                        {fmtSec(selected.durationMs)} · 起点 {timecode(selected.startMs)}
                      </span>
                    </div>
                    {/* 挪位置 / 删片段（E1）：起点永远由顺序推出，不留空隙 */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[9px]">
                      <button
                        type="button"
                        disabled={Boolean(readOnly) || selectedIndex <= 0}
                        onClick={() => moveTimelineItem(selected.id, -1)}
                        title="与上一段换位置：起点重新排，不留空隙"
                        className="rounded-token border border-line px-1.5 py-px text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        ← 前移
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(readOnly) || selectedIndex >= view.clips.length - 1}
                        onClick={() => moveTimelineItem(selected.id, 1)}
                        title="与下一段换位置：起点重新排，不留空隙"
                        className="rounded-token border border-line px-1.5 py-px text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        后移 →
                      </button>
                      {deletingClip === selected.id ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              removeTimelineItem(selected.id);
                              setDeletingClip(null);
                              setSelectedId(undefined);
                              seekTo(0);
                            }}
                            className="rounded-token border border-pick/70 px-1.5 py-px text-pick transition-colors duration-[var(--dur)] hover:border-pick"
                          >
                            确认删这一段
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeletingClip(null)}
                            className="rounded-token border border-line px-1.5 py-px text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={Boolean(readOnly)}
                          onClick={() => setDeletingClip(selected.id)}
                          title="只从时间线摘掉这一段（take 还在，重新初剪能排回来）"
                          className="rounded-token border border-line px-1.5 py-px text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          删这一段
                        </button>
                      )}
                      <span className="text-muted-2">
                        第 {selectedIndex + 1} / {view.clips.length} 段
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selected.takes.map((take) => (
                        <button
                          key={take.id}
                          type="button"
                          disabled={
                            Boolean(readOnly) ||
                            take.status === "rejected" ||
                            take.id === selected.takeId
                          }
                          onClick={() => {
                            setNotice("");
                            setTimelineTake(selected.id, take.id);
                          }}
                          title={
                            take.status === "rejected"
                              ? "已淘汰的 take 不再进成片"
                              : take.hasVideo
                                ? "换成这一版"
                                : "这一版没有视频地址"
                          }
                          className={cn(
                            "rounded-token border px-2 py-1 text-[9.5px] transition-colors duration-[var(--dur)]",
                            take.id === selected.takeId
                              ? "border-pick text-text"
                              : "border-line text-muted hover:border-line-2 hover:text-text",
                            take.status === "rejected" && "opacity-40",
                          )}
                        >
                          第 {take.no} 版 · {STATUS_LABEL[take.status]}
                          {take.hasVideo ? "" : " · 无视频"}
                        </button>
                      ))}
                      {selected.takes.length === 0 && (
                        <p className="text-[10px] text-muted-2">这一镜还没有 take。</p>
                      )}
                    </div>
                    {selected.lines.length > 0 && (
                      <ul className="mt-3 border-t border-line">
                        {selected.lines.map((line) => (
                          <li
                            key={line.id}
                            className="flex items-start gap-3 border-b border-line py-1.5 text-[10px]"
                          >
                            <span className="tnum w-[46px] shrink-0 text-muted-2">
                              {timecode(line.startMs)}
                            </span>
                            <span className="w-[46px] shrink-0 text-muted">{line.characterName}</span>
                            <span className="min-w-0 flex-1 text-text">{line.text}</span>
                            {line.cues.length > 1 && (
                              <span className="shrink-0 text-[8.5px] text-muted-2">
                                {line.cues.length} 行
                              </span>
                            )}
                            <span
                              className={cn(
                                "shrink-0 text-[8.5px]",
                                line.audioUri ? "text-muted" : "text-muted-2",
                              )}
                            >
                              {line.audioUri ? "有声" : "没配"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}

                <section aria-label="音轨与字幕轨" className="mt-5 border-t border-line pt-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-[11px] tracking-[.06em] text-text">音轨与字幕轨</h2>
                    <span className="text-[8.5px] tracking-[.06em] text-muted-2">E1</span>
                  </div>
                  <p className="mt-1 text-[9px] leading-[1.7] text-muted-2">
                    画面轨必须首尾相接（渲染清单要求），所以能单独挪的只有配音与字幕：
                    点一下挪 100ms，按住 <kbd className="rounded border border-line px-1">Shift</kbd>{" "}
                    挪 500ms。两句都挪过时，「归位」只归这一条轨。
                  </p>
                  {view.clips.some((clip) => clip.lines.length > 0) ? (
                    <ul className="mt-2 border-t border-line">
                      {view.clips.flatMap((clip) =>
                        clip.lines.map((line) => {
                          const shifted = line.voiceOffsetMs !== 0 || line.subtitleOffsetMs !== 0;
                          return (
                            <li
                              key={line.id}
                              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-1.5 text-[10px]"
                            >
                              <span className="tnum w-[46px] shrink-0 text-muted-2">
                                {timecode(line.startMs)}
                              </span>
                              <span className="w-[42px] shrink-0 text-muted">
                                {line.characterName}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-text">
                                {line.text}
                              </span>
                              <div className="flex shrink-0 items-center gap-1">
                                <span className="text-[8.5px] text-muted-2">配音</span>
                                <TrackNudge
                                  label="配音"
                                  offsetMs={line.voiceOffsetMs}
                                  readOnly={Boolean(readOnly)}
                                  onShift={(delta, big) =>
                                    shiftLineTrack(line.id, "voice", big ? delta * 5 : delta)
                                  }
                                  onReset={() => shiftLineTrack(line.id, "voice", null)}
                                />
                              </div>
                              <div className="flex shrink-0 items-center gap-1">
                                <span className="text-[8.5px] text-muted-2">字幕</span>
                                <TrackNudge
                                  label="字幕"
                                  offsetMs={line.subtitleOffsetMs}
                                  readOnly={Boolean(readOnly)}
                                  onShift={(delta, big) =>
                                    shiftLineTrack(line.id, "subtitle", big ? delta * 5 : delta)
                                  }
                                  onReset={() => shiftLineTrack(line.id, "subtitle", null)}
                                />
                              </div>
                              {shifted && (
                                <span className="shrink-0 text-[8.5px] text-muted">
                                  {line.voiceOffsetMs !== 0 && `配音 ${signedMs(line.voiceOffsetMs)}`}
                                  {line.voiceOffsetMs !== 0 && line.subtitleOffsetMs !== 0 && " · "}
                                  {line.subtitleOffsetMs !== 0 && `字幕 ${signedMs(line.subtitleOffsetMs)}`}
                                </span>
                              )}
                            </li>
                          );
                        }),
                      )}
                    </ul>
                  ) : (
                    <p className="mt-2 text-[9.5px] text-muted-2">时间线里还没有台词。</p>
                  )}
                </section>

                <section aria-label="配乐" className="mt-5 border-t border-line pt-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-[11px] tracking-[.06em] text-text">配乐</h2>
                    <span className="text-[8.5px] tracking-[.06em] text-muted-2">C4 · C12</span>
                  </div>

                  {view.music.length === 0 ? (
                    <>
                      <p className="mt-1 text-[9.5px] leading-[1.7] text-muted-2">
                        选一条自己有权使用的音乐。加入后默认循环铺满全片，台词出现时自动压低
                        15 dB；整片混音会归一到 −14 LUFS。
                      </p>
                      <div className="mt-2 flex flex-wrap items-end gap-2">
                        <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[9.5px] text-muted-2">
                          音乐文件
                          <input
                            type="file"
                            accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg"
                            disabled={Boolean(readOnly) || musicBusy}
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              void chooseMusic(file);
                              event.target.value = "";
                            }}
                            className="rounded-token border border-line bg-transparent px-2 py-1 text-[10px] text-muted file:mr-2 file:rounded-token file:border-0 file:bg-line file:px-2 file:py-0.5 file:text-[9.5px] file:text-text"
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-[9.5px] text-muted-2">
                          情绪
                          <select
                            value={musicMood}
                            onChange={(event) => setMusicMood(event.target.value)}
                            className="rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                          >
                            {["紧张", "悬疑", "温柔", "悲伤", "燃", "轻松"].map((mood) => (
                              <option key={mood} value={mood} className="bg-surface">
                                {mood}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="mt-2 flex flex-wrap items-end gap-2">
                        <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[9.5px] text-muted-2">
                          授权来源（必填）
                          <input
                            value={musicLicense}
                            onChange={(event) => setMusicLicense(event.target.value)}
                            placeholder="例如：Artlist 授权 / 授权书 2026-11-01 / 自己录制"
                            className="rounded-token border border-line bg-transparent px-2 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={commitMusic}
                          disabled={
                            Boolean(readOnly) ||
                            musicBusy ||
                            !musicFile ||
                            !musicLicense.trim()
                          }
                          className="rounded-token border border-line px-3 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          加入配乐
                        </button>
                      </div>
                      {musicFile && (
                        <p className="mt-1 text-[9px] text-muted">
                          已读入 {musicFile.name} · {fmtSec(musicFile.durationMs)} ·{" "}
                          {(musicFile.size / 1024 / 1024).toFixed(1)} MB
                        </p>
                      )}
                      {musicBusy && (
                        <p className="mt-1 text-[9px] text-muted-2">正在读音频与时长…</p>
                      )}
                      {musicError && (
                        <p className="mt-1 text-[9px] leading-[1.6] text-pick">{musicError}</p>
                      )}
                      <p className="mt-1 text-[8.5px] leading-[1.6] text-muted-2">
                        mp3 / m4a / wav / ogg，≤ 18 MB。没有授权来源的音乐不会进项目；
                        上传素材在导出前检查里还会再要求确认一次。
                      </p>
                    </>
                  ) : (
                    view.music.map((cue) => (
                      <div key={cue.id} className="mt-2 rounded-token border border-line p-2.5">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate text-[10.5px] text-text">
                            {cue.title}
                          </span>
                          <span className="text-[8.5px] text-muted-2">
                            {cue.assetDurationMs ? fmtSec(cue.assetDurationMs) : "时长未知"} ·{" "}
                            {cue.loop ? "循环铺满" : "只播一遍"} · 全片 {fmtSec(cue.durationMs)}
                          </span>
                        </div>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <label className="flex items-center gap-2 text-[9.5px] text-muted-2">
                            基准增益
                            <input
                              type="range"
                              min={-40}
                              max={0}
                              step={1}
                              value={cue.gainDb}
                              disabled={Boolean(readOnly)}
                              onChange={(event) =>
                                updateMusic({ gainDb: Number(event.target.value) }, cue.id)
                              }
                              className="min-w-0 flex-1 accent-[var(--pick)]"
                            />
                            <span className="tnum w-[42px] text-right text-[9px] text-muted">
                              {cue.gainDb} dB
                            </span>
                          </label>
                          <label className="flex items-center gap-2 text-[9.5px] text-muted-2">
                            台词下压低
                            <input
                              type="range"
                              min={12}
                              max={18}
                              step={1}
                              value={cue.duckDb}
                              disabled={Boolean(readOnly) || !cue.ducking}
                              onChange={(event) =>
                                updateMusic({ duckDb: Number(event.target.value) }, cue.id)
                              }
                              className="min-w-0 flex-1 accent-[var(--pick)]"
                            />
                            <span className="tnum w-[42px] text-right text-[9px] text-muted">
                              {cue.duckDb} dB
                            </span>
                          </label>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-3">
                          <label className="flex cursor-pointer items-center gap-1.5 text-[9.5px] text-muted">
                            <input
                              type="checkbox"
                              checked={cue.ducking}
                              disabled={Boolean(readOnly)}
                              onChange={(event) =>
                                updateMusic({ ducking: event.target.checked }, cue.id)
                              }
                              className="accent-[var(--pick)]"
                            />
                            台词下自动 ducking
                          </label>
                          <label className="flex items-center gap-1.5 text-[9.5px] text-muted-2">
                            情绪
                            <select
                              value={cue.mood}
                              disabled={Boolean(readOnly)}
                              onChange={(event) =>
                                updateMusic({ mood: event.target.value }, cue.id)
                              }
                              className="rounded-token border border-line bg-transparent px-1 py-0.5 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
                            >
                              {["", "紧张", "悬疑", "温柔", "悲伤", "燃", "轻松"].map((mood) => (
                                <option key={mood || "none"} value={mood} className="bg-surface">
                                  {mood || "未标"}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            type="button"
                            onClick={toggleMusicPreview}
                            className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                          >
                            试听
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              removeMusic(cue.id);
                              setLoudness(undefined);
                            }}
                            disabled={Boolean(readOnly)}
                            className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-pick enabled:hover:text-pick disabled:opacity-40"
                          >
                            移除
                          </button>
                          <audio ref={musicPreviewRef} className="hidden" />
                        </div>
                        <p className="mt-1.5 text-[8.5px] leading-[1.6] text-muted-2">
                          授权：{cue.licenseRef} · 导出时混音总线归一到 −14 LUFS，真峰值目标 ≤ −1
                          dBTP。
                        </p>
                      </div>
                    ))
                  )}

                  <MusicCurvePanel
                    project={project}
                    readOnly={Boolean(readOnly)}
                    onFill={(cueId) => fillMusicByCurve(cueId)}
                    onUpdateCue={(patch, cueId) => {
                      updateMusic(patch, cueId);
                    }}
                    onUpsertMotif={(input) => upsertMotif(input)}
                    onRemoveMotif={(motifId) => {
                      removeMotif(motifId);
                    }}
                  />

                  {loudness && (
                    <div className="mt-2 rounded-token border border-line bg-surface/60 px-2.5 py-2">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-[9.5px] text-text">上次成片响度实测</span>
                        <span
                          className={cn(
                            "text-[8.5px] tracking-[.06em]",
                            loudness.verdict === "pass"
                              ? "text-muted-2"
                              : loudness.verdict === "fail"
                                ? "text-pick"
                                : "text-muted",
                          )}
                        >
                          {loudness.verdict === "pass"
                            ? "达标"
                            : loudness.verdict === "review"
                              ? "需人工试听"
                              : loudness.verdict === "unmeasured"
                                ? "未测"
                                : "未达标"}
                        </span>
                        <span className="tnum ml-auto text-[8.5px] text-muted-2">
                          {loudness.integratedLufs === null
                            ? "LUFS 未测"
                            : `${loudness.integratedLufs.toFixed(1)} LUFS`}
                          {" · "}
                          {loudness.truePeakDb === null
                            ? "真峰值未测"
                            : `${loudness.truePeakDb.toFixed(1)} dBTP`}
                        </span>
                      </div>
                      <p className="mt-1 text-[8.5px] leading-[1.6] text-muted-2">
                        {loudness.detail}
                        {loudness.monoMs !== null && loudness.monoMs > 0
                          ? `；检出单声道 / 近单声道 ${(loudness.monoMs / 1000).toFixed(1)} 秒`
                          : ""}
                      </p>
                    </div>
                  )}
                </section>

                <section aria-label="导出" className="mt-6 border-t border-line pt-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-[11px] tracking-[.06em] text-text">导出</h2>
                    <label className="flex items-center gap-2 text-[9.5px] text-muted-2">
                      字幕模板
                      <select
                        value={styleId}
                        disabled={readOnly}
                        onChange={(event) =>
                          setSubtitleLayout({ preset: event.target.value as SubtitleStyleId })
                        }
                        className="rounded-token border border-line bg-transparent px-1.5 py-0.5 text-[10px] text-text focus:border-line-2 focus:outline-none disabled:opacity-40"
                      >
                        {Object.values(SUBTITLE_STYLES).map((item) => (
                          <option key={item.id} value={item.id} className="bg-surface">
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="mt-2 rounded-token border border-line bg-surface/60 p-2.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-[10px] text-text">
                        版式微调
                        {styleCustom && (
                          <span className="ml-1 text-[9px] text-muted-2">（已调）</span>
                        )}
                      </span>
                      <span className="text-[8.5px] text-muted-2">
                        预览、ASS 与成片共用这一份
                      </span>
                    </div>
                    <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
                      <label className="flex items-center gap-2 text-[9.5px] text-muted-2">
                        字号
                        <input
                          type="range"
                          min={2}
                          max={12}
                          step={0.1}
                          value={style.fontSizeCqw}
                          disabled={readOnly}
                          onChange={(event) =>
                            setSubtitleLayout({ fontSizeCqw: Number(event.target.value) })
                          }
                          className="min-w-0 flex-1 accent-[var(--pick)]"
                        />
                        <span className="tnum w-[38px] text-right text-[9px] text-muted">
                          {style.fontSizeCqw.toFixed(1)}
                        </span>
                      </label>
                      <label className="flex items-center gap-2 text-[9.5px] text-muted-2">
                        离底边
                        <input
                          type="range"
                          min={2}
                          max={45}
                          step={0.5}
                          value={style.bottomPct}
                          disabled={readOnly}
                          onChange={(event) =>
                            setSubtitleLayout({ bottomPct: Number(event.target.value) })
                          }
                          className="min-w-0 flex-1 accent-[var(--pick)]"
                        />
                        <span className="tnum w-[38px] text-right text-[9px] text-muted">
                          {style.bottomPct.toFixed(1)}%
                        </span>
                      </label>
                      <label className="flex items-center gap-2 text-[9.5px] text-muted-2">
                        描边
                        <input
                          type="range"
                          min={0}
                          max={3}
                          step={0.05}
                          value={style.strokeCqw}
                          disabled={readOnly}
                          onChange={(event) =>
                            setSubtitleLayout({ strokeCqw: Number(event.target.value) })
                          }
                          className="min-w-0 flex-1 accent-[var(--pick)]"
                        />
                        <span className="tnum w-[38px] text-right text-[9px] text-muted">
                          {style.strokeCqw.toFixed(2)}
                        </span>
                      </label>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setSubtitleLayout({
                            fontSizeCqw: null,
                            bottomPct: null,
                            strokeCqw: null,
                          })
                        }
                        disabled={readOnly || !styleCustom}
                        className="rounded-token border border-line px-2 py-0.5 text-[9px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
                      >
                        恢复模板
                      </button>
                      <span className="text-[8.5px] leading-[1.6] text-muted-2">
                        字幕压在 8% 底部安全区里会挡住平台操作栏；离底边太近时预览里能看到参考线。
                      </span>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(160px,1fr)_auto]">
                    <label className="flex flex-col gap-1 text-[9.5px] text-muted-2">
                      目标平台
                      <select
                        value={platform}
                        onChange={(event) => setPlatform(event.target.value as PlatformId)}
                        className="rounded-token border border-line bg-transparent px-2 py-1 text-[10.5px] text-text focus:border-line-2 focus:outline-none"
                      >
                        {PLATFORM_SPECS.map((spec) => (
                          <option key={spec.id} value={spec.id} className="bg-surface">
                            {spec.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="flex items-end">
                      <span className="pb-1.5 text-[8.5px] tracking-[.06em] text-muted-2">
                        规格库 {PLATFORM_SPEC_VERSION} · 发布包会记下这一版
                      </span>
                    </div>
                  </div>

                  <div className="mt-2 rounded-token border border-line bg-surface/60 p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="text-[10.5px] tracking-[.06em] text-text">平台规格</h3>
                      <span
                        className={cn(
                          "tnum text-[9px]",
                          platformValidation.ok ? "text-muted-2" : "text-pick",
                        )}
                      >
                        {platformValidation.ok
                          ? `${platformValidation.review} 项参考提醒 · 画幅 / 时长 / 编码通过`
                          : `${platformValidation.blocked} 项硬阻断`}
                      </span>
                    </div>
                    <ul className="mt-1.5 border-t border-line">
                      {platformValidation.checks.map((check) => (
                        <PlatformRow key={check.id} check={check} />
                      ))}
                    </ul>
                    <p className="mt-1.5 text-[8.5px] leading-[1.6] text-muted-2">
                      {platformValidation.spec.note} 只有画幅、时长上限、编码与已知上限的文件大小会硬拦；
                      帧率、码率、标题字数、话题数量与封面是参考值，平台随时会改。
                    </p>
                  </div>

                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-[9.5px] text-muted-2">
                      标题
                      <input
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        className="rounded-token border border-line bg-transparent px-2 py-1 text-[10.5px] text-text focus:border-line-2 focus:outline-none"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-[9.5px] text-muted-2">
                      话题（逗号或空格分隔）
                      <input
                        value={topics}
                        onChange={(event) => setTopics(event.target.value)}
                        className="rounded-token border border-line bg-transparent px-2 py-1 text-[10.5px] text-text focus:border-line-2 focus:outline-none"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-[9.5px] text-muted-2 sm:col-span-2">
                      简介
                      <textarea
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        rows={2}
                        className="resize-none rounded-token border border-line bg-transparent px-2 py-1 text-[10.5px] leading-[1.7] text-text focus:border-line-2 focus:outline-none"
                      />
                    </label>
                  </div>

                  <div className="mt-3 rounded-token border border-line bg-surface/60 p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="text-[10.5px] tracking-[.06em] text-text">导出前检查</h3>
                      <span
                        className={cn(
                          "tnum text-[9px]",
                          report.ok ? "text-muted-2" : "text-pick",
                        )}
                      >
                        {report.ok
                          ? report.review > 0
                            ? `${report.review} 处待确认 · 指纹 ${report.signature}`
                            : `通过 · 指纹 ${report.signature}`
                          : `${report.blocked} 处阻断 · 指纹 ${report.signature}`}
                      </span>
                    </div>

                    <ul className="mt-1.5 border-t border-line">
                      {report.checks.map((check) => (
                        <CheckRow key={check.id} check={check} />
                      ))}
                    </ul>

                    {/* 生成结果复核（H6）：只有这一项能在这里直接处理 */}
                    {review.total > 0 && (
                      <div className="mt-1 border-t border-line pt-1.5">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-[9px] tracking-[.06em] text-muted-2">
                            逐条复核 · {review.passed}/{review.total} 已看
                            {review.rejected > 0 && ` · ${review.rejected} 条不可用`}
                          </span>
                          <span className="text-[8.5px] text-muted-2">
                            像素与视频没有模型审核，只有人看得见
                          </span>
                        </div>
                        {/* 全部列出：通过的排最后。藏起来的话「已看」就撤不掉了 */}
                        <ReviewPanel
                          subjects={review.subjects}
                          readOnly={Boolean(readOnly)}
                          onReview={(assetId, status) => reviewAsset(assetId, status)}
                        />
                      </div>
                    )}

                    {report.findings.length > 0 && (
                      <div className="mt-1 border-t border-line pt-2">
                        <p className="text-[9px] tracking-[.06em] text-muted-2">命中</p>
                        <ul className="mt-1 space-y-1.5">
                          {report.findings.slice(0, 8).map((finding, index) => (
                            <li
                              key={`${finding.ruleId}-${finding.path}-${index}`}
                              className="flex items-start gap-2 text-[9.5px] leading-[1.6]"
                            >
                              <span
                                className={cn(
                                  "shrink-0 pt-px text-[8.5px] tracking-[.06em]",
                                  finding.severity === "block" ? "text-pick" : "text-muted-2",
                                )}
                              >
                                {finding.severity === "block" ? "阻断" : "确认"}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="text-muted">{finding.path}</span>
                                <span className="text-muted-2"> · 「{finding.term}」 </span>
                                <span className="text-muted-2">{finding.message}</span>
                                <span className="mt-0.5 block text-[9px] text-muted-2">
                                  {finding.excerpt}
                                </span>
                              </span>
                            </li>
                          ))}
                        </ul>
                        {report.findings.length > 8 && (
                          <p className="mt-1.5 text-[9px] text-muted-2">
                            还有 {report.findings.length - 8} 处没有列出：先改掉上面这些再重新检查。
                          </p>
                        )}
                      </div>
                    )}

                    {report.review > 0 && report.ok && (
                      <label className="mt-2 flex cursor-pointer items-start gap-2 border-t border-line pt-2 text-[9.5px] leading-[1.6] text-muted">
                        <input
                          type="checkbox"
                          checked={acknowledged}
                          onChange={(event) =>
                            setAckSignature(event.target.checked ? report.signature : undefined)
                          }
                          className="mt-[2px] accent-[var(--pick)]"
                        />
                        <span>
                          我确认上面 {report.review} 处内容属于剧情需要，没有美化或教学细节，可以导出。
                        </span>
                      </label>
                    )}

                    <p
                      className={cn(
                        "mt-2 border-t border-line pt-2 text-[9.5px] leading-[1.6]",
                        report.ok ? "text-muted-2" : "text-pick",
                      )}
                    >
                      {gateOpen
                        ? "检查通过：五个导出按钮都可用。"
                        : `${gateReason}改完文案会自动重新检查，确认状态也会随之失效。`}
                    </p>
                  </div>

                  <ComplianceCheckpoints
                    project={project}
                    title={title}
                    description={description}
                    topics={topics}
                  />

                  <div className="mt-3 border-t border-line pt-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[9px] tracking-[.06em] text-muted-2">渲染档位</span>
                      {(["draft", "final"] as const).map((id) => {
                        const option = RENDER_PROFILES[id];
                        const locked = id === "final" && !finalAllowed;
                        return (
                          <button
                            key={id}
                            type="button"
                            aria-pressed={quality === id}
                            onClick={() => setQuality(id)}
                            disabled={locked}
                            className={cn(
                              "rounded-token border px-2.5 py-1 text-[10px] transition-colors duration-[var(--dur)] disabled:cursor-not-allowed disabled:opacity-40",
                              quality === id
                                ? "border-pick bg-pick/12 text-text"
                                : "border-line text-muted enabled:hover:border-line-2 enabled:hover:text-text",
                            )}
                          >
                            {option.label}
                            <span className="ml-1.5 text-[9px] text-muted-2">
                              {option.width}×{option.height} · {option.fps}fps
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-1.5 text-[9.5px] leading-[1.7] text-muted-2">
                      {finalAllowed
                        ? "定稿已解锁：先在草稿上看节奏，确认成片后再导定稿。"
                        : "定稿要先在页面底部确认这一版成片；没确认时只能导草稿。"}
                    </p>

                    <label className="mt-2 flex items-start gap-2 text-[10px] leading-[1.7] text-muted">
                      <input
                        id="burn-subtitles"
                        type="checkbox"
                        checked={burnSubtitles}
                        onChange={(event) => setBurnSubtitles(event.target.checked)}
                        className="mt-[3px] accent-[var(--pick)]"
                      />
                      <span>
                        把字幕烧进画面
                        <span className="ml-1 text-[9.5px] text-muted-2">
                          关掉导出一版无字幕的（文件名带「-无字幕」），适合平台自己加字幕或要二次剪辑；「AI 生成」角标始终保留。
                        </span>
                      </span>
                    </label>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={exportVideo}
                      disabled={!gateOpen || rendering || view.clips.length === 0}
                      className="rounded-token border border-pick bg-pick px-3 py-1 text-[10.5px] text-white transition-opacity duration-[var(--dur)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {rendering ? "正在渲染 MP4…" : `导出${profile.label} MP4`}
                    </button>
                    {rendering && renderJobId && (
                      <button
                        type="button"
                        onClick={() => void cancelRenderJob()}
                        title="排队中会直接摘掉；正在编码就停掉 ffmpeg，不留半成品"
                        className="rounded-token border border-line px-3 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                      >
                        取消渲染
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={exportPreview}
                      disabled={!gateOpen}
                      className="rounded-token border border-line px-3 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      导出预览 HTML
                    </button>
                    <button
                      type="button"
                      onClick={exportOtio}
                      disabled={!gateOpen}
                      className="rounded-token border border-line px-3 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      导出 .otio
                    </button>
                    <button
                      type="button"
                      onClick={exportSrt}
                      disabled={!gateOpen}
                      className="rounded-token border border-line px-3 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      导出字幕 SRT
                    </button>
                    <button
                      type="button"
                      onClick={exportAss}
                      disabled={!gateOpen}
                      className="rounded-token border border-line px-3 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      导出字幕 ASS
                    </button>
                    <button
                      type="button"
                      onClick={exportPackage}
                      disabled={!gateOpen}
                      className="rounded-token border border-line px-3 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      导出发布包
                    </button>
                  </div>

                  {(notice || renderStage) && (
                    <p className="mt-2 text-[9.5px] leading-[1.7] text-muted">
                      {renderStage || notice}
                    </p>
                  )}

                  <p className="mt-2 text-[9.5px] leading-[1.7] text-muted-2">
                    {lastRender
                      ? `这一版成片：${lastRender.fileName} · ${formatSize(lastRender.bytes)} · ${RENDER_PROFILES[lastRender.quality].label}。打发布包会带上它，并记进项目发布记录（已有 ${project.publishPackages.length} 份）。`
                      : `还没有导出过成片：先导出草稿或定稿 MP4，发布包的视频位才有内容。项目里已有 ${project.publishPackages.length} 份发布记录。`}
                  </p>

                  <p className="mt-3 text-[9.5px] leading-[1.7] text-muted-2">
                    成片 MP4 由本机 ffmpeg 渲染：草稿 540×960 / 24fps 出处快、定稿 1080×1920 / 30fps 画质高；字幕可选烧进画面，「AI 生成」角标始终保留。
                    提交后进入渲染队列，同一时间只跑一条，排队位置与编码进度显示在按钮下方；
                    远端素材只从白名单域名下载，取不到时用首帧或占位图顶上并计数。
                  </p>
                  <p className="mt-2 text-[9.5px] leading-[1.7] text-muted-2">
                    AI 标识不是可选项：预览画面{badgeCornerLabel(badgePlacement.corner)}的「AI 生成」角标（按目标平台避开点赞 / 评论栏）、
                    HTML 元数据、OTIO 元数据与发布包里的 `aiLabel` 都会带上；成片 MP4 里也已经烧进画面。
                    角标位置由平台规格决定，不给单独开关。
                  </p>
                </section>
              </div>
            </div>
          )}

          {readOnly && (
            <p className="mt-6 text-[10px] text-muted-2">另一个标签页在编辑：这一页只读，刷新后才能接管。</p>
          )}
        </div>
      </main>
      <StageGate stage="edit" />
    </div>
  );
}
