"use client";

import { useEffect, useMemo, useState } from "react";
import type { VoicePerformance, VoiceTake } from "@loomina/ir";
import {
  DEFAULT_PERFORMANCE,
  ENDING_LABEL,
  emphasisText,
  inputOf,
  isDefaultPerformance,
  summarizePerformance,
} from "@/lib/voice-performance";
import type { VoiceLine } from "@/lib/read-model";
import { cn } from "@/lib/utils";

export type VoicePerformancePanelProps = {
  line: VoiceLine;
  /** 这一句在试听台里的版本（新的在前） */
  takes: VoiceTake[];
  /** 当前采用的资产 id：用来标「正在用」 */
  adoptedAssetId?: string;
  readOnly: boolean;
  /** 供应商可能不支持这些参数：界面上如实说明 */
  canSpeak: boolean;
  onSave: (performance: VoicePerformance | undefined) => boolean;
  onGenerateTake: () => void;
  onAdoptTake: (takeId: string) => void;
  onRemoveTake: (takeId: string) => void;
};

function fieldClass(disabled: boolean): string {
  return cn(
    "rounded-token border border-line bg-transparent px-1.5 py-0.5 text-[10px] text-text focus:border-line-2 focus:outline-none",
    disabled && "cursor-not-allowed opacity-45",
  );
}

/**
 * 逐句表演参数与试听台（C2 / C9 / ADR-0124）。
 *
 * 参数写 `dialogue.updated { performance }`，与文本编辑共用同一套历史与回退。
 * 重音用「选中文本」加，不让作者填下标；停顿同理。
 * 供应商是否真的支持其中几项没有验证过，所以这里明写「可能不支持」。
 */
export function VoicePerformancePanel({
  line,
  takes,
  adoptedAssetId,
  readOnly,
  canSpeak,
  onSave,
  onGenerateTake,
  onAdoptTake,
  onRemoveTake,
}: VoicePerformancePanelProps) {
  const [draft, setDraft] = useState<VoicePerformance>(line.performance ?? DEFAULT_PERFORMANCE);
  const [notice, setNotice] = useState("");
  const [selection, setSelection] = useState<{ start: number; end: number }>();

  // 外部改了参数（撤销 / 回放）时跟上
  useEffect(() => {
    setDraft(line.performance ?? DEFAULT_PERFORMANCE);
    setNotice("");
    setSelection(undefined);
  }, [line.id, line.performance]);

  const chars = useMemo(() => [...line.text], [line.text]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(line.performance ?? DEFAULT_PERFORMANCE);

  const patch = (next: Partial<VoicePerformance>) => {
    setNotice("");
    setDraft((current) => ({ ...current, ...next }));
  };

  const captureSelection = () => {
    const element = document.getElementById(`perf-text-${line.id}`);
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return;
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? 0;
    if (end <= start) {
      setNotice("先在句子文本里选中要重读的那几个字。");
      return;
    }
    setSelection({ start, end });
    setNotice(`已选中「${emphasisText(line.text, start, end)}」：点「加重音」写进项目。`);
  };

  const addEmphasis = () => {
    if (!selection) {
      setNotice("先选中要重读的字。");
      return;
    }
    if (draft.emphasis.length >= 8) {
      setNotice("重音最多 8 处：先把不用的删掉。");
      return;
    }
    const overlaps = draft.emphasis.some(
      (span) => selection.start < span.end && selection.end > span.start,
    );
    if (overlaps) {
      setNotice("这一段已经有重音了。");
      return;
    }
    patch({
      emphasis: [...draft.emphasis, { start: selection.start, end: selection.end, strength: 2 }].sort(
        (a, b) => a.start - b.start,
      ),
    });
    setSelection(undefined);
  };

  const addPause = () => {
    const element = document.getElementById(`perf-text-${line.id}`);
    const caret =
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? (element.selectionStart ?? 0)
        : 0;
    if (draft.pauses.length >= 8) {
      setNotice("停顿最多 8 处：先把不用的删掉。");
      return;
    }
    if (draft.pauses.some((pause) => pause.afterChar === caret)) {
      setNotice("这个位置已经有停顿了。");
      return;
    }
    const next = [...draft.pauses, { afterChar: caret, ms: 400 }].sort(
      (a, b) => a.afterChar - b.afterChar,
    );
    patch({ pauses: next });
    // 停顿只能靠标点表达：那个位置本来就有标点时，念出来不会有变化，要说清楚
    const before = inputOf(line.text, draft);
    const after = inputOf(line.text, { ...draft, pauses: next });
    setNotice(
      before === after
        ? `第 ${caret} 个字之后本来就有标点，念出来不会更慢——换个位置试试。`
        : `已加一处停顿：第 ${caret} 个字之后，会插一个${400 < 600 ? "逗号" : "省略号"}。`,
    );
  };

  const save = () => {
    if (readOnly) return;
    const ok = onSave(isDefaultPerformance(draft) ? undefined : draft);
    setNotice(ok ? "已写进项目：下一次出声按这组参数念。" : "没有要写的改动。");
  };

  return (
    <div className="mt-2 rounded-token border border-line bg-surface/40 p-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-[9.5px] tracking-[.06em] text-text">表演</h4>
        <span className="text-[8.5px] text-muted-2">
          {isDefaultPerformance(line.performance ?? DEFAULT_PERFORMANCE)
            ? "默认：原速、平、无重音"
            : summarizePerformance(line.performance ?? DEFAULT_PERFORMANCE)}
        </span>
      </div>

      <label className="mt-2 flex flex-col gap-0.5 text-[8.5px] text-muted-2">
        句子（选中要重读的字）
        <input
          id={`perf-text-${line.id}`}
          value={line.text}
          readOnly
          onSelect={captureSelection}
          onMouseUp={captureSelection}
          onKeyUp={captureSelection}
          aria-label="句子文本（选中要重读的字）"
          className="rounded-token border border-line bg-transparent px-1.5 py-1 text-[11px] text-text selection:bg-pick/30 focus:border-line-2 focus:outline-none"
        />
      </label>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-[8.5px] text-muted-2">
          语速
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={draft.rate}
            disabled={readOnly}
            onChange={(event) => patch({ rate: Number(event.target.value) })}
            aria-label="语速"
            className="min-w-0 flex-1 accent-[var(--pick)]"
          />
          <span className="tnum w-[38px] text-right text-[9px] text-muted">
            {draft.rate.toFixed(2)}×
          </span>
        </label>
        <label className="flex items-center gap-2 text-[8.5px] text-muted-2">
          音高
          <input
            type="range"
            min={-12}
            max={12}
            step={1}
            value={draft.pitch}
            disabled={readOnly}
            onChange={(event) => patch({ pitch: Number(event.target.value) })}
            aria-label="音高"
            className="min-w-0 flex-1 accent-[var(--pick)]"
          />
          <span className="tnum w-[38px] text-right text-[9px] text-muted">
            {draft.pitch > 0 ? `+${draft.pitch}` : draft.pitch}
          </span>
        </label>
        <label className="flex items-center gap-2 text-[8.5px] text-muted-2">
          音量
          <input
            type="range"
            min={0.25}
            max={2}
            step={0.05}
            value={draft.volume}
            disabled={readOnly}
            onChange={(event) => patch({ volume: Number(event.target.value) })}
            aria-label="音量"
            className="min-w-0 flex-1 accent-[var(--pick)]"
          />
          <span className="tnum w-[38px] text-right text-[9px] text-muted">
            {Math.round(draft.volume * 100)}%
          </span>
        </label>
        <label className="flex items-center gap-2 text-[8.5px] text-muted-2">
          气声
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={draft.breathiness}
            disabled={readOnly}
            onChange={(event) => patch({ breathiness: Number(event.target.value) })}
            aria-label="气声"
            className="min-w-0 flex-1 accent-[var(--pick)]"
          />
          <span className="tnum w-[38px] text-right text-[9px] text-muted">
            {Math.round(draft.breathiness * 100)}%
          </span>
        </label>
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5 text-[8.5px] text-muted-2">
          句尾
          <select
            value={draft.ending}
            disabled={readOnly}
            onChange={(event) => patch({ ending: event.target.value as VoicePerformance["ending"] })}
            aria-label="句尾走向"
            className={fieldClass(readOnly)}
          >
            {Object.entries(ENDING_LABEL).map(([value, label]) => (
              <option key={value} value={value} className="bg-surface">
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[120px] flex-1 flex-col gap-0.5 text-[8.5px] text-muted-2">
          情绪
          <input
            value={draft.emotion}
            disabled={readOnly}
            onChange={(event) => patch({ emotion: event.target.value.slice(0, 20) })}
            placeholder="克制 / 试探 / 压着火"
            aria-label="情绪"
            className={fieldClass(readOnly)}
          />
        </label>
      </div>

      <div className="mt-2 border-t border-line pt-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={addEmphasis}
            disabled={readOnly}
            className="rounded-token border border-line px-1.5 py-px text-[8.5px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
          >
            加重音
          </button>
          <button
            type="button"
            onClick={addPause}
            disabled={readOnly}
            className="rounded-token border border-line px-1.5 py-px text-[8.5px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
          >
            在光标处加停顿
          </button>
          <span className="text-[8.5px] text-muted-2">
            重音 {draft.emphasis.length} 处 · 停顿 {draft.pauses.length} 处
          </span>
        </div>

        {(draft.emphasis.length > 0 || draft.pauses.length > 0) && (
          <ul className="mt-1 flex flex-wrap gap-1">
            {draft.emphasis.map((span) => (
              <li
                key={`e-${span.start}-${span.end}`}
                className="flex items-center gap-1 rounded-token border border-line px-1 py-px text-[8.5px] text-muted"
              >
                重读「{emphasisText(line.text, span.start, span.end)}」
                <button
                  type="button"
                  onClick={() =>
                    patch({
                      emphasis: draft.emphasis.filter(
                        (item) => !(item.start === span.start && item.end === span.end),
                      ),
                    })
                  }
                  disabled={readOnly}
                  aria-label="删掉这处重音"
                  className="text-muted-2 enabled:hover:text-pick disabled:opacity-40"
                >
                  ×
                </button>
              </li>
            ))}
            {draft.pauses.map((pause) => (
              <li
                key={`p-${pause.afterChar}`}
                className="flex items-center gap-1 rounded-token border border-line px-1 py-px text-[8.5px] text-muted"
              >
                第 {pause.afterChar} 字后停 {pause.ms}ms
                <button
                  type="button"
                  onClick={() =>
                    patch({ pauses: draft.pauses.filter((item) => item.afterChar !== pause.afterChar) })
                  }
                  disabled={readOnly}
                  aria-label="删掉这处停顿"
                  className="text-muted-2 enabled:hover:text-pick disabled:opacity-40"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {draft.pauses.length > 0 && (
          <p className="mt-1 text-[8px] leading-[1.6] text-muted-2">
            实际发给供应商的文本：{inputOf(line.text, draft)}
          </p>
        )}
      </div>

      <p className="mt-2 text-[8px] leading-[1.6] text-muted-2">
        {canSpeak
          ? "语速会作为 speed 发送；情绪、气声与句尾拼成 instructions。当前模型可能不支持其中几项——念出来没变不是 bug。"
          : "还没配配音模型：参数照样能存进项目，配上模型之后下一次出声才会用上。"}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={save}
          disabled={readOnly || !dirty}
          className="rounded-token border border-line-2 px-2 py-0.5 text-[9.5px] text-text transition-colors duration-[var(--dur)] enabled:hover:border-pick enabled:hover:text-pick disabled:cursor-not-allowed disabled:opacity-40"
        >
          存下表演
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(DEFAULT_PERFORMANCE);
            setNotice("已恢复默认：点「存下表演」才会写进项目。");
          }}
          disabled={readOnly}
          className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
        >
          恢复默认
        </button>
        <button
          type="button"
          onClick={onGenerateTake}
          disabled={readOnly || !canSpeak}
          title={canSpeak ? "按这组参数再念一版，存进试听台" : "还没配配音模型"}
          className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          再念一版
        </button>
        {notice && <span className="text-[8.5px] leading-[1.5] text-pick">{notice}</span>}
      </div>

      <div className="mt-2 border-t border-line pt-2">
        <div className="flex items-baseline justify-between gap-2">
          <h5 className="text-[9px] tracking-[.06em] text-muted">试听台</h5>
          <span className="tnum text-[8.5px] text-muted-2">{takes.length} 版</span>
        </div>
        {takes.length === 0 ? (
          <p className="mt-1 text-[8.5px] leading-[1.6] text-muted-2">
            还没有存过版本：改完参数点「再念一版」，每次都是真花钱的调用，所以不默认生成三版。
          </p>
        ) : (
          <ul className="mt-1 border-t border-line">
            {takes.map((take, index) => {
              const adopted = adoptedAssetId === take.assetId;
              return (
                <li
                  key={take.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line py-1"
                >
                  <span className="tnum w-[26px] shrink-0 text-[8.5px] text-muted-2">
                    v{takes.length - index}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[8.5px] text-muted">
                    {summarizePerformance(take.performance)}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-token border px-1 py-px text-[8px]",
                      adopted ? "border-line-2 text-text" : "border-dashed border-line text-muted-2",
                    )}
                  >
                    {adopted ? "正在用" : "未采用"}
                  </span>
                  <button
                    type="button"
                    onClick={() => onAdoptTake(take.id)}
                    disabled={readOnly || adopted}
                    className="shrink-0 rounded-token border border-line px-1.5 py-px text-[8.5px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
                  >
                    采用
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveTake(take.id)}
                    disabled={readOnly || adopted}
                    title={adopted ? "正被采用的那一版不能删" : "从试听台删掉（资产不删）"}
                    className="shrink-0 rounded-token border border-line px-1.5 py-px text-[8.5px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-pick enabled:hover:text-pick disabled:opacity-40"
                  >
                    删
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
