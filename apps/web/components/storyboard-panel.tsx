"use client";

import { useEffect, useMemo } from "react";
import type { BeatKind, Project, ShotPurpose } from "@loomina/ir";
import {
  BEAT_LABEL,
  BEAT_ORDER,
  BEAT_TASK,
  PURPOSE_LABEL,
  PURPOSE_TASK,
  analyzeStoryboard,
  digestBeats,
} from "@/lib/storyboard";
import { cn } from "@/lib/utils";

function shotLabel(no: number): string {
  return `SH-${String(no).padStart(2, "0")}`;
}

function spanLabel(beat: { shotNos: number[] }): string {
  if (beat.shotNos.length === 0) return "";
  const first = beat.shotNos[0]!;
  const last = beat.shotNos.at(-1)!;
  return first === last
    ? shotLabel(first)
    : `${shotLabel(first)}–${shotLabel(last)}`;
}

export type StoryboardPanelProps = {
  project: Project;
  currentShotId: string;
  /** 整片重做一遍的报价；价目未知就不查 V8 */
  quoteAllCny?: number;
  /** 另一个标签页在编辑：所有下拉只读 */
  readOnly?: boolean;
  onSelect: (shotId: string) => void;
  onPlanChange: (patch: { beat?: BeatKind; purpose?: ShotPurpose }) => void;
  onClose: () => void;
};

/**
 * 分镜检查面板（A11 / A12 / A13，ADR-0096）。
 *
 * 右侧抽屉：上面是覆盖率和当前镜的节拍 / 目的，下面按场次列拍、列问题。
 * 改拍或目的写 `shot.updated`；点问题里的镜号跳到那一镜。
 */
export function StoryboardPanel({
  project,
  currentShotId,
  quoteAllCny,
  readOnly = false,
  onSelect,
  onPlanChange,
  onClose,
}: StoryboardPanelProps) {
  const report = useMemo(
    () =>
      analyzeStoryboard(project, {
        requoteCny: quoteAllCny,
        budgetCny: project.budgetCny,
      }),
    [project, quoteAllCny],
  );
  const digest = useMemo(() => digestBeats(report.beats), [report.beats]);
  const current = report.plans.find((plan) => plan.shotId === currentShotId);
  const planLocked = readOnly || project.shots.find((shot) => shot.id === currentShotId)?.locked === true;

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
        aria-label="分镜检查"
        className="flex h-full w-[380px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">分镜检查</h2>
            <span className="tnum text-[9px] text-muted-2">
              {report.summary.shots} 镜 · {report.summary.beats} 拍
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
              <dt className="text-[8.5px] text-muted-2">覆盖率</dt>
              <dd
                className={cn(
                  "tnum mt-0.5 text-[15px]",
                  report.summary.coveragePct === 100 ? "text-text" : "text-pick",
                )}
              >
                {report.summary.coveragePct}%
              </dd>
            </div>
            <div className="rounded-token border border-line px-2 py-1.5">
              <dt className="text-[8.5px] text-muted-2">拍</dt>
              <dd className="tnum mt-0.5 text-[15px] text-text">
                {report.summary.coveredBeats}/{report.summary.beats}
              </dd>
            </div>
            <div className="rounded-token border border-line px-2 py-1.5">
              <dt className="text-[8.5px] text-muted-2">错误</dt>
              <dd
                className={cn(
                  "tnum mt-0.5 text-[15px]",
                  report.summary.errors > 0 ? "text-pick" : "text-muted-2",
                )}
              >
                {report.summary.errors}
              </dd>
            </div>
            <div className="rounded-token border border-line px-2 py-1.5">
              <dt className="text-[8.5px] text-muted-2">提示</dt>
              <dd className="tnum mt-0.5 text-[15px] text-muted">
                {report.summary.warnings}
              </dd>
            </div>
          </dl>

          {current && (
            <section className="mt-4">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-[10.5px] tracking-[.06em] text-text">
                  当前镜 {shotLabel(current.no)}
                </h3>
                <span className="text-[8.5px] text-muted-2">
                  {current.sceneLabel} · {(current.durationMs / 1000).toFixed(1)}s
                </span>
              </div>
              <div className="mt-2 grid grid-cols-1 gap-2">
                <label className="flex flex-col gap-1 text-[9px] text-muted-2">
                  节拍
                  <select
                    value={current.beat}
                    disabled={planLocked}
                    onChange={(event) =>
                      onPlanChange({ beat: event.target.value as BeatKind })
                    }
                    className="rounded-token border border-line bg-bg px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {BEAT_ORDER.map((kind) => (
                      <option key={kind} value={kind} className="bg-surface">
                        {BEAT_LABEL[kind]} · {BEAT_TASK[kind]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[9px] text-muted-2">
                  镜头目的
                  <select
                    value={current.purpose}
                    disabled={planLocked}
                    onChange={(event) =>
                      onPlanChange({ purpose: event.target.value as ShotPurpose })
                    }
                    className="rounded-token border border-line bg-bg px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {(["establish", "information", "emotion", "reaction", "transition", "hook"] as ShotPurpose[]).map(
                      (purpose) => (
                        <option key={purpose} value={purpose} className="bg-surface">
                          {PURPOSE_LABEL[purpose]} · {PURPOSE_TASK[purpose]}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              </div>
              {planLocked ? (
                <p className="mt-1.5 text-[9px] leading-[1.6] text-muted-2">
                  {readOnly
                    ? "另一个标签页在编辑：这一页只读。"
                    : "这一镜已锁定：先解锁再改节拍或镜头目的。"}
                </p>
              ) : (
                (current.beatFrom === "inferred" || current.purposeFrom === "inferred") && (
                  <p className="mt-1.5 text-[9px] leading-[1.6] text-muted-2">
                    {current.beatFrom === "inferred" && current.purposeFrom === "inferred"
                      ? "这一镜的节拍与镜头目的还没有手动标注：先按镜序推断，改了才会写进项目。"
                      : current.beatFrom === "inferred"
                        ? "这一镜的节拍还没有手动标注：现在是按镜序推断的，改了才会写进项目。"
                        : "这一镜的镜头目的还没有手动标注：现在是按镜序推断的，改了才会写进项目。"}
                  </p>
                )
              )}
            </section>
          )}

          <section className="mt-5">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">节拍</h3>
            {/* 节拍摘要（A11）：先给一句总览，再逐拍展开 */}
            {digest.count > 0 && (
              <div className="mt-1.5 border border-line px-2 py-1.5 text-[9px] leading-[1.7] text-muted-2">
                <p className="text-muted">
                  {digest.count} 拍 · 共 {digest.totalSeconds.toFixed(1)}s · 覆盖{" "}
                  <span className="tnum">
                    {digest.covered}/{digest.count}
                  </span>
                  {digest.longest && (
                    <>
                      {" "}
                      · 最长「{digest.longest.label}」{digest.longest.seconds.toFixed(1)}s（
                      {digest.longest.sharePct}%）
                    </>
                  )}
                </p>
                <p className="mt-0.5 break-words">{digest.arc}</p>
              </div>
            )}
            <ul className="mt-1.5 border-t border-line">
              {report.beats.map((beat) => {
                const covered = beat.hasInformation && beat.hasEmotion;
                return (
                  <li key={beat.id} className="border-b border-line py-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (beat.shotIds[0]) onSelect(beat.shotIds[0]);
                      }}
                      className="flex w-full items-start justify-between gap-2 text-left"
                    >
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-[10.5px] text-text">
                            {BEAT_LABEL[beat.kind]}
                          </span>
                          <span className="tnum text-[9px] text-muted-2">
                            {beat.sceneLabel} · {spanLabel(beat)} ·{" "}
                            {(beat.durationMs / 1000).toFixed(1)}s · {beat.shotIds.length} 镜 ·{" "}
                            {beat.aslSeconds.toFixed(1)}s/镜 · {beat.cutsPer10s.toFixed(1)} 切/10s
                          </span>
                        </span>
                        <span className="mt-0.5 block text-[9px] text-muted-2">
                          {BEAT_TASK[beat.kind]}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "tnum shrink-0 rounded-token border px-1.5 py-px text-[8.5px]",
                          covered ? "border-line-2 text-muted" : "border-line text-muted-2",
                        )}
                      >
                        {covered
                          ? "信息 + 情绪"
                          : [!beat.hasInformation ? "缺信息" : "", !beat.hasEmotion ? "缺情绪" : ""]
                              .filter(Boolean)
                              .join(" · ")}
                      </span>
                    </button>
                  </li>
                );
              })}
              {report.beats.length === 0 && (
                <li className="py-2 text-[10px] text-muted-2">还没有镜头。</li>
              )}
            </ul>
          </section>

          <section className="mt-5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">校验</h3>
              <span className="tnum text-[9px] text-muted-2">
                {report.summary.errors} 错 · {report.summary.warnings} 提示
              </span>
            </div>
            <ul className="mt-1.5 border-t border-line">
              {report.issues.map((issue, index) => {
                const first = report.plans.find((plan) => plan.shotId === issue.shotIds[0]);
                return (
                  <li key={`${issue.rule}-${index}`} className="border-b border-line py-2">
                    <div className="flex items-start gap-2">
                      <span
                        className={cn(
                          "tnum shrink-0 pt-px text-[8.5px] tracking-[.06em]",
                          issue.severity === "error" ? "text-pick" : "text-muted-2",
                        )}
                      >
                        {issue.rule}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[9.5px] leading-[1.65] text-muted">{issue.message}</p>
                        {first ? (
                          <p className="mt-1 flex items-baseline gap-1.5 text-[9px]">
                            <button
                              type="button"
                              onClick={() => onSelect(first.shotId)}
                              className="text-muted-2 underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
                            >
                              去 {shotLabel(first.no)}
                            </button>
                            {issue.shotIds.length > 1 && (
                              <span className="tnum text-[8.5px] text-muted-2">
                                共 {issue.shotIds.length} 镜
                              </span>
                            )}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
              {report.issues.length === 0 && (
                <li className="py-2 text-[10px] text-muted-2">
                  当前规则都过了：建立镜头、信息与情绪、时长、轴线、切率、尾帧都没有异常。
                </li>
              )}
            </ul>
          </section>

          <p className="mt-4 border-t border-line pt-3 text-[9px] leading-[1.7] text-muted-2">
            当前视频模型：首帧 ✓ · 尾帧 ✗ · 运镜仅提示词 · 单镜 1–8 秒。
          </p>
          <p className="mt-2 text-[9px] leading-[1.7] text-muted-2">
            V3 轴线只看同一场相邻两镜的左右调度，没有 3D 坐标，只说「像」越轴，不标红；V7 拿每拍平均镜长与全片
            对比，查该碎不碎的拍；V9 只查尾帧，运镜本身只作为提示词提交。覆盖率只统计「信息镜头 + 情绪 /
            反应镜头」是否齐全，不评价故事好不好。
          </p>
        </div>
      </aside>
    </div>
  );
}
