"use client";

import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ProjectRequote } from "@/lib/pricing";
import { ExportIcon, Logomark, PlayIcon } from "@/components/icons";
import { ModelPicker } from "@/components/model-picker";
import type { Modality } from "@/lib/config-types";

/** 阶段是一列；还没做出来的阶段 href 为 null，点了不跳。 */
const stages = [
  { name: "故事", href: "/story" },
  { name: "剧本", href: "/script" },
  { name: "定妆", href: "/cast" },
  { name: "分镜", href: "/" },
  { name: "关键帧", href: "/keyframes" },
  { name: "声音", href: "/voice" },
  { name: "成片", href: "/edit" },
] as const;

export type StageName = (typeof stages)[number]["name"];

/** 这一阶段会花哪类模型的请求；顶栏只显示相关的下拉 */
const STAGE_MODELS: Partial<Record<StageName, Modality[]>> = {
  分镜: ["image", "video"],
  定妆: ["image"],
  关键帧: ["image", "video"],
  声音: ["tts", "asr"],
};

export type TopBarProps = {
  title: string;
  version: number;
  stage: StageName;
  spentCny?: number;
  budgetCny?: number;
  /** 生成过但价目表里没有模型的图，算不进已花（ADR-0033） */
  unpriced?: number;
  /** 已花怎么构成的：分镜 / 定妆 / 已淘汰（ADR-0036） */
  spendBreakdown?: { takes: number; assets: number; rejected: number };
  /** 本地写入失败：如实说没存住（ADR-0034） */
  storageError?: string;
  /** 另一个标签页在编辑：这一页只读 */
  readOnly?: boolean;
  /** 整片重做一遍的报价；给了才多一行 */
  allRequote?: ProjectRequote;
  /** 改预算上限（元）；给了才显示可改的输入框 */
  onBudgetChange?: (cny: number) => void;
  /** 导出当前页；给了才真的导出（ADR-0048） */
  onExport?: () => void;
  /** 导出按钮的说明；不给就沿用「导出」 */
  exportLabel?: string;
  /** 打开预演（ADR-0084）；给了才出现「预演」 */
  onPreview?: () => void;
  /** 打开分镜检查（ADR-0096）；给了才出现「检查」 */
  onCheck?: () => void;
  /** 检查里要看的条数（错误 + 提示），显示在按钮右上 */
  checkCount?: number;
  /** 打开一致性体检（ADR-0097）；给了才出现「体检」 */
  onConsistency?: () => void;
  /** 待复核 + 不达标的镜头数，显示在按钮右上 */
  consistencyCount?: number;
};

function Money({ value }: { value?: number }) {
  return <span className="tnum">{value === undefined ? "—" : `¥${value.toFixed(2)}`}</span>;
}

export function TopBar({
  title,
  version,
  stage,
  spentCny,
  budgetCny,
  unpriced = 0,
  spendBreakdown,
  storageError,
  readOnly,
  allRequote,
  onBudgetChange,
  onExport,
  exportLabel,
  onPreview,
  onCheck,
  checkCount,
  onConsistency,
  consistencyCount,
}: TopBarProps) {
  const [draftBudget, setDraftBudget] = useState<string>("");
  const budget = budgetCny ?? 60;
  // 超预算是硬事：数字变 pick，展开里单独一行写超了多少
  const over = spentCny !== undefined ? Math.round((spentCny - budget) * 100) / 100 : 0;
  const commitBudget = () => {
    const value = Number.parseFloat(draftBudget);
    if (!Number.isFinite(value) || value <= 0) return;
    onBudgetChange?.(value);
    setDraftBudget("");
  };

  return (
    <header className="flex h-[46px] shrink-0 items-center gap-6 border-b border-line px-4">
      <div className="flex items-center gap-2">
        <Logomark className="h-[21px] w-[21px] text-text" />
        <span className="text-[13px] tracking-[.08em] text-text">{title}</span>
        <span className="tnum text-[9px] text-muted-2">v{version}</span>
        <span className="tnum rounded-token border border-line px-1.5 py-px text-[8.5px] text-muted-2">示例</span>
      </div>

      <nav aria-label="阶段" className="tnum hidden items-center gap-2.5 text-[10px] text-muted md:flex">
        {stages.map((item, i) => {
          const active = item.name === stage;
          return (
            <span key={item.name} className="flex items-center gap-2.5">
              {i > 0 && <span className="text-line-2">·</span>}
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "transition-colors duration-[var(--dur)] hover:text-text",
                  active ? "text-text" : "text-muted",
                )}
              >
                {item.name}
              </Link>
            </span>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-4">
        {STAGE_MODELS[stage] && (
          <div className="hidden items-center gap-3 lg:flex">
            {STAGE_MODELS[stage]!.map((modality) => (
              <ModelPicker key={modality} modality={modality} />
            ))}
          </div>
        )}
        <Link
          href="/settings"
          className="text-[10px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
        >
          设置
        </Link>
        {readOnly && (
          <span
            title="另一个标签页在编辑这份项目。这里只读，刷新后以那边为准"
            className="tnum text-[9px] tracking-[.08em] text-muted-2"
          >
            只读
          </span>
        )}
        {storageError && (
          <span
            title={storageError}
            className="tnum text-[9px] tracking-[.08em] text-pick"
          >
            未保存
          </span>
        )}
        {spentCny !== undefined && (
          <details className="relative">
            <summary
              className={cn(
                "tnum cursor-pointer list-none text-[10px] transition-colors duration-[var(--dur)] hover:text-text [&::-webkit-details-marker]:hidden",
                over > 0 ? "text-pick" : "text-muted",
              )}
            >
              ¥{spentCny.toFixed(2)}
              <span className="text-muted-2"> / {budget.toFixed(2)}</span>
            </summary>

            <div className="absolute right-0 top-full z-20 mt-2.5 w-[252px] rounded-token border border-line bg-surface p-3">
              <dl className="space-y-1.5 text-[10.5px]">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-2">已花</dt>
                  <dd className="text-muted">
                    <Money value={spentCny} />
                  </dd>
                </div>
                {spendBreakdown && spendBreakdown.takes > 0 && (
                  <div className="flex items-baseline justify-between gap-3 pl-3">
                    <dt className="text-muted-2">分镜 take</dt>
                    <dd className="text-muted-2">
                      <Money value={spendBreakdown.takes} />
                    </dd>
                  </div>
                )}
                {spendBreakdown && spendBreakdown.assets > 0 && (
                  <div className="flex items-baseline justify-between gap-3 pl-3">
                    <dt className="text-muted-2">定妆图</dt>
                    <dd className="text-muted-2">
                      <Money value={spendBreakdown.assets} />
                    </dd>
                  </div>
                )}
                {spendBreakdown && spendBreakdown.rejected > 0 && (
                  <div className="flex items-baseline justify-between gap-3 pl-3">
                    <dt className="text-muted-2">已淘汰 take</dt>
                    <dd className="text-muted-2">
                      <Money value={spendBreakdown.rejected} />
                    </dd>
                  </div>
                )}
                {allRequote && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-2">全部重做一遍</dt>
                    <dd className="text-text">
                      <Money value={allRequote.totalCny} />
                    </dd>
                  </div>
                )}
                {over > 0 && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-2">超出</dt>
                    <dd className="text-pick">
                      <Money value={over} />
                    </dd>
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-2">预算</dt>
                  <dd className="flex items-baseline gap-2 text-muted">
                    <Money value={budget} />
                  </dd>
                </div>
              </dl>
              {onBudgetChange && !readOnly && (
                <div className="mt-2.5 flex items-center gap-1.5 border-t border-line pt-2.5">
                  <input
                    id="budget-input"
                    value={draftBudget}
                    onChange={(event) => setDraftBudget(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitBudget();
                    }}
                    inputMode="decimal"
                    placeholder={budget.toFixed(2)}
                    aria-label="新预算（元）"
                    className="tnum w-full min-w-0 rounded-token border border-line bg-transparent px-1.5 py-1 text-right text-[10.5px] text-text placeholder:text-muted-2 focus:border-line-2 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={commitBudget}
                    className="shrink-0 rounded-token border border-line px-2 py-1 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                  >
                    改预算
                  </button>
                </div>
              )}
              {unpriced > 0 && (
                <p className="mt-2.5 border-t border-line pt-2 text-[9px] leading-[1.5] text-muted-2">
                  另有 {unpriced} 张定妆图没有价目，没算进已花
                </p>
              )}
              {allRequote && (
                <p className="mt-2.5 border-t border-line pt-2 text-[9px] leading-[1.5] text-muted-2">
                  {allRequote.basis}
                </p>
              )}
            </div>
          </details>
        )}
        {onConsistency && (
          <button
            type="button"
            onClick={onConsistency}
            title="查定妆锚点、场景主镜、道具参考与 take 溯源：不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            体检
            {consistencyCount !== undefined && consistencyCount > 0 && (
              <span className="tnum text-[9px] text-pick">{consistencyCount}</span>
            )}
          </button>
        )}
        {onCheck && (
          <button
            type="button"
            onClick={onCheck}
            title="看每一拍的覆盖率，查分镜问题：不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            检查
            {checkCount !== undefined && checkCount > 0 && (
              <span className="tnum text-[9px] text-pick">{checkCount}</span>
            )}
          </button>
        )}
        {onPreview && (
          <button
            type="button"
            onClick={onPreview}
            title="把这一条片按镜头时长放一遍：关键帧 + 字幕，不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            <PlayIcon className="h-3.5 w-3.5" />
            预演
          </button>
        )}
        <button
          type="button"
          onClick={onExport}
          disabled={!onExport}
          title={onExport ? exportLabel ?? "导出当前页" : "这一页还不能导出"}
          className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45"
        >
          <ExportIcon className="h-3.5 w-3.5" />
          导出
        </button>
      </div>
    </header>
  );
}
