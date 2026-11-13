"use client";

import { useMemo, useState } from "react";
import type { Grade, Transition, TransitionKind } from "@loomina/ir";
import {
  GRADE_PRESETS,
  TRANSITION_LABEL,
  TRANSITION_MAX_MS,
  TRANSITION_MIN_MS,
  gradeFilters,
  gradeLine,
  gradePresetById,
  isDefaultGrade,
} from "@/lib/render-effects";
import { cn } from "@/lib/utils";

const CONTRAST_OPTIONS: { value: Grade["contrast"]; label: string }[] = [
  { value: "flat", label: "压平" },
  { value: "natural", label: "原样" },
  { value: "punchy", label: "加对比" },
];

const SATURATION_OPTIONS: { value: Grade["saturation"]; label: string }[] = [
  { value: "muted", label: "退色" },
  { value: "natural", label: "原样" },
  { value: "rich", label: "加饱和" },
];

const TEMPERATURE_OPTIONS: { value: Grade["temperature"]; label: string }[] = [
  { value: "cool", label: "偏冷" },
  { value: "neutral", label: "原样" },
  { value: "warm", label: "偏暖" },
];

const TRANSITION_OPTIONS: TransitionKind[] = ["black", "white"];

/** 时间线上的一处接缝：后一段从第几毫秒开始、接在哪一段之后 */
export type SeamOption = {
  itemId: string;
  /** 后一段的镜号，例如 SH-02 */
  label: string;
  /** 接缝在成片里的位置（毫秒） */
  atMs: number;
  durationMs: number;
  transition?: Transition;
};

export type GradePanelProps = {
  grade: Grade;
  /** 存一次：整块写一条 `project.updated { grade }`；返回是否真的改了 */
  onSave: (grade: Grade) => boolean;
  /** 时间线上的接缝（第一段没有）；空数组表示还没初剪 */
  seams: SeamOption[];
  /** 设某一处接缝的转场；`undefined` 恢复硬切 */
  onTransition: (itemId: string, transition: Transition | undefined) => boolean;
  readOnly?: boolean;
  onClose: () => void;
};

/**
 * 调色与转场（E4 / ADR-0169）。
 *
 * 调色作用在**拼好的画面**上，字幕与角标之前——压完字幕再调，白字会变米黄。
 * 转场挂在后一段上，只做不改变时长的淡入淡出：叠化会让成片比时间线短，
 * 后面的字幕与配音整体错位，时长是音轨定的（准则 P5）。
 */
export function GradePanel({
  grade,
  onSave,
  seams,
  onTransition,
  readOnly = false,
  onClose,
}: GradePanelProps) {
  const [draft, setDraft] = useState<Grade>(grade);
  const [flash, setFlash] = useState("");
  const filters = useMemo(() => gradeFilters(draft), [draft]);
  const preset = gradePresetById(draft.presetId);
  const dirty =
    draft.presetId !== grade.presetId ||
    draft.contrast !== grade.contrast ||
    draft.saturation !== grade.saturation ||
    draft.temperature !== grade.temperature ||
    draft.vignette !== grade.vignette;

  const pickPreset = (id: string) => {
    const found = gradePresetById(id);
    setDraft((prev) =>
      found ? { ...prev, presetId: found.id, ...found.value } : { ...prev, presetId: "" },
    );
    setFlash("");
  };

  const save = () => {
    const ok = onSave(draft);
    setFlash(ok ? "调色已存：下一次导出生效，提示词与已出的图不受影响。" : "没有变化。");
  };

  const setSeam = (seam: SeamOption, kind: TransitionKind | "cut") => {
    const ok =
      kind === "cut"
        ? onTransition(seam.itemId, undefined)
        : onTransition(seam.itemId, {
            kind,
            durationMs: seam.transition?.durationMs ?? 300,
          });
    setFlash(
      ok
        ? kind === "cut"
          ? `${seam.label} 前面恢复硬切。`
          : `${seam.label} 前面改成${TRANSITION_LABEL[kind]}。`
        : readOnly
          ? "页面只读，先解锁。"
          : "没有变化。",
    );
  };

  const setSeamDuration = (seam: SeamOption, durationMs: number) => {
    if (!seam.transition) return;
    const ok = onTransition(seam.itemId, { ...seam.transition, durationMs });
    setFlash(
      ok ? `${seam.label} 前面的转场改成 ${durationMs}ms。` : "这一段太短，转场放不下。",
    );
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="调色与转场"
        className="flex h-full w-[440px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">调色与转场</h2>
            <span className="tnum text-[9px] text-muted-2">
              {dirty ? "有未保存的改动" : isDefaultGrade(grade) ? "原样" : "已调过"}
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
          <p className="text-[9.5px] leading-[1.7] text-muted-2">
            调色只作用在导出的成片上，不改提示词、不动已出的图。字幕与「AI 生成」角标在调色之后才压上去，
            不会被一起染黄。
          </p>

          <section className="mt-4">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">调色预设</h3>
            <div className="mt-1.5 flex flex-col gap-1.5">
              {GRADE_PRESETS.map((item) => {
                const active = draft.presetId === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={readOnly}
                    onClick={() => pickPreset(item.id)}
                    aria-pressed={active}
                    className={cn(
                      "border px-2.5 py-1.5 text-left transition-colors duration-[var(--dur)] disabled:opacity-40",
                      active ? "border-pick bg-pick/10" : "border-line hover:border-line-2",
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-[10.5px] text-text">{item.name}</span>
                      {active && <span className="text-[8.5px] text-pick">已选</span>}
                    </span>
                    <span className="mt-0.5 block text-[9px] leading-[1.6] text-muted-2">
                      {item.blurb}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="mt-4">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">逐项微调</h3>
            <div className="mt-1.5 flex flex-col gap-2">
              <Row
                label="对比"
                options={CONTRAST_OPTIONS}
                value={draft.contrast}
                disabled={readOnly}
                onChange={(contrast) => setDraft((prev) => ({ ...prev, contrast }))}
              />
              <Row
                label="饱和"
                options={SATURATION_OPTIONS}
                value={draft.saturation}
                disabled={readOnly}
                onChange={(saturation) => setDraft((prev) => ({ ...prev, saturation }))}
              />
              <Row
                label="色温"
                options={TEMPERATURE_OPTIONS}
                value={draft.temperature}
                disabled={readOnly}
                onChange={(temperature) => setDraft((prev) => ({ ...prev, temperature }))}
              />
              <label className="flex items-center gap-2 text-[9.5px] text-muted-2">
                <input
                  type="checkbox"
                  checked={draft.vignette}
                  disabled={readOnly}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, vignette: event.target.checked }))
                  }
                  className="accent-[var(--pick)]"
                />
                四角压暗（暗角）
              </label>
            </div>
          </section>

          <section className="mt-3 border border-line px-3 py-2.5">
            <p className="text-[8.5px] tracking-[.06em] text-muted-2">会送进渲染的滤镜</p>
            <p className="mt-1 break-words font-mono text-[9px] leading-[1.7] text-text">
              {filters.length ? filters.join(",") : "（不调色）"}
            </p>
            <p className="mt-1 text-[9px] leading-[1.6] text-muted-2">{gradeLine(draft)}</p>
            {preset && !matchesPreset(draft, preset) && (
              <p className="mt-1 text-[9px] leading-[1.6] text-muted-2">
                逐项改过之后就不再是「{preset.name}」的原样，渲染按上面的逐项参数走。
              </p>
            )}
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                disabled={readOnly || !dirty}
                onClick={save}
                className="rounded-token border border-pick bg-pick px-2.5 py-1 text-[10px] text-white transition-opacity duration-[var(--dur)] enabled:hover:opacity-90 disabled:opacity-40"
              >
                存调色
              </button>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => {
                  setDraft({ presetId: "", contrast: "natural", saturation: "natural", temperature: "neutral", vignette: false });
                  setFlash("");
                }}
                className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-text disabled:opacity-40"
              >
                恢复原样
              </button>
            </div>
            {flash && <p className="mt-1 text-[9.5px] text-muted">{flash}</p>}
          </section>

          <section className="mt-5 border-t border-line pt-3">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">接缝（E4）</h3>
            <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">
              只做不改变时长的转场：上一段末尾淡到黑（或白），下一段开头再淡回来。
              叠化会让成片比时间线短，后面的字幕与配音整体错位，所以不做。
            </p>
            {seams.length === 0 ? (
              <p className="mt-2 text-[9.5px] text-muted-2">
                时间线还不到两段：先去初剪排好，接缝才会出现。
              </p>
            ) : (
              <div className="mt-1.5 flex flex-col gap-2">
                {seams.map((seam) => {
                  const maxMs = Math.min(TRANSITION_MAX_MS, Math.floor(seam.durationMs / 2));
                  const kind = seam.transition?.kind;
                  return (
                    <div key={seam.itemId} className="border border-line px-2.5 py-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="tnum text-[10px] text-text">
                          {seam.label} 前面
                        </span>
                        <span className="tnum text-[8.5px] text-muted-2">
                          {(seam.atMs / 1000).toFixed(1)}s · 后一段 {(seam.durationMs / 1000).toFixed(1)}s
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <button
                          type="button"
                          disabled={readOnly}
                          onClick={() => setSeam(seam, "cut")}
                          aria-pressed={kind === undefined}
                          className={cn(
                            "rounded-token border px-1.5 py-px text-[9px] transition-colors duration-[var(--dur)] disabled:opacity-40",
                            kind === undefined
                              ? "border-pick text-text"
                              : "border-line text-muted-2 hover:border-line-2 hover:text-text",
                          )}
                        >
                          硬切
                        </button>
                        {TRANSITION_OPTIONS.map((option) => (
                          <button
                            key={option}
                            type="button"
                            disabled={readOnly || maxMs < TRANSITION_MIN_MS}
                            onClick={() => setSeam(seam, option)}
                            aria-pressed={kind === option}
                            title={
                              maxMs < TRANSITION_MIN_MS
                                ? "这一段太短，放不下转场"
                                : `${TRANSITION_LABEL[option]}：默认 300ms`
                            }
                            className={cn(
                              "rounded-token border px-1.5 py-px text-[9px] transition-colors duration-[var(--dur)] disabled:opacity-40",
                              kind === option
                                ? "border-pick text-text"
                                : "border-line text-muted-2 hover:border-line-2 hover:text-text",
                            )}
                          >
                            {TRANSITION_LABEL[option]}
                          </button>
                        ))}
                      </div>
                      {seam.transition && (
                        <label className="mt-1.5 flex items-center gap-2 text-[9px] text-muted-2">
                          时长
                          <input
                            type="range"
                            min={TRANSITION_MIN_MS}
                            max={maxMs}
                            step={50}
                            value={Math.min(seam.transition.durationMs, maxMs)}
                            disabled={readOnly}
                            onChange={(event) => setSeamDuration(seam, Number(event.target.value))}
                            className="min-w-0 flex-1 accent-[var(--pick)]"
                          />
                          <span className="tnum w-[42px] text-right text-muted">
                            {seam.transition.durationMs}ms
                          </span>
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}

/** 预设与逐项参数是否还一致：一致时不必提示「已经改过」 */
function matchesPreset(grade: Grade, preset: { value: Omit<Grade, "presetId"> }): boolean {
  return (
    grade.contrast === preset.value.contrast &&
    grade.saturation === preset.value.saturation &&
    grade.temperature === preset.value.temperature &&
    grade.vignette === preset.value.vignette
  );
}

function Row<T extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[34px] shrink-0 text-[9.5px] text-muted-2">{label}</span>
      <div className="flex flex-1 gap-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={cn(
              "flex-1 rounded-token border px-1.5 py-px text-[9px] transition-colors duration-[var(--dur)] disabled:opacity-40",
              value === option.value
                ? "border-pick text-text"
                : "border-line text-muted-2 hover:border-line-2 hover:text-text",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
