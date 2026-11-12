"use client";

import { useEffect, useMemo } from "react";
import type { Project, ProjectEvent } from "@loomina/ir";
import { costDashboard } from "@/lib/cost-dashboard";
import { shotLedger, spendByStage, spendOf } from "@/lib/read-model";
import { billCsv, spendReport } from "@/lib/spend-report";
import { cn } from "@/lib/utils";

/**
 * 记账抽屉（H4）。
 *
 * 回答三个问题：钱花在哪个阶段、花在哪一镜、这台设备上一共花了多少。
 * 全部从 IR 与事件日志派生，不写事件、不改预算；没有价目的东西单独数出来，不当 0 算。
 */
export function SpendLedger({
  project,
  events,
  open,
  onClose,
}: {
  project: Project;
  /** 本地整条事件日志（H4 跨项目汇总）：开过几个项目就有几条 project.created */
  events: ProjectEvent[];
  open: boolean;
  onClose: () => void;
}) {
  const spend = useMemo(() => spendOf(project), [project]);
  const stages = useMemo(() => spendByStage(project), [project]);
  const shots = useMemo(() => shotLedger(project), [project]);
  const report = useMemo(() => spendReport(events), [events]);
  const board = useMemo(() => costDashboard(project), [project]);
  const stageTotal = stages.reduce((sum, stage) => sum + stage.spent, 0);
  const budget = project.budgetCny;

  const exportBill = () => {
    const blob = new Blob([billCsv(events)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `账单-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

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
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={exportBill}
              title="导出这台设备上所有项目的账单：项目合计、逐镜明细、按阶段三段，CSV 可直接用表格软件打开"
              className="rounded-token border border-line px-2 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
            >
              导出账单
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-token border border-line px-2 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
            >
              关闭
            </button>
          </div>
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
                  spend.unpricedCalls > 0 ? "text-pick" : "text-muted-2",
                )}
              >
                {spend.unpricedCalls}
                <span className="ml-0.5 text-[8.5px] text-muted-2">次</span>
              </dd>
            </div>
            <div className="rounded-token border border-line px-2 py-1.5">
              <dt className="text-[8.5px] text-muted-2">已淘汰</dt>
              <dd className="tnum mt-0.5 text-[15px] text-muted">
                ¥{spend.rejected.toFixed(2)}
              </dd>
            </div>
          </dl>

          <section className="mt-4" aria-label="成本看板">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">成本看板</h3>
              <span className="tnum text-[9px] text-muted-2">H15</span>
            </div>
            <dl className="mt-1.5 grid grid-cols-3 gap-2">
              <div className="rounded-token border border-line px-2 py-1.5">
                <dt className="text-[8.5px] text-muted-2">单镜均成本</dt>
                <dd className="tnum mt-0.5 text-[13px] text-text">
                  {board.avgCnyPerShot === undefined
                    ? "—"
                    : `¥${board.avgCnyPerShot.toFixed(2)}`}
                </dd>
                <dd className="tnum text-[8px] text-muted-2">
                  {board.pricedShots} / {board.shots} 镜有花费
                </dd>
              </div>
              <div className="rounded-token border border-line px-2 py-1.5">
                <dt className="text-[8.5px] text-muted-2">首次通过率</dt>
                <dd className="tnum mt-0.5 text-[13px] text-text">
                  {board.firstPassRate === undefined
                    ? "—"
                    : `${Math.round(board.firstPassRate * 100)}%`}
                </dd>
                <dd className="tnum text-[8px] text-muted-2">
                  {board.firstPassShots} / {board.judgedShots} 镜已判定
                </dd>
              </div>
              <div className="rounded-token border border-line px-2 py-1.5">
                <dt className="text-[8.5px] text-muted-2">重试占比</dt>
                <dd
                  className={cn(
                    "tnum mt-0.5 text-[13px]",
                    board.retryCny > 0 ? "text-pick" : "text-text",
                  )}
                >
                  {board.retryShare === undefined
                    ? "—"
                    : `${Math.round(board.retryShare * 100)}%`}
                </dd>
                <dd className="tnum text-[8px] text-muted-2">
                  {board.rejectedTakes} / {board.takes} 条 take
                  {board.retryCny > 0 ? ` · ¥${board.retryCny.toFixed(2)}` : ""}
                </dd>
              </div>
            </dl>

            {board.topShots.length > 0 && (
              <p className="tnum mt-1.5 text-[8.5px] leading-[1.6] text-muted-2">
                最贵：
                {board.topShots
                  .slice(0, 3)
                  .map((shot) => `${shot.label} ¥${shot.spent.toFixed(2)}`)
                  .join(" · ")}
              </p>
            )}

            {board.anomalies.length > 0 ? (
              <ul className="mt-2 border-t border-line">
                {board.anomalies.map((item) => (
                  <li
                    key={item.shotId}
                    className="flex items-start justify-between gap-3 border-b border-line py-1.5"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="tnum text-[9.5px] text-muted">{item.label}</span>
                        <span className="text-[10px] text-text">{item.scene || "—"}</span>
                        <span className="text-[8.5px] text-pick">异常突增</span>
                      </div>
                      <p className="mt-0.5 text-[8.5px] leading-[1.5] text-muted-2">
                        {item.reason}
                      </p>
                    </div>
                    <span className="tnum shrink-0 text-[10.5px] text-pick">
                      ¥{item.spent.toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-[9px] leading-[1.6] text-muted-2">
                {board.medianCnyPerShot === undefined
                  ? "还没有花过钱的镜，暂时看不出异常。"
                  : `没有明显贵出中位数的镜（中位数 ¥${board.medianCnyPerShot.toFixed(2)}）。`}
              </p>
            )}

            <p className="mt-2 text-[8.5px] leading-[1.7] text-muted-2">
              均值 / 中位数只看有花钱的镜，零花费不摊薄；首次通过率只算第一版 take
              已有采纳 / 淘汰结论的镜，还没判定的不计入；重试占比按淘汰 take
              条数算。异常突增 = 贵过中位数 3 倍且多花至少 ¥1，有花费的镜少于 4 个不下结论。
            </p>
          </section>

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
                      {/* 图 / 视频按张数说，文本 / 配音按次数说（H4）：单位不同，不能混成一个数 */}
                      {stage.unpriced > 0 && (
                        <span className="text-[8.5px] text-pick">
                          {stage.unpriced} 张未定价
                        </span>
                      )}
                      {stage.unpricedCalls > stage.unpriced && (
                        <span className="text-[8.5px] text-pick">
                          {stage.unpricedCalls - stage.unpriced} 次未定价
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

          <section className="mt-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">这台设备</h3>
              <span className="tnum text-[9px] text-muted-2">
                {report.rows.length} 个项目 · 合计 ¥{report.total.toFixed(2)}
              </span>
            </div>
            <ul className="mt-1.5 border-t border-line">
              {report.rows.map((row) => (
                <li
                  key={`${row.id}-${row.fromEvent}`}
                  className="flex items-start justify-between gap-3 border-b border-line py-1.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="truncate text-[10px] text-text">{row.title}</span>
                      <span className="tnum text-[8.5px] text-muted-2">
                        v{row.version} · {row.shots} 镜
                      </span>
                      {row.id === project.id && (
                        <span className="text-[8.5px] text-muted">正在看</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[8.5px] leading-[1.5] text-muted-2">
                      {row.startedAt.slice(0, 10)} 起 · {row.events} 条事件
                      {row.spend.text > 0 ? ` · 文本 ¥${row.spend.text.toFixed(2)}` : ""}
                      {row.spend.voice > 0 ? ` · 配音 ¥${row.spend.voice.toFixed(2)}` : ""}
                      {row.spend.unpricedCalls > 0
                        ? ` · ${row.spend.unpricedCalls} 次未定价`
                        : ""}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "tnum shrink-0 text-[10.5px]",
                      row.spend.spent > 0 ? "text-text" : "text-muted-2",
                    )}
                  >
                    ¥{row.spend.spent.toFixed(2)}
                  </span>
                </li>
              ))}
              {report.rows.length === 0 && (
                <li className="py-2 text-[9.5px] text-muted-2">日志里还没有项目。</li>
              )}
            </ul>
            {report.skipped > 0 && (
              <p className="mt-1.5 text-[9px] leading-[1.6] text-pick">
                有 {report.skipped} 段日志回放不了，没算进合计：那几段可能是在旧版本里写的。
              </p>
            )}
          </section>

          <p className="mt-4 border-t border-line pt-3 text-[9px] leading-[1.7] text-muted-2">
            只加知道单价的东西：没有价目的生成结果单独数「未定价」，不当 0 算。
            文本按 token、配音按字计价——单价是你在设置页里给每个模型填的估算，
            填了才算钱；本机 ffmpeg 渲染不按文件收费，账单里只记机器时间，不折成钱。
          </p>
        </div>
      </aside>
    </div>
  );
}
