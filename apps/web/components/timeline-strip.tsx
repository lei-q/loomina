"use client";

import Link from "next/link";
import { useMemo } from "react";
import { shotLabel, toStageView } from "@/lib/read-model";
import { useWorkbench } from "@/lib/workbench-store";
import { cn } from "@/lib/utils";

/** 秒数显示成 0:00 / 1:23；时间线看的是位置，不是毫秒 */
function clock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * 自由工作台的时间线条（F8）。
 *
 * 阶段式里时间线只在成片页；自由工作台要「分镜、预览、时间线同屏」，
 * 所以在分镜页底下铺一条只读的时间线：点一段就跳到那一镜，
 * 真正的初剪 / 换 take 仍然去成片页。
 */
export function TimelineStrip() {
  const project = useWorkbench((state) => state.project);
  const select = useWorkbench((state) => state.select);
  const currentShotId = useWorkbench((state) => state.currentShotId);
  const view = useMemo(() => toStageView(project), [project]);
  const noOf = useMemo(
    () => new Map(view.shots.map((shot) => [shot.id, shot.no])),
    [view.shots],
  );
  const items = project.timeline.items;
  const totalMs = items.reduce((end, item) => Math.max(end, item.startMs + item.durationMs), 0);

  return (
    <section
      aria-label="时间线"
      className="flex shrink-0 items-center gap-3 border-t border-line px-6 py-1.5"
    >
      <span className="tnum shrink-0 text-[9px] tracking-[.08em] text-muted-2">
        时间线 · {items.length} 段 · {clock(totalMs)}
      </span>
      {items.length === 0 ? (
        <span className="min-w-0 flex-1 text-[9.5px] text-muted-2">
          还没初剪：去成片页按剧本顺序排一遍。
        </span>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {items.map((item, index) => {
            const no = noOf.get(item.shotId);
            const active = item.shotId === currentShotId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => select(item.shotId)}
                title={`第 ${index + 1} 段 · ${clock(item.startMs)} 起 · 时长 ${(item.durationMs / 1000).toFixed(1)} 秒`}
                className={cn(
                  "tnum flex shrink-0 items-center gap-1.5 rounded-token border px-1.5 py-0.5 text-[9px] transition-colors duration-[var(--dur)]",
                  active
                    ? "border-line-2 bg-surface text-text"
                    : "border-line text-muted-2 hover:border-line-2 hover:text-text",
                )}
              >
                <span>{index + 1}</span>
                <span>{no === undefined ? "—" : shotLabel(no)}</span>
                <span className="text-muted-2">{(item.durationMs / 1000).toFixed(1)}s</span>
              </button>
            );
          })}
        </div>
      )}
      <Link
        href="/edit"
        className="shrink-0 text-[9.5px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
      >
        成片 →
      </Link>
    </section>
  );
}
