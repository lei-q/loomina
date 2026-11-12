"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Scene } from "@/components/scene";
import { shotLabel, type AnimaticView } from "@/lib/read-model";
import { elapsedMsOf, locateInTimeline, totalMsOf } from "@/lib/animatic-clock";
import { assetHref } from "@/lib/asset-uri";
import {
  canPreviewFrames,
  createFrameThrottle,
  frameKeyOf,
  frameUrlOf,
  probeFrameCapability,
  stepFrame,
  type FrameCapability,
} from "@/lib/preview-frame";
import { canProxy, proxyUrlOf } from "@/lib/preview-proxy";
import { CloseIcon, PauseIcon, PlayIcon } from "@/components/icons";

/**
 * 预演（ADR-0084 / E7.1 / ADR-0127）：把这一条片按镜头时长一张张放过去。
 *
 * 只在浏览器里播现成的关键帧 / 视频，不渲染文件、不花钱；
 * 先让人看见节奏与字幕，再决定要不要生成。
 *
 * E7.1 把它从「只能从某一镜开头播」升级成一条**可拖的时间轴**：
 * 播放由一条墙钟推进（不是每镜一个 setTimeout），拖动时把整片毫秒数
 * 换算成「第几镜 + 镜内偏移」，播放与拖动共用同一套换算。
 * 精度到镜准确、镜内近似——镜内偏移能不能落到那一帧由播放器决定。
 */
export function AnimaticOverlay({
  view,
  onClose,
}: {
  view: AnimaticView;
  onClose: () => void;
}) {
  const total = Math.max(view.segments.length, 1);
  const totalMs = totalMsOf(view.segments);
  const [index, setIndex] = useState(0);
  const [offsetMs, setOffsetMs] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [ended, setEnded] = useState(false);
  const [clip, setClip] = useState(0);
  /** 用户拖动后 +1：让播放器把 currentTime 拉回这一处 */
  const [seekToken, setSeekToken] = useState(0);
  const lastTick = useRef<number | undefined>(undefined);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // 配乐（E10）：一条床，跟着预演播 / 停
  const musicRef = useRef<HTMLAudioElement | null>(null);
  const music = view.music[0];
  const [musicOn, setMusicOn] = useState(true);
  const segment = view.segments[index];
  const clips = segment?.clips ?? [];
  /** 素材地址先过 assetHref：资产库里的素材走 /api/asset/…（H3 / ADR-0128） */
  // 540p 代理（E7）：开着且这条片子在资产库里，就播代理——拖动 seek 轻得多；
  // 代理转不出来（没 ffmpeg 等）就自动回原片，并写明原因。
  const [proxyMode, setProxyMode] = useState(false);
  const [proxyFailedUri, setProxyFailedUri] = useState<string | undefined>(undefined);
  const proxyable = canProxy(segment?.videoUri);
  const useProxy = proxyMode && proxyable && proxyFailedUri !== segment?.videoUri;
  const videoSrc = useProxy
    ? proxyUrlOf(segment?.videoUri!)
    : assetHref(segment?.videoUri);
  const imageSrc = assetHref(segment?.imageUri);
  const musicSrc = assetHref(music?.uri);
  /** 下一次「跳转」要把片子对到哪一毫秒；只有跳转时才有值 */
  const pendingSeek = useRef<number | undefined>(undefined);

  // ── 帧级找点（E7.2 / ADR-0129）──────────────────────────────
  // 服务端 ffmpeg 精确切帧；拿不到就停在 E7.1，界面写清为什么。
  const [frameCapability, setFrameCapability] = useState<FrameCapability | undefined>(undefined);
  const [frameMode, setFrameMode] = useState(false);
  const [frameSrc, setFrameSrc] = useState<string | undefined>(undefined);
  const [frameError, setFrameError] = useState<string | undefined>(undefined);
  const [frameLoading, setFrameLoading] = useState(false);
  const throttle = useRef(createFrameThrottle()).current;
  const frameUri = segment?.videoUri;
  const frameable = Boolean(frameCapability?.tier === "frame" && canPreviewFrames(frameUri));
  /** 镜内毫秒：拖动找点与逐帧步进共用这一个位置 */
  const shotMs = Math.round(offsetMs);
  const shotMaxMs = Math.round((segment?.dur ?? 0) * 1000);

  useEffect(() => {
    let alive = true;
    void probeFrameCapability().then((capability) => {
      if (alive) setFrameCapability(capability);
    });
    return () => {
      alive = false;
    };
  }, []);

  /** 要这一镜镜内第 `ms` 毫秒的那一帧 */
  const requestFrame = useCallback(
    (ms: number) => {
      if (!frameUri) return;
      const at = Math.min(Math.max(0, Math.round(ms)), shotMaxMs);
      throttle.request(frameKeyOf(frameUri, at), () => {
        setFrameError(undefined);
        setFrameLoading(true);
        setFrameSrc(frameUrlOf(frameUri, at));
      });
    },
    [frameUri, shotMaxMs, throttle],
  );

  // 换镜 / 关掉 / 素材变了：旧帧不能留着冒充新镜。
  // **必须排在「要这一帧」之前**：同一轮里先清、再要，否则刚取到的帧会被清掉。
  useEffect(() => {
    setFrameSrc(undefined);
    setFrameError(undefined);
    setFrameLoading(false);
    throttle.cancel();
    throttle.forget();
  }, [index, frameMode, frameUri, throttle]);

  // 开帧级找点时先要当前这一处；之后跟着镜内位置走
  useEffect(() => {
    if (!frameMode) return;
    requestFrame(offsetMs);
  }, [frameMode, index, offsetMs, requestFrame]);

  /** 换到一镜没有片子 / 不在资产库的镜头：帧级找点自己关掉，不留一个勾着却用不了的开关 */
  useEffect(() => {
    if (frameMode && frameCapability !== undefined && !frameable) setFrameMode(false);
  }, [frameMode, frameCapability, frameable]);

  /** 帧级找点打开时暂停播放：一面在放、一面在定格，说不清看的是哪一帧 */
  useEffect(() => {
    if (frameMode) setPlaying(false);
  }, [frameMode]);

  /**
   * 播放 / 暂停。**一按播放就退出帧级找点**：切帧最快 60ms 一次，冒充不了播放。
   *
   * 这里必须写成一个动作，不能靠「playing 变真就把 frameMode 关掉」的 effect：
   * 打开帧级找点的那一瞬 playing 还是真，两个 effect 会互相抵消，
   * 勾上立刻又弹回未勾。
   */
  const togglePlay = useCallback(() => {
    setPlaying((value) => {
      if (!value) setFrameMode(false);
      return !value;
    });
  }, []);

  /** 跳到某一镜（镜内从头开始） */
  const jump = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(view.segments.length - 1, next));
      pendingSeek.current = 0;
      setIndex(clamped);
      setOffsetMs(0);
      setSeekToken((value) => value + 1);
      setEnded(false);
    },
    [view.segments.length],
  );

  /** 拖到整条片子的某一毫秒 */
  const seek = useCallback(
    (ms: number) => {
      const at = locateInTimeline(view.segments, ms);
      pendingSeek.current = at.offsetMs;
      setIndex(at.index);
      setOffsetMs(at.offsetMs);
      setSeekToken((value) => value + 1);
      setEnded(false);
    },
    [view.segments],
  );

  const finish = useCallback(() => {
    setPlaying(false);
    setEnded(true);
    // 停在片尾而不是跳回最后一镜的开头：进度条与「x / 总长」要对得上
    const last = Math.max(0, view.segments.length - 1);
    pendingSeek.current = undefined;
    setIndex(last);
    setOffsetMs((view.segments[last]?.dur ?? 0) * 1000);
  }, [view.segments]);

  // 墙钟推进：每 50ms 算一次「整片第几毫秒」，再换算回镜与偏移。
  // 不用每镜一个 setTimeout：拖动之后定时器与画面就对不上了。
  //
  // 用 `setInterval` 而不是 `requestAnimationFrame`：预演是 24fps 的节奏预览，
  // 不需要每帧刷新；而 rAF 在后台标签页里会被完全停掉，回来时进度会跳。
  // 定时器在后台被降到 1 秒一次，所以 delta 封顶 250ms——宁可后台慢一点，
  // 也不要在切回来时凭空跳过一大段。
  //
  // 位置放在 ref 里、effect 只依赖 `playing`：effect 若依赖 offsetMs，
  // 每次 tick 都会重启定时器，delta 永远是 0。
  const position = useRef({ index: 0, offsetMs: 0 });
  useEffect(() => {
    position.current = { index, offsetMs };
  }, [index, offsetMs]);

  useEffect(() => {
    if (!playing || view.segments.length === 0) {
      lastTick.current = undefined;
      return;
    }
    const timer = setInterval(() => {
      const now = performance.now();
      const previous = lastTick.current;
      lastTick.current = now;
      if (previous === undefined) return;
      const at = position.current;
      const delta = Math.min(250, Math.max(0, now - previous));
      const next = elapsedMsOf(view.segments, at.index, at.offsetMs) + delta;
      if (next >= totalMs) {
        finish();
        return;
      }
      const located = locateInTimeline(view.segments, next);
      if (located.index !== at.index) setIndex(located.index);
      setOffsetMs(located.offsetMs);
    }, 50);
    return () => {
      clearInterval(timer);
      lastTick.current = undefined;
    };
  }, [playing, totalMs, view.segments, finish]);

  const replay = () => {
    pendingSeek.current = 0;
    setIndex(0);
    setOffsetMs(0);
    setSeekToken((value) => value + 1);
    setEnded(false);
    // 再看一遍是「整条放」：帧级找点留着只会卡在第一帧
    setFrameMode(false);
    setPlaying(true);
  };

  // 换镜 / 拖到别处 → 这一镜的台词从头念
  useEffect(() => {
    setClip(0);
  }, [index, seekToken]);

  // 音轨跟着播放状态走：暂停时真停，接着播从原处续上（ADR-0085）
  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    const current = clips[clip];
    if (!playing || !current) {
      element.pause();
      return;
    }
    const src = assetHref(current.uri);
    if (!src) {
      element.pause();
      return;
    }
    if (element.getAttribute("src") !== src) element.src = src;
    void element.play().catch(() => {
      // 浏览器不给自动播放时，字幕照走；用户点一下「暂停 / 播放」即可
    });
  }, [playing, index, clip, clips]);

  // 拖动 / 切镜之后把片子对到那一处（镜内近似：浏览器只能从关键帧之后解码）。
  //
  // **只在显式跳转时对一次**，不跟着每帧的 offsetMs 走：每帧写一次 currentTime
  // 会不停打断加载，视频永远停在 readyState 0。播放期间让片子自己放，
  // 切镜由墙钟决定；墙钟与片子之间的漂移在这一级是可接受的（到镜准确）。
  const applyPendingSeek = useCallback(() => {
    const element = videoRef.current;
    const target = pendingSeek.current;
    if (!element || target === undefined) return;
    if (!Number.isFinite(element.duration) || element.duration <= 0) return;
    try {
      element.currentTime = Math.min(target / 1000, Math.max(0, element.duration - 0.05));
      pendingSeek.current = undefined;
    } catch {
      // 元数据还没到就拖了：留到 loadedmetadata 再对
    }
  }, []);

  useEffect(() => {
    applyPendingSeek();
  }, [seekToken, index, segment?.videoUri, applyPendingSeek]);

  // 视频跟着播放状态走：暂停真停，继续接着放
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    if (playing) void element.play().catch(() => {});
    else element.pause();
  }, [playing, index, segment?.videoUri]);

  // 配乐跟着播放状态走：暂停就停，继续从原处接上；不放「不是成片」的默片预演
  useEffect(() => {
    const element = musicRef.current;
    if (!element || !music?.uri) return;
    element.volume = music.volume;
    element.loop = music.loop;
    if (playing && musicOn) void element.play().catch(() => {});
    else element.pause();
  }, [playing, musicOn, music?.uri, music?.volume, music?.loop]);

  // 空格暂停 / 继续，左右切镜，Esc 关掉；帧级找点时 , . 逐帧步进
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === " ") {
        event.preventDefault();
        togglePlay();
      }
      if (event.key === "ArrowRight") jump(index + 1);
      if (event.key === "ArrowLeft") jump(index - 1);
      if (frameMode && (event.key === "," || event.key === ".")) {
        event.preventDefault();
        const direction = event.key === "." ? 1 : -1;
        const at = stepFrame(shotMs, direction, shotMaxMs);
        seek(elapsedMsOf(view.segments, index, at));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, jump, onClose, togglePlay, frameMode, shotMs, shotMaxMs, seek, view.segments]);

  const elapsed = elapsedMsOf(view.segments, index, offsetMs);
  const progress = totalMs > 0 ? Math.min(100, (elapsed / totalMs) * 100) : 0;

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
        <span
          className={cn(
            "rounded-token border px-1.5 py-px text-[8.5px]",
            frameMode && frameSrc
              ? "border-line-2 text-text"
              : "border-line text-muted-2",
          )}
          title={
            frameMode && frameCapability?.tier === "frame"
              ? "由服务端 ffmpeg 精确切帧，拖到哪一毫秒就是那一帧"
              : "时间轴到镜准确；镜内只能落到最近的关键帧之后，所以是近似"
          }
        >
          {frameMode && frameCapability?.tier === "frame"
            ? `帧级找点 · ffmpeg${frameCapability.ffmpeg ? ` ${frameCapability.ffmpeg}` : ""}`
            : "到镜准确 · 镜内近似"}
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
          {frameMode && frameSrc ? (
            // 帧级找点：服务端切出来的那一帧，替换掉正在播的片子
            <img
              src={frameSrc}
              alt={`${shotLabel(segment?.no ?? 1)} 第 ${shotMs} 毫秒`}
              onLoad={() => setFrameLoading(false)}
              onError={() => {
                setFrameLoading(false);
                setFrameError("这一帧切不出来：可能已经超过片子的时长");
                // 失败后允许重试同一处
                throttle.forget();
                setFrameSrc(undefined);
              }}
              className="h-full w-full object-cover"
            />
          ) : videoSrc ? (
            <video
              key={`${segment?.id}-${useProxy ? "proxy" : "raw"}`}
              ref={videoRef}
              src={videoSrc}
              poster={imageSrc}
              muted
              playsInline
              autoPlay
              loop
              onLoadedMetadata={applyPendingSeek}
              onError={() => {
                if (useProxy) setProxyFailedUri(segment?.videoUri);
              }}
              className="h-full w-full object-cover"
            />
          ) : imageSrc ? (
            <img
              src={imageSrc}
              alt={`${shotLabel(segment?.no ?? 1)} 预演画面`}
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
          {musicSrc && (
            <audio ref={musicRef} src={musicSrc} preload="auto" className="hidden" />
          )}
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
            <li>
              {music
                ? `配乐「${music.title}」${music.loop ? " · 循环铺满" : ""}`
                : "还没有配乐：节奏只有画面与台词"}
            </li>
          </ul>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={togglePlay}
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

          {/* 540p 代理（E7 / ADR-0127 §3）：播代理让拖动轻得多，原片留给导出 */}
          <div className="rounded-token border border-line px-2 py-1.5">
            <label className="flex items-start gap-2 text-[10px] leading-[1.6] text-muted">
              <input
                type="checkbox"
                checked={proxyMode}
                disabled={!proxyable}
                onChange={(event) => {
                  setProxyMode(event.target.checked);
                  setProxyFailedUri(undefined);
                }}
                className="mt-0.5 accent-current disabled:opacity-40"
              />
              <span className={cn(!proxyable && "text-muted-2")}>
                540p 代理
                <span className="block text-[9px] leading-[1.6] text-muted-2">
                  {!proxyable
                    ? "这一镜的片子不在资产库里，只能播原片"
                    : proxyFailedUri === segment?.videoUri
                      ? "代理转不出来：这一镜先播原片"
                      : "第一次会转一小会儿，之后拖动比原片轻；导出仍用原片"}
                </span>
              </span>
            </label>
          </div>

          {/* 帧级找点（E7.2 / ADR-0129）：把镜内找点交给服务端 ffmpeg */}
          <div className="rounded-token border border-line px-2 py-1.5">
            <label className="flex items-start gap-2 text-[10px] leading-[1.6] text-muted">
              <input
                type="checkbox"
                checked={frameMode}
                disabled={!frameable}
                onChange={(event) => setFrameMode(event.target.checked)}
                className="mt-0.5 accent-current disabled:opacity-40"
              />
              <span className={cn(!frameable && "text-muted-2")}>
                帧级找点
                <span className="block text-[9px] leading-[1.6] text-muted-2">
                  {frameCapability === undefined
                    ? "在问这台机器能不能切帧…"
                    : frameCapability.tier === "approx"
                      ? frameCapability.reason
                      : !canPreviewFrames(frameUri)
                        ? segment?.videoUri
                          ? "这一镜的片子还不在本机资产库里，只能到镜近似"
                          : "这一镜没有片子：拖到镜内也只有一张图"
                        : "服务端 ffmpeg 精确切帧；打开后暂停播放"}
                </span>
              </span>
            </label>
            {frameMode && frameable && (
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => seek(elapsedMsOf(view.segments, index, stepFrame(shotMs, -1, shotMaxMs)))}
                  disabled={shotMs <= 0}
                  className="rounded-token border border-line px-1.5 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-35"
                  title="退一帧（33ms）"
                >
                  ‹ 一帧
                </button>
                <button
                  type="button"
                  onClick={() => seek(elapsedMsOf(view.segments, index, stepFrame(shotMs, 1, shotMaxMs)))}
                  disabled={shotMs >= shotMaxMs}
                  className="rounded-token border border-line px-1.5 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-35"
                  title="进一帧（33ms）"
                >
                  一帧 ›
                </button>
                <span className="tnum ml-auto text-[9px] text-muted-2">
                  镜内 {(shotMs / 1000).toFixed(2)}s
                  {frameLoading ? " · 切帧中" : ""}
                </span>
              </div>
            )}
            {frameMode && frameError && (
              <p className="mt-1 text-[9px] leading-[1.6] text-[#d98b6a]">{frameError}</p>
            )}
          </div>
          {music && (
            <label className="flex items-start gap-2 text-[9.5px] leading-[1.6] text-muted-2">
              <input
                type="checkbox"
                checked={musicOn}
                onChange={(event) => setMusicOn(event.target.checked)}
                className="mt-0.5 accent-current"
              />
              <span>
                配乐「{music.title}」{music.loop ? " · 循环" : ""}
                {musicOn ? "" : "（已静音）"}
              </span>
            </label>
          )}
          <p className="text-[9px] leading-[1.6] text-muted-2">
            空格暂停，← → 切镜，Esc 退出；拖下面的进度条找点
            {frameMode && frameable ? "，, . 逐帧" : ""}
          </p>
        </div>
      </div>

      {/* 整条进度（E7.1）：可拖的时间轴，拖到哪一毫秒就停在哪一镜的那一处 */}
      <div className="shrink-0 px-5 pb-4 pt-2">
        <div className="mb-1.5 flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={Math.max(0, totalMs)}
            step={10}
            value={Math.round(elapsed)}
            onChange={(event) => seek(Number(event.target.value))}
            aria-label="预演进度"
            className="h-3 w-full min-w-0 cursor-pointer accent-current"
          />
          <span className="tnum shrink-0 text-[9px] text-muted-2">
            {(elapsed / 1000).toFixed(1)}s
          </span>
        </div>
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
          {(elapsed / 1000).toFixed(1)}s / {view.totalSec.toFixed(1)}s · 共 {total} 镜
        </p>
      </div>
    </div>
  );
}
