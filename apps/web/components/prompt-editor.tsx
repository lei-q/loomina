"use client";

import { useState } from "react";
import { PROMPT_OVERRIDE_MAX } from "@/lib/prompt-override";
import { cn } from "@/lib/utils";

export type PromptTab = {
  /** 覆盖值的键：`sheet:c-lin:front`、`keyframe:s-01:first`… */
  key: string;
  /** 同一个生成动作下可能有多份提示词（四视图、首尾帧、系统 / 用户消息） */
  label: string;
  /** 代码按项目内容算出来的默认提示词；没手改时显示并送出它 */
  prompt: string;
};

/**
 * 生成按钮旁边的提示词（ADR-0148）。
 *
 * 展示的是「这一次真正要送去模型的那一段」，展开就能改；
 * 改过的版本按 `key` 存进 store，生成时优先送出，清空或点「恢复默认」回到默认那段。
 * 不写事件、不进 IR：它描述的是这一次想怎么说，不是项目事实。
 */
export function PromptEditor({
  tabs,
  values,
  onChange,
  readOnly,
  className,
  note,
  defaultOpen = false,
  maxChars = PROMPT_OVERRIDE_MAX,
}: {
  tabs: PromptTab[];
  /** 手改过的提示词：key → 文本 */
  values: Record<string, string>;
  /** 改一份提示词；`null` 表示恢复默认 */
  onChange: (key: string, value: string | null) => void;
  readOnly?: boolean;
  className?: string;
  /** 这一处提示词额外的说明（比如声音页「没写就只把台词送出去」） */
  note?: string;
  defaultOpen?: boolean;
  /** 有些接口自己有更短的上限（配音的 instructions 是 300 字） */
  maxChars?: number;
}) {
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(defaultOpen);
  if (tabs.length === 0) return null;
  const index = Math.min(active, tabs.length - 1);
  const tab = tabs[index]!;
  const override = values[tab.key];
  const current = override ?? tab.prompt;
  const customized = override !== undefined;
  const anyCustomized = tabs.some((item) => values[item.key] !== undefined);

  return (
    <details
      className={cn("border border-line bg-surface/40 text-[9.5px] text-muted-2", className)}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer select-none items-baseline gap-1.5 px-2 py-1 hover:text-muted">
        <span>提示词 · 可改</span>
        {anyCustomized && (
          <span className="rounded-token border border-pick/60 px-1 text-[8.5px] text-pick">
            已改
          </span>
        )}
        <span className="ml-auto text-[8.5px] text-muted-2">{tab.label}</span>
      </summary>

      <div className="border-t border-line px-2 py-1.5">
        {tabs.length > 1 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {tabs.map((item, i) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setActive(i)}
                aria-pressed={i === index}
                className={cn(
                  "rounded-token border px-1.5 py-px text-[8.5px] transition-colors duration-[var(--dur)]",
                  i === index
                    ? "border-line-2 text-text"
                    : "border-line text-muted-2 hover:border-line-2 hover:text-text",
                )}
              >
                {item.label}
                {values[item.key] !== undefined && <span className="ml-0.5 text-pick">·</span>}
              </button>
            ))}
          </div>
        )}

        <textarea
          value={current}
          onChange={(event) =>
            onChange(
              tab.key,
              event.target.value === tab.prompt ? null : event.target.value,
            )
          }
          readOnly={readOnly}
          rows={5}
          maxLength={maxChars}
          aria-label={tab.label}
          placeholder={tab.prompt ? undefined : "没写就不额外说明，只把台词原样送出去"}
          className="w-full resize-y rounded-token border border-line bg-bg px-1.5 py-1 text-[10px] leading-[1.65] text-text placeholder:text-muted-2 focus:border-line-2 focus:outline-none read-only:opacity-60"
        />

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="tnum text-[8.5px] text-muted-2">
            {current.length} / {maxChars}
          </span>
          {customized ? (
            <span className="text-[8.5px] text-pick">生成时用你改的这一版</span>
          ) : (
            <span className="text-[8.5px] text-muted-2">由项目内容自动拼出</span>
          )}
          <button
            type="button"
            onClick={() => onChange(tab.key, null)}
            disabled={readOnly || !customized}
            title="清掉手改，回到按项目内容拼出来的那一段"
            className="ml-auto rounded-token border border-line px-1.5 py-px text-[8.5px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
          >
            恢复默认
          </button>
        </div>

        <p className="mt-1 text-[8px] leading-[1.6] text-muted-2">
          {note ??
            "改完直接点生成：送出的就是这一版。手改只对之后的生成生效，不写进项目，刷新回到默认。"}
        </p>
      </div>
    </details>
  );
}
