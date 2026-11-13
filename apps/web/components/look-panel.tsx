"use client";

import { useMemo, useState } from "react";
import type { Look } from "@loomina/ir";
import { LOOK_PRESETS, compileLook, isDefaultLook, lookPresetById } from "@loomina/pipeline";
import { cn } from "@/lib/utils";

const CONTRAST_OPTIONS: { value: Look["contrast"]; label: string }[] = [
  { value: "soft", label: "柔" },
  { value: "balanced", label: "标准" },
  { value: "hard", label: "硬" },
];

const TEMPERATURE_OPTIONS: { value: Look["temperature"]; label: string }[] = [
  { value: "warm", label: "暖" },
  { value: "neutral", label: "中性" },
  { value: "cool", label: "冷" },
];

const TEXTURE_OPTIONS: { value: Look["texture"]; label: string }[] = [
  { value: "clean", label: "干净" },
  { value: "grain", label: "颗粒" },
  { value: "dream", label: "柔焦" },
];

export type LookPanelProps = {
  look: Look;
  /** 存一次：整块写一条 `project.updated`；返回是否真的改了 */
  onSave: (look: Look) => boolean;
  readOnly?: boolean;
  onClose: () => void;
};

/**
 * 画面风格与摄影参数（B7 / I5，ADR-0165）。
 *
 * 一条片子的风格只在这里定义一次：所有出图提示词的最后一句都由它编译。
 * 改完只影响下一次出图——已经出的图不会自动重做，界面如实说明。
 */
export function LookPanel({ look, onSave, readOnly = false, onClose }: LookPanelProps) {
  const [draft, setDraft] = useState<Look>(look);
  const preview = useMemo(() => compileLook(draft), [draft]);
  const preset = lookPresetById(draft.presetId);
  const dirty =
    draft.presetId !== look.presetId ||
    draft.contrast !== look.contrast ||
    draft.temperature !== look.temperature ||
    draft.texture !== look.texture ||
    draft.note !== look.note;

  const pickPreset = (id: string) => {
    const found = lookPresetById(id);
    setDraft((prev) =>
      found
        ? { ...prev, presetId: found.id, ...found.defaults }
        : { ...prev, presetId: "" },
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
        aria-label="画面风格"
        className="flex h-full w-[440px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">画面风格</h2>
            <span className="tnum text-[9px] text-muted-2">
              {dirty ? "有未保存的改动" : isDefaultLook(look) ? "默认档" : "已调过"}
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
          <section>
            <h3 className="text-[10.5px] tracking-[.06em] text-text">风格预设</h3>
            <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">
              选一个取向，再按下面的三项微调。不选就是默认档（实拍电影质感、自然光、轻微颗粒）。
            </p>
            <div className="mt-2 flex flex-col gap-1.5">
              {LOOK_PRESETS.map((item) => {
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
                      active
                        ? "border-pick bg-pick/10"
                        : "border-line hover:border-line-2",
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
              <button
                type="button"
                disabled={readOnly}
                onClick={() => pickPreset("")}
                aria-pressed={!draft.presetId}
                className={cn(
                  "border px-2.5 py-1.5 text-left text-[10.5px] transition-colors duration-[var(--dur)] disabled:opacity-40",
                  !draft.presetId ? "border-pick bg-pick/10 text-text" : "border-line text-muted hover:border-line-2 hover:text-text",
                )}
              >
                不用预设，只按参数
              </button>
            </div>
          </section>

          <section className="mt-4">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">摄影参数</h3>
            <div className="mt-2 flex flex-col gap-2.5">
              <Row label="光比">
                {CONTRAST_OPTIONS.map((option) => (
                  <Choice
                    key={option.value}
                    active={draft.contrast === option.value}
                    disabled={readOnly}
                    onClick={() => setDraft((prev) => ({ ...prev, contrast: option.value }))}
                  >
                    {option.label}
                  </Choice>
                ))}
              </Row>
              <Row label="色温">
                {TEMPERATURE_OPTIONS.map((option) => (
                  <Choice
                    key={option.value}
                    active={draft.temperature === option.value}
                    disabled={readOnly}
                    onClick={() => setDraft((prev) => ({ ...prev, temperature: option.value }))}
                  >
                    {option.label}
                  </Choice>
                ))}
              </Row>
              <Row label="质感">
                {TEXTURE_OPTIONS.map((option) => (
                  <Choice
                    key={option.value}
                    active={draft.texture === option.value}
                    disabled={readOnly}
                    onClick={() => setDraft((prev) => ({ ...prev, texture: option.value }))}
                  >
                    {option.label}
                  </Choice>
                ))}
              </Row>
            </div>
            <p className="mt-2 text-[9px] leading-[1.65] text-muted-2">
              画幅固定竖屏 9:16。光比与色温是整片口径，单镜的机位与景别仍在分镜页改。
            </p>
          </section>

          <section className="mt-4">
            <label
              htmlFor="look-note"
              className="text-[10.5px] tracking-[.06em] text-text"
            >
              补充风格句
            </label>
            <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">
              最多 80 字，会接在提示词最后。写看得见的东西（「雨夜霓虹」「旧墙皮」），
              别写形容词堆叠。
            </p>
            <input
              id="look-note"
              value={draft.note}
              maxLength={80}
              disabled={readOnly}
              onChange={(event) => setDraft((prev) => ({ ...prev, note: event.target.value }))}
              placeholder="例如：雨夜霓虹，湿地面反光"
              className="mt-1.5 w-full rounded-token border border-line bg-transparent px-2 py-1 text-[10.5px] text-text placeholder:text-muted-2 focus:border-line-2 focus:outline-none disabled:opacity-40"
            />
          </section>

          <section className="mt-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">提示词最后一句</h3>
              <span className="tnum text-[9px] text-muted-2">{[...preview].length} 字</span>
            </div>
            <p className="mt-1.5 break-words border border-line px-2.5 py-2 text-[10px] leading-[1.7] text-text">
              {preview}
            </p>
            {preset && (
              <p className="mt-1 text-[9px] leading-[1.6] text-muted-2">
                预设「{preset.name}」：{preset.phrase}
              </p>
            )}
          </section>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={readOnly || !dirty}
              onClick={() => {
                if (onSave(draft)) onClose();
              }}
              className="rounded-token border border-pick bg-pick px-3 py-1 text-[10.5px] text-white transition-opacity duration-[var(--dur)] enabled:hover:opacity-90 disabled:opacity-40"
            >
              存风格
            </button>
            <button
              type="button"
              disabled={readOnly || isDefaultLook(draft)}
              onClick={() => {
                const reset: Look = {
                  presetId: "",
                  contrast: "balanced",
                  temperature: "neutral",
                  texture: "grain",
                  aspect: "9:16",
                  note: "",
                };
                setDraft(reset);
              }}
              className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
            >
              恢复默认
            </button>
            {dirty && (
              <span className="text-[9px] text-muted-2">有未保存的改动</span>
            )}
          </div>

          <p className="mt-4 border-t border-line pt-3 text-[9px] leading-[1.7] text-muted-2">
            风格只影响下一次出图：已经出的三视图、关键帧与视频不会自动重做。
            要换风格重做，回到对应的格子重新生成——那会再花一次钱。
          </p>
        </div>
      </aside>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[34px] shrink-0 text-[9.5px] text-muted-2">{label}</span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function Choice({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "rounded-token border px-2 py-0.5 text-[9.5px] transition-colors duration-[var(--dur)] disabled:opacity-40",
        active
          ? "border-pick bg-pick/10 text-text"
          : "border-line text-muted hover:border-line-2 hover:text-text",
      )}
    >
      {children}
    </button>
  );
}
