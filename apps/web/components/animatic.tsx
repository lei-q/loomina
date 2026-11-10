"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Scene } from "@/components/scene";
import { shotLabel, type AnimaticView } from "@/lib/read-model";
import { CloseIcon, PauseIcon, PlayIcon } from "@/components/icons";

/**
 * 预演（ADR-0084）：把这一条片按镜头时长一张张放过去。
 *
 * 只在浏览器里播现成的关键帧 / 视频，不渲染文件、不花钱；
 * 先让人看见节奏与字幕，再决定要不要生成。
 */
export function AnimaticOverlay({
  view,
  onClose,
}: {
  view: AnimaticView;
  onClose: () => void;
}) {
  const total = Math.max(view.segments.length, 1);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [ended, setEnded] = useState(false);
  const [clip, setClip] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const segment = view.segments[index];
  const clips = segment?.clips ?? [];

  const jump = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(view.segments.length - 1, next));
      setIndex(clamped);
      setEnded(false);
    },
    [view.segments.length],
  );

  const finish = useCallback(() => {
    setPlaying(false);
    setEnded(true);
  }, []);

  // 每一镜按自己的秒数往下走；到头就停住，不自动循环
  useEffect(() => {
    if (!playing || !segment) return;
    timer.current = setTimeout(() => {
      if (index + 1 >= view.segments.length) finish();
      else setIndex(index + 1);
    }, segment.dur * 1000);
    return () => clearTimeout(timer.current);
  }, [playing, index, segment, view.segments.length, finish]);

  const replay = () => {
    setIndex(0);
    setEnded(false);
    setPlaying(true);
  };

  // 换镜 → 从这一镜的第一句念起
  useEffect(() => {
    setClip(0);
  }, [index]);

  // 音轨跟着播放状态走：暂停时真停，接着播从原处续上（ADR-0085）
  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    const current = clips[clip];
    if (!playing || !current) {
      element.pause();
      return;
    }
    if (element.src !== current.uri) element.src = current.uri;
    void element.play().catch(() => {
      // 浏览器不给自动播放时，字幕照走；用户点一下「暂停 / 播放」即可
    });
  }, [playing, index, clip, clips]);

  // 空格暂停 / 继续，左右切镜，Esc 关掉
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === " ") {
        event.preventDefault();
        setPlaying((value) => !value);
      }
      if (event.key === "ArrowRight") jump(index + 1);
      if (event.key === "ArrowLeft") jump(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, jump, onClose]);

  const elapsed = view.segments
    .slice(0, index)
    .reduce((sum, item) => sum + item.dur, 0);
  const progress =
    view.totalSec > 0 ? Math.min(100, (elapsed / view.totalSec) * 100) : 0;

  return (
    <div
      role="dialog"
      aria-label="预演"
      className="fixed inset-0 z-50 flex flex-col bg-bg/95 backdrop-blur-sm"
    >
      <div className="flex shrink-0 items-center gap-3 px-5 py-3">
        <span className="text-[12px] tracking-[.08em] text-text">预演</span>
        <span className="tnum text-[9.5px] text-muted-2">
          {shotLabel(segment?.no ?? 1)} · 第 {index + 1} / {view.segments.length} 镜 ·{" "}
          {view.totalSec.toFixed(1)}s
        </span>
        <span className="tnum rounded-token border border-line px-1.5 py-px text-[8.5px] text-muted-2">
          这不是成片
        </span>
        <button
          type="button"
          onClick={onClose}
          title="关掉预演（Esc）"
          className="ml-auto grid h-7 w-7 place-items-center rounded-token border border-line text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
        >
          <CloseIcon className="h-3.5 w-3.5" />
          <span className="sr-only">关闭</span>
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center gap-8 px-6">
        <div className="relative aspect-[9/16] h-[min(68vh,620px)] overflow-hidden rounded-token border border-white/[.075] bg-surface">
          {segment?.videoUri ? (
            <video
              key={segment.id}
              src={segment.videoUri}
              poster={segment.imageUri}
              muted
              playsInline
              autoPlay
              loop
              className="h-full w-full object-cover"
            />
          ) : segment?.imageUri ? (
            <img
              src={segment.imageUri}
              alt={`${shotLabel(segment.no)} 预演画面`}
              className="h-full w-full object-cover"
            />
          ) : (
            <Scene kind={segment?.art ?? "corridor"} className="h-full w-full opacity-70" />
          )}

          {!segment?.hasPicture && (
            <span className="absolute left-1.5 top-1.5 rounded-[1px] border border-dashed border-line-2 px-1.5 py-[1px] text-[8.5px] text-muted-2">
              没图 · 占位
            </span>
          )}

          {segment?.subtitle && (
            <p className="absolute inset-x-[8%] bottom-[7%] text-center text-[17px] leading-[1.45] text-white [text-shadow:0_1px_3px_rgba(0,0,0,.9)]">
              {segment.subtitle}
            </p>
          )}

          {ended && (
            <div className="absolute inset-0 grid place-items-center bg-bg/80">
              <button
                type="button"
                onClick={replay}
                className="flex items-center gap-1.5 rounded-token border border-line-2 px-3 py-1.5 text-[11.5px] text-text hover:border-text"
              >
                <PlayIcon className="h-3.5 w-3.5" />
                再看一遍
              </button>
            </div>
          )}

          <audio
            ref={audioRef}
            onEnded={() => {
              if (clip + 1 < clips.length) setClip(clip + 1);
            }}
            className="hidden"
          />
        </div>

        <div className="flex w-[220px] shrink-0 flex-col gap-3">
          <p className="text-[11px] leading-[1.8] text-muted">
            关键帧按镜头时长一张张过，字幕跟着台词走。先看故事与节奏站不站得住，再决定要不要生成。
          </p>
          <ul className="space-y-1 text-[10px] leading-[1.6] text-muted-2">
            <li>全长 {view.totalSec.toFixed(1)} 秒 · {view.segments.length} 镜</li>
            <li>有片子的镜头 {view.withVideo} 个</li>
            <li>还没有画面 {view.missing} 个（占位色块）</li>
            <li>
              {view.withVoice === 0
                ? "还没有配音：这一版是默片预演"
                : `有配音的镜头 ${view.withVoice} 个${
                    view.withVoice < view.segments.length ? "（其余是默片）" : ""
                  }`}
            </li>
          </ul>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPlaying((value) => !value)}
              className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
            >
              {playing ? <PauseIcon className="h-3 w-3" /> : <PlayIcon className="h-3 w-3" />}
              {playing ? "暂停" : "播放"}
            </button>
            <button
              type="button"
              onClick={() => jump(index - 1)}
              disabled={index === 0}
              className="rounded-token border border-line px-2 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-35"
            >
              上一镜
            </button>
            <button
              type="button"
              onClick={() => jump(index + 1)}
              disabled={index >= view.segments.length - 1}
              className="rounded-token border border-line px-2 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-35"
            >
              下一镜
            </button>
          </div>
          <p className="text-[9px] leading-[1.6] text-muted-2">
            空格暂停，← → 切镜，Esc 退出
          </p>
        </div>
      </div>

      {/* 整条进度：每一镜占它自己那段宽度，点哪段跳哪段 */}
      <div className="shrink-0 px-5 pb-4 pt-2">
        <div className="mb-1.5 h-[2px] w-full bg-line">
          <div
            className="h-full bg-text transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex gap-[3px]">
          {view.segments.map((item, i) => (
            <button
              key={item.id}
              type="button"
              onClick={() => jump(i)}
              title={`${shotLabel(item.no)} · ${item.dur.toFixed(1)}s`}
              style={{ flexGrow: item.dur, flexBasis: 0 }}
              className={cn(
                "h-6 min-w-3 rounded-[1px] border text-[8px] transition-colors duration-[var(--dur)]",
                i === index
                  ? "border-text bg-surface text-text"
                  : "border-line text-muted-2 hover:border-line-2 hover:text-muted",
                !item.hasPicture && "border-dashed",
              )}
            >
              <span className="tnum">{item.no}</span>
            </button>
          ))}
        </div>
        <p className="tnum mt-1.5 text-[9px] text-muted-2">
          {Math.round(elapsed * 10) / 10}s / {view.totalSec.toFixed(1)}s · 共 {total} 镜
        </p>
      </div>
    </div>
  );
}
