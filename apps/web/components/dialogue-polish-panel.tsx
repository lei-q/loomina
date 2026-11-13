"use client";

import { useMemo } from "react";
import type { Project } from "@loomina/ir";
import { toScriptView } from "@/lib/read-model";
import {
  MAX_LINE_CHARS,
  MAX_LINES_PER_SHOT,
  POLISH_ISSUE_LABEL,
  polishDialogue,
  type PolishLineInput,
} from "@/lib/dialogue-polish";
import { cn } from "@/lib/utils";

/**
 * 台词压缩与金句抽屉（A20 / ADR-0163）。
 *
 * 三个区：要压的句子（给建议文本，点「用这版」走 `editDialogue`）、
 * 金句候选（只标出来，不改）、一镜多句（给拆或删的方向）。
 * 建议不进 IR：抽屉关掉就没了，采用才写一条 `dialogue.updated`。
 */
export type DialoguePolishPanelProps = {
  project: Project;
  /** 采用一句建议；返回是否写进去了 */
  onAdopt: (lineId: string, text: string) => boolean;
  /** 跳到剧本页的那一镜；不传就不显示 */
  onSelectShot?: (shotId: string) => void;
  readOnly?: boolean;
  onClose: () => void;
};

export function DialoguePolishPanel({
  project,
  onAdopt,
  onSelectShot,
  readOnly = false,
  onClose,
}: DialoguePolishPanelProps) {
  const report = useMemo(() => {
    const view = toScriptView(project);
    const input: PolishLineInput[] = [];
    for (const scene of view.scenes) {
      for (const shot of scene.shots) {
        for (const line of shot.lines) {
          input.push({
            lineId: line.id,
            shotId: shot.id,
            shotNo: shot.no,
            speaker: line.character,
            text: line.text,
          });
        }
      }
    }
    return polishDialogue(input);
  }, [project]);

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="台词压缩与金句"
        className="flex h-full w-[420px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">台词压缩</h2>
            <span className="tnum text-[9px] text-muted-2">
              {report.totalLines} 句 · 平均 {report.averageChars.toFixed(1)} 字
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
              <p className="text-[8.5px] text-muted-2">压完能省</p>
              <p className="tnum mt-0.5 text-[22px] leading-none text-text">
                {report.savedChars}
                <span className="ml-1 text-[10px] text-muted-2">字</span>
              </p>
            </div>
            <div className="text-right text-[9px] leading-[1.6] text-muted-2">
              <p className="tnum">{report.problems.length} 句要改</p>
              <p className="tnum">{report.punches.length} 句金句候选</p>
              <p className="tnum">
                {report.shots.filter((shot) => shot.issue === "crowded").length} 镜两句以上
              </p>
            </div>
          </section>

          <section className="mt-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">要压的句子</h3>
              <span className="tnum text-[9px] text-muted-2">{report.problems.length} 条</span>
            </div>
            <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">
              单句上限 {MAX_LINE_CHARS} 字。建议只做「删」：删填充词、删解释从句、留最后半句；
              压不进去时不硬截断，只给方向。
            </p>
            <ul className="mt-1.5 border-t border-line">
              {report.problems.map((line) => (
                <li key={line.lineId} className="border-b border-line py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="tnum text-[9px] text-muted-2">
                      SH-{String(line.shotNo).padStart(2, "0")} · {line.speaker}
                    </span>
                    <span className="flex shrink-0 items-baseline gap-1.5">
                      {line.issues.map((issue) => (
                        <span key={issue} className="text-[8.5px] text-pick">
                          {POLISH_ISSUE_LABEL[issue]}
                        </span>
                      ))}
                      <span className="tnum text-[9px] text-muted-2">{line.chars} 字</span>
                    </span>
                  </div>
                  <p className="mt-1 break-words text-[10px] leading-[1.6] text-muted">
                    「{line.text}」
                  </p>
                  {line.suggestion && (
                    <p className="mt-1 break-words text-[10px] leading-[1.6] text-text">
                      建议：「{line.suggestion}」
                      <span className="tnum ml-1 text-[8.5px] text-muted-2">
                        {line.chars} → {[...line.suggestion].length} 字
                      </span>
                    </p>
                  )}
                  <p className="mt-0.5 break-words text-[9px] leading-[1.65] text-muted-2">
                    {line.reason}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[9px]">
                    {line.suggestion && (
                      <button
                        type="button"
                        disabled={readOnly}
                        onClick={() => onAdopt(line.lineId, line.suggestion!)}
                        className="rounded-token border border-line px-1.5 py-0.5 text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
                      >
                        用这版
                      </button>
                    )}
                    {onSelectShot && (
                      <button
                        type="button"
                        onClick={() => onSelectShot(line.shotId)}
                        className="text-muted-2 underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
                      >
                        去这一镜
                      </button>
                    )}
                  </div>
                </li>
              ))}
              {report.problems.length === 0 && (
                <li className="py-2 text-[10px] text-muted-2">
                  没有要压的句子：都在 {MAX_LINE_CHARS} 字以内，也没有填充词。
                </li>
              )}
            </ul>
          </section>

          <section className="mt-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">金句候选</h3>
              <span className="tnum text-[9px] text-muted-2">{report.punches.length} 句</span>
            </div>
            <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">
              只按「短、有落点词、没有废话」打分：分数高说明它像一句能被记住的短台词，
              不说明它写得好。这里不改字。
            </p>
            <ul className="mt-1.5 border-t border-line">
              {report.punches.slice(0, 8).map((line) => (
                <li key={line.lineId} className="border-b border-line py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="tnum text-[9px] text-muted-2">
                      SH-{String(line.shotNo).padStart(2, "0")} · {line.speaker}
                    </span>
                    <span className="tnum text-[10.5px] text-text">{line.punch}</span>
                  </div>
                  <p className="mt-0.5 break-words text-[10px] leading-[1.6] text-text">
                    「{line.text}」
                  </p>
                  <p className="mt-0.5 text-[9px] leading-[1.6] text-muted-2">
                    {line.punchNotes.slice(0, 3).join(" ")}
                  </p>
                </li>
              ))}
              {report.punches.length === 0 && (
                <li className="py-2 text-[10px] text-muted-2">
                  还没有够短、够响的句子：先把要压的那几句改短。
                </li>
              )}
            </ul>
          </section>

          <section className="mt-4">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">一镜多句</h3>
            <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">
              一镜最多 {MAX_LINES_PER_SHOT} 句。多出来的要么拆成两镜，要么删一句——
              工具不会替你删，删台词会牵动镜头时长与已出的配音。
            </p>
            <ul className="mt-1.5 border-t border-line">
              {report.shots
                .filter((shot) => shot.issue === "crowded")
                .map((shot) => (
                  <li
                    key={shot.shotId}
                    className="flex items-baseline justify-between gap-2 border-b border-line py-2"
                  >
                    <span className="tnum text-[10px] text-text">
                      SH-{String(shot.shotNo).padStart(2, "0")}
                    </span>
                    <span className="flex items-baseline gap-2 text-[9px]">
                      <span className="tnum text-muted-2">{shot.lines} 句</span>
                      {onSelectShot && (
                        <button
                          type="button"
                          onClick={() => onSelectShot(shot.shotId)}
                          className={cn(
                            "text-muted-2 underline decoration-line-2 underline-offset-2",
                            "transition-colors duration-[var(--dur)] hover:text-text",
                          )}
                        >
                          去这一镜
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              {report.shots.every((shot) => shot.issue !== "crowded") && (
                <li className="py-2 text-[10px] text-muted-2">
                  没有一镜塞两句以上。
                </li>
              )}
            </ul>
          </section>

          <p className="mt-4 border-t border-line pt-3 text-[9px] leading-[1.7] text-muted-2">
            规则只看字数、填充词与解释词，读不懂语境：一句「其实」有时是人物性格，不是废话。
            建议只在你点「用这版」时写进项目，一条建议一条 `dialogue.updated`，时长按新字数重估。
          </p>
        </div>
      </aside>
    </div>
  );
}
