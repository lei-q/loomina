"use client";

import { useMemo, useState } from "react";
import {
  genreById,
  LOGLINE_DIMENSIONS,
  LOGLINE_MAX_CANDIDATES,
  LOGLINE_PASS,
  LOGLINE_STRONG,
  scoreLogline,
  scoreLoglines,
  type LoglineScore,
} from "@loomina/pipeline";

const VERDICT_STYLE: Record<LoglineScore["verdict"], string> = {
  淘汰: "border-pick text-pick",
  保留: "border-line-2 text-muted",
  优先: "border-line-2 text-text",
};

function ScoreBars({ score, weak }: { score: number; weak: boolean }) {
  return (
    <span className="flex items-center gap-[3px]" aria-hidden>
      {[1, 2, 3, 4, 5].map((step) => (
        <span
          key={step}
          className={
            step <= score
              ? `h-2 w-3 rounded-[1px] ${weak ? "bg-pick" : "bg-text"}`
              : "h-2 w-3 rounded-[1px] border border-line bg-transparent"
          }
        />
      ))}
    </span>
  );
}

export function LoglineScoreCard({
  text,
  genreId,
  title = "logline 体检",
}: {
  text: string;
  genreId: string;
  title?: string;
}) {
  const score = useMemo(
    () => scoreLogline(text, genreById(genreId)),
    [text, genreId],
  );
  return (
    <div className="rounded-token border border-line bg-surface p-3.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <h3 className="text-[10px] tracking-[.12em] text-muted-2">{title}</h3>
        <span className="tnum text-[15px] leading-none text-text">{score.total}</span>
        <span className="text-[9px] text-muted-2">/ 30</span>
        <span
          className={`rounded-token border px-1.5 py-0.5 text-[9.5px] ${VERDICT_STYLE[score.verdict]}`}
        >
          {score.verdict}
        </span>
        <span className="ml-auto text-[9px] leading-[1.6] text-muted-2">
          低于 {LOGLINE_PASS} 淘汰 · {LOGLINE_STRONG} 以上优先
        </span>
      </div>

      <ul className="mt-3 space-y-2">
        {score.dims.map((dim) => (
          <li key={dim.key} className="grid gap-1 sm:grid-cols-[72px_86px_1fr] sm:items-baseline sm:gap-3">
            <span className="text-[10.5px] text-muted">{dim.label}</span>
            <span className="flex items-center gap-2">
              <ScoreBars score={dim.score} weak={dim.score < 3} />
              <span className="tnum text-[9px] text-muted-2">{dim.score}/5</span>
            </span>
            <span className="text-[10px] leading-[1.65] text-muted-2">{dim.reason}</span>
          </li>
        ))}
      </ul>

      <p className="mt-3 border-t border-line pt-2.5 text-[9.5px] leading-[1.65] text-muted-2">
        {score.weak.length === 0
          ? "六维都在 3 分以上：可以拿去开工。"
          : `先改：${score.weak.map((dim) => dim.label).join("、")}。评分按词法与结构本地计算，不是模型评审，最终仍由你拍板。`}
      </p>
    </div>
  );
}

export function LoglineWorkshop({ genreId }: { genreId: string }) {
  const [raw, setRaw] = useState("");
  const [scored, setScored] = useState<LoglineScore[]>();

  function run() {
    const scores = scoreLoglines(raw, genreById(genreId))
      .slice()
      .sort((a, b) => b.total - a.total);
    setScored(scores);
  }

  return (
    <details className="mt-3 rounded-token border border-line bg-bg px-3 py-2">
      <summary className="cursor-pointer text-[10px] leading-[1.7] text-muted">
        logline 工坊 · 一行一个候选，最多 10 条，本地打分
      </summary>
      <div className="mt-2.5">
        <textarea
          value={raw}
          onChange={(event) => {
            setRaw(event.target.value);
            setScored(undefined);
          }}
          rows={4}
          placeholder={"外卖员想要证明父亲没偷公司机密，却被董事长当众开除。\n离婚当天，她捡到了前夫失忆的弟弟。"}
          className="w-full resize-y rounded-token border border-line bg-surface px-2.5 py-2 text-[11px] leading-[1.8] text-text placeholder:text-muted-2 focus:border-line-2 focus:outline-none"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[9px] text-muted-2">
            一行一个候选，前 {LOGLINE_MAX_CANDIDATES} 行参与打分；分数只在本机算。
          </span>
          <button
            type="button"
            onClick={run}
            disabled={raw.trim().length === 0}
            className="rounded-token border border-line-2 px-3 py-1 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-text disabled:cursor-not-allowed disabled:border-line disabled:text-muted-2"
          >
            打分
          </button>
        </div>

        {scored && (
          <ol className="mt-3 divide-y divide-line border-t border-line">
            {scored.length === 0 ? (
              <li className="py-2 text-[10px] text-muted-2">没有可打分的候选。</li>
            ) : (
              scored.map((candidate, index) => (
                <li key={`${candidate.text}-${index}`} className="py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="tnum w-4 text-[9px] text-muted-2">{index + 1}</span>
                    <span className="tnum text-[12px] text-text">{candidate.total}</span>
                    <span
                      className={`rounded-token border px-1 py-0.5 text-[9px] ${VERDICT_STYLE[candidate.verdict]}`}
                    >
                      {candidate.verdict}
                    </span>
                    {candidate.weak.length > 0 && (
                      <span className="text-[9px] text-muted-2">
                        弱：{candidate.weak.map((dim) => dim.label).join("、")}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 pl-6 text-[10.5px] leading-[1.7] text-muted">{candidate.text}</p>
                </li>
              ))
            )}
          </ol>
        )}

        <p className="mt-2 text-[9px] leading-[1.6] text-muted-2">
          {LOGLINE_DIMENSIONS.map((dim) => `${dim.label}：${dim.question}`).join("　")}
        </p>
      </div>
    </details>
  );
}
