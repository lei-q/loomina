"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { StageState } from "@/lib/stage-flow";

/**
 * 闸门确认（F9）。
 *
 * 三条规则对应三块文案：确认什么（locks）、代价是什么（downstream）、
 * 永远给「再看看」。这里不替作者做决定，也不把「确认」做成一路向前的默认。
 */
export function GateConfirm({
  state,
  onClose,
  onConfirm,
  onReopen,
}: {
  state: StageState;
  onClose: () => void;
  /** 返回 true 表示写进去了，弹层随后关闭。`override` 是带条件确认（A12） */
  onConfirm: (note: string, override: boolean) => boolean;
  onReopen?: () => void;
}) {
  const [note, setNote] = useState(state.note ?? "");
  // A12：覆盖率不满也能确认，但要先勾一下「我知道」
  const [override, setOverride] = useState(false);
  const needsOverride = state.waivable.length > 0;
  const blocked = !state.canConfirm || (needsOverride && !override);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const stale = state.gate === "stale";
  const confirmed = state.gate === "confirmed";

  return (
    <div
      role="presentation"
      onClick={onClose}
      className="fixed inset-0 z-50 grid place-items-center bg-bg/80 p-6 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${state.name}闸门`}
        onClick={(event) => event.stopPropagation()}
        className="w-[min(560px,92vw)] rounded-token border border-line bg-surface p-5 text-text shadow-[0_24px_64px_rgba(0,0,0,.55)]"
      >
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-[12.5px] tracking-[.08em] text-text">
            {state.name}确认
          </h2>
          <span className="tnum text-[9.5px] text-muted-2">{state.summary}</span>
        </div>

        <p
          className={cn(
            "mt-2 text-[10px] leading-[1.7]",
            stale ? "text-pick" : confirmed ? "text-muted" : "text-muted-2",
          )}
        >
          {stale
            ? "确认之后内容又改过：这次确认会按现在的内容重新记账，旧的那次作废。"
            : confirmed
              ? `这一阶段已经确认过${state.confirmedAt ? `（${state.confirmedAt.slice(5, 10)}）` : ""}。再确认一次只会更新签名。`
              : state.canConfirm
                ? "确认只记在事件日志里，不删除任何东西；之后随时可以回退。"
                : "这一阶段还是空的，先填一点内容再确认。"}
        </p>

        <dl className="mt-4 space-y-3">
          <div>
            <dt className="text-[9px] tracking-[.14em] text-muted-2">这次确认会锁定</dt>
            <dd className="mt-1 text-[10.5px] leading-[1.75] text-muted">{state.locks}</dd>
          </div>
          <div>
            <dt className="text-[9px] tracking-[.14em] text-muted-2">之后再改的代价</dt>
            <dd className="mt-1 text-[10.5px] leading-[1.75] text-muted">{state.downstream}</dd>
          </div>
          {state.missing.length > 0 && (
            <div>
              <dt className="text-[9px] tracking-[.14em] text-muted-2">现在还差</dt>
              <dd className="mt-1 text-[10.5px] leading-[1.75] text-pick">
                {state.missing.join("；")}
              </dd>
            </div>
          )}
          {needsOverride && (
            <div>
              <dt className="text-[9px] tracking-[.14em] text-muted-2">可以带条件确认</dt>
              <dd className="mt-1 space-y-1.5">
                <p className="text-[10.5px] leading-[1.75] text-muted">
                  {state.waivable.join("；")}
                </p>
                <label className="flex items-start gap-2 text-[10px] leading-[1.6] text-muted-2">
                  <input
                    type="checkbox"
                    checked={override}
                    onChange={(event) => setOverride(event.target.checked)}
                    className="mt-0.5 accent-current"
                  />
                  <span>
                    我知道这些缺口：先往下做，之后回分镜页补镜再重新确认。确认记录里会标明是带条件确认。
                  </span>
                </label>
              </dd>
            </div>
          )}
        </dl>

        <label className="mt-4 block">
          <span className="text-[9px] tracking-[.14em] text-muted-2">
            留一句话（可不填，最多 240 字）
          </span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={240}
            rows={2}
            placeholder="例如：脸和衣服定了，声音等配音模型接通再补"
            className="mt-1 w-full resize-none rounded-token border border-line bg-bg px-2.5 py-1.5 text-[10.5px] leading-[1.7] text-text placeholder:text-muted-2 focus:border-line-2 focus:outline-none"
          />
        </label>

        <div className="mt-4 flex items-center justify-end gap-2">
          {onReopen && confirmed && (
            <button
              type="button"
              onClick={() => {
                onReopen();
                onClose();
              }}
              className="mr-auto rounded-token border border-line px-2.5 py-1 text-[10px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
            >
              回退本阶段
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-token border border-line px-3 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            再看看
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => {
              if (onConfirm(note, override)) onClose();
            }}
            disabled={blocked}
            title={
              state.canConfirm
                ? needsOverride && !override
                  ? "先勾选上面的「我知道」"
                  : undefined
                : state.missing.join("；")
            }
            className="rounded-token border border-text bg-text px-3 py-1 text-[10.5px] text-bg transition-opacity duration-[var(--dur)] hover:opacity-85 disabled:pointer-events-none disabled:opacity-35"
          >
            {stale
              ? "按现在的内容重新确认"
              : needsOverride
                ? `${state.confirmLabel}（带条件）`
                : state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
