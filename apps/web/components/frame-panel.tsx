"use client";

import { useMemo, useState } from "react";
import {
  DEFAULT_FRAME,
  FRAME_ASPECTS,
  FRAME_FITS,
  type Frame,
  type FrameAspect,
  type ShotFocus,
} from "@loomina/ir";
import {
  FRAME_ASPECT_LABEL,
  FRAME_FIT_BLURB,
  FRAME_FIT_LABEL,
  focusLine,
  frameLine,
} from "@/lib/render-effects";
import { frameSize } from "@/lib/render-manifest";
import { cn } from "@/lib/utils";

/** 画幅面板里的一镜：够画一张缩略图、够标焦点 */
export type FrameShot = {
  shotId: string;
  /** 镜号，例如 SH-03 */
  label: string;
  /** 这一镜在成片里从第几毫秒开始 */
  startMs: number;
  /** 有画面就画缩略图，没有就画占位条 */
  still?: string;
  focus?: ShotFocus;
};

export type FramePanelProps = {
  frame: Frame;
  /** 存一次：整块写一条 `project.updated { frame }`；返回是否真的改了 */
  onSave: (frame: Frame) => boolean;
  shots: FrameShot[];
  /** 改某一镜的裁切焦点；`undefined` 恢复居中 */
  onFocus: (shotId: string, focus: ShotFocus | undefined) => boolean;
  readOnly?: boolean;
  onClose: () => void;
};

/**
 * 画幅与适配（E5 / ADR-0170）。
 *
 * 画幅只决定**导出**的形状，不改提示词：竖屏生成、再裁成 16:9 发横屏平台，
 * 是短剧分发的常态。裁切会切掉画面，所以每一镜能单独说「留住哪一块」。
 */
export function FramePanel({
  frame,
  onSave,
  shots,
  onFocus,
  readOnly = false,
  onClose,
}: FramePanelProps) {
  const [draft, setDraft] = useState<Frame>(frame);
  const [flash, setFlash] = useState("");
  const dirty = draft.aspect !== frame.aspect || draft.fit !== frame.fit;
  const finalSize = frameSize("final", draft.aspect);
  const draftSize = frameSize("draft", draft.aspect);
  const cropped = draft.fit === "crop";
  const focused = useMemo(() => shots.filter((shot) => shot.focus), [shots]);

  const save = () => {
    const ok = onSave(draft);
    setFlash(ok ? "画幅已存：下一次导出生效，提示词与已出的图不受影响。" : "没有变化。");
  };

  const setFocus = (shot: FrameShot, x: number, y: number) => {
    const ok = onFocus(shot.shotId, x === 0.5 && y === 0.5 ? undefined : { x, y });
    setFlash(
      ok
        ? x === 0.5 && y === 0.5
          ? `${shot.label} 的裁切回到居中。`
          : `${shot.label} 裁切时留住${focusLine({ x, y })}。`
        : readOnly
          ? "页面只读，先解锁。"
          : "没有变化。",
    );
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="画幅与裁切"
        className="flex h-full w-[460px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">画幅与裁切</h2>
            <span className="tnum text-[9px] text-muted-2">
              {dirty ? "有未保存的改动" : frameLine(frame)}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-token border border-line px-2 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            关闭
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <p className="text-[9.5px] leading-[1.7] text-muted-2">
            画幅只决定导出的形状，不改提示词、不动已出的图。定稿短边固定 1080，
            所以换画幅只换形状、不降清晰度。
          </p>

          <section className="mt-4">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">形状</h3>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              {FRAME_ASPECTS.map((aspect) => {
                const active = draft.aspect === aspect;
                const size = frameSize("final", aspect);
                return (
                  <button
                    key={aspect}
                    type="button"
                    disabled={readOnly}
                    onClick={() => setDraft((prev) => ({ ...prev, aspect }))}
                    aria-pressed={active}
                    className={cn(
                      "flex flex-col items-center gap-1.5 border px-2 py-2.5 transition-colors duration-[var(--dur)] disabled:opacity-40",
                      active ? "border-pick bg-pick/10" : "border-line hover:border-line-2",
                    )}
                  >
                    <ShapeIcon aspect={aspect} active={active} />
                    <span className="text-[10px] text-text">{FRAME_ASPECT_LABEL[aspect]}</span>
                    <span className="tnum text-[8.5px] text-muted-2">
                      {size.width}×{size.height}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="mt-4">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">放不下的时候</h3>
            <div className="mt-1.5 flex flex-col gap-1.5">
              {FRAME_FITS.map((fit) => {
                const active = draft.fit === fit;
                return (
                  <button
                    key={fit}
                    type="button"
                    disabled={readOnly}
                    onClick={() => setDraft((prev) => ({ ...prev, fit }))}
                    aria-pressed={active}
                    className={cn(
                      "border px-2.5 py-1.5 text-left transition-colors duration-[var(--dur)] disabled:opacity-40",
                      active ? "border-pick bg-pick/10" : "border-line hover:border-line-2",
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-[10.5px] text-text">{FRAME_FIT_LABEL[fit]}</span>
                      {active && <span className="text-[8.5px] text-pick">已选</span>}
                    </span>
                    <span className="mt-0.5 block text-[9px] leading-[1.6] text-muted-2">
                      {FRAME_FIT_BLURB[fit]}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="mt-3 border border-line px-3 py-2.5">
            <p className="text-[8.5px] tracking-[.06em] text-muted-2">导出尺寸</p>
            <p className="mt-1 text-[9.5px] leading-[1.7] text-text">
              草稿 {draftSize.width}×{draftSize.height} · 定稿 {finalSize.width}×{finalSize.height}
            </p>
            <p className="mt-1 text-[9px] leading-[1.6] text-muted-2">
              {cropped
                ? "裁切按每一镜的「留住哪一块」取景；没设过的居中。"
                : draft.fit === "blur"
                  ? "整幅画面缩小放进去，空出来的地方用同一帧放大模糊填满。"
                  : "整幅画面缩到放得下，空出来的地方填深色——最稳，什么都不切。"}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                disabled={readOnly || !dirty}
                onClick={save}
                className="rounded-token border border-pick bg-pick px-2.5 py-1 text-[10px] text-white transition-opacity duration-[var(--dur)] enabled:hover:opacity-90 disabled:opacity-40"
              >
                存画幅
              </button>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => {
                  setDraft(DEFAULT_FRAME);
                  setFlash("");
                }}
                className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-text disabled:opacity-40"
              >
                恢复竖屏留边
              </button>
            </div>
            {flash && <p className="mt-1 text-[9.5px] text-muted">{flash}</p>}
          </section>

          <section className="mt-5 border-t border-line pt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">裁切时留住哪一块（E5）</h3>
              <span className="tnum text-[8.5px] text-muted-2">
                {focused.length > 0 ? `${focused.length} 镜设过` : "全部居中"}
              </span>
            </div>
            <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">
              竖屏裁成横屏只留下画面里的一条横带：人站在上三分之一，居中裁就把头裁掉了。
              点一下九宫格里的位置，这一镜就按那里取景。不点就是居中。
              {!cropped && "（现在不是裁切模式，这里的设置先留着，换回裁切就生效。）"}
            </p>
            {shots.length === 0 ? (
              <p className="mt-2 text-[9.5px] text-muted-2">
                时间线还是空的：先去初剪排好，镜头才会出现在这里。
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {shots.map((shot) => (
                  <li key={shot.shotId} className="flex items-start gap-3 border border-line px-2.5 py-2">
                    <div className="relative h-[54px] w-[30px] shrink-0 overflow-hidden border border-line bg-black">
                      {shot.still ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={shot.still}
                          alt={`${shot.label} 的画面`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center text-[7px] text-muted-2">
                          无画面
                        </span>
                      )}
                      <span
                        aria-hidden
                        className="pointer-events-none absolute h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-pick"
                        style={{
                          left: `${(shot.focus?.x ?? 0.5) * 100}%`,
                          top: `${(shot.focus?.y ?? 0.5) * 100}%`,
                        }}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="tnum text-[10px] text-text">{shot.label}</span>
                        <span className="tnum text-[8.5px] text-muted-2">
                          {(shot.startMs / 1000).toFixed(1)}s · {focusLine(shot.focus)}
                        </span>
                      </div>
                      <div className="mt-1 grid w-[72px] grid-cols-3 gap-px">
                        {[0.2, 0.5, 0.8].map((y) =>
                          [0.2, 0.5, 0.8].map((x) => {
                            const active =
                              Math.abs((shot.focus?.x ?? 0.5) - x) < 0.01 &&
                              Math.abs((shot.focus?.y ?? 0.5) - y) < 0.01;
                            return (
                              <button
                                key={`${x}-${y}`}
                                type="button"
                                disabled={readOnly}
                                onClick={() => setFocus(shot, x, y)}
                                aria-pressed={active}
                                aria-label={`${shot.label} 留住${focusLine({ x, y })}`}
                                title={`留住${focusLine({ x, y })}`}
                                className={cn(
                                  "h-[14px] border transition-colors duration-[var(--dur)] disabled:opacity-40",
                                  active
                                    ? "border-pick bg-pick/40"
                                    : "border-line hover:border-line-2 hover:bg-surface",
                                )}
                              />
                            );
                          }),
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}

/** 三个画幅的小图形：比文字更快认出来 */
function ShapeIcon({ aspect, active }: { aspect: FrameAspect; active: boolean }) {
  const box = 30;
  const sizes: Record<FrameAspect, { w: number; h: number }> = {
    "9:16": { w: 16, h: 28 },
    "16:9": { w: 28, h: 16 },
    "1:1": { w: 22, h: 22 },
  };
  const { w, h } = sizes[aspect];
  return (
    <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} aria-hidden>
      <rect
        x={(box - w) / 2}
        y={(box - h) / 2}
        width={w}
        height={h}
        fill="none"
        stroke={active ? "var(--pick)" : "currentColor"}
        strokeWidth={1}
        className={active ? "" : "text-muted-2"}
      />
    </svg>
  );
}

