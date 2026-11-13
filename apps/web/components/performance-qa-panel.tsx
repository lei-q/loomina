"use client";

import { useEffect, useMemo } from "react";
import type { Project, Shot } from "@loomina/ir";
import {
  PERFORMANCE_FOCUS_LABEL,
  PERFORMANCE_QA_RULE_LABEL,
  analyzePerformanceQa,
  type ShotPerformanceQa,
} from "@/lib/performance-qa";
import { cn } from "@/lib/utils";

const VERDICT_LABEL: Record<ShotPerformanceQa["verdict"], string> = {
  pass: "通过",
  review: "建议改",
  fail: "会出问题",
  unknown: "未写",
};

const SIZE_LABEL: Record<Shot["shotSize"], string> = {
  wide: "全景",
  medium: "中景",
  close: "特写",
  "extreme-close": "大特写",
};

export type PerformanceQaPanelProps = {
  project: Project;
  currentShotId: string;
  onSelect: (shotId: string) => void;
  /** 去表演面板改这一镜；不给就只列问题 */
  onEdit?: (shotId: string) => void;
  onClose: () => void;
};

/**
 * 表演 QA 面板（B18 / PERFORMANCE.md §十）。
 *
 * 只查表演设计本身：这一景别靠什么演戏、写没写、视线看的人在不在这镜里、
 * 起转落写全没有、强度配不配景别与节拍。不做抽帧表情识别——面板底部明说。
 */
export function PerformanceQaPanel({
  project,
  currentShotId,
  onSelect,
  onEdit,
  onClose,
}: PerformanceQaPanelProps) {
  const report = useMemo(() => analyzePerformanceQa(project), [project]);
  const current = report.shots.find((item) => item.shotId === currentShotId) ?? report.shots[0];

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="表演 QA"
        className="flex h-full w-[420px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">表演 QA</h2>
            <span className="tnum text-[9px] text-muted-2">{report.summary.shots} 镜</span>
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
              <dt className="text-[8.5px] text-muted-2">通过</dt>
              <dd className="tnum mt-0.5 text-[15px] text-text">{report.summary.pass}</dd>
            </div>
            <div className="rounded-token border border-line px-2 py-1.5">
              <dt className="text-[8.5px] text-muted-2">建议改</dt>
              <dd
                className={cn(
                  "tnum mt-0.5 text-[15px]",
                  report.summary.review > 0 ? "text-pick" : "text-muted-2",
                )}
              >
                {report.summary.review}
              </dd>
            </div>
            <div className="rounded-token border border-line px-2 py-1.5">
              <dt className="text-[8.5px] text-muted-2">会出问题</dt>
              <dd
                className={cn(
                  "tnum mt-0.5 text-[15px]",
                  report.summary.fail > 0 ? "text-pick" : "text-muted-2",
                )}
              >
                {report.summary.fail}
              </dd>
            </div>
            <div className="rounded-token border border-line px-2 py-1.5">
              <dt className="text-[8.5px] text-muted-2">未写</dt>
              <dd className="tnum mt-0.5 text-[15px] text-muted-2">{report.summary.unknown}</dd>
            </div>
          </dl>
          {report.summary.unknown > 0 && (
            <p className="mt-1.5 text-[9px] leading-[1.6] text-muted-2">
              {report.summary.unknown} 镜还没写表演设计：先有 objective 与视线，这里才判得了。
            </p>
          )}

          {current && (
            <section className="mt-4">
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-[10.5px] tracking-[.06em] text-text">
                    当前镜 {current.label}
                  </h3>
                  <span
                    className={cn(
                      "tnum rounded-token border px-1.5 py-px text-[8.5px]",
                      current.verdict === "pass"
                        ? "border-line-2 text-muted"
                        : current.verdict === "unknown"
                          ? "border-line text-muted-2"
                          : "border-pick/50 text-pick",
                    )}
                  >
                    {VERDICT_LABEL[current.verdict]}
                  </span>
                </div>
                <span className="tnum text-[9px] text-muted-2">
                  {SIZE_LABEL[current.shotSize]} · 看{PERFORMANCE_FOCUS_LABEL[current.focus]}
                </span>
              </div>

              {current.verdict === "unknown" ? (
                <p className="mt-2 text-[9.5px] leading-[1.7] text-muted-2">
                  这一镜还没有表演设计：写一句 objective 与视线，首尾帧与视频提示词才会写到表情和看谁。
                </p>
              ) : current.findings.length === 0 ? (
                <p className="mt-2 text-[9.5px] leading-[1.7] text-muted">
                  这一镜的表演设计写全了：这一景别要看的东西都在。
                </p>
              ) : (
                <ul className="mt-2 space-y-2 border-t border-line pt-2">
                  {current.findings.map((finding, index) => (
                    <li key={`${finding.rule}-${index}`} className="text-[9.5px] leading-[1.65]">
                      <p className="flex items-baseline gap-1.5">
                        <span
                          className={cn(
                            "shrink-0 text-[8.5px] tracking-[.06em]",
                            finding.severity === "fail" ? "text-pick" : "text-muted-2",
                          )}
                        >
                          {PERFORMANCE_QA_RULE_LABEL[finding.rule]}
                        </span>
                        <span className={finding.severity === "fail" ? "text-pick" : "text-muted"}>
                          {finding.message}
                        </span>
                      </p>
                      <p className="mt-0.5 text-[9px] text-muted-2">{finding.fix}</p>
                    </li>
                  ))}
                </ul>
              )}

              {onEdit && current.verdict !== "unknown" && (
                <button
                  type="button"
                  onClick={() => onEdit(current.shotId)}
                  className="mt-2.5 rounded-token border border-line-2 px-2.5 py-1 text-[10px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                >
                  去改这一镜的表演
                </button>
              )}
            </section>
          )}

          <section className="mt-5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">要改的镜头</h3>
              <span className="tnum text-[9px] text-muted-2">{report.attention.length} 镜</span>
            </div>
            <ul className="mt-1.5 border-t border-line">
              {report.attention.map((shot) => (
                <li key={shot.shotId} className="border-b border-line">
                  <button
                    type="button"
                    onClick={() => onSelect(shot.shotId)}
                    className="flex w-full items-baseline justify-between gap-2 py-2 text-left"
                  >
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="tnum text-[10px] text-text">{shot.label}</span>
                      <span className="truncate text-[9px] text-muted-2">
                        {SIZE_LABEL[shot.shotSize]} · 看{PERFORMANCE_FOCUS_LABEL[shot.focus]}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-baseline gap-1.5">
                      <span
                        className={cn(
                          "text-[9px]",
                          shot.verdict === "fail" ? "text-pick" : "text-muted-2",
                        )}
                      >
                        {VERDICT_LABEL[shot.verdict]}
                      </span>
                      <span className="tnum text-[8.5px] text-muted-2">
                        {shot.findings.length} 条
                      </span>
                    </span>
                  </button>
                </li>
              ))}
              {report.attention.length === 0 && (
                <li className="py-2 text-[10px] leading-[1.7] text-muted-2">
                  没有要改的镜头：写了的表演设计都配得上各自的景别。
                </li>
              )}
            </ul>
          </section>

          <section className="mt-5">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">按景别看什么</h3>
            <ul className="mt-1.5 space-y-1 border-t border-line pt-2 text-[9px] leading-[1.65] text-muted-2">
              <li>
                <span className="text-muted">特写 / 大特写</span> · 看微表情：嘴角、眼睑、呼吸。
                没写微表情就是中性脸。
              </li>
              <li>
                <span className="text-muted">中景</span> · 看姿态：肩膀、重心、手。
              </li>
              <li>
                <span className="text-muted">全景</span> · 看调度：谁在左、谁在前。
              </li>
            </ul>
          </section>

          <p className="mt-4 border-t border-line pt-3 text-[9px] leading-[1.7] text-muted-2">
            这里查的是表演设计：这一镜要什么、给没给微表情、视线看的人在不在这镜里、
            起转落写全没有、强度配不配景别与节拍。没有抽帧，也不做表情或视线识别——
            演得好不好仍然要人看片。
          </p>
        </div>
      </aside>
    </div>
  );
}
