"use client";

import { Scene } from "@/components/scene";
import { CheckIcon, CrossIcon, RedoIcon } from "@/components/icons";
import type { StageShot, StageView } from "@/lib/read-model";
import type { Decision } from "@/lib/workbench-store";
import { cn } from "@/lib/utils";

function Cell({
  shot,
  current,
  onSelect,
}: {
  shot: StageShot;
  current: boolean;
  onSelect: (shotId: string) => void;
}) {
  return (
    <button
      type="button"
      title={`${shot.no} · ${shot.action}`}
      aria-current={current ? "true" : undefined}
      onClick={() => onSelect(shot.id)}
      className={cn(
        "relative aspect-[9/16] h-[80px] shrink-0 overflow-hidden rounded-[1px] border border-white/[.06] bg-surface",
        "transition-opacity duration-[var(--dur)] hover:opacity-100",
        shot.state === "reject" ? "opacity-70" : "opacity-100",
      )}
    >
      <Scene kind={shot.art} className="h-full w-full" />

      {shot.state === "reject" && <span className="absolute inset-0 bg-black/50" />}

      <span className="tnum absolute bottom-1 left-1 text-[7.5px] text-white/55">
        {String(shot.no).padStart(2, "0")}
      </span>

      {shot.state === "pick" && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-pick" />}
      {shot.state === "reject" && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-reject" />}
      {current && <span className="absolute inset-0 outline outline-1 -outline-offset-1 outline-text" />}
    </button>
  );
}

export type ReelBarProps = {
  view: StageView;
  onSelect: (shotId: string) => void;
  onDecide: (status: Decision) => void;
};

export function ReelBar({ view, onSelect, onDecide }: ReelBarProps) {
  const current = view.shots[view.current]!;
  const decidable = !current.locked && current.take !== undefined;

  return (
    <footer className="shrink-0 border-t border-line">
      {/* 整条片子常驻：一格一格等比，不折叠 */}
      <div className="reel-scroll h-[104px] overflow-x-auto px-5">
        <div className="mx-auto flex h-full w-max items-center gap-[5px]">
          {view.shots.map((shot) => (
            <Cell
              key={shot.id}
              shot={shot}
              current={shot.id === current.id}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>

      {/* 一句话指令 + 两个动作，重做永远带价 */}
      <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
        <label className="flex flex-1 items-center gap-2.5 rounded-token border border-line bg-surface px-3 py-2 focus-within:border-line-2">
          <span className="tnum shrink-0 text-[9px] text-muted-2">SH-{String(current.no).padStart(2, "0")}</span>
          <input
            type="text"
            placeholder="说哪里不对：太暗了 · 换个角度 · 她笑得太早了"
            className="w-full bg-transparent text-[12.5px] text-text placeholder:text-muted-2 focus:outline-none"
          />
          <kbd className="tnum shrink-0 text-[9px] text-muted-2">⌘⏎</kbd>
        </label>

        {current.locked ? (
          <span className="tnum shrink-0 px-1 text-[10.5px] text-muted-2">已锁定 · 只读</span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onDecide("rejected")}
              disabled={!decidable}
              className={cn(
                "flex items-center gap-1.5 rounded-token border border-line px-3 py-2 text-[12px] transition-colors duration-[var(--dur)]",
                "text-muted hover:border-line-2 hover:text-text",
                "disabled:pointer-events-none disabled:opacity-40",
              )}
            >
              <CrossIcon className="h-3.5 w-3.5" />
              淘汰
            </button>

            <button
              type="button"
              disabled
              title={`${view.requote.basis} · 生成还没接通`}
              className="flex items-center gap-1.5 rounded-token border border-line px-3 py-2 text-[12px] text-text opacity-40 disabled:pointer-events-none"
            >
              <RedoIcon className="h-3.5 w-3.5" />
              重做
              <span className="tnum text-[9px] text-muted">
                {view.requote.totalCny === undefined
                  ? "价目未知"
                  : `¥${view.requote.totalCny.toFixed(2)}`}
              </span>
            </button>

            <button
              type="button"
              onClick={() => onDecide("approved")}
              disabled={!decidable}
              className={cn(
                "flex items-center gap-1.5 rounded-token bg-text px-3 py-2 text-[12px] text-bg transition-opacity duration-[var(--dur)] hover:opacity-85",
                "disabled:pointer-events-none disabled:opacity-40",
              )}
            >
              <CheckIcon className="h-3.5 w-3.5" />
              留用
            </button>
          </>
        )}
      </div>
    </footer>
  );
}
