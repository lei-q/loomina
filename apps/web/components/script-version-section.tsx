"use client";

import { useMemo, useState } from "react";
import { useWorkbench } from "@/lib/workbench-store";
import { scriptVersionsOf, textDiff } from "@/lib/script-versions";
import { cn } from "@/lib/utils";

/**
 * 剧本版本库（C14 第五档 / ADR-0204）。
 *
 * 版本从事件日志重建、不另存快照；展开能看那一版的整份剧本纯文本与
 * 和现在的行差异。轻恢复只写回剧本字段，整份回退走 F2 的全局回滚。
 */
const MAX_VERSIONS = 40;
const MAX_DIFF_LINES = 6;

function clock(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at.slice(11, 19);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ScriptVersionSection() {
  const events = useWorkbench((state) => state.events);
  const readOnly = useWorkbench((state) => state.readOnly);
  const restoreScriptVersion = useWorkbench((state) => state.restoreScriptVersion);
  const restoreTo = useWorkbench((state) => state.restoreTo);
  const scriptNotice = useWorkbench((state) => state.scriptNotice);
  const [expanded, setExpanded] = useState<number>();
  const [confirming, setConfirming] = useState<number>();

  const versions = useMemo(() => scriptVersionsOf(events), [events]);
  const currentText = versions.at(-1)?.text ?? "";
  const shown = [...versions].reverse().slice(0, MAX_VERSIONS);
  // 最后一条版本的 eventIndex 不一定等于「版本数 - 1」：日志里夹着非剧本事件
  const currentIndex = versions.at(-1)?.eventIndex;

  const take = (eventIndex: number, kind: "soft" | "full") => {
    if (kind === "soft") {
      restoreScriptVersion(eventIndex);
      return;
    }
    restoreTo(eventIndex + 1, `回到剧本版本：${clock(versions.find((item) => item.eventIndex === eventIndex)?.at ?? "")}`);
    setConfirming(undefined);
  };

  return (
    <details className="mt-4 rounded-token border border-line bg-bg px-3 py-2" aria-label="剧本版本库">
      <summary className="cursor-pointer text-[10px] leading-[1.7] text-muted">
        剧本版本库 · {versions.length} 版
      </summary>
      <p className="mt-1 text-[9px] leading-[1.7] text-muted-2">
        每版从事件日志重建，不另存快照。「用这版写回」只改当前还在的场 / 镜 / 句的剧本字段，
        不碰关键帧、take、配音与时间线；已删的结构、锁定的镜头带不回来。
        「整份回到这里」会把别的阶段也一起退回当时。
      </p>
      {scriptNotice && (
        <p className="mt-1 text-[9.5px] leading-[1.6] text-muted">{scriptNotice}</p>
      )}
      <ol className="mt-2 space-y-1">
        {shown.map((version) => {
          const isCurrent = version.eventIndex === currentIndex;
          const open = expanded === version.eventIndex;
          const diff = open ? textDiff(version.text, currentText) : undefined;
          return (
            <li
              key={version.eventIndex}
              className="rounded-token border border-line px-2 py-1.5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="tnum text-[9px] text-muted-2">
                  {clock(version.at)} · {version.labels.join(" · ") || "初版"} ·{" "}
                  {version.scenes} 场 / {version.shots} 镜 / {version.lines} 句
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? undefined : version.eventIndex)}
                    className="rounded-token border border-line px-1.5 py-0.5 text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                  >
                    {open ? "收起" : "看这一版"}
                  </button>
                  {isCurrent ? (
                    <span className="text-[8.5px] text-muted-2">现在这一版</span>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={Boolean(readOnly)}
                        onClick={() => take(version.eventIndex, "soft")}
                        title="把这一版的剧本文字写回当前仍存在的场 / 镜 / 句；不重新生成、不花钱"
                        className="rounded-token border border-line px-1.5 py-0.5 text-[9px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-pick enabled:hover:text-pick disabled:opacity-40"
                      >
                        用这版写回
                      </button>
                      {confirming === version.eventIndex ? (
                        <>
                          <button
                            type="button"
                            disabled={Boolean(readOnly)}
                            onClick={() => take(version.eventIndex, "full")}
                            className="rounded-token border border-pick px-1.5 py-0.5 text-[9px] text-pick disabled:opacity-40"
                          >
                            真的整份回退
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirming(undefined)}
                            className="text-[9px] text-muted-2 hover:text-text"
                          >
                            算了
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={Boolean(readOnly)}
                          onClick={() => setConfirming(version.eventIndex)}
                          title="全局回滚：关键帧、take、配音、审批与时间线也一起回到这一版"
                          className="rounded-token border border-line px-1.5 py-0.5 text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
                        >
                          整份回到这里
                        </button>
                      )}
                    </>
                  )}
                </span>
              </div>
              {open && (
                <div className="mt-2 border-t border-line pt-2">
                  {diff && (diff.added.length > 0 || diff.removed.length > 0) ? (
                    <div className="mb-2 grid gap-2 sm:grid-cols-2">
                      <div>
                        <p className="text-[8.5px] text-muted-2">这一版比现在多</p>
                        <ul className="mt-0.5 space-y-0.5">
                          {diff.removed.slice(0, MAX_DIFF_LINES).map((line, index) => (
                            <li key={`removed-${index}`} className="truncate text-[9px] text-pick">
                              − {line}
                            </li>
                          ))}
                          {diff.removed.length > MAX_DIFF_LINES && (
                            <li className="text-[8.5px] text-muted-2">
                              还有 {diff.removed.length - MAX_DIFF_LINES} 行
                            </li>
                          )}
                        </ul>
                      </div>
                      <div>
                        <p className="text-[8.5px] text-muted-2">现在比这一版多</p>
                        <ul className="mt-0.5 space-y-0.5">
                          {diff.added.slice(0, MAX_DIFF_LINES).map((line, index) => (
                            <li key={`added-${index}`} className="truncate text-[9px] text-muted">
                              ＋ {line}
                            </li>
                          ))}
                          {diff.added.length > MAX_DIFF_LINES && (
                            <li className="text-[8.5px] text-muted-2">
                              还有 {diff.added.length - MAX_DIFF_LINES} 行
                            </li>
                          )}
                        </ul>
                      </div>
                    </div>
                  ) : (
                    <p className="mb-2 text-[9px] text-muted-2">和现在的整份文本一样。</p>
                  )}
                  <pre
                    className={cn(
                      "max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-[2px] border border-line bg-surface px-2 py-1.5",
                      "text-[9px] leading-[1.6] text-muted",
                    )}
                  >
                    {version.text}
                  </pre>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {versions.length > shown.length && (
        <p className="mt-2 text-[9px] text-muted-2">
          还有 {versions.length - shown.length} 版没列出：先在历史抽屉里回到更早的位置。
        </p>
      )}
    </details>
  );
}
