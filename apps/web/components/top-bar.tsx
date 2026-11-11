"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { ProjectRequote } from "@/lib/pricing";
import { buildHistory, nextUndo } from "@/lib/history";
import { ExportIcon, Logomark, PlayIcon } from "@/components/icons";
import { HistoryPanel } from "@/components/history-panel";
import { ModelPicker } from "@/components/model-picker";
import { SpendLedger } from "@/components/spend-ledger";
import type { Modality } from "@/lib/config-types";
import { nextOpenStage, stageStates } from "@/lib/stage-flow";
import { useWorkbench } from "@/lib/workbench-store";

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

/** 每个阶段用得上的工具（F8）：阶段式只露这些，自由工作台全开 */
type StageTool =
  | "ledger"
  | "budget"
  | "export"
  | "preview"
  | "check"
  | "performance"
  | "consistency"
  | "blocking"
  | "doctor";

const STAGE_TOOLS: Record<StageName, StageTool[]> = {
  故事: [],
  剧本: ["export", "doctor"],
  定妆: ["ledger", "budget"],
  分镜: ["ledger", "budget", "export", "preview", "check", "performance", "consistency", "blocking"],
  关键帧: ["ledger", "budget", "preview"],
  声音: ["ledger", "budget", "preview"],
  成片: ["ledger", "budget", "export"],
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
  /** 打开表演与调度面板（B16 / B17，ADR-0103）；给了才出现「表演」 */
  onPerformance?: () => void;
  /** 还没写表演设计的镜头数，显示在按钮右上 */
  performanceCount?: number;
  /** 打开一致性体检（ADR-0097）；给了才出现「体检」 */
  onConsistency?: () => void;
  /** 待复核 + 不达标的镜头数，显示在按钮右上 */
  consistencyCount?: number;
  /** 打开走位（B13.1 / ADR-0126）；给了才出现「走位」 */
  onBlocking?: () => void;
  /** 越轴的镜头对数，显示在按钮右上 */
  blockingCount?: number;
  /** 打开剧本医生（A18 / ADR-0123）；给了才出现「医生」 */
  onDoctor?: () => void;
  /** 剧本医生里偏低的项数，显示在按钮右上 */
  doctorCount?: number;
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
  onPerformance,
  performanceCount,
  onConsistency,
  consistencyCount,
  onBlocking,
  blockingCount,
  onDoctor,
  doctorCount,
}: TopBarProps) {
  const [draftBudget, setDraftBudget] = useState<string>("");
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const project = useWorkbench((state) => state.project);
  const events = useWorkbench((state) => state.events);
  const undo = useWorkbench((state) => state.undo);
  const setRetryLimit = useWorkbench((state) => state.setRetryLimit);
  const setOnBudgetExceed = useWorkbench((state) => state.setOnBudgetExceed);
  const mode = useWorkbench((state) => state.mode);
  const setMode = useWorkbench((state) => state.setMode);
  const lockedNotice = useWorkbench((state) => state.lockedNotice);
  const dismissLockNotice = useWorkbench((state) => state.dismissLockNotice);
  // 阶段式只露这一阶段的工具；自由工作台全部展开（F8）
  const shows = (tool: StageTool) => mode === "free" || STAGE_TOOLS[stage].includes(tool);
  // 撤销一步是哪一步：按钮 title 与历史抽屉用同一份判断（F2 / ADR-0109）
  const step = useMemo(() => nextUndo(events, buildHistory(events)), [events]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return;
      if (event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      // 输入框里的撤销交给浏览器：那里撤的是刚打的字，不是项目
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      void undo();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo]);
  const gateStates = stageStates(project);
  const nextStage = nextOpenStage(gateStates);
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
        {mode === "free" && (
          <span className="tnum rounded-token border border-line-2 px-1.5 py-px text-[8.5px] text-muted">
            自由工作台
          </span>
        )}
      </div>

      <nav aria-label="阶段" className="tnum hidden items-center gap-2.5 text-[10px] text-muted md:flex">
        {stages.map((item, i) => {
          const active = item.name === stage;
          const gate = gateStates.find((state) => state.name === item.name);
          const gateTitle =
            gate?.gate === "confirmed"
              ? `${gate.name}已确认${gate.confirmedAt ? `（${gate.confirmedAt.slice(5, 10)}）` : ""}`
              : gate?.gate === "stale"
                ? `${gate.name}确认后内容改过，需要再确认`
                : `${gate?.name ?? item.name}还没确认`;
          return (
            <span key={item.name} className="flex items-center gap-2.5">
              {i > 0 && <span className="text-line-2">·</span>}
              <span className="flex items-center gap-1.5">
                {mode === "guided" && (
                  <span
                    aria-hidden="true"
                    title={gateTitle}
                    className={cn(
                      "block h-[4px] w-[4px] shrink-0 rounded-full",
                      gate?.gate === "confirmed"
                        ? "bg-text"
                        : gate?.gate === "stale"
                          ? "bg-pick"
                          : "border border-line-2",
                    )}
                  />
                )}
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
            </span>
          );
        })}
      </nav>

      {/* 阶段式默认路径：一条「下一步」把人领到还没确认的那一阶段（F8） */}
      {mode === "guided" && nextStage && (
        <Link
          href={nextStage.href}
          className="tnum hidden items-center gap-1.5 border-l border-line pl-6 text-[10px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text xl:flex"
        >
          下一步 · {nextStage.name}
          <span className="text-muted-2">→</span>
        </Link>
      )}

      <div className="ml-auto flex items-center gap-4">
        {STAGE_MODELS[stage] && (
          <div className="hidden items-center gap-3 lg:flex">
            {STAGE_MODELS[stage]!.map((modality) => (
              <ModelPicker key={modality} modality={modality} />
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setMode(mode === "guided" ? "free" : "guided")}
          title={
            mode === "guided"
              ? "切到自由工作台：收起阶段闸门，全部工具展开，已确认的阶段也不再锁编辑"
              : "切回阶段式：按七阶段走，已确认的阶段会锁住编辑"
          }
          className="text-[10px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
        >
          {mode === "guided" ? "自由工作台" : "回到阶段式"}
        </button>
        <Link
          href="/settings"
          className="text-[10px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
        >
          设置
        </Link>
        {shows("ledger") && (
          <button
            type="button"
            onClick={() => setLedgerOpen(true)}
            title="按阶段与按镜看钱花在哪：不花钱"
            className="text-[10px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
          >
            记账
          </button>
        )}
        <button
          type="button"
          onClick={() => void undo()}
          disabled={readOnly || !step}
          title={
            readOnly
              ? "另一个标签页在编辑，这里不能撤销"
              : step
                ? `撤销：${step.label}（⌘Z / Ctrl+Z）`
                : "没有更早的改动可撤销"
          }
          className="text-[10px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45"
        >
          撤销
        </button>
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          title="看每一步，回到任何一步；删掉的东西在回收站里"
          className="text-[10px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
        >
          历史
        </button>
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
        {shows("budget") && spentCny !== undefined && (
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
              {!readOnly && (
                <div className="mt-2.5 space-y-1.5 border-t border-line pt-2.5">
                  <label className="flex items-center justify-between gap-2 text-[9.5px] text-muted-2">
                    <span>单镜最多试</span>
                    <select
                      id="retry-limit"
                      value={project.maxAttemptsPerShot}
                      onChange={(event) => setRetryLimit(Number(event.target.value))}
                      className="rounded-token border border-line bg-transparent px-1 py-0.5 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
                    >
                      {[1, 2, 3, 4, 5].map((value) => (
                        <option key={value} value={value} className="bg-surface text-text">
                          {value} 次
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center justify-between gap-2 text-[9.5px] text-muted-2">
                    <span>超预算时</span>
                    <select
                      id="budget-exceed"
                      value={project.onBudgetExceed}
                      onChange={(event) =>
                        setOnBudgetExceed(event.target.value === "keep" ? "keep" : "block")
                      }
                      className="rounded-token border border-line bg-transparent px-1 py-0.5 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
                    >
                      <option value="block" className="bg-surface text-text">
                        停下，等我处理
                      </option>
                      <option value="keep" className="bg-surface text-text">
                        保留现有结果
                      </option>
                    </select>
                  </label>
                  <p className="text-[9px] leading-[1.5] text-muted-2">
                    {project.onBudgetExceed === "keep"
                      ? "超预算的镜头不再调用生成，沿用手上已有的画面。"
                      : "超预算的镜头直接拦下，不会悄悄花钱。"}
                  </p>
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
        {shows("doctor") && onDoctor && (
          <button
            type="button"
            onClick={onDoctor}
            title="按十二维读一遍剧本：结构诊断与改写方向，不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            医生
            {doctorCount !== undefined && doctorCount > 0 && (
              <span className="tnum text-[9px] text-pick">{doctorCount}</span>
            )}
          </button>
        )}
        {shows("consistency") && onConsistency && (
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
        {shows("blocking") && onBlocking && (
          <button
            type="button"
            onClick={onBlocking}
            title="俯视走位图、自动摆位与越轴检查：不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            走位
            {blockingCount !== undefined && blockingCount > 0 && (
              <span className="tnum text-[9px] text-pick">{blockingCount}</span>
            )}
          </button>
        )}
        {shows("performance") && onPerformance && (
          <button
            type="button"
            onClick={onPerformance}
            title="写这一镜的表演设计、视线与站位：不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            表演
            {performanceCount !== undefined && performanceCount > 0 && (
              <span className="tnum text-[9px] text-pick">{performanceCount}</span>
            )}
          </button>
        )}
        {shows("check") && onCheck && (
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
        {shows("preview") && onPreview && (
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
        {shows("export") && (
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
        )}
      </div>
      {/* 阶段硬锁（F8）：被拦下的那一次写在底部，不弹窗、不打断 */}
      {lockedNotice && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 flex w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-token border border-pick/60 bg-surface px-3 py-2 text-[10.5px] shadow-lg"
        >
          <span className="shrink-0 text-pick">阶段已确认</span>
          <span className="min-w-0 flex-1 leading-[1.6] text-muted">{lockedNotice}</span>
          <button
            type="button"
            onClick={dismissLockNotice}
            className="shrink-0 rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            知道了
          </button>
        </div>
      )}
      <SpendLedger
        project={project}
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
      />
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </header>
  );
}
