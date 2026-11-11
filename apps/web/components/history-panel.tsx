"use client";

import { useEffect, useMemo } from "react";
import { buildHistory, historyPosition, nextUndo, type HistoryEntry } from "@/lib/history";
import { recycleBin } from "@/lib/read-model";
import { cn } from "@/lib/utils";
import { useWorkbench } from "@/lib/workbench-store";

const KIND_LABEL: Record<HistoryEntry["kind"], string> = {
  created: "起点",
  edit: "改动",
  removal: "删除",
  restore: "回滚",
};

function clock(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at.slice(11, 19);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 最多显示多少条：日志可以很长，抽屉没必要一次渲染几千行 */
const VISIBLE_ROWS = 200;

export type HistoryPanelProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * 历史抽屉（F2 / ADR-0109）。
 *
 * 上面是「下一步撤销退到哪」，下面是整条日志的人话版本：
 * 任何一格都能「回到这里」。回滚本身也写一条事件，所以回退不是销毁——
 * 日志还留着，想往前再走一步也行。
 */
export function HistoryPanel({ open, onClose }: HistoryPanelProps) {
  const events = useWorkbench((state) => state.events);
  const project = useWorkbench((state) => state.project);
  const readOnly = useWorkbench((state) => state.readOnly) ?? false;
  const historyNotice = useWorkbench((state) => state.historyNotice);
  const undo = useWorkbench((state) => state.undo);
  const restoreTo = useWorkbench((state) => state.restoreTo);
  const restoreRemovalAt = useWorkbench((state) => state.restoreRemovalAt);

  const history = useMemo(() => (open ? buildHistory(events) : []), [open, events]);
  const bin = useMemo(() => (open ? recycleBin(events, project) : []), [open, events, project]);
  const position = useMemo(() => (open ? historyPosition(events) : 0), [open, events]);
  const step = useMemo(() => (open ? nextUndo(events, history) : undefined), [open, events, history]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const newestFirst = [...history].reverse();
  const hidden = Math.max(0, newestFirst.length - VISIBLE_ROWS);
  const atLatest = position === events.length;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="历史"
        className="flex h-full w-[420px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">历史</h2>
            <span className="tnum text-[9px] text-muted-2">
              {events.length} 条事件 · 回收站 {bin.length}
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

        <div className="min-h-0 flex-1 overflow-y-auto">
          <section className="border-b border-line px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] text-muted-2">下一步撤销</p>
                <p className="mt-0.5 truncate text-[11px] text-text" title={step?.label}>
                  {step ? step.label : "已经退到最早，没有更早的改动可撤"}
                </p>
                {step && step.eventCount > 1 && (
                  <p className="tnum mt-0.5 text-[9px] text-muted-2">
                    一共 {step.eventCount} 条事件，一次退完
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void undo()}
                disabled={readOnly || !step}
                title="撤销上一步操作（⌘Z / Ctrl+Z）"
                className="shrink-0 rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45"
              >
                撤销
              </button>
            </div>
            {!atLatest && (
              <button
                type="button"
                onClick={() => void restoreTo(events.length, "回到最新")}
                disabled={readOnly}
                className="mt-2 rounded-token border border-line px-2 py-1 text-[9.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45"
              >
                回到最新
              </button>
            )}
            {historyNotice && (
              <p className="mt-2 text-[9.5px] leading-[1.6] text-muted">{historyNotice}</p>
            )}
            <p className="mt-2 text-[9px] leading-[1.6] text-muted-2">
              回滚不删日志：它只记一条「回到这里」。图片资产不会被复制，所以历史再长也不涨体积。
            </p>
          </section>

          <section className="px-4 py-3">
            <h3 className="text-[10px] tracking-[.08em] text-muted-2">
              每一步 · 最新的在前
            </h3>
            <ul className="mt-1.5">
              {hidden > 0 && (
                <li className="py-1.5 text-[9px] text-muted-2">
                  更早的 {hidden} 条收起了：撤销会继续往回退，它们还在日志里。
                </li>
              )}
              {newestFirst.slice(0, VISIBLE_ROWS).map((entry) => {
                const current = entry.count === position;
                return (
                  <li
                    key={`${entry.at}-${entry.index}`}
                    className={cn(
                      "flex items-start gap-2 border-b border-line py-1.5",
                      current && "text-text",
                    )}
                  >
                    <span className="tnum mt-px w-[72px] shrink-0 text-[8.5px] leading-[1.7] text-muted-2">
                      {clock(entry.at)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block text-[10.5px] leading-[1.6]",
                          entry.kind === "removal" ? "text-pick" : "text-muted",
                          current && "text-text",
                        )}
                      >
                        {entry.kind === "restore" ? `↩ ${entry.label}` : entry.label}
                      </span>
                      {entry.stepStart && entry.groupSize > 1 && (
                        <span className="tnum mt-0.5 block text-[8.5px] text-muted-2">
                          {KIND_LABEL[entry.kind]} · 同一步 {entry.groupSize} 条
                        </span>
                      )}
                    </span>
                    {current ? (
                      <span className="tnum mt-px shrink-0 rounded-token border border-line px-1 py-0.5 text-[8px] text-muted">
                        现在
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void restoreTo(entry.count, `回到：${entry.label}`)}
                        disabled={readOnly}
                        title={`把项目恢复到这一步之后（第 ${entry.count} 条事件）`}
                        className="mt-px shrink-0 rounded-token border border-line px-1.5 py-0.5 text-[8.5px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        回到这里
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="border-t border-line px-4 py-3">
            <h3 className="text-[10px] tracking-[.08em] text-muted-2">
              回收站 · 删掉还没放回的
            </h3>
            {bin.length === 0 ? (
              <p className="mt-1.5 text-[9.5px] leading-[1.6] text-muted-2">
                空的。删掉的人物、地点、道具、场次与镜头会先到这里，放回来不会丢台词与 take。
              </p>
            ) : (
              <ul className="mt-1.5">
                {bin.map((item) => (
                  <li
                    key={`${item.kind}-${item.id}`}
                    className="flex items-center gap-2 border-b border-line py-1.5"
                  >
                    <span className="tnum w-[72px] shrink-0 text-[8.5px] text-muted-2">
                      {clock(item.at)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted">
                      {item.label}
                      <span className="ml-1.5 text-[8.5px] text-muted-2">
                        {KIND_LABEL.removal}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => void restoreRemovalAt(item.index)}
                      disabled={readOnly}
                      title="按删除之前的样子放回来：写补偿事件，不删历史"
                      className="shrink-0 rounded-token border border-line px-1.5 py-0.5 text-[8.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      放回
                    </button>
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
