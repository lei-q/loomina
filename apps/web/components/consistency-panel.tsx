"use client";

import { useEffect, useMemo } from "react";
import type { Project } from "@loomina/ir";
import { analyzeConsistency, type ShotConsistency } from "@/lib/consistency";
import { cn } from "@/lib/utils";

const VERDICT_LABEL: Record<ShotConsistency["verdict"], string> = {
  pass: "通过",
  review: "待复核",
  fail: "不达标",
  unknown: "未出片",
};

const SIZE_LABEL: Record<string, string> = {
  wide: "全景",
  medium: "中景",
  close: "近景",
  "extreme-close": "大特写",
};

function ScoreBar({ score }: { score: number | null }) {
  return (
    <span className="block h-[3px] w-full overflow-hidden rounded-full bg-line">
      <span
        className={cn(
          "block h-full rounded-full",
          score === null ? "bg-transparent" : score >= 85 ? "bg-muted-2" : "bg-pick",
        )}
        style={{ width: score === null ? "0%" : `${Math.max(0, Math.min(100, score))}%` }}
      />
    </span>
  );
}

export type ConsistencyPanelProps = {
  project: Project;
  currentShotId: string;
  onSelect: (shotId: string) => void;
  onClose: () => void;
};

/**
 * 一致性体检面板（B14，ADR-0097）。
 *
 * 只列结构化锚点与溯源：不假装做过人脸 / 像素比对。
 * 每一维度可以单独看分数与补图建议；点镜头跳过去。
 */
export function ConsistencyPanel({
  project,
  currentShotId,
  onSelect,
  onClose,
}: ConsistencyPanelProps) {
  const report = useMemo(() => analyzeConsistency(project), [project]);
  const current =
    report.shots.find((item) => item.shotId === currentShotId) ?? report.shots[0];

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
        aria-label="一致性体检"
        className="flex h-full w-[400px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">一致性体检</h2>
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
              <dt className="text-[8.5px] text-muted-2">平均</dt>
              <dd className="tnum mt-0.5 text-[15px] text-text">{report.summary.average}</dd>
            </div>
            <div className="rounded-token border border-line px-2 py-1.5">
              <dt className="text-[8.5px] text-muted-2">通过</dt>
              <dd className="tnum mt-0.5 text-[15px] text-text">{report.summary.pass}</dd>
            </div>
            <div className="rounded-token border border-line px-2 py-1.5">
              <dt className="text-[8.5px] text-muted-2">待复核</dt>
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
              <dt className="text-[8.5px] text-muted-2">不达标</dt>
              <dd
                className={cn(
                  "tnum mt-0.5 text-[15px]",
                  report.summary.fail > 0 ? "text-pick" : "text-muted-2",
                )}
              >
                {report.summary.fail}
              </dd>
            </div>
          </dl>
          {report.summary.unknown > 0 && (
            <p className="mt-1.5 text-[9px] text-muted-2">
              {report.summary.unknown} 镜还没有 take：只算了锚点准备度，不判定成片一致性。
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
                  {SIZE_LABEL[current.shotSize] ?? current.shotSize} · 线 {current.threshold}
                </span>
              </div>

              <p className="tnum mt-1 text-[11px] text-muted">
                {current.overall === null ? "不可评" : `${current.overall} 分`}
                <span className="ml-2 text-[9px] text-muted-2">
                  · 只算可测维度，按景别定通过线
                </span>
              </p>

              <ul className="mt-2 space-y-1.5">
                {current.dimensions.map((dimension) => (
                  <li key={dimension.key} className="grid grid-cols-[52px_1fr_30px] items-center gap-2">
                    <span className="text-[9.5px] text-muted">{dimension.label}</span>
                    <ScoreBar score={dimension.score} />
                    <span
                      className={cn(
                        "tnum text-right text-[9.5px]",
                        dimension.score === null
                          ? "text-muted-2"
                          : dimension.score >= 85
                            ? "text-muted"
                            : "text-pick",
                      )}
                    >
                      {dimension.score === null ? "—" : dimension.score}
                    </span>
                  </li>
                ))}
              </ul>

              {current.issues.length > 0 ? (
                <ul className="mt-3 space-y-2 border-t border-line pt-2">
                  {current.issues.map((issue, index) => (
                    <li key={`${issue.dimension}-${index}`} className="text-[9.5px] leading-[1.65]">
                      <p className={issue.severity === "error" ? "text-pick" : "text-muted"}>
                        {issue.message}
                      </p>
                      {issue.fix && (
                        <p className="mt-0.5 text-[9px] text-muted-2">{issue.fix}</p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 border-t border-line pt-2 text-[9.5px] leading-[1.65] text-muted">
                  这一镜的结构化锚点齐了。
                </p>
              )}
            </section>
          )}

          <section className="mt-5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">需要看的镜头</h3>
              <span className="tnum text-[9px] text-muted-2">
                {report.attention.length} 镜
              </span>
            </div>
            <ul className="mt-1.5 border-t border-line">
              {report.attention.map((shot) => {
                const worst = [...shot.dimensions]
                  .filter((item) => item.score !== null)
                  .sort((a, b) => (a.score ?? 100) - (b.score ?? 100))[0];
                return (
                  <li key={shot.shotId} className="border-b border-line">
                    <button
                      type="button"
                      onClick={() => onSelect(shot.shotId)}
                      className="flex w-full items-center justify-between gap-2 py-2 text-left"
                    >
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="tnum text-[10px] text-text">{shot.label}</span>
                        <span className="truncate text-[9px] text-muted-2">
                          {SIZE_LABEL[shot.shotSize] ?? shot.shotSize}
                          {worst ? ` · ${worst.label} ${worst.score}` : ""}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-baseline gap-1.5">
                        <span className="tnum text-[9.5px] text-pick">{shot.overall}</span>
                        <span className="tnum text-[8.5px] text-muted-2">
                          / {shot.threshold}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {report.attention.length === 0 && (
                <li className="py-2 text-[10px] leading-[1.7] text-muted-2">
                  没有需要复核的镜头：结构化锚点都在通过线以上。
                </li>
              )}
            </ul>
          </section>

          <section className="mt-5">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">未测</h3>
            <ul className="mt-1.5 space-y-1.5 border-t border-line pt-2">
              {report.notMeasured.map((item) => (
                <li key={item.key} className="text-[9px] leading-[1.65] text-muted-2">
                  <span className="text-muted">{item.label}</span> · {item.reason}
                </li>
              ))}
            </ul>
          </section>

          <p className="mt-4 border-t border-line pt-3 text-[9px] leading-[1.7] text-muted-2">
            这里查的是定妆锚点、场景主镜、道具参考、take 的模型与溯源，不是人脸或像素相似度。
            分数只说明「生成所需的结构在不在、出了问题能不能查」，不评价画面好不好。
          </p>
        </div>
      </aside>
    </div>
  );
}
