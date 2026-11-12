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
  // 这一镜的帧对不上了：轨道条上一眼能看见，不点进去才知道（ADR-0057）
  const stale = [
    shot.staleFirst ? `首帧（${shot.staleFirst.reasons.join("、")}）` : null,
    shot.staleLast ? `尾帧（${shot.staleLast.reasons.join("、")}）` : null,
  ].filter((item): item is string => item !== null);
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

      {shot.hasVideo && (
        <span
          title={`已经有片子 · ${shot.takes.filter((take) => take.uri).length} 拍`}
          className="absolute bottom-0.5 right-1 text-[8px] text-white/70"
        >
          ▶
        </span>
      )}

      {shot.state === "pick" && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-pick" />}
      {shot.state === "reject" && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-reject" />}
      {stale.length > 0 && (
        <span
          title={`出图之后改过：${stale.join("、")}，这一帧已对不上`}
          className="absolute left-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-pick"
        />
      )}
      {shot.locked && (
        <span
          title="这一镜已锁定"
          className="absolute right-0.5 top-0.5 grid h-[13px] w-[13px] place-items-center rounded-[1px] bg-black/55"
        >
          <LockIcon className="h-[8px] w-[8px] text-white/75" />
        </span>
      )}
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
  /**
   * 规则表没听懂时，显式让文本模型再读一遍（H19 / ADR-0141）。
   * 成功返回 true，输入框据此清空。
   */
  onInstructWithModel: (text: string) => Promise<boolean>;
  /** 模型正在读：按钮转圈，防重复点 */
  instructBusy?: boolean;
  /** 锁 / 解锁这一镜（ADR-0041） */
  onSetLock: (locked: boolean) => void;
  /** 一步留用并锁定：还没留用时，锁定按钮换个说法（ADR-0041 附记） */
  onApproveAndLock: () => void;
  /** 按这一镜重拍一条视频：从首帧出发，多一拍 take（ADR-0083） */
  onRedo: () => void;
  /** 出一秒视频多少钱；价目不知道就不给 */
  videoCnyPerSecond?: number;
};

export function ReelBar({
  view,
  onSelect,
  onDecide,
  onInstruct,
  onInstructWithModel,
  instructBusy,
  onSetLock,
  onApproveAndLock,
  onRedo,
  videoCnyPerSecond,
}: ReelBarProps) {
  const current = view.shots[view.current]!;
  const decidable = !current.locked && current.take !== undefined;
  // 锁定是"这一镜定了"：先留用，再锁（ADR-0041）
  const canLock = !current.locked && current.state === "pick";
  // 还没留用时，同一个按钮改做"留用并锁"：一次点击写两条事件（ADR-0041 附记）
  const canApproveLock = !current.locked && current.state !== "pick" && current.take !== undefined;
  const lockLabel = current.state === "pick" ? "锁定" : "留用并锁";
  // 重做 = 重拍视频：首帧是起点，没有首帧就拍不了（ADR-0083）
  const canRedo = !current.locked && current.hasKeyframe;
  const redoPrice =
    videoCnyPerSecond === undefined ? undefined : current.dur * videoCnyPerSecond;
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
              placeholder="说哪里不对：太暗了 · 换个角度 · 快一点 · 她笑得太早了"
              className="w-full bg-transparent text-[12.5px] text-text placeholder:text-muted-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
            <kbd className="tnum shrink-0 text-[9px] text-muted-2">⏎</kbd>
          </label>
        </form>

        {/* 规则表没听懂时，作者自己决定要不要花一次模型调用（H19 / ADR-0141） */}
        {!current.locked && draft.trim().length > 0 && (
          <button
            type="button"
            disabled={instructBusy}
            onClick={async () => {
              if (await onInstructWithModel(draft)) setDraft("");
            }}
            title="把这句和当前镜头交给文本模型再读一遍：一次请求只回一个补丁，读不出就不写"
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-token border border-line px-3 py-2 text-[12px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            {instructBusy ? "模型在读…" : "让模型读一遍"}
          </button>
        )}

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
              onClick={onRedo}
              disabled={!canRedo}
              title={
                canRedo
                  ? videoCnyPerSecond === undefined
                    ? `按这一镜重拍一条 ${current.dur.toFixed(1)}s 的视频，多一拍 take；价比不出来`
                    : `${current.dur.toFixed(1)}s × ¥${videoCnyPerSecond.toFixed(2)}/s · 按这一镜重拍一条视频，多一拍 take`
                  : current.locked
                    ? "这一镜已锁定，先解锁再重做"
                    : "先有首帧，才能重拍"
              }
              className="flex items-center gap-1.5 rounded-token border border-line px-3 py-2 text-[12px] text-text transition-colors duration-[var(--dur)] hover:border-line-2 disabled:pointer-events-none disabled:opacity-40"
            >
              <RedoIcon className="h-3.5 w-3.5" />
              重做
              <span className="tnum text-[9px] text-muted">
                {redoPrice === undefined
                  ? canRedo
                    ? "价目未知"
                    : "先出首帧"
                  : `¥${redoPrice.toFixed(2)}`}
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
