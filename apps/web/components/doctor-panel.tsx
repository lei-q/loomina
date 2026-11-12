"use client";

import { useEffect, useMemo, useState } from "react";
import type { Project } from "@loomina/ir";
import { doctorSnapshotOf, type DoctorRewrite, type DoctorRewriteItem } from "@/lib/doctor-ai";
import { toScriptView } from "@/lib/read-model";
import {
  DOCTOR_MODE_LABEL,
  analyzeScript,
  type DoctorDimension,
  type DoctorMode,
  type DoctorSuggestion,
} from "@/lib/script-doctor";
import { cn } from "@/lib/utils";

const SOURCE_LABEL: Record<DoctorDimension["source"], string> = {
  local: "本地",
  model: "模型未测",
  unmeasured: "未测",
};

function ScoreBar({ score }: { score: number | null }) {
  return (
    <span className="block h-[3px] w-full overflow-hidden rounded-full bg-line">
      <span
        className={cn(
          "block h-full rounded-full",
          score === null ? "bg-transparent" : score >= 3 ? "bg-muted-2" : "bg-pick",
        )}
        style={{ width: score === null ? "0%" : `${(score / 5) * 100}%` }}
      />
    </span>
  );
}

function shotLabel(no: number): string {
  return `SH-${String(no).padStart(2, "0")}`;
}

export type DoctorPanelProps = {
  project: Project;
  /** 点建议里的镜号跳到那一镜；不传就不显示跳转 */
  onSelectShot?: (shotId: string) => void;
  /** 采用一条模型改写；不传就不显示「采用」 */
  onAdopt?: (item: DoctorRewriteItem) => boolean;
  readOnly?: boolean;
  onClose: () => void;
};

function itemKey(item: DoctorRewriteItem): string {
  if (item.kind === "dialogue") return `d:${item.lineId}`;
  if (item.kind === "shot") return `s:${item.shotId}`;
  return `t:${item.field}`;
}

/**
 * 剧本医生抽屉（A18 / ADR-0123）。
 *
 * 第一档是本地报告；第二档是模型改写：作者点一个模式才调用，建议不进 IR，
 * 点「采用」才走 `dialogue.updated` / `shot.updated` / `story.updated`。
 * 每次打开现算，改一个字就变。
 */
export function DoctorPanel({
  project,
  onSelectShot,
  onAdopt,
  readOnly = false,
  onClose,
}: DoctorPanelProps) {
  const report = useMemo(() => analyzeScript(project), [project]);
  /** 正在让模型读哪个模式；一次只发一个请求 */
  const [busyMode, setBusyMode] = useState<DoctorMode>();
  const [rewrite, setRewrite] = useState<DoctorRewrite>();
  const [modelError, setModelError] = useState<string>();
  const [adopted, setAdopted] = useState<Set<string>>(() => new Set());
  const [adoptNote, setAdoptNote] = useState<string>();

  /** 第二档（A18）：点一个模式才调用模型；建议不进 IR */
  const askModel = async (mode: DoctorMode) => {
    if (busyMode || readOnly) return;
    setBusyMode(mode);
    setModelError(undefined);
    setAdoptNote(undefined);
    try {
      const snapshot = doctorSnapshotOf(project, toScriptView(project), report, mode);
      const response = await fetch("/api/doctor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshot }),
      });
      const payload = (await response.json().catch(() => null)) as
        | DoctorRewrite
        | { error?: string }
        | null;
      if (!response.ok) {
        const error = payload && "error" in payload ? payload.error : undefined;
        setModelError(error ?? `模型没回话（${response.status}）。`);
        return;
      }
      setRewrite(payload as DoctorRewrite);
    } catch {
      setModelError("没连上服务端：检查开发服务器，或稍后再点。");
    } finally {
      setBusyMode(undefined);
    }
  };

  const adopt = (item: DoctorRewriteItem) => {
    if (!onAdopt || readOnly) return;
    const key = itemKey(item);
    const ok = onAdopt(item);
    if (ok) {
      setAdopted((current) => new Set(current).add(key));
      setAdoptNote("已按这条改写写进剧本。");
    } else {
      setAdoptNote("没写进去：这一镜可能锁着，或原文就是这一版。");
    }
  };

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
        aria-label="剧本医生"
        className="flex h-full w-[400px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">剧本医生</h2>
            <span className="tnum text-[9px] text-muted-2">
              已测 {report.measured} / {report.total}
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
          <section className="flex items-end justify-between gap-3 border border-line px-3 py-2.5">
            <div>
              <p className="text-[8.5px] text-muted-2">总分（已测维度均值）</p>
              <p className="tnum mt-0.5 text-[22px] leading-none text-text">
                {report.overall === null ? "—" : report.overall.toFixed(1)}
                <span className="ml-1 text-[10px] text-muted-2">/ 5</span>
              </p>
            </div>
            <div className="text-right text-[9px] leading-[1.6] text-muted-2">
              <p
                className={cn(
                  "text-[10.5px]",
                  report.summary.verdict === "偏低"
                    ? "text-pick"
                    : report.summary.verdict === "未测"
                      ? "text-muted-2"
                      : "text-muted",
                )}
              >
                {report.summary.verdict}
              </p>
              <p className="tnum">
                {report.summary.warn} 项偏低 · {report.summary.info} 项提示
              </p>
              <p className="tnum">{report.seconds.toFixed(1)}s</p>
            </div>
          </section>

          <section className="mt-4">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">十二维</h3>
            <ul className="mt-1.5 border-t border-line">
              {report.dims.map((dim) => (
                <li key={dim.key} className="border-b border-line py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[10px] text-text">{dim.label}</span>
                    <span className="flex shrink-0 items-baseline gap-1.5">
                      <span
                        className={cn(
                          "tnum text-[8.5px]",
                          dim.source === "local" ? "text-muted-2" : "text-muted-2/70",
                        )}
                      >
                        {SOURCE_LABEL[dim.source]}
                      </span>
                      <span
                        className={cn(
                          "tnum text-[10.5px]",
                          dim.score === null
                            ? "text-muted-2"
                            : dim.score >= 3
                              ? "text-text"
                              : "text-pick",
                        )}
                      >
                        {dim.score === null ? "—" : dim.score}
                      </span>
                    </span>
                  </div>
                  <div className="mt-1">
                    <ScoreBar score={dim.score} />
                  </div>
                  <p className="mt-1 break-words text-[9px] leading-[1.65] text-muted-2">
                    {dim.reason}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">发现</h3>
              <span className="tnum text-[9px] text-muted-2">{report.findings.length} 条</span>
            </div>
            <ul className="mt-1.5 border-t border-line">
              {report.findings.map((finding) => (
                <li key={`${finding.key}-${finding.shotIds.join()}`} className="border-b border-line py-2">
                  <div className="flex items-start gap-2">
                    <span
                      className={cn(
                        "tnum shrink-0 pt-px text-[8.5px] tracking-[.06em]",
                        finding.severity === "warn" ? "text-pick" : "text-muted-2",
                      )}
                    >
                      {finding.severity === "warn" ? "偏低" : "提示"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[9.5px] leading-[1.65] text-muted">{finding.message}</p>
                      {finding.shotIds.length > 0 && onSelectShot && (
                        <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[9px]">
                          {finding.shotIds.slice(0, 6).map((shotId) => {
                            const no = report.shotNos[shotId];
                            return (
                              <button
                                key={shotId}
                                type="button"
                                onClick={() => onSelectShot(shotId)}
                                className="text-muted-2 underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
                              >
                                {no ? shotLabel(no) : "这一镜"}
                              </button>
                            );
                          })}
                          {finding.shotIds.length > 6 && (
                            <span className="tnum text-[8.5px] text-muted-2">
                              共 {finding.shotIds.length} 镜
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
              {report.findings.length === 0 && (
                <li className="py-2 text-[10px] text-muted-2">
                  当前检查项都过了：钩子、密度、反转、台词、结尾与可拍性没有偏低项。
                </li>
              )}
            </ul>
          </section>

          <section className="mt-4">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">改写方向</h3>
            <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">
              六种模式只给方向，不替你写字。改写是创作决定：看准了再去剧本页改。
            </p>
            <ul className="mt-1.5 border-t border-line">
              {report.suggestions.map((suggestion) => (
                <SuggestionRow
                  key={suggestion.mode}
                  suggestion={suggestion}
                  onSelectShot={onSelectShot}
                />
              ))}
            </ul>
          </section>

          <section className="mt-4">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">让模型改一版</h3>
            <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">
              点一个模式，模型最多给三条能直接替换原文的改写；点「采用」才写进项目。
              减人物 / 减场景只给合并与改写，不会替你删角色或场次。
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {report.suggestions.map((suggestion) => (
                <button
                  key={suggestion.mode}
                  type="button"
                  disabled={readOnly || Boolean(busyMode)}
                  onClick={() => void askModel(suggestion.mode)}
                  className={cn(
                    "rounded-token border px-2 py-0.5 text-[9px] transition-colors duration-[var(--dur)] disabled:opacity-40",
                    busyMode === suggestion.mode
                      ? "border-pick text-pick"
                      : "border-line text-muted enabled:hover:border-line-2 enabled:hover:text-text",
                  )}
                >
                  {busyMode === suggestion.mode
                    ? `${DOCTOR_MODE_LABEL[suggestion.mode]} · 读剧本中…`
                    : DOCTOR_MODE_LABEL[suggestion.mode]}
                </button>
              ))}
            </div>
            {modelError && (
              <p className="mt-2 text-[9px] leading-[1.65] text-pick">{modelError}</p>
            )}
            {rewrite && (
              <div className="mt-2 border-t border-line pt-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[9.5px] text-text">
                    {DOCTOR_MODE_LABEL[rewrite.mode]} · {rewrite.items.length} 条
                  </span>
                  <span className="text-[8.5px] text-muted-2">
                    {rewrite.model}
                  </span>
                </div>
                {rewrite.reason && (
                  <p className="mt-0.5 text-[9px] leading-[1.65] text-muted-2">
                    {rewrite.reason}
                  </p>
                )}
                <ul className="mt-1 divide-y divide-line">
                  {rewrite.items.map((item) => {
                    const key = itemKey(item);
                    const done = adopted.has(key);
                    return (
                      <li key={key} className="py-2">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[9px] text-muted-2">{item.target}</span>
                          <button
                            type="button"
                            disabled={readOnly || done || !onAdopt}
                            onClick={() => adopt(item)}
                            className="shrink-0 rounded-token border border-line px-1.5 py-0.5 text-[8.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
                          >
                            {done ? "已采用" : "采用"}
                          </button>
                        </div>
                        <p className="mt-1 break-words text-[9.5px] leading-[1.65] text-text">
                          {item.text}
                        </p>
                        {item.why && (
                          <p className="mt-0.5 break-words text-[9px] leading-[1.65] text-muted-2">
                            {item.why}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {adoptNote && (
                  <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">{adoptNote}</p>
                )}
              </div>
            )}
          </section>

          <p className="mt-4 border-t border-line pt-3 text-[9px] leading-[1.7] text-muted-2">
            分数是本机按词法与结构估的，不是模型评审：它只回答「结构上像不像」，回答不了「这个故事好不好」。
            情绪兑现要模型判断、原创性等 A8 的相似度检查，这两项如实写「未测」，不填 0 分。
            报告不存进项目：改一句台词，重开这里就会变。
          </p>
        </div>
      </aside>
    </div>
  );
}

function SuggestionRow({
  suggestion,
  onSelectShot,
}: {
  suggestion: DoctorSuggestion;
  onSelectShot?: (shotId: string) => void;
}) {
  return (
    <li className="border-b border-line py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] text-text">{DOCTOR_MODE_LABEL[suggestion.mode]}</span>
        <span
          className={cn(
            "shrink-0 text-[8.5px]",
            suggestion.applicable ? "text-muted" : "text-muted-2",
          )}
        >
          {suggestion.applicable ? "用得上" : "现在不用"}
        </span>
      </div>
      <p className="mt-0.5 break-words text-[9px] text-muted-2">{suggestion.target}</p>
      <p className="mt-1 break-words text-[9.5px] leading-[1.65] text-muted">
        {suggestion.direction}
      </p>
      {onSelectShot && suggestion.shotIds.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[9px]">
          {suggestion.shotIds.slice(0, 4).map((shotId) => (
            <button
              key={shotId}
              type="button"
              onClick={() => onSelectShot(shotId)}
              className="text-muted-2 underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
            >
              去这一镜
            </button>
          ))}
        </p>
      )}
    </li>
  );
}
