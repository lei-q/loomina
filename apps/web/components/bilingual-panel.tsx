"use client";

import { useEffect, useMemo, useState } from "react";
import type { EditView } from "@/lib/edit";
import { cn } from "@/lib/utils";

export type BilingualPanelProps = {
  view: EditView;
  /** 写一句的译文；`null` 清掉。返回是否真的写进去了 */
  onTranslate: (lineId: string, translation: string | null) => boolean;
  /** 双语开关：开不开、第二行语言、第二行位置 */
  onSwitch: (patch: {
    enabled?: boolean;
    lang?: string;
    position?: "below" | "above";
  }) => boolean;
  /** 跳到某一毫秒（按句头时间） */
  onSeek?: (ms: number) => void;
  readOnly?: boolean;
  onClose: () => void;
};

const LANGS = [
  { id: "en", label: "英语" },
  { id: "ja", label: "日语" },
  { id: "ko", label: "韩语" },
  { id: "es", label: "西语" },
  { id: "th", label: "泰语" },
];

function timecode(ms: number): string {
  const total = Math.max(0, Math.round(ms / 100) / 10);
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/**
 * 双语字幕（D5 / ADR-0173）。
 *
 * 译文属于某一句话，不属于版式：这里逐句写第二行，版式只决定第二行在
 * 上面还是下面、叫什么语言。没翻的句子照实标出来，不拿原文凑数——
 * 双语的目的是让看不懂中文的人看懂，把中文再放一遍是假的双语。
 *
 * 不调翻译模型：这一版只做「写、改、清」与三种导出（SRT / ASS / 成片）。
 * 自动翻译与字幕时间轴对齐留给后续（见 ADR-0173 的「不做」）。
 */
export function BilingualPanel({
  view,
  onTranslate,
  onSwitch,
  onSeek,
  readOnly,
  onClose,
}: BilingualPanelProps) {
  const { translation, translationCoverage } = view;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [lang, setLang] = useState(translation.lang);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 句子按时间线顺序；译文的显示值优先取正在编辑的草稿
  const lines = useMemo(
    () =>
      view.clips.flatMap((clip) =>
        clip.lines.map((line) => ({
          id: line.id,
          text: line.text,
          translation: line.translation ?? "",
          startMs: line.cueStartMs,
          shotNo: clip.shotNo,
          characterName: line.characterName,
        })),
      ),
    [view.clips],
  );

  const valueOf = (id: string, saved: string) => draft[id] ?? saved;
  const dirty = (id: string, saved: string) => (draft[id] ?? saved) !== saved;

  const save = (id: string, saved: string) => {
    if (readOnly) return;
    const next = valueOf(id, saved);
    if (next.trim() === saved.trim()) return;
    const ok = onTranslate(id, next.trim() || null);
    setNotice(
      ok
        ? next.trim()
          ? "译文已写进项目：双语开着时，SRT、ASS、预览与成片都带第二行。"
          : "已清掉这一句的译文：导出时这一句只出原文。"
        : "和项目里的一样，没有要写的。",
    );
    if (ok) {
      setDraft((prev) => {
        const { [id]: _drop, ...rest } = prev;
        return rest;
      });
    }
  };

  const missing = lines.filter((line) => !line.translation.trim());

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="双语字幕"
        className="flex h-full w-[470px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">双语字幕</h2>
            <span className="tnum text-[9px] text-muted-2">
              {translationCoverage.translated} / {translationCoverage.lines} 句有译文
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
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={translation.enabled}
              disabled={readOnly}
              onClick={() => {
                const next = !translation.enabled;
                const ok = onSwitch({ enabled: next });
                if (ok) {
                  setNotice(
                    next
                      ? "双语已打开：有译文的句子在预览、SRT、ASS 与成片里都出两行。"
                      : "双语已关掉：导出回到一行原文，译文还留着，随时能再开。",
                  );
                }
              }}
              className={cn(
                "rounded-token border px-2.5 py-1 text-[10px] transition-colors duration-[var(--dur)] disabled:opacity-40",
                translation.enabled
                  ? "border-pick bg-pick/15 text-text"
                  : "border-line text-muted hover:border-line-2 hover:text-text",
              )}
            >
              {translation.enabled ? "双语：开" : "双语：关"}
            </button>

            <label className="flex items-center gap-1.5 text-[9.5px] text-muted-2">
              第二行
              <select
                value={lang}
                disabled={readOnly}
                onChange={(event) => {
                  const next = event.target.value;
                  setLang(next);
                  const ok = onSwitch({ lang: next });
                  if (ok) setNotice(`第二行改成「${next}」：只改导出注释与界面上的说法，不改译文。`);
                }}
                className="rounded-token border border-line bg-bg px-1.5 py-0.5 text-[10px] text-text focus:border-line-2 focus:outline-none disabled:opacity-40"
              >
                {LANGS.map((item) => (
                  <option key={item.id} value={item.id} className="bg-surface">
                    {item.label}（{item.id}）
                  </option>
                ))}
                {!LANGS.some((item) => item.id === translation.lang) && (
                  <option value={translation.lang} className="bg-surface">
                    {translation.lang}
                  </option>
                )}
              </select>
            </label>

            <div className="flex items-center gap-1">
              {(["below", "above"] as const).map((position) => (
                <button
                  key={position}
                  type="button"
                  disabled={readOnly}
                  onClick={() => {
                    const ok = onSwitch({ position });
                    if (ok) {
                      setNotice(
                        position === "below"
                          ? "第二行放在原文下面。"
                          : "第二行放在原文上面。",
                      );
                    }
                  }}
                  className={cn(
                    "rounded-token border px-2 py-0.5 text-[9.5px] transition-colors duration-[var(--dur)] disabled:opacity-40",
                    translation.position === position
                      ? "border-line-2 bg-text/10 text-text"
                      : "border-line text-muted hover:border-line-2 hover:text-text",
                  )}
                >
                  {position === "below" ? "在下面" : "在上面"}
                </button>
              ))}
            </div>
          </div>

          {notice && (
            <p className="mt-2 rounded-token border border-line bg-surface/60 px-2 py-1.5 text-[9.5px] leading-[1.6] text-muted">
              {notice}
            </p>
          )}

          {translation.enabled && missing.length > 0 && (
            <p className="mt-2 text-[9px] leading-[1.65] text-muted-2">
              还有 {missing.length} 句没译文：导出时这些句子只出原文，不会拿中文再放一遍。
            </p>
          )}

          <ul className="mt-3 border-t border-line">
            {lines.length === 0 && (
              <li className="py-3 text-[9.5px] leading-[1.7] text-muted-2">
                时间线里还没有台词：先加台词，才有第二行可写。
              </li>
            )}
            {lines.map((line) => {
              const value = valueOf(line.id, line.translation);
              const edited = dirty(line.id, line.translation);
              return (
                <li key={line.id} className="border-b border-line py-2.5">
                  <div className="flex flex-wrap items-baseline gap-2 text-[9px] text-muted-2">
                    <button
                      type="button"
                      onClick={() => onSeek?.(line.startMs)}
                      className="tnum text-muted underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
                      title="跳到这一句"
                    >
                      {timecode(line.startMs)}
                    </button>
                    <span>
                      SH-{String(line.shotNo).padStart(2, "0")} · {line.characterName}
                    </span>
                    {!line.translation.trim() && (
                      <span className="text-pick">没译文</span>
                    )}
                  </div>
                  <p className="mt-1 text-[10px] leading-[1.6] text-text">{line.text}</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <input
                      value={value}
                      disabled={readOnly}
                      onChange={(event) =>
                        setDraft((prev) => ({ ...prev, [line.id]: event.target.value }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") save(line.id, line.translation);
                      }}
                      placeholder={`第二行（${translation.lang}）`}
                      maxLength={400}
                      className="min-w-0 flex-1 rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text placeholder:text-muted-2/70 focus:border-line-2 focus:outline-none disabled:opacity-40"
                    />
                    <button
                      type="button"
                      disabled={readOnly || !edited}
                      onClick={() => save(line.id, line.translation)}
                      className="shrink-0 rounded-token border border-line-2 bg-text/10 px-2 py-0.5 text-[9.5px] text-text transition-colors duration-[var(--dur)] hover:bg-text/20 disabled:opacity-40"
                    >
                      保存
                    </button>
                    {line.translation.trim() && (
                      <button
                        type="button"
                        disabled={readOnly}
                        onClick={() => {
                          const ok = onTranslate(line.id, null);
                          if (ok) {
                            setDraft((prev) => {
                              const { [line.id]: _drop, ...rest } = prev;
                              return rest;
                            });
                            setNotice("已清掉这一句的译文：导出时这一句只出原文。");
                          }
                        }}
                        className="shrink-0 rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
                      >
                        清掉
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <p className="mt-4 border-t border-line pt-3 text-[9px] leading-[1.7] text-muted-2">
            译文跟着那一句台词走：改断句、挪字幕都不会丢。双语关掉时译文留着，
            导出回到一行原文。这里不调翻译模型——第二行是你写的；自动翻译与
            配音对齐还没做。
          </p>
        </div>
      </aside>
    </div>
  );
}
