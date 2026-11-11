"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { TopBar } from "@/components/top-bar";
import {
  DEFAULT_SUBTITLE_CHARS,
  SAFE_AREA,
  SUBTITLE_CHARS,
  SUBTITLE_STYLES,
  timecode,
  toEditView,
  type SubtitleChars,
  type SubtitleStyleId,
} from "@/lib/edit";
import {
  buildOtio,
  buildPreviewHtml,
  buildPublishPackage,
  buildSrt,
  downloadFile,
  safeFileName,
} from "@/lib/export-cut";
import { shotLabel, spendOf, toStageView } from "@/lib/read-model";
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
  const setBudget = useWorkbench((state) => state.setBudget);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [showSafe, setShowSafe] = useState(true);
  const [styleId, setStyleId] = useState<SubtitleStyleId>("default");
  const [maxChars, setMaxChars] = useState<SubtitleChars>(DEFAULT_SUBTITLE_CHARS);
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState("");
  const [topics, setTopics] = useState("短剧,AI创作");
  const [notice, setNotice] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const fired = useRef<Set<string>>(new Set());

  const view = useMemo(() => toEditView(project, { maxChars }), [project, maxChars]);
  const stage = useMemo(() => toStageView(project), [project]);
  const spend = useMemo(() => spendOf(project), [project]);

  const style = SUBTITLE_STYLES[styleId];
  const current =
    view.clips.find(
      (clip) =>
        elapsed >= clip.startMs && elapsed < clip.startMs + clip.durationMs,
    ) ?? view.clips.at(-1);
  const selected =
    view.clips.find((clip) => clip.id === selectedId) ?? current ?? view.clips[0];
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
        if (elapsed < line.startMs || elapsed >= line.startMs + line.durationMs) continue;
        if (fired.current.has(line.id)) continue;
        fired.current.add(line.id);
        element.src = line.audioUri;
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

  const exportPreview = () => {
    const html = buildPreviewHtml(view, styleId);
    const size = new Blob([html]).size;
    downloadFile(safeFileName(view.title, "预览.html"), html, "text/html");
    setNotice(
      `预览已导出：${(size / 1024 / 1024).toFixed(1)} MB。双击打开就能播；素材是内嵌的。`,
    );
  };

  const exportOtio = () => {
    const otio = buildOtio(view);
    downloadFile(
      safeFileName(view.title, "时间线.otio"),
      JSON.stringify(otio, null, 2),
      "application/json",
    );
    setNotice("时间线已按 OTIO 导出：可以拿到剪辑软件里继续剪。");
  };

  const exportSrt = () => {
    downloadFile(safeFileName(view.title, "字幕.srt"), buildSrt(view), "text/plain");
    setNotice("字幕已导出（SRT）：时间按初剪的绝对时间。");
  };

  const exportPackage = () => {
    const pack = buildPublishPackage(view, {
      title,
      description,
      topics: topics.split(/[,，\s]+/),
      style: styleId,
      kind: "draft",
    });
    downloadFile(
      safeFileName(view.title, "发布包.json"),
      JSON.stringify(pack, null, 2),
      "application/json",
    );
    setNotice(
      pack.warnings.length > 0
        ? `发布包已导出。还有几件事没齐：${pack.warnings.join("；")}。`
        : "发布包已导出：标题、简介、话题、封面、字幕与 AI 标注都在里面。",
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
                      src={current.uri}
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
                      src={current.stillUri}
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

                  <span className="absolute left-2 top-2 rounded-token bg-black/55 px-1.5 py-0.5 text-[8.5px] text-white/80">
                    {current ? `${shotLabel(current.shotNo)} · ${current.takeNo} 版` : ""}
                  </span>
                  {current?.locked && (
                    <span className="absolute right-2 top-2 rounded-token bg-black/55 px-1.5 py-0.5 text-[8.5px] text-white/80">
                      已锁定
                    </span>
                  )}
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
                  <div className="mt-2 flex h-[26px] w-full overflow-hidden rounded-token border border-line bg-surface">
                    {view.cues.map((cue) => (
                      <button
                        key={cue.id}
                        type="button"
                        onClick={() => seekTo(cue.startMs)}
                        title={`${timecode(cue.startMs)} · ${cue.characterName}：${cue.text}`}
                        style={{
                          width: `${(cue.durationMs / Math.max(1, view.totalMs)) * 100}%`,
                          minWidth: cue.text.length > 0 ? 2 : 0,
                        }}
                        className={cn(
                          "flex min-w-[2px] items-center justify-center overflow-hidden border-r border-bg px-0.5 text-[8px] transition-colors duration-[var(--dur)] last:border-r-0",
                          elapsed >= cue.startMs &&
                            elapsed < cue.startMs + cue.durationMs
                            ? "bg-text/20 text-text"
                            : "bg-line/50 text-muted hover:bg-line-2",
                        )}
                      >
                        <span className="truncate">{cue.text}</span>
                      </button>
                    ))}
                    {view.cues.length === 0 && (
                      <span className="flex flex-1 items-center px-2 text-[9px] text-muted-2">
                        时间线里还没有台词
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[8.5px] leading-[1.6] text-muted-2">
                    按标点断句，时间按字数分；改字数档位，断句会立刻重排。点一条字幕跳到那一句。
                  </p>

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

                <section aria-label="导出" className="mt-6 border-t border-line pt-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-[11px] tracking-[.06em] text-text">导出</h2>
                    <label className="flex items-center gap-2 text-[9.5px] text-muted-2">
                      字幕样式
                      <select
                        value={styleId}
                        onChange={(event) => setStyleId(event.target.value as SubtitleStyleId)}
                        className="rounded-token border border-line bg-transparent px-1.5 py-0.5 text-[10px] text-text focus:border-line-2 focus:outline-none"
                      >
                        {Object.values(SUBTITLE_STYLES).map((item) => (
                          <option key={item.id} value={item.id} className="bg-surface">
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
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

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={exportPreview}
                      className="rounded-token border border-pick bg-pick px-3 py-1 text-[10.5px] text-white transition-opacity duration-[var(--dur)] hover:opacity-90"
                    >
                      导出预览 HTML
                    </button>
                    <button
                      type="button"
                      onClick={exportOtio}
                      className="rounded-token border border-line px-3 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                    >
                      导出 .otio
                    </button>
                    <button
                      type="button"
                      onClick={exportSrt}
                      className="rounded-token border border-line px-3 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                    >
                      导出字幕 SRT
                    </button>
                    <button
                      type="button"
                      onClick={exportPackage}
                      className="rounded-token border border-line px-3 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                    >
                      导出发布包
                    </button>
                  </div>

                  {notice && (
                    <p className="mt-2 text-[9.5px] leading-[1.7] text-muted">{notice}</p>
                  )}

                  <p className="mt-3 text-[9.5px] leading-[1.7] text-muted-2">
                    预览 HTML 是自包含的：画面、字幕、音轨都在文件里，双击就能看。
                    <span className="text-muted"> mp4 还没做</span>——本机 ffmpeg 已装好，
                    但服务端渲染管线还没接，所以发布包里的视频位先空着，
                    拿 OTIO 去剪辑软件出片是现在能走通的路。
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
    </div>
  );
}
