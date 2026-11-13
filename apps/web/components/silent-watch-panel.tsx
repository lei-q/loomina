"use client";

import { useEffect, useMemo } from "react";
import type { EditCue, EditView } from "@/lib/edit";
import {
  GAP_MS,
  READ_CPS_COMFORT,
  READ_CPS_HARD,
  SILENT_ISSUE_LABEL,
  silentWatchOfEdit,
} from "@/lib/silent-watch";
import { cn } from "@/lib/utils";

function timecode(ms: number): string {
  const total = Math.max(0, Math.round(ms / 100) / 10);
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export type SilentWatchPanelProps = {
  view: EditView;
  /** 跳到成片里的某一毫秒，并把断句编辑器打开到那一句 */
  onSeekCue?: (cue: EditCue) => void;
  /** 跳到成片里的某一毫秒（断点没有台词，只能跳时间） */
  onSeek?: (ms: number) => void;
  onClose: () => void;
};

/**
 * 静音可懂度检查抽屉（C13 / ADR-0164）。
 *
 * 只查字幕这一侧：读不读得完、停得够不够久、有没有长空档、
 * 指代清不清、一镜里换人有没有标出来。画面里藏了什么、表演读不读得懂
 * 测不了，报告里直接写「未测」，不给假分数。
 */
export function SilentWatchPanel({ view, onSeekCue, onSeek, onClose }: SilentWatchPanelProps) {
  const report = useMemo(() => silentWatchOfEdit(view), [view]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const cueById = useMemo(() => new Map(view.cues.map((cue) => [cue.id, cue])), [view.cues]);

  const jumpToCue = (cueId: string) => {
    const cue = cueById.get(cueId);
    if (!cue) return;
    if (onSeekCue) onSeekCue(cue);
    else onSeek?.(cue.startMs);
  };

  const problems = report.cues.filter((cue) => cue.issue);

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="静音可懂度检查"
        className="flex h-full w-[430px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">静音可懂度</h2>
            <span className="tnum text-[9px] text-muted-2">
              {report.cues.length} 条字幕 · {view.totalSec.toFixed(1)}s
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
              <p className="text-[8.5px] text-muted-2">{report.gradeLabel}</p>
              <p className="tnum mt-0.5 text-[24px] leading-none text-text">
                {report.score}
                <span className="ml-1 text-[10px] text-muted-2">分</span>
              </p>
            </div>
            <div className="text-right text-[9px] leading-[1.6] text-muted-2">
              <p className="tnum">{report.summary.unreadable} 条读不完</p>
              <p className="tnum">{report.summary.gap} 段没字幕</p>
              <p className="tnum">{report.summary.pronoun} 句指代不清</p>
            </div>
          </section>
          <p className="mt-2 break-words text-[10px] leading-[1.7] text-muted">{report.verdict}</p>

          <section className="mt-4">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">读不读得完</h3>
            <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">
              按「可见字数 ÷ 停留秒数」算：超过 {READ_CPS_HARD} 字/秒读不完，
              {READ_CPS_COMFORT} 字/秒以内舒服。下面只列有问题的。
            </p>
            <ul className="mt-1.5 border-t border-line">
              {problems.map((cue) => (
                <li key={cue.cueId} className="border-b border-line py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="tnum text-[9px] text-muted-2">
                      {timecode(cue.startMs)} · SH-{String(cue.shotNo).padStart(2, "0")} ·{" "}
                      {cue.speaker || "旁白"}
                    </span>
                    <span className="flex shrink-0 items-baseline gap-1.5">
                      <span className="text-[8.5px] text-pick">
                        {cue.issue ? SILENT_ISSUE_LABEL[cue.issue] : ""}
                      </span>
                      <span className="tnum text-[9px] text-muted-2">
                        {cue.chars} 字 / {(cue.durationMs / 1000).toFixed(1)}s · {cue.cps}
                      </span>
                    </span>
                  </div>
                  <p className="mt-1 break-words text-[10px] leading-[1.6] text-text">
                    「{cue.text}」
                  </p>
                  <div className="mt-1 flex flex-wrap items-baseline gap-2 text-[9px]">
                    {cue.suggestedChars !== undefined && (
                      <span className="text-muted-2">
                        这段停留最多放得下 {cue.suggestedChars} 字
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => jumpToCue(cue.cueId)}
                      className="text-muted-2 underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
                    >
                      去这一条
                    </button>
                  </div>
                </li>
              ))}
              {problems.length === 0 && (
                <li className="py-2 text-[10px] text-muted-2">
                  每条字幕都读得完：没有超过 {READ_CPS_HARD} 字/秒的，也没有一闪而过的。
                </li>
              )}
            </ul>
          </section>

          <section className="mt-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">信息断点</h3>
              <span className="tnum text-[9px] text-muted-2">{report.gaps.length} 段</span>
            </div>
            <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">
              连续 {GAP_MS / 1000} 秒以上没有字幕：静音时这一段只剩画面，
              观众得靠表演与调度接住。
            </p>
            <ul className="mt-1.5 border-t border-line">
              {report.gaps.map((gap) => (
                <li
                  key={`${gap.startMs}-${gap.durationMs}`}
                  className="flex items-baseline justify-between gap-2 border-b border-line py-2"
                >
                  <span className="tnum text-[10px] text-text">
                    {timecode(gap.startMs)} → {timecode(gap.startMs + gap.durationMs)}
                  </span>
                  <span className="flex items-baseline gap-2 text-[9px] text-muted-2">
                    <span className="tnum">
                      {(gap.durationMs / 1000).toFixed(1)}s · {gap.shots} 镜
                    </span>
                    {onSeek && (
                      <button
                        type="button"
                        onClick={() => onSeek(gap.startMs)}
                        className="underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
                      >
                        去这一段
                      </button>
                    )}
                  </span>
                </li>
              ))}
              {report.gaps.length === 0 && (
                <li className="py-2 text-[10px] text-muted-2">没有长时间的空档。</li>
              )}
            </ul>
          </section>

          <section className="mt-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">指代不清</h3>
              <span className="tnum text-[9px] text-muted-2">{report.pronouns.length} 句</span>
            </div>
            <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">
              以「他 / 这个 / 那个人」开头，而前三条字幕里没出现过任何人名：
              静音时观众不知道说的是谁。
            </p>
            <ul className="mt-1.5 border-t border-line">
              {report.pronouns.map((line) => (
                <li key={line.cueId} className="border-b border-line py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="tnum text-[9px] text-muted-2">
                      SH-{String(line.shotNo).padStart(2, "0")} · 开头是「{line.lead}」
                    </span>
                    <button
                      type="button"
                      onClick={() => jumpToCue(line.cueId)}
                      className="text-[9px] text-muted-2 underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
                    >
                      去这一条
                    </button>
                  </div>
                  <p className="mt-1 break-words text-[10px] leading-[1.6] text-text">
                    「{line.text}」
                  </p>
                </li>
              ))}
              {report.pronouns.length === 0 && (
                <li className="py-2 text-[10px] text-muted-2">
                  没有悬空的指代：每句「他」前面都能找到人。
                </li>
              )}
            </ul>
          </section>

          <section className="mt-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">说话人不清</h3>
              <span className="tnum text-[9px] text-muted-2">{report.speakers.length} 处</span>
            </div>
            <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">
              一镜里两个人先后说话、中间没有切镜：
              {view.subtitleStyle.speakerColors
                ? "现在字幕按角色着色，颜色能帮上忙，所以扣分减半。"
                : "现在字幕是单色的，静音时分不出谁在说。"}
            </p>
            <ul className="mt-1.5 border-t border-line">
              {report.speakers.map((item) => (
                <li
                  key={item.cueId}
                  className="flex items-baseline justify-between gap-2 border-b border-line py-2"
                >
                  <span className="text-[10px] text-text">
                    SH-{String(item.shotNo).padStart(2, "0")} · {item.speakers.join(" → ")}
                  </span>
                  <span className="flex items-baseline gap-2 text-[9px] text-muted-2">
                    <span className="max-w-[150px] truncate">「{item.text}」</span>
                    <button
                      type="button"
                      onClick={() => jumpToCue(item.cueId)}
                      className="underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
                    >
                      去这一条
                    </button>
                  </span>
                </li>
              ))}
              {report.speakers.length === 0 && (
                <li className="py-2 text-[10px] text-muted-2">没有一镜里换人的情况。</li>
              )}
            </ul>
          </section>

          <section className="mt-4">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">字幕覆盖率</h3>
            <div className="mt-1.5 flex items-baseline justify-between gap-2">
              <span className="tnum text-[10px] text-text">
                {Math.round(report.coverage.ratio * 100)}%
              </span>
              <span className="tnum text-[9px] text-muted-2">
                {(report.coverage.subtitleMs / 1000).toFixed(1)}s /{" "}
                {(report.coverage.totalMs / 1000).toFixed(1)}s
              </span>
            </div>
            <span className="mt-1 block h-[3px] w-full overflow-hidden rounded-full bg-line">
              <span
                className={cn(
                  "block h-full rounded-full",
                  report.coverage.low ? "bg-pick" : "bg-muted-2",
                )}
                style={{ width: `${Math.round(report.coverage.ratio * 100)}%` }}
              />
            </span>
            <p className="mt-1.5 text-[9px] leading-[1.65] text-muted-2">
              {report.coverage.low
                ? "有字幕的时间不到成片的 20%：静音时大半时间只有画面。"
                : "有字幕的时间占成片的比例；成片短于 30 秒时不判偏低。"}
            </p>
          </section>

          <p className="mt-4 border-t border-line pt-3 text-[9px] leading-[1.7] text-muted-2">
            {report.untested}
            报告全部从当前时间线与断句算出，不写 IR、不调模型、不花钱。
          </p>
        </div>
      </aside>
    </div>
  );
}
