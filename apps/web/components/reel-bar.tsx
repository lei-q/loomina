"use client";

import { useState } from "react";
import { Scene } from "@/components/scene";
import { CheckIcon, CrossIcon, LockIcon, RedoIcon, UnlockIcon } from "@/components/icons";
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
  /** 一句话指令：成功返回 true，输入框据此清空（ADR-0039） */
  onInstruct: (text: string) => boolean;
  /** 锁 / 解锁这一镜（ADR-0041） */
  onSetLock: (locked: boolean) => void;
  /** 一步留用并锁定：还没留用时，锁定按钮换个说法（ADR-0041 附记） */
  onApproveAndLock: () => void;
};

export function ReelBar({ view, onSelect, onDecide, onInstruct, onSetLock, onApproveAndLock }: ReelBarProps) {
  const current = view.shots[view.current]!;
  const decidable = !current.locked && current.take !== undefined;
  // 锁定是"这一镜定了"：先留用，再锁（ADR-0041）
  const canLock = !current.locked && current.state === "pick";
  // 还没留用时，同一个按钮改做"留用并锁"：一次点击写两条事件（ADR-0041 附记）
  const canApproveLock = !current.locked && current.state !== "pick" && current.take !== undefined;
  const lockLabel = current.state === "pick" ? "锁定" : "留用并锁";
  const lockTitle = canLock
    ? "锁定这一镜：不再改、不再生成"
    : canApproveLock
      ? "留用这一条 take 并锁定这一镜：写两条事件，一步到位"
      : "先留用一条 take，再锁定这一镜";
  const [draft, setDraft] = useState("");

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
        <form
          className="flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (onInstruct(draft)) setDraft("");
          }}
        >
          <label className="flex items-center gap-2.5 rounded-token border border-line bg-surface px-3 py-2 focus-within:border-line-2">
            <span className="tnum shrink-0 text-[9px] text-muted-2">SH-{String(current.no).padStart(2, "0")}</span>
            <input
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={current.locked}
              placeholder="说哪里不对：太暗了 · 换个角度 · 她笑得太早了"
              className="w-full bg-transparent text-[12.5px] text-text placeholder:text-muted-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
            <kbd className="tnum shrink-0 text-[9px] text-muted-2">⏎</kbd>
          </label>
        </form>

        {current.locked ? (
          <>
            <span className="tnum shrink-0 px-1 text-[10.5px] text-muted-2">已锁定 · 只读</span>
            <button
              type="button"
              onClick={() => onSetLock(false)}
              title="解锁会留痕：之后的改动都写进日志"
              className="flex items-center gap-1.5 rounded-token border border-line px-3 py-2 text-[12px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
            >
              <UnlockIcon className="h-3.5 w-3.5" />
              解锁
            </button>
          </>
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

            <button
              type="button"
              onClick={() => (canLock ? onSetLock(true) : onApproveAndLock())}
              disabled={!canLock && !canApproveLock}
              title={lockTitle}
              className={cn(
                "flex items-center gap-1.5 rounded-token border border-line px-3 py-2 text-[12px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text",
                "disabled:pointer-events-none disabled:opacity-40",
              )}
            >
              <LockIcon className="h-3.5 w-3.5" />
              {lockLabel}
            </button>
          </>
        )}
      </div>
    </footer>
  );
}
