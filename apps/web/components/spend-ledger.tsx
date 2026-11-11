"use client";

import { useEffect, useMemo } from "react";
import type { Project } from "@loomina/ir";
import { shotLedger, spendByStage, spendOf } from "@/lib/read-model";
import { cn } from "@/lib/utils";

/**
 * 记账抽屉（H4）。
 *
 * 回答两个问题：钱花在哪个阶段、花在哪一镜。
 * 全部从 IR 派生，不写事件、不改预算；没有价目的东西单独数出来，不当 0 算。
 */
export function SpendLedger({
  project,
  open,
  onClose,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
}) {
  const spend = useMemo(() => spendOf(project), [project]);
  const stages = useMemo(() => spendByStage(project), [project]);
  const shots = useMemo(() => shotLedger(project), [project]);
  const stageTotal = stages.reduce((sum, stage) => sum + stage.spent, 0);
  const budget = project.budgetCny;

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="记账"
        className="flex h-full w-[420px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">记账</h2>
            <span className="tnum text-[9px] text-muted-2">
              按阶段 / 按镜 · {project.shots.length} 镜
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
          <dl className="grid grid-cols-4 gap-2">
            <div className="rounded-token border border-line px-2 py-1.5">
              <dt className="text-[8.5px] text-muted-2">已花</dt>
              <dd className="tnum mt-0.5 text-[15px] text-text">¥{spend.spent.toFixed(2)}</dd>
            </div>
            <div className="rounded-token border border-line px-2 py-1.5">
              <dt className="text-[8.5px] text-muted-2">预算</dt>
              <dd className="tnum mt-0.5 text-[15px] text-muted">¥{budget.toFixed(2)}</dd>
            </div>
            <div className="rounded-token border border-line px-2 py-1.5">
              <dt className="text-[8.5px] text-muted-2">未定价</dt>
              <dd
                className={cn(
                  "tnum mt-0.5 text-[15px]",
                  spend.unpriced > 0 ? "text-pick" : "text-muted-2",
                )}
              >
                {spend.unpriced}
              </dd>
            </div>
            <div className="rounded-token border border-line px-2 py-1.5">
              <dt className="text-[8.5px] text-muted-2">已淘汰</dt>
              <dd className="tnum mt-0.5 text-[15px] text-muted">
                ¥{spend.rejected.toFixed(2)}
              </dd>
            </div>
          </dl>

          <section className="mt-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">按阶段</h3>
              <span className="tnum text-[9px] text-muted-2">
                合计 ¥{stageTotal.toFixed(2)}
              </span>
            </div>
            <ul className="mt-1.5 border-t border-line">
              {stages.map((stage) => (
                <li
                  key={stage.id}
                  className="flex items-start justify-between gap-3 border-b border-line py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[10px] text-text">{stage.label}</span>
                      {stage.unpriced > 0 && (
                        <span className="text-[8.5px] text-pick">
                          {stage.unpriced} 张未定价
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[9px] leading-[1.6] text-muted-2">
                      {stage.detail}
                    </p>
                  </div>
                  <span className="tnum shrink-0 text-[11px] text-text">
                    ¥{stage.spent.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">按镜</h3>
              <span className="text-[9px] text-muted-2">定妆等项目成本不摊进镜头</span>
            </div>
            <ul className="mt-1.5 border-t border-line">
              {shots.map((shot) => (
                <li
                  key={shot.shotId}
                  className="flex items-start justify-between gap-3 border-b border-line py-1.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="tnum text-[9.5px] text-muted">{shot.label}</span>
                      <span className="text-[10px] text-text">{shot.scene || "—"}</span>
                      <span className="tnum text-[8.5px] text-muted-2">
                        {(shot.durationMs / 1000).toFixed(1)}s
                      </span>
                      {shot.unpriced > 0 && (
                        <span className="text-[8.5px] text-pick">
                          {shot.unpriced} 张未定价
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[8.5px] leading-[1.5] text-muted-2">
                      {shot.takes} 条 take
                      {shot.rejected > 0 ? ` · 淘汰 ¥${shot.rejected.toFixed(2)}` : ""}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "tnum shrink-0 text-[10.5px]",
                      shot.spent > 0 ? "text-text" : "text-muted-2",
                    )}
                  >
                    ¥{shot.spent.toFixed(2)}
                  </span>
                </li>
              ))}
              {shots.length === 0 && (
                <li className="py-2 text-[9.5px] text-muted-2">还没有镜头。</li>
              )}
            </ul>
          </section>

          <p className="mt-4 border-t border-line pt-3 text-[9px] leading-[1.7] text-muted-2">
            只加知道单价的东西：没有价目的生成资产单独数「未定价」，不当 0 算。
            文本模型调用与本机 ffmpeg 渲染目前没有落进 IR 的费用，因此剧本与成片阶段
            可能显示 ¥0.00——那表示「未记账」，不是「免费」。
          </p>
        </div>
      </aside>
    </div>
  );
}
