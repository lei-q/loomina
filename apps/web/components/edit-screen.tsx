"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SfxCue } from "@loomina/ir";
import { StageGate } from "@/components/stage-gate";
import { ComplianceCheckpoints } from "@/components/compliance-checkpoints";
import { MusicCurvePanel } from "@/components/music-curve-panel";
import { PublishLedgerPanel } from "@/components/publish-ledger-panel";
import { RightsPanel } from "@/components/rights-panel";
import { SilentWatchPanel } from "@/components/silent-watch-panel";
import { BilingualPanel } from "@/components/bilingual-panel";
import { BrandPanel } from "@/components/brand-panel";
import { brandArtOf, cardImage } from "@/lib/card-image";
import { GradePanel, type SeamOption } from "@/components/grade-panel";
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
import { SPEAKER_COLORS, speakerColorAt } from "@/lib/speaker-color";
import { clampedDeltaMs, dragDeltaMs } from "@/lib/track-drag";
import { cancelRender, exportMp4 } from "@/lib/render-client";
import { hydrateView } from "@/lib/asset-hydrate";
import { assetHref } from "@/lib/asset-uri";
import { RENDER_PROFILES, frameSize, type RenderQuality } from "@/lib/render-manifest";
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
import { aiLabelRecordFor, badgeCornerLabel, badgePlacementOf } from "@/lib/ai-label";
import {
  COVER_STYLES,
  coverArtOf,
  coverFileNameOf,
  coverFrameUrlOf,
  coverHookOf,
  coverSizeOf,
  dataUrlBytes,
  downloadCover,
  drawCover,
  type CoverArt,
} from "@/lib/cover";
import { canPreviewFrames } from "@/lib/preview-frame";
import { silentWatchOfEdit } from "@/lib/silent-watch";
import {
  clipFades,
  focusLine,
  gradeCssFilter,
  isDefaultFrame,
  isDefaultGrade,
} from "@/lib/render-effects";
import { FramePanel, type FrameShot } from "@/components/frame-panel";
import { MultiPlatformPanel } from "@/components/multi-platform-panel";
import { versionLine, versionPlans, versionSuffix } from "@/lib/multi-platform";
import { rightsReport } from "@/lib/rights";
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

/** 封面取帧：同源图片才读得进画布；读不到就退回纯排版封面（G6） */
function loadCoverImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("这一帧读不出来"));
    image.src = src;
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

/** 拖动的 10ms 档位：不到 1 秒时按毫秒写，免得全是 `+0.0s` */
function signedOffset(ms: number): string {
  return Math.abs(ms) >= 1000 ? signedMs(ms) : `${ms > 0 ? "+" : "−"}${Math.abs(ms)}ms`;
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
  const setSubtitleTranslation = useWorkbench((state) => state.setSubtitleTranslation);
  const setLineTranslation = useWorkbench((state) => state.setLineTranslation);
  const setBrand = useWorkbench((state) => state.setBrand);
  const shiftLineTrack = useWorkbench((state) => state.shiftLineTrack);
  const reviewAsset = useWorkbench((state) => state.reviewAsset);
  const addMusic = useWorkbench((state) => state.addMusic);
  const updateMusic = useWorkbench((state) => state.updateMusic);
  const removeMusic = useWorkbench((state) => state.removeMusic);
  const addSfx = useWorkbench((state) => state.addSfx);
  const updateSfx = useWorkbench((state) => state.updateSfx);
  const removeSfx = useWorkbench((state) => state.removeSfx);
  const setMix = useWorkbench((state) => state.setMix);
  const fillMusicByCurve = useWorkbench((state) => state.fillMusicByCurve);
  const upsertMotif = useWorkbench((state) => state.upsertMotif);
  const removeMotif = useWorkbench((state) => state.removeMotif);
  const setBudget = useWorkbench((state) => state.setBudget);
  const recordPublish = useWorkbench((state) => state.recordPublish);
  const recordPublishReceipt = useWorkbench((state) => state.recordPublishReceipt);
  const upsertRights = useWorkbench((state) => state.upsertRights);
  const removeRights = useWorkbench((state) => state.removeRights);
  const setGrade = useWorkbench((state) => state.setGrade);
  const importLut = useWorkbench((state) => state.importLut);
  const saveCoverAsset = useWorkbench((state) => state.saveCoverAsset);
  const setFrame = useWorkbench((state) => state.setFrame);
  const setShotFocus = useWorkbench((state) => state.setShotFocus);
  const setTimelineTransition = useWorkbench((state) => state.setTimelineTransition);

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
  // 静音可懂度（C13 / ADR-0164）：只查字幕这一侧，全部从当前时间线派生
  const [silentOpen, setSilentOpen] = useState(false);
  // 双语字幕（D5 / ADR-0173）：逐句写第二行，版式只决定第二行放上还是下
  const [bilingualOpen, setBilingualOpen] = useState(false);
  // 品牌包与头尾卡（E9 / ADR-0174）：卡片是导出最前 / 最后的一张静帧
  const [brandOpen, setBrandOpen] = useState(false);
  // 发布台账（G10）与授权记录（H7）：都是留档，不改成片
  const [publishOpen, setPublishOpen] = useState(false);
  const [rightsOpen, setRightsOpen] = useState(false);
  // 调色与转场（E4 / ADR-0169）：只影响导出，不改时间线与提示词
  const [gradeOpen, setGradeOpen] = useState(false);
  // 画幅与裁切（E5 / ADR-0170）：同样只影响导出
  const [frameOpen, setFrameOpen] = useState(false);
  // 多平台版本（G9 / ADR-0171）：勾几个平台就出几版
  const [multiOpen, setMultiOpen] = useState(false);
  const [multiPicks, setMultiPicks] = useState<PlatformId[]>(["douyin", "bilibili"]);
  const [multiStage, setMultiStage] = useState("");
  const [multiBusy, setMultiBusy] = useState(false);
  const [multiResults, setMultiResults] = useState<
    { platform: PlatformId; name: string; bytes: number; fileName: string }[]
  >([]);
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
  /** 封面（G6）：用哪一镜的哪一帧，以及出好的 PNG */
  const [coverShotId, setCoverShotId] = useState<string>();
  const [coverPos, setCoverPos] = useState(0.3);
  const [cover, setCover] = useState<{ dataUrl: string; art: CoverArt }>();
  const [coverBusy, setCoverBusy] = useState(false);
  /** 封面版式（G6）：四种，默认「剧照」 */
  const [coverStyle, setCoverStyle] = useState("classic");
  /** 已存进资产库的那一张：同一张不重复存 */
  const [coverSavedId, setCoverSavedId] = useState("");
  const [musicFile, setMusicFile] = useState<{
    name: string;
    size: number;
    uri: string;
    mime: string;
    durationMs: number;
  }>();
  const [musicMood, setMusicMood] = useState("紧张");
  const [musicLicense, setMusicLicense] = useState("");
  /** 新加这一段的起点（秒）：多条 cue 混排时各占一段 */
  const [musicStartSec, setMusicStartSec] = useState("0");
  const [musicBusy, setMusicBusy] = useState(false);
  const [musicError, setMusicError] = useState("");
  const musicPreviewRef = useRef<HTMLAudioElement>(null);
  /** 音效层（C7 / ADR-0184）：与配乐同一套文件读取，控件更少 */
  const [sfxFile, setSfxFile] = useState<{
    name: string;
    size: number;
    uri: string;
    mime: string;
    durationMs: number;
  }>();
  const [sfxLicense, setSfxLicense] = useState("");
  const [sfxStartSec, setSfxStartSec] = useState("0");
  const [sfxRole, setSfxRole] = useState<SfxCue["role"]>("foley");
  const [sfxLoop, setSfxLoop] = useState(false);
  const [sfxBusy, setSfxBusy] = useState(false);
  const [sfxError, setSfxError] = useState("");
  const sfxPreviewRef = useRef<HTMLAudioElement>(null);
  /** 正在拖动的字幕（E1 / ADR-0145）：只在本机预览，松手才写一次事件 */
  const [cueDrag, setCueDrag] = useState<{ lineId: string; deltaMs: number } | null>(null);
  const cueLaneRef = useRef<HTMLDivElement>(null);
  const cueDragRef = useRef<{
    lineId: string;
    startX: number;
    moved: boolean;
    deltaMs: number;
  } | null>(null);
  const skipCueClick = useRef(false);
  /** 确认的是哪一版预检：文案一改，指纹变，确认自动失效 */
  const [ackSignature, setAckSignature] = useState<string>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const fired = useRef<Set<string>>(new Set());

  const view = useMemo(() => toEditView(project, { maxChars }), [project, maxChars]);
  // 顶栏徽标只数「静音时会断」的地方，与抽屉里同一份报告
  const silent = useMemo(() => silentWatchOfEdit(view), [view]);
  const silentCount =
    silent.summary.unreadable +
    silent.summary.flash +
    silent.summary.gap +
    silent.summary.pronoun +
    silent.summary.speaker;
  // 授权与台账的顶栏徽标：缺几条授权、几份发布包还没贴回执
  const rights = useMemo(
    () => rightsReport(project, new Date().toISOString().slice(0, 10)),
    [project],
  );
  const rightsGapCount = rights.gaps.length + rights.expired.length;
  const unpublishedCount = project.publishPackages.filter(
    (pack) => !pack.publishedAt?.trim(),
  ).length;
  // 接缝（E4）：第一段前面没有画面，从第二段起每一段都是一处接缝
  const seams: SeamOption[] = useMemo(
    () =>
      view.clips.slice(1).map((clip) => ({
        itemId: clip.id,
        label: shotLabel(clip.shotNo),
        atMs: clip.startMs,
        durationMs: clip.durationMs,
        ...(clip.transitionIn ? { transition: clip.transitionIn } : {}),
      })),
    [view.clips],
  );
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
        // 按实际画幅预检（E5）：改成横屏后，只收 9:16 的平台要在这里就拦住，
        // 不能等到导出完才发现规格不符
        width: frameSize("final", project.frame.aspect).width,
        height: frameSize("final", project.frame.aspect).height,
        ...(lastRender ? { fileBytes: lastRender.bytes } : {}),
      }),
    [project, title, description, topics, view.totalMs, platform, lastRender, project.frame.aspect],
  );
  // 生成结果复核（H6）：会进成片的每一条，逐条给作者看
  const review = useMemo(() => reviewSummaryOf(project), [project]);
  const platformValidation = useMemo(
    () =>
      validatePlatform(platformSpecOf(platform), {
        durationMs: view.totalMs,
        // 按实际画幅校验（E5）：改成横屏后，只收 9:16 的平台会在这里拦下来
        width: frameSize("final", project.frame.aspect).width,
        height: frameSize("final", project.frame.aspect).height,
        fps: 30,
        codec: "H.264",
        title,
        topics: topics.split(/[,，\s]+/).filter(Boolean),
        // 导出过才有实际体积与码率；没有就是「导出后再核」
        ...(lastRender ? { fileBytes: lastRender.bytes } : {}),
      }),
    [platform, view.totalMs, title, topics, lastRender, project.frame.aspect],
  );
  const acknowledged = report.review > 0 && ackSignature === report.signature;
  const gateOpen = report.ok && (report.review === 0 || acknowledged);
  // 角标位置跟着目标平台走（H5）：预览、播放器与成片三处共用同一张表
  const badgePlacement = badgePlacementOf(platform);
  const editGate = useMemo(() => stageStateOf(project, "edit"), [project]);
  const finalAllowed = editGate.gate === "confirmed";
  const profile = RENDER_PROFILES[quality];
  // 硬阻断有两种来源：文案命中的 findings，以及平台规格这类整项判死的检查。
  // 后者 findings 为 0，只报「0 处硬阻断」会让人以为没拦住（G7 / E5 都撞上过）。
  const blockingCheck = report.checks.find((check) => check.status === "block");
  const gateReason = !report.ok
    ? report.blocked > 0
      ? `还有 ${report.blocked} 处硬阻断：改完文案再导出。`
      : `${blockingCheck?.label ?? "有一项"}没过：${blockingCheck?.detail ?? "看下面的检查结果"}`
    : report.review > 0 && !acknowledged
      ? `有 ${report.review} 处需要人工确认：读完后勾选确认。`
      : "";
  // 多平台版本（G9）的闸门要去掉「平台规格」这一项：每个平台各自判规格，
  // 不能被当前选中的平台一票否决——项目是 16:9 却选着抖音时，B 站 / X 那几版照样能出。
  const contentBlocking = report.checks.find(
    (check) => check.status === "block" && check.id !== "spec",
  );
  const contentGateOpen = !contentBlocking && (report.review === 0 || acknowledged);
  const contentGateReason = contentBlocking
    ? `${contentBlocking.label}没过：${contentBlocking.detail}`
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
    ) ??
    // 片头卡窗口里还没有镜头开始：停在第一镜，不跳到最后一镜
    (elapsed < (view.clips[0]?.startMs ?? 0) ? view.clips[0] : view.clips.at(-1));
  // 头尾卡（E9 / ADR-0174）：播放头落在卡上时，舞台上就是那张卡
  const stageCard = view.cards.find(
    (card) => elapsed >= card.startMs && elapsed < card.startMs + card.durationMs,
  );
  // 舞台上的那张卡：只在播放头落进卡片窗口时用；按品牌与画幅缓存，
  // 不跟着秒表每秒重画一遍
  const cardStills = useMemo(
    () => ({
      intro: cardImage(brandArtOf(view.brand, "intro", view.brand.intro), frameSize("draft", view.frame.aspect)),
      outro: cardImage(brandArtOf(view.brand, "outro", view.brand.outro), frameSize("draft", view.frame.aspect)),
    }),
    [view.brand, view.frame.aspect],
  );
  const stageCardImage = stageCard ? cardStills[stageCard.role] : undefined;
  const selected =
    view.clips.find((clip) => clip.id === selectedId) ?? current ?? view.clips[0];
  const selectedIndex = selected
    ? view.clips.findIndex((clip) => clip.id === selected.id)
    : -1;
  // 封面（G6）：默认选当前这一镜；没有画面的镜不进选项
  const coverClips = view.clips.filter((clip) => clip.hasPicture);
  const coverClip =
    coverClips.find((clip) => clip.id === coverShotId) ??
    coverClips.find((clip) => clip.id === selected?.id) ??
    coverClips[0];
  // 只有资产库里的视频才切得动帧；静态图没有「第几毫秒」
  const coverCanSeek = Boolean(coverClip?.uri && canPreviewFrames(coverClip.uri));
  const coverAtMs = coverClip && coverCanSeek ? Math.round(coverClip.durationMs * coverPos) : 0;
  const coverTitle = title.trim() || view.title;
  const coverSize = coverSizeOf(platform);
  // 标题、平台或版式改过，封面上的字与尺寸就跟不上了：提示重新生成，但不偷偷改图
  const coverStale = cover
    ? cover.art.platform !== platform ||
      cover.art.title !== coverTitle ||
      cover.art.styleId !== coverStyle
    : false;
  const currentCue = view.cues.find(
    (cue) =>
      elapsed >= cue.startMs && elapsed < cue.startMs + cue.durationMs,
  );
  const progress = view.totalMs > 0 ? (elapsed / view.totalMs) * 100 : 0;

  /**
   * 转场（E4）在预览里的近似：接缝处盖一层黑 / 白遮罩。
   * 与导出同一套规则（`clipFades` 的单侧夹取），只是这里画在 DOM 上——
   * 真正的淡变由 ffmpeg 做，预览只求看得出接法。
   */
  const dip = (() => {
    if (!current) return { opacity: 0, kind: "black" as const };
    const fades = clipFades(view.clips)[view.clips.indexOf(current)];
    if (!fades) return { opacity: 0, kind: "black" as const };
    const inClip = elapsed - current.startMs;
    let opacity = 0;
    let kind: "black" | "white" = "black";
    if (fades.fadeInMs > 0 && inClip < fades.fadeInMs) {
      opacity = 1 - inClip / fades.fadeInMs;
      kind = fades.fadeInKind;
    }
    if (fades.fadeOutMs > 0) {
      const outStart = current.durationMs - fades.fadeOutMs;
      if (inClip > outStart) {
        const value = (inClip - outStart) / fades.fadeOutMs;
        if (value > opacity) {
          opacity = value;
          kind = fades.fadeOutKind;
        }
      }
    }
    return { opacity: Math.max(0, Math.min(1, opacity)), kind };
  })();
  /** 调色（E4）在预览里的近似：CSS 滤镜对上三档对比 / 饱和 / 色温 */
  const gradeCss = gradeCssFilter(project.grade);
  // 画幅（E5）：预览按成片形状摆，适配方式决定画面怎么填进去
  const frameCssRatio = project.frame.aspect.replace(":", " / ");
  const frameCrop = project.frame.fit === "crop";
  const frameBlur = project.frame.fit === "blur";
  const currentFocus = current?.focus;
  const frameObjectPosition = `${Math.round((currentFocus?.x ?? 0.5) * 100)}% ${Math.round((currentFocus?.y ?? 0.5) * 100)}%`;
  // 画幅面板的每一镜：缩略图 + 现在留住哪一块
  const frameShots: FrameShot[] = useMemo(
    () =>
      view.clips.map((clip) => ({
        shotId: clip.shotId,
        label: shotLabel(clip.shotNo),
        startMs: clip.startMs,
        ...(clip.stillUri ? { still: assetHref(clip.stillUri) } : {}),
        ...(clip.focus ? { focus: clip.focus } : {}),
      })),
    [view.clips],
  );

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

  /** 每一句现在被挪了多少（E1）：拖动从原值上算增量 */
  const subtitleOffsetByLine = useMemo(
    () =>
      new Map(
        view.clips
          .flatMap((clip) => clip.lines)
          .map((line) => [line.id, line.subtitleOffsetMs]),
      ),
    [view.clips],
  );

  /**
   * 字幕条上的整句拖动（E1 / ADR-0145）：按下只记起点，挪动只更新本机预览，
   * 松手才写一次 `dialogue.updated`——拖一次不该在日志里留下一百条事件。
   */
  const startCueDrag = (event: React.PointerEvent<HTMLButtonElement>, lineId: string) => {
    if (readOnly) return;
    cueDragRef.current = { lineId, startX: event.clientX, moved: false, deltaMs: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveCueDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = cueDragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    // 3px 以内当点击：手一抖不该把字幕挪走
    if (!drag.moved && Math.abs(dx) < 3) return;
    drag.moved = true;
    const laneWidth = cueLaneRef.current?.clientWidth ?? 0;
    const current = subtitleOffsetByLine.get(drag.lineId) ?? 0;
    drag.deltaMs = clampedDeltaMs(current, dragDeltaMs(dx, laneWidth, view.totalMs));
    setCueDrag({ lineId: drag.lineId, deltaMs: drag.deltaMs });
  };

  const endCueDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = cueDragRef.current;
    cueDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag) return;
    setCueDrag(null);
    if (!drag.moved) return;
    // 拖动之后浏览器还会补一个 click：别让它顺手把断句编辑器打开
    skipCueClick.current = true;
    if (drag.deltaMs !== 0 && shiftLineTrack(drag.lineId, "subtitle", drag.deltaMs)) {
      setNotice(`字幕整句挪了 ${signedOffset(drag.deltaMs)}：松手才写一次，还能继续拖或按 ↺ 归位。`);
    }
  };

  const cancelCueDrag = () => {
    cueDragRef.current = null;
    setCueDrag(null);
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
      startMs: Math.max(0, Math.round(Number(musicStartSec) * 1000) || 0),
    });
    if (ok) {
      setMusicFile(undefined);
      setMusicLicense("");
      setMusicError("");
      setNotice(
        view.music.length === 0
          ? "配乐已加入：导出时会按台词窗自动 ducking。"
          : "又加了一段配乐：各段在自己的起点进来，导出时一起混。",
      );
    }
  };

  const toggleMusicPreview = (cue?: { uri?: string; gainDb: number }) => {
    const element = musicPreviewRef.current;
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

  const chooseSfx = async (file: File | undefined) => {
    if (!file) return;
    setSfxBusy(true);
    setSfxError("");
    try {
      if (file.size > 18 * 1024 * 1024) {
        throw new Error("文件超过 18 MB：换一声短一点的音效。");
      }
      const result = await readMusicFile(file);
      setSfxFile({ name: file.name, size: file.size, ...result });
    } catch (error) {
      setSfxFile(undefined);
      setSfxError(error instanceof Error ? error.message : "这条音效读不进来。");
    } finally {
      setSfxBusy(false);
    }
  };

  const commitSfx = () => {
    if (!sfxFile) {
      setSfxError("先选一个音频文件。");
      return;
    }
    if (!sfxLicense.trim()) {
      setSfxError("写清授权来源：音效库名、授权书编号，或「自己录制」。");
      return;
    }
    const ok = addSfx({
      uri: sfxFile.uri,
      mime: sfxFile.mime,
      title: sfxFile.name.replace(/\.[^.]+$/, ""),
      durationMs: sfxFile.durationMs,
      licenseRef: sfxLicense,
      startMs: Math.max(0, Math.round(Number(sfxStartSec) * 1000) || 0),
      role: sfxRole,
      loop: sfxLoop,
    });
    if (ok) {
      setSfxFile(undefined);
      setSfxLicense("");
      setSfxError("");
      setNotice("音效已加入：导出时按自己的起点与增益混进音效总线。");
    }
  };

  const toggleSfxPreview = (cue?: { uri?: string; gainDb: number }) => {
    const element = sfxPreviewRef.current;
    if (!element || !cue?.uri) return;
    if (element.paused) {
      const src = assetHref(cue.uri);
      if (src && element.getAttribute("src") !== src) element.src = src;
      element.currentTime = 0;
      element.volume = Math.pow(10, cue.gainDb / 20);
      void element.play().catch(() => setSfxError("浏览器没能播放这条音效。"));
    } else {
      element.pause();
    }
  };

  const exportPreview = async () => {
    // 预览不是发到平台上的那一版：画幅规格没过也能先看剪辑，
    // 角标按当前平台摆只是让人提前看见位置（与 G9 的内容侧闸门同一条）
    if (!contentGateOpen) {
      setNotice(contentGateReason);
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
      // 尺寸按实际画幅报（E5）：说 1080×1920 却给了一条横屏片子是最容易看漏的错
      const exported = frameSize(quality, project.frame.aspect);
      setNotice(
        `${profile.label}成片已导出：${mb} MB · ${exported.width}×${exported.height} / ${profile.fps}fps · ${
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

  /**
   * 多平台版本渲染（G9 / ADR-0171）。
   *
   * 勾上的平台依次各出一版：形状与角标位置按平台走，项目里的画幅设置不动。
   * 不并发——本机渲染队列同一时间只跑一条，并发只会把几版都排进队列、进度互相盖住。
   * 一版失败不中断后面几版：失败的那一版报出来，别的照出。
   */
  const exportVersions = async () => {
    if (multiBusy || rendering) return;
    if (!contentGateOpen) {
      setNotice(contentGateReason);
      return;
    }
    // 定稿闸门与单版导出一致：几版一起导也是定稿，同样要先确认这一版成片
    if (quality === "final" && !finalAllowed) {
      setNotice("定稿渲染要先在页面底部确认这一版成片；还没确认时只能导出草稿。");
      return;
    }
    const plans = versionPlans(project.frame, view.totalMs, multiPicks, quality).filter(
      (plan) => !plan.blocker,
    );
    if (plans.length === 0) {
      setNotice("没有能出的平台：先在画幅里选一个平台收的形状。");
      return;
    }
    setMultiBusy(true);
    setMultiResults([]);
    setNotice("");
    const done: { platform: PlatformId; name: string; bytes: number; fileName: string }[] = [];
    const failed: string[] = [];
    try {
      for (const [index, plan] of plans.entries()) {
        setMultiStage(versionLine(plan, index, plans.length, quality));
        const startedAt = Date.now();
        try {
          const result = await exportMp4(
            view,
            style,
            renderComplianceOf(report, acknowledged),
            quality,
            setMultiStage,
            {
              subtitles: burnSubtitles,
              platform: plan.platform,
              frame: plan.frame,
              fileNameSuffix: `-${versionSuffix(plan.platform)}`,
              onJob: setRenderJobId,
            },
          );
          done.push({
            platform: plan.platform,
            name: plan.spec.name,
            bytes: result.bytes,
            fileName: result.fileName,
          });
          // 每一版都记一条发布记录（G10）：平台 / 档位 / 文件 / 体积 / 指纹。
          // 指纹按剪辑内容算（画幅不进指纹），同一剪法出的几版指纹相同，对得上。
          recordPublish({
            platform: plan.platform,
            quality,
            fileName: result.fileName,
            bytes: result.bytes,
            renderMs: Date.now() - startedAt,
            contentHash: aiLabelRecordFor(view).contentHash,
          });
          setMultiResults([...done]);
        } catch (error) {
          failed.push(`${plan.spec.name}：${error instanceof Error ? error.message : "渲染失败"}`);
        } finally {
          setRenderJobId(undefined);
        }
      }
      setNotice(
        failed.length === 0
          ? `${done.length} 版都导出了：${done.map((item) => item.name).join(" / ")}。每版都记进了发布记录。`
          : `导出 ${done.length} 版，${failed.length} 版失败：${failed.join("；")}`,
      );
    } finally {
      setMultiBusy(false);
      setMultiStage("");
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
    if (!contentGateOpen) {
      setNotice(contentGateReason);
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
    if (!contentGateOpen) {
      setNotice(contentGateReason);
      return;
    }
    downloadFile(safeFileName(view.title, "字幕.srt"), buildSrt(view), "text/plain");
    setNotice("字幕已导出（SRT）：时间按初剪的绝对时间。");
  };

  const exportAss = () => {
    if (!contentGateOpen) {
      setNotice(contentGateReason);
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

  const generateCover = async () => {
    if (!coverClip) {
      setNotice("这一版还没有能当封面的画面：先给某一镜出图或出视频。");
      return;
    }
    if (!gateOpen) {
      setNotice(gateReason);
      return;
    }
    setCoverBusy(true);
    setNotice("正在出封面…");
    try {
      // 视频走服务端精确切帧；静态图直接读；都读不到就出纯标题封面，不拿占位图冒充
      const src =
        coverClip.uri && canPreviewFrames(coverClip.uri)
          ? coverFrameUrlOf(coverClip.uri, coverAtMs, coverSize.width)
          : coverClip.stillUri
            ? assetHref(coverClip.stillUri)
            : undefined;
      const image = src ? await loadCoverImage(src).catch(() => null) : null;
      const canvas = document.createElement("canvas");
      canvas.width = coverSize.width;
      canvas.height = coverSize.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("浏览器没有给出画布");
      drawCover(
        ctx,
        {
          title: coverTitle,
          hook: coverHookOf(description),
          platform,
          image,
          imageWidth: image?.naturalWidth,
          imageHeight: image?.naturalHeight,
          styleId: coverStyle,
        },
        coverSize.width,
        coverSize.height,
      );
      const dataUrl = canvas.toDataURL("image/png");
      const art = coverArtOf({
        title: coverTitle,
        shotNo: coverClip.shotNo,
        atMs: coverAtMs,
        bytes: dataUrlBytes(dataUrl),
        platform,
        styleId: coverStyle,
      });
      setCover({ dataUrl, art });
      setCoverSavedId("");
      setNotice(
        `封面已生成：${
          image
            ? `第 ${coverClip.shotNo} 镜 ${fmtSec(coverAtMs)} 的画面`
            : "这一镜没有可用的画面，出的是纯标题封面"
        } · ${coverSize.width}×${coverSize.height} · ${formatSize(art.bytes)}。`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "封面没出成");
    } finally {
      setCoverBusy(false);
    }
  };

  const saveCover = () => {
    if (!cover) return;
    const fileName = coverFileNameOf(cover.art.title, coverSize.ratio);
    downloadCover(cover.dataUrl, fileName);
    setNotice(`封面已下载：${fileName}（${formatSize(cover.art.bytes)}）。`);
  };

  const saveCoverToLibrary = async () => {
    if (!cover) return;
    const result = await saveCoverAsset({
      dataUrl: cover.dataUrl,
      title: cover.art.title,
      width: cover.art.width,
      height: cover.art.height,
    });
    if (!result.assetId) {
      setNotice(result.error ?? "封面没存进资产库。");
      return;
    }
    setCoverSavedId(result.assetId);
    setNotice(`封面已存进资产库：${result.assetId}（${formatSize(cover.art.bytes)}）。`);
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
      ...(cover ? { coverArt: cover.art } : {}),
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
    const tail = `${recorded ? "已记进项目的发布记录。" : "项目是只读的，这次没有记进发布记录。"}${
      coverStale ? "封面是按改之前的标题 / 平台出的，重新生成一张再发。" : ""
    }`;
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
        onBilingual={view.clips.length > 0 ? () => setBilingualOpen(true) : undefined}
        untranslatedCount={
          view.translation.enabled ? view.translationCoverage.lines - view.translationCoverage.translated : 0
        }
        onSilent={view.clips.length > 0 ? () => setSilentOpen(true) : undefined}
        silentCount={silentCount}
        onBrand={() => setBrandOpen(true)}
        cardCount={view.cards.length}
        onPublishLedger={() => setPublishOpen(true)}
        unpublishedCount={unpublishedCount}
        onGrade={() => setGradeOpen(true)}
        gradeCustomized={!isDefaultGrade(project.grade)}
        onFrame={() => setFrameOpen(true)}
        frameCustomized={!isDefaultFrame(project.frame)}
        onRights={() => setRightsOpen(true)}
        rightsGapCount={rightsGapCount}
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
                  style={{ aspectRatio: frameCssRatio, containerType: "inline-size" }}
                >
                  {/* 模糊填充（E5）：同一帧放大模糊垫在后面，画面本体缩进去 */}
                  {frameBlur && (current?.uri || current?.stillUri) && (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute -inset-[6%]"
                      style={{
                        backgroundImage: `url(${assetHref(current.uri ?? current.stillUri ?? "")})`,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                        filter: "blur(18px) brightness(.55)",
                      }}
                    />
                  )}
                  {stageCardImage ? (
                    // 片头 / 片尾卡（E9 / ADR-0174）：导出时是同一张图
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={stageCardImage}
                      alt={`${stageCard?.role === "intro" ? "片头" : "片尾"}卡`}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : current?.uri ? (
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
                      className={cn(
                        "absolute inset-0 h-full w-full",
                        frameCrop ? "object-cover" : "object-contain",
                      )}
                      style={{
                        objectPosition: frameObjectPosition,
                        ...(gradeCss ? { filter: gradeCss } : {}),
                      }}
                    />
                  ) : current?.stillUri ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={assetHref(current.stillUri)}
                      alt={`${shotLabel(current.shotNo)} 的画面`}
                      className={cn(
                        "absolute inset-0 h-full w-full",
                        frameCrop ? "object-cover" : "object-contain",
                      )}
                      style={{
                        objectPosition: frameObjectPosition,
                        ...(gradeCss ? { filter: gradeCss } : {}),
                      }}
                    />
                  ) : (
                    <div
                      className="absolute inset-0 flex items-center justify-center bg-[repeating-linear-gradient(45deg,#111,#111_12px,#151515_12px,#151515_24px)] text-[10.5px] text-muted-2"
                      style={gradeCss ? { filter: gradeCss } : undefined}
                    >
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

                  {dip.opacity > 0.01 && (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0"
                      style={{
                        background: dip.kind === "white" ? "#fff" : "#000",
                        opacity: dip.opacity,
                      }}
                    />
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
                        color: currentCue.speakerColor ?? "#fff",
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
                    {view.cards
                      .filter((card) => card.role === "intro")
                      .map((card) => (
                        <button
                          key="card-intro"
                          type="button"
                          onClick={() => setBrandOpen(true)}
                          title={`片头卡 · ${fmtSec(card.durationMs)}：点开改标题与时长`}
                          style={{
                            width: `${(card.durationMs / Math.max(1, view.totalMs)) * 100}%`,
                          }}
                          className="flex min-w-[2px] items-center justify-center overflow-hidden border-r border-bg bg-pick/15 text-[8.5px] text-pick transition-colors duration-[var(--dur)] hover:bg-pick/25"
                        >
                          片头
                        </button>
                      ))}
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
                    {view.cards
                      .filter((card) => card.role === "outro")
                      .map((card) => (
                        <button
                          key="card-outro"
                          type="button"
                          onClick={() => setBrandOpen(true)}
                          title={`片尾卡 · ${fmtSec(card.durationMs)}：点开改标题与时长`}
                          style={{
                            width: `${(card.durationMs / Math.max(1, view.totalMs)) * 100}%`,
                          }}
                          className="flex min-w-[2px] items-center justify-center overflow-hidden bg-pick/15 text-[8.5px] text-pick transition-colors duration-[var(--dur)] hover:bg-pick/25"
                        >
                          片尾
                        </button>
                      ))}
                  </div>

                  <div className="mt-1 flex justify-between text-[8.5px] text-muted-2">
                    <span>0s</span>
                    <span className="tnum">{view.totalSec.toFixed(1)}s</span>
                  </div>

                  {/* 接缝（E4）：每两段之间一格，点开调色与转场抽屉 */}
                  {seams.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      <span className="text-[8.5px] tracking-[.08em] text-muted-2">接缝</span>
                      {seams.map((seam) => (
                        <button
                          key={seam.itemId}
                          type="button"
                          onClick={() => setGradeOpen(true)}
                          title={
                            seam.transition
                              ? `${seam.label} 前面：${seam.transition.kind === "black" ? "淡到黑" : "淡到白"} ${seam.transition.durationMs}ms`
                              : `${seam.label} 前面是硬切：点开改成淡入淡出`
                          }
                          className={cn(
                            "tnum rounded-token border px-1.5 py-px text-[8.5px] transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text",
                            seam.transition
                              ? "border-pick/60 text-text"
                              : "border-line text-muted-2",
                          )}
                        >
                          {seam.label}
                          {seam.transition
                            ? ` ${seam.transition.kind === "black" ? "黑" : "白"}${seam.transition.durationMs}`
                            : " 硬切"}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* 画幅（E5）：一行摘要，点开抽屉改形状与每一镜的裁切焦点 */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[8.5px]">
                    <span className="tracking-[.08em] text-muted-2">画幅</span>
                    <button
                      type="button"
                      onClick={() => setFrameOpen(true)}
                      title="点开改画幅与每一镜的裁切焦点"
                      className={cn(
                        "tnum rounded-token border px-1.5 py-px transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text",
                        isDefaultFrame(project.frame)
                          ? "border-line text-muted-2"
                          : "border-pick/60 text-text",
                      )}
                    >
                      {project.frame.aspect} ·{" "}
                      {project.frame.fit === "pad"
                        ? "留边"
                        : project.frame.fit === "crop"
                          ? "裁切"
                          : "模糊填充"}
                    </button>
                    {project.frame.fit === "crop" && (
                      <span className="text-muted-2">
                        {view.clips.filter((clip) => clip.focus).length > 0
                          ? `${view.clips.filter((clip) => clip.focus).length} 镜设过焦点`
                          : "全部居中"}
                      </span>
                    )}
                    {current && project.frame.fit === "crop" && (
                      <span className="text-muted-2">
                        · 当前 {shotLabel(current.shotNo)} {focusLine(currentFocus)}
                      </span>
                    )}
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
                  <div
                    ref={cueLaneRef}
                    className="relative mt-2 h-[26px] w-full overflow-hidden rounded-token border border-line bg-surface"
                  >
                    {view.cues.map((cue) => {
                      const previewDelta = cueDrag?.lineId === cue.lineId ? cueDrag.deltaMs : 0;
                      return (
                        <button
                          key={cue.id}
                          type="button"
                          onClick={() => {
                            if (skipCueClick.current) {
                              skipCueClick.current = false;
                              return;
                            }
                            seekTo(cue.startMs);
                            openCueEditor(cue.lineId);
                          }}
                          onPointerDown={(event) => startCueDrag(event, cue.lineId)}
                          onPointerMove={moveCueDrag}
                          onPointerUp={endCueDrag}
                          onPointerCancel={cancelCueDrag}
                          title={`${timecode(cue.startMs)} · ${cue.characterName}：${cue.text}${cue.manual ? "（手改过）" : ""} · 拖动整句挪位（10ms 一档），点一下改断句`}
                          style={{
                            left: `${((cue.startMs + previewDelta) / Math.max(1, view.totalMs)) * 100}%`,
                            width: `${(cue.durationMs / Math.max(1, view.totalMs)) * 100}%`,
                          }}
                          className={cn(
                            "absolute top-0 flex h-full min-w-[2px] cursor-grab touch-none items-center justify-center overflow-hidden border-r border-bg px-0.5 text-[8px] select-none transition-colors duration-[var(--dur)] active:cursor-grabbing",
                            previewDelta !== 0 && "z-10 ring-1 ring-pick",
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
                      );
                    })}
                    {view.cues.length === 0 && (
                      <span className="flex h-full items-center px-2 text-[9px] text-muted-2">
                        时间线里还没有台词
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[8.5px] leading-[1.6] text-muted-2">
                    按标点断句，时间按字数分；改字数档位，断句会立刻重排。点一条字幕跳到那一句，同时打开手改；
                    按住一条左右拖，整句挪位（10ms 一档，松手才写入；几十毫秒的微调仍用下面的 ‹ ›）。
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
                                  {line.voiceOffsetMs !== 0 && `配音 ${signedOffset(line.voiceOffsetMs)}`}
                                  {line.voiceOffsetMs !== 0 && line.subtitleOffsetMs !== 0 && " · "}
                                  {line.subtitleOffsetMs !== 0 && `字幕 ${signedOffset(line.subtitleOffsetMs)}`}
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

                  {view.music.length > 0 && (
                    <div className="mt-2 flex flex-col gap-2">
                      {view.music.map((cue, index) => (
                        <div key={cue.id} className="rounded-token border border-line p-2.5">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className="min-w-0 flex-1 truncate text-[10.5px] text-text">
                              <span className="tnum mr-1.5 text-[8.5px] text-muted-2">
                                {index + 1}
                              </span>
                              {cue.title}
                            </span>
                            <span className="tnum text-[8.5px] text-muted-2">
                              {cue.assetDurationMs ? fmtSec(cue.assetDurationMs) : "时长未知"} ·{" "}
                              {cue.loop ? "循环" : "只播一遍"} · {fmtSec(cue.startMs)} 起 · 长{" "}
                              {fmtSec(cue.durationMs)}
                            </span>
                          </div>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            <label className="flex items-center gap-2 text-[9.5px] text-muted-2">
                              起点（秒）
                              <input
                                type="number"
                                min={0}
                                max={Math.max(0, view.totalMs / 1000)}
                                step={0.5}
                                value={(cue.startMs / 1000).toFixed(1)}
                                disabled={Boolean(readOnly)}
                                onChange={(event) =>
                                  updateMusic(
                                    {
                                      startMs: Math.round(
                                        Math.max(0, Number(event.target.value)) * 1000,
                                      ),
                                    },
                                    cue.id,
                                  )
                                }
                                className="tnum w-full min-w-0 rounded-token border border-line bg-transparent px-1.5 py-0.5 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
                              />
                            </label>
                            <label className="flex items-center gap-2 text-[9.5px] text-muted-2">
                              这一段多长（秒）
                              <input
                                type="number"
                                min={0.5}
                                step={0.5}
                                value={(cue.durationMs / 1000).toFixed(1)}
                                disabled={Boolean(readOnly)}
                                onChange={(event) =>
                                  updateMusic(
                                    {
                                      durationMs: Math.round(
                                        Math.max(0.5, Number(event.target.value)) * 1000,
                                      ),
                                    },
                                    cue.id,
                                  )
                                }
                                className="tnum w-full min-w-0 rounded-token border border-line bg-transparent px-1.5 py-0.5 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
                              />
                            </label>
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
                                {["", "紧张", "悬疑", "温柔", "悲伤", "燃", "轻松"].map(
                                  (mood) => (
                                    <option key={mood || "none"} value={mood} className="bg-surface">
                                      {mood || "未标"}
                                    </option>
                                  ),
                                )}
                              </select>
                            </label>
                            <button
                              type="button"
                              onClick={() => toggleMusicPreview(cue)}
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
                          </div>
                          <p className="mt-1.5 text-[8.5px] leading-[1.6] text-muted-2">
                            授权：{cue.licenseRef} · 导出时混音总线归一到 −14 LUFS，真峰值目标
                            ≤ −1 dBTP。
                          </p>
                        </div>
                      ))}
                    </div>
                  )}

                  {view.music.length < 4 ? (
                    <div
                      className={
                        view.music.length > 0 ? "mt-3 border-t border-line pt-3" : undefined
                      }
                    >
                      <p className="mt-1 text-[9.5px] leading-[1.7] text-muted-2">
                        {view.music.length === 0
                          ? "选一条自己有权使用的音乐。加入后默认循环铺满全片，台词出现时自动压低 15 dB；整片混音会归一到 −14 LUFS。"
                          : "再加一段：各段在自己的起点进来，可以叠在同一段时间上做层次，也可以各占一段。"}
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
                          起点（秒）
                          <input
                            type="number"
                            min={0}
                            max={Math.max(0, view.totalMs / 1000)}
                            step={0.5}
                            value={musicStartSec}
                            onChange={(event) => setMusicStartSec(event.target.value)}
                            className="tnum w-[76px] rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
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
                          {view.music.length === 0 ? "加入配乐" : "再加一段"}
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
                        mp3 / m4a / wav / ogg，≤ 18 MB，最多 4 段。没有授权来源的音乐不会进项目；
                        上传素材在导出前检查里还会再要求确认一次。
                      </p>
                    </div>
                  ) : (
                    <p className="mt-3 border-t border-line pt-3 text-[9px] leading-[1.6] text-muted-2">
                      已经有 4 段配乐（渲染清单上限）：先移掉或合并一段再加。
                    </p>
                  )}

                  <audio ref={musicPreviewRef} className="hidden" />

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
                      {loudness.dialogueGainsDb && loudness.dialogueGainsDb.length > 0 && (
                        <p className="tnum mt-1 text-[8.5px] leading-[1.6] text-muted-2">
                          {(() => {
                            const gains = loudness.dialogueGainsDb!;
                            const low = Math.min(...gains);
                            const high = Math.max(...gains);
                            const zero = gains.every((gain) => gain === 0);
                            const touch = gains.some((gain) => Math.abs(gain) >= 12);
                            return zero
                              ? `对白按句归一：${gains.length} 句，都在目标位附近`
                              : `对白按句归一：${gains.length} 句，增益 ${low >= 0 ? "+" : ""}${low.toFixed(1)} … ${high >= 0 ? "+" : ""}${high.toFixed(1)} dB${touch ? "（有一句已触 12 dB 上限）" : ""}`;
                          })()}
                        </p>
                      )}
                      {loudness.sfxGainsDb && loudness.sfxGainsDb.length > 0 && (
                        <p className="tnum mt-1 text-[8.5px] leading-[1.6] text-muted-2">
                          {(() => {
                            const gains = loudness.sfxGainsDb!;
                            const zero = gains.every((gain) => gain === 0);
                            const touch = gains.some((gain) => Math.abs(gain) >= 15);
                            return zero
                              ? `音效按角色归一：${gains.length} 条，都在各自目标位附近`
                              : `音效按角色归一：${gains.length} 条，叠加增益 ${gains
                                  .map((gain) => `${gain >= 0 ? "+" : ""}${gain.toFixed(1)}`)
                                  .join(" / ")} dB${touch ? "（有一条已触 15 dB 上限）" : ""}`;
                          })()}
                        </p>
                      )}
                    </div>
                  )}
                </section>

                <section aria-label="音效" className="mt-5 border-t border-line pt-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-[11px] tracking-[.06em] text-text">音效</h2>
                    <span className="text-[8.5px] tracking-[.06em] text-muted-2">C7</span>
                  </div>
                  <p className="mt-1 text-[9.5px] leading-[1.7] text-muted-2">
                    短促的效果音：关门、脚步、雨声、转场一记重音。音效不跟着台词压低，
                    按自己的起点与增益混进音效总线；环境声可以循环铺满一段。
                  </p>

                  {view.sfx.length > 0 && (
                    <div className="mt-2 flex flex-col gap-2">
                      {view.sfx.map((cue) => (
                        <div key={cue.id} className="rounded-token border border-line p-2.5">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className="min-w-0 flex-1 truncate text-[10.5px] text-text">
                              {cue.title}
                            </span>
                            <span className="tnum text-[8.5px] text-muted-2">
                              {cue.role === "ambience"
                                ? "环境"
                                : cue.role === "impact"
                                  ? "重音"
                                  : cue.role === "transition"
                                    ? "转场"
                                    : "拟音"}{" "}
                              · {cue.loop ? "循环" : "只播一遍"} · {fmtSec(cue.startMs)} 起 · 长{" "}
                              {fmtSec(cue.durationMs)}
                            </span>
                          </div>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            <label className="flex items-center gap-2 text-[9.5px] text-muted-2">
                              起点（秒）
                              <input
                                type="number"
                                min={0}
                                max={Math.max(0, view.totalMs / 1000)}
                                step={0.1}
                                value={(cue.startMs / 1000).toFixed(1)}
                                disabled={Boolean(readOnly)}
                                onChange={(event) =>
                                  updateSfx(
                                    {
                                      startMs: Math.round(
                                        Math.max(0, Number(event.target.value)) * 1000,
                                      ),
                                    },
                                    cue.id,
                                  )
                                }
                                className="tnum w-full min-w-0 rounded-token border border-line bg-transparent px-1.5 py-0.5 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
                              />
                            </label>
                            <label className="flex items-center gap-2 text-[9.5px] text-muted-2">
                              这一段多长（秒）
                              <input
                                type="number"
                                min={0.1}
                                step={0.1}
                                value={(cue.durationMs / 1000).toFixed(1)}
                                disabled={Boolean(readOnly)}
                                onChange={(event) =>
                                  updateSfx(
                                    {
                                      durationMs: Math.round(
                                        Math.max(0.1, Number(event.target.value)) * 1000,
                                      ),
                                    },
                                    cue.id,
                                  )
                                }
                                className="tnum w-full min-w-0 rounded-token border border-line bg-transparent px-1.5 py-0.5 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
                              />
                            </label>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-3">
                            <label className="flex flex-1 items-center gap-2 text-[9.5px] text-muted-2">
                              增益
                              <input
                                type="range"
                                min={-40}
                                max={0}
                                step={1}
                                value={cue.gainDb}
                                disabled={Boolean(readOnly)}
                                onChange={(event) =>
                                  updateSfx({ gainDb: Number(event.target.value) }, cue.id)
                                }
                                className="min-w-0 flex-1 accent-[var(--pick)]"
                              />
                              <span className="tnum w-[42px] text-right text-[9px] text-muted">
                                {cue.gainDb} dB
                              </span>
                            </label>
                            <label className="flex cursor-pointer items-center gap-1.5 text-[9.5px] text-muted">
                              <input
                                type="checkbox"
                                checked={cue.loop}
                                disabled={Boolean(readOnly)}
                                onChange={(event) =>
                                  updateSfx({ loop: event.target.checked }, cue.id)
                                }
                                className="accent-[var(--pick)]"
                              />
                              循环
                            </label>
                            <button
                              type="button"
                              onClick={() => toggleSfxPreview(cue)}
                              className="rounded-token border border-line px-2 py-0.5 text-[9px] text-muted enabled:hover:border-line-2 enabled:hover:text-text"
                            >
                              试听
                            </button>
                            <button
                              type="button"
                              onClick={() => removeSfx(cue.id)}
                              disabled={Boolean(readOnly)}
                              className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-pick disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              移掉
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {view.sfx.length < 8 ? (
                    <div
                      className={
                        view.sfx.length > 0 ? "mt-3 border-t border-line pt-3" : undefined
                      }
                    >
                      <div className="mt-2 flex flex-wrap items-end gap-2">
                        <label className="flex min-w-[170px] flex-1 flex-col gap-1 text-[9.5px] text-muted-2">
                          音效文件
                          <input
                            type="file"
                            accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg"
                            disabled={Boolean(readOnly) || sfxBusy}
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              void chooseSfx(file);
                              event.target.value = "";
                            }}
                            className="rounded-token border border-line bg-transparent px-2 py-1 text-[10px] text-muted file:mr-2 file:rounded-token file:border-0 file:bg-line file:px-2 file:py-0.5 file:text-[9.5px] file:text-text"
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-[9.5px] text-muted-2">
                          起点（秒）
                          <input
                            type="number"
                            min={0}
                            max={Math.max(0, view.totalMs / 1000)}
                            step={0.1}
                            value={sfxStartSec}
                            onChange={(event) => setSfxStartSec(event.target.value)}
                            className="tnum w-[76px] rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-[9.5px] text-muted-2">
                          类型
                          <select
                            value={sfxRole}
                            onChange={(event) => setSfxRole(event.target.value as SfxCue["role"])}
                            className="rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                          >
                            <option value="foley" className="bg-surface">拟音</option>
                            <option value="ambience" className="bg-surface">环境</option>
                            <option value="impact" className="bg-surface">重音</option>
                            <option value="transition" className="bg-surface">转场</option>
                          </select>
                        </label>
                        <label className="mb-[3px] flex cursor-pointer items-center gap-1.5 text-[9.5px] text-muted">
                          <input
                            type="checkbox"
                            checked={sfxLoop}
                            onChange={(event) => setSfxLoop(event.target.checked)}
                            className="accent-[var(--pick)]"
                          />
                          循环铺满
                        </label>
                      </div>
                      <div className="mt-2 flex flex-wrap items-end gap-2">
                        <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[9.5px] text-muted-2">
                          授权来源（必填）
                          <input
                            value={sfxLicense}
                            onChange={(event) => setSfxLicense(event.target.value)}
                            placeholder="例如：Freesound 授权 / 授权书 2026-11-01 / 自己录制"
                            className="rounded-token border border-line bg-transparent px-2 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={commitSfx}
                          disabled={
                            Boolean(readOnly) || sfxBusy || !sfxFile || !sfxLicense.trim()
                          }
                          className="rounded-token border border-line px-3 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {view.sfx.length === 0 ? "加入音效" : "再加一条"}
                        </button>
                      </div>
                      {sfxFile && (
                        <p className="mt-1 text-[9px] text-muted">
                          已读入 {sfxFile.name} · {fmtSec(sfxFile.durationMs)} ·{" "}
                          {(sfxFile.size / 1024 / 1024).toFixed(1)} MB
                        </p>
                      )}
                      {sfxBusy && (
                        <p className="mt-1 text-[9px] text-muted-2">正在读音频与时长…</p>
                      )}
                      {sfxError && (
                        <p className="mt-1 text-[9px] leading-[1.6] text-pick">{sfxError}</p>
                      )}
                      <p className="mt-1 text-[8.5px] leading-[1.6] text-muted-2">
                        mp3 / m4a / wav / ogg，≤ 18 MB，最多 8 条。默认按文件长度放一遍；
                        环境声勾「循环铺满」后铺到片尾。
                      </p>
                    </div>
                  ) : (
                    <p className="mt-3 border-t border-line pt-3 text-[9px] leading-[1.6] text-muted-2">
                      已经有 8 条音效（渲染清单上限）：先移掉一条再加。
                    </p>
                  )}

                  <audio ref={sfxPreviewRef} className="hidden" />
                </section>

                <section aria-label="混音平衡" className="mt-5 border-t border-line pt-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-[11px] tracking-[.06em] text-text">混音平衡</h2>
                    <span className="text-[8.5px] tracking-[.06em] text-muted-2">C7</span>
                  </div>
                  <p className="mt-1 text-[9.5px] leading-[1.7] text-muted-2">
                    三路总线各调一次：对白要更清楚就把对白抬起来，音乐抢戏就压下去。
                    这是相对平衡，整片随后仍归一到 −14 LUFS；全归 0 与改动前逐字节同构。
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    {(
                      [
                        ["dialogueDb", "对白"],
                        ["musicDb", "配乐"],
                        ["sfxDb", "音效"],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key} className="flex items-center gap-2 text-[9.5px] text-muted-2">
                        {label}
                        <input
                          type="range"
                          min={-12}
                          max={12}
                          step={1}
                          value={view.mix[key]}
                          disabled={Boolean(readOnly)}
                          onChange={(event) => setMix({ [key]: Number(event.target.value) })}
                          className="min-w-0 flex-1 accent-[var(--pick)]"
                        />
                        <span className="tnum w-[40px] text-right text-[9px] text-muted">
                          {view.mix[key] > 0 ? "+" : ""}
                          {view.mix[key]} dB
                        </span>
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setMix({ dialogueDb: 0, musicDb: 0, sfxDb: 0 })}
                    disabled={
                      Boolean(readOnly) ||
                      (view.mix.dialogueDb === 0 &&
                        view.mix.musicDb === 0 &&
                        view.mix.sfxDb === 0)
                    }
                    className="mt-2 rounded-token border border-line px-2 py-0.5 text-[9px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    全部归 0
                  </button>
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
                    <label className="mt-2 flex items-start gap-2 text-[9.5px] leading-[1.7] text-muted">
                      <input
                        id="speaker-colors"
                        type="checkbox"
                        checked={style.speakerColors}
                        disabled={readOnly}
                        onChange={(event) =>
                          setSubtitleLayout({ speakerColors: event.target.checked })
                        }
                        className="mt-[3px] accent-[var(--pick)]"
                      />
                      <span>
                        按角色着色
                        <span className="ml-1 text-[8.5px] text-muted-2">
                          每个角色一句一个颜色（六个轮回），多人对话一眼看出谁在说；关掉就全是白色。默认按角色在项目里的顺序取，也可以下面逐个点名。
                        </span>
                      </span>
                    </label>
                    {style.speakerColors && project.characters.length > 0 && (
                      <div className="mt-2 rounded-token border border-line bg-surface/60 p-2">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-[9px] text-muted">每个角色的颜色</span>
                          <span className="text-[8.5px] text-muted-2">
                            点色块点名；「默认」回到按顺序取
                          </span>
                        </div>
                        <ul className="mt-1.5 space-y-1">
                          {project.characters.map((character, index) => {
                            const fallbackColor = speakerColorAt(index);
                            const overrides = style.speakerColorOverrides ?? {};
                            const color = overrides[character.id] ?? fallbackColor;
                            const named = overrides[character.id] !== undefined;
                            return (
                              <li
                                key={character.id}
                                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[9.5px]"
                              >
                                <span className="w-[64px] shrink-0 truncate text-text">
                                  {character.name}
                                </span>
                                <span className="flex items-center gap-1">
                                  {SPEAKER_COLORS.map((option) => (
                                    <button
                                      key={option}
                                      type="button"
                                      disabled={readOnly}
                                      onClick={() =>
                                        setSubtitleLayout({
                                          speakerColorOverrides: {
                                            ...overrides,
                                            [character.id]: option,
                                          },
                                        })
                                      }
                                      title={`把「${character.name}」的字幕改成 ${option}`}
                                      aria-label={`${character.name} ${option}`}
                                      aria-pressed={color === option}
                                      style={{ backgroundColor: option }}
                                      className={cn(
                                        "h-3.5 w-3.5 rounded-full border transition-transform duration-[var(--dur)] disabled:opacity-40",
                                        color === option
                                          ? "scale-110 border-text"
                                          : "border-line-2 hover:scale-105",
                                      )}
                                    />
                                  ))}
                                </span>
                                <span className="tnum text-[8.5px] text-muted-2">{color}</span>
                                {named ? (
                                  <button
                                    type="button"
                                    disabled={readOnly}
                                    onClick={() => {
                                      const next = { ...overrides };
                                      delete next[character.id];
                                      setSubtitleLayout({ speakerColorOverrides: next });
                                    }}
                                    className="rounded-token border border-line px-1 py-0.5 text-[8.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
                                  >
                                    默认
                                  </button>
                                ) : (
                                  <span className="text-[8.5px] text-muted-2">按顺序</span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setSubtitleLayout({
                            fontSizeCqw: null,
                            bottomPct: null,
                            strokeCqw: null,
                            speakerColors: null,
                            speakerColorOverrides: null,
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
                    {platformValidation.spec.maxFileNote && (
                      <p className="mt-1.5 text-[8.5px] leading-[1.6] text-muted-2">
                        文件上限的口径：{platformValidation.spec.maxFileNote}。
                      </p>
                    )}
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

                    {/* 勾选确认看的是内容侧：平台规格那一项由每个平台各自判（G9），
                        当前选着抖音不该挡住 B 站 / X 那几版的确认 */}
                    {report.review > 0 && !contentBlocking && (
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
                        ? "检查通过：导出按钮都可用。"
                        : contentGateOpen
                          ? `${gateReason}字幕、OTIO 与预览仍然可以导出（它们不看平台画幅）；成片、封面与发布包要等这一项过了。`
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
                              {frameSize(id, project.frame.aspect).width}×
                              {frameSize(id, project.frame.aspect).height} · {option.fps}fps
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

                  <div className="mt-3 border-t border-line pt-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[9px] tracking-[.06em] text-muted-2">封面</span>
                      <select
                        aria-label="封面用哪一镜"
                        value={coverClip?.id ?? ""}
                        onChange={(event) => setCoverShotId(event.target.value)}
                        disabled={coverClips.length === 0}
                        className="rounded-token border border-line bg-transparent px-1.5 py-0.5 text-[10px] text-text focus:border-line-2 focus:outline-none disabled:opacity-40"
                      >
                        {coverClips.map((clip) => (
                          <option key={clip.id} value={clip.id} className="bg-surface">
                            第 {clip.shotNo} 镜 · {clip.takeNo} 版
                          </option>
                        ))}
                      </select>
                      {coverCanSeek ? (
                        <>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={Math.round(coverPos * 100)}
                            onChange={(event) => setCoverPos(Number(event.target.value) / 100)}
                            aria-label="封面取帧位置"
                            className="w-24 accent-[var(--pick)]"
                          />
                          <span className="text-[9px] text-muted-2">{fmtSec(coverAtMs)}</span>
                        </>
                      ) : (
                        <span className="text-[9px] text-muted-2">静态图 · 不切帧</span>
                      )}
                      <button
                        type="button"
                        onClick={() => void generateCover()}
                        disabled={coverBusy || !gateOpen || !coverClip}
                        className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {coverBusy ? "正在出封面…" : "生成封面"}
                      </button>
                      <button
                        type="button"
                        onClick={saveCover}
                        disabled={!cover}
                        className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        下载 PNG
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveCoverToLibrary()}
                        disabled={!cover || Boolean(coverSavedId)}
                        className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {coverSavedId ? "已存进资产库" : "存进资产库"}
                      </button>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span className="text-[9px] text-muted-2">版式</span>
                      {COVER_STYLES.map((style) => (
                        <button
                          key={style.id}
                          type="button"
                          onClick={() => setCoverStyle(style.id)}
                          aria-pressed={coverStyle === style.id}
                          title={style.blurb}
                          className={`rounded-token border px-1.5 py-px text-[9px] transition-colors duration-[var(--dur)] ${
                            coverStyle === style.id
                              ? "border-pick text-text"
                              : "border-line text-muted-2 hover:border-line-2 hover:text-text"
                          }`}
                        >
                          {style.name}
                        </button>
                      ))}
                      <span className="tnum ml-auto text-[8.5px] text-muted-2">
                        {coverSize.ratio} · {coverSize.width}×{coverSize.height}
                      </span>
                    </div>
                    {cover && (
                      <div className="mt-2 flex items-start gap-2.5">
                        <img
                          src={cover.dataUrl}
                          alt="封面预览"
                          className="border border-line object-cover"
                          style={{
                            aspectRatio: coverSize.ratio.replace(":", " / "),
                            width: coverSize.ratio === "16:9" ? 106 : coverSize.ratio === "3:4" ? 72 : 60,
                          }}
                        />
                        <p className="text-[9.5px] leading-[1.7] text-muted">
                          {cover.art.width}×{cover.art.height} · 第 {cover.art.shotNo} 镜{" "}
                          {fmtSec(cover.art.atMs)} · {formatSize(cover.art.bytes)}
                          {coverStale && (
                            <span className="text-pick"> · 标题或平台改过了，重新生成才会带上新的</span>
                          )}
                        </p>
                      </div>
                    )}
                    <p className="mt-1.5 text-[9.5px] leading-[1.7] text-muted-2">
                      封面 = 抽一帧 + 项目标题 + 简介第一行（钩子）；版式与尺寸跟着目标平台走
                      （{coverSize.ratio}），「AI 生成」角标按平台摆在
                      {badgeCornerLabel(badgePlacement.corner)}，和成片同一张表。拖上面那条找回最像封面的一帧；
                      「存进资产库」会把这张 PNG 记成项目资产，下一集可以直接拿去用。
                    </p>
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
                    {/* 多平台版本（G9）：勾几个平台就出几版，形状与角标跟着平台走。
                        闸门不看法当前平台的规格——那一项由面板里每个平台各自判。 */}
                    <button
                      type="button"
                      onClick={() => setMultiOpen(true)}
                      disabled={!contentGateOpen || view.clips.length === 0}
                      title="按平台规格一次出好几版：抖音竖屏、B 站横屏、X 方形；不另开渲染路径"
                      className="rounded-token border border-line px-3 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      多平台版本
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
                      disabled={!contentGateOpen}
                      className="rounded-token border border-line px-3 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      导出预览 HTML
                    </button>
                    <button
                      type="button"
                      onClick={exportOtio}
                      disabled={!contentGateOpen}
                      className="rounded-token border border-line px-3 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      导出 .otio
                    </button>
                    <button
                      type="button"
                      onClick={exportSrt}
                      disabled={!contentGateOpen}
                      className="rounded-token border border-line px-3 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      导出字幕 SRT
                    </button>
                    <button
                      type="button"
                      onClick={exportAss}
                      disabled={!contentGateOpen}
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
                    成片 MP4 由本机 ffmpeg 渲染：草稿短边 540 / 24fps 出处快、定稿短边 1080 / 30fps 画质高；画幅按「画幅」里的设置；字幕可选烧进画面，「AI 生成」角标始终保留。
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
      {silentOpen && (
        <SilentWatchPanel
          view={view}
          onSeekCue={(cue) => {
            setSilentOpen(false);
            seekTo(cue.startMs);
            openCueEditor(cue.lineId);
          }}
          onSeek={(ms) => {
            setSilentOpen(false);
            seekTo(ms);
          }}
          onClose={() => setSilentOpen(false)}
        />
      )}
      {bilingualOpen && (
        <BilingualPanel
          view={view}
          onTranslate={(lineId, translation) => setLineTranslation(lineId, translation)}
          onSwitch={(patch) => setSubtitleTranslation(patch)}
          onSeek={(ms) => {
            setBilingualOpen(false);
            seekTo(ms);
          }}
          readOnly={Boolean(readOnly)}
          onClose={() => setBilingualOpen(false)}
        />
      )}
      {brandOpen && (
        <BrandPanel
          view={view}
          onSave={(patch) => setBrand(patch)}
          readOnly={Boolean(readOnly)}
          onClose={() => setBrandOpen(false)}
        />
      )}
      {publishOpen && (
        <PublishLedgerPanel
          project={project}
          onSave={(packageId, patch) => recordPublishReceipt(packageId, patch)}
          readOnly={Boolean(readOnly)}
          onClose={() => setPublishOpen(false)}
        />
      )}
      {multiOpen && (
        <MultiPlatformPanel
          plans={versionPlans(project.frame, view.totalMs, PLATFORM_SPECS.map((spec) => spec.id), quality)}
          selected={multiPicks}
          onToggle={(id) =>
            setMultiPicks((prev) =>
              prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
            )
          }
          onExport={() => void exportVersions()}
          stage={multiStage}
          busy={multiBusy}
          results={multiResults}
          frameLabel={`${project.frame.aspect} · ${
            project.frame.fit === "pad" ? "留边" : project.frame.fit === "crop" ? "裁切" : "模糊填充"
          }`}
          gateReason={
            contentGateReason ||
            (quality === "final" && !finalAllowed
              ? "定稿要先在页面底部确认这一版成片；没确认时只能导草稿。"
              : "")
          }
          readOnly={Boolean(readOnly)}
          onClose={() => setMultiOpen(false)}
        />
      )}
      {frameOpen && (
        <FramePanel
          frame={project.frame}
          onSave={(next) => setFrame(next)}
          shots={frameShots}
          onFocus={(shotId, focus) => setShotFocus(shotId, focus)}
          readOnly={Boolean(readOnly)}
          onClose={() => setFrameOpen(false)}
        />
      )}
      {gradeOpen && (
        <GradePanel
          grade={project.grade}
          onSave={(next) => setGrade(next)}
          seams={seams}
          onTransition={(itemId, transition) => setTimelineTransition(itemId, transition)}
          onImportLut={importLut}
          readOnly={Boolean(readOnly)}
          onClose={() => setGradeOpen(false)}
        />
      )}
      {rightsOpen && (
        <RightsPanel
          project={project}
          onSave={(record) => upsertRights(record)}
          onRemove={(id) => removeRights(id)}
          readOnly={Boolean(readOnly)}
          onClose={() => setRightsOpen(false)}
        />
      )}
      <StageGate stage="edit" />
    </div>
  );
}
