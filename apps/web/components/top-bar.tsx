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
import { rememberWorkspace } from "@/lib/event-log";
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
  | "performanceQa"
  | "consistency"
  | "blocking"
  | "space"
  | "doctor"
  | "polish"
  | "silent"
  | "bilingual"
  | "brand"
  | "look"
  | "publish"
  | "rights"
  | "grade"
  | "frame"
  | "language";

const STAGE_TOOLS: Record<StageName, StageTool[]> = {
  故事: [],
  剧本: ["export", "doctor", "polish"],
  定妆: ["ledger", "budget", "look", "rights"],
  分镜: [
    "ledger",
    "budget",
    "export",
    "preview",
    "check",
    "performance",
    "performanceQa",
    "consistency",
    "blocking",
    "space",
    "language",
  ],
  关键帧: ["ledger", "budget", "preview"],
  声音: ["ledger", "budget", "preview"],
  成片: [
    "ledger",
    "budget",
    "export",
    "silent",
    "bilingual",
    "brand",
    "publish",
    "grade",
    "frame",
    "rights",
  ],
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
  /** 打开表演 QA（B18）；给了才出现「演检」 */
  onPerformanceQa?: () => void;
  /** 表演设计要改的镜头数（会出问题 + 建议改），显示在按钮右上 */
  performanceQaCount?: number;
  /** 打开一致性体检（ADR-0097）；给了才出现「体检」 */
  onConsistency?: () => void;
  /** 待复核 + 不达标的镜头数，显示在按钮右上 */
  consistencyCount?: number;
  /** 打开走位（B13.1 / ADR-0126）；给了才出现「走位」 */
  onBlocking?: () => void;
  /** 越轴的镜头对数，显示在按钮右上 */
  blockingCount?: number;
  /** 打开场景空间板 / 走位台账（B11）；给了才出现「空间」 */
  onSpace?: () => void;
  /** 相邻镜之间的问题条数，显示在按钮右上 */
  spaceCount?: number;
  /** 打开剧本医生（A18 / ADR-0123）；给了才出现「医生」 */
  onDoctor?: () => void;
  /** 剧本医生里偏低的项数，显示在按钮右上 */
  doctorCount?: number;
  /** 打开台词压缩与金句（A20 / ADR-0163）；给了才出现「台词」 */
  onPolish?: () => void;
  /** 要压的台词句数，显示在按钮右上 */
  polishCount?: number;
  /** 打开双语字幕（D5 / ADR-0173）；给了才出现「双语」 */
  onBilingual?: () => void;
  /** 还有几句没译文，显示在按钮右上 */
  untranslatedCount?: number;
  /** 打开品牌包与头尾卡（E9 / ADR-0174）；给了才出现「品牌」 */
  onBrand?: () => void;
  /** 头尾卡开了几张，显示在按钮右上 */
  cardCount?: number;
  /** 打开静音可懂度检查（C13 / ADR-0164）；给了才出现「静音」 */
  onSilent?: () => void;
  /** 静音时有问题的地方数，显示在按钮右上 */
  silentCount?: number;
  /** 打开画面风格（B7 / I5，ADR-0165）；给了才出现「风格」 */
  onLook?: () => void;
  /** 风格调过没有：调过就在按钮上标一下 */
  lookCustomized?: boolean;
  /** 打开发布台账（G10 / ADR-0166）；给了才出现「台账」 */
  onPublishLedger?: () => void;
  /** 有几份发布包还没贴回执，显示在按钮右上 */
  unpublishedCount?: number;
  /** 打开授权记录（H7 / ADR-0167）；给了才出现「授权」 */
  onRights?: () => void;
  /** 缺几条授权（含已过期），显示在按钮右上 */
  rightsGapCount?: number;
  /** 打开调色（E4 / ADR-0169）；给了才出现「调色」 */
  onGrade?: () => void;
  /** 调色调过没有：调过就在按钮上标一下 */
  gradeCustomized?: boolean;
  /** 打开画幅与裁切（E5 / ADR-0170）；给了才出现「画幅」 */
  onFrame?: () => void;
  /** 画幅调过没有：调过就在按钮上标一下 */
  frameCustomized?: boolean;
  /** 打开镜头语言库（I1）；给了才出现「语言」 */
  onLanguage?: () => void;
  /** 当前镜有没有对上库里的说法：对上了就不标点 */
  languageMatched?: boolean;
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
  onPerformanceQa,
  performanceQaCount,
  onConsistency,
  consistencyCount,
  onBlocking,
  blockingCount,
  onSpace,
  spaceCount,
  onDoctor,
  doctorCount,
  onPolish,
  polishCount,
  onBilingual,
  untranslatedCount,
  onBrand,
  cardCount,
  onSilent,
  silentCount,
  onLook,
  lookCustomized,
  onPublishLedger,
  unpublishedCount,
  onRights,
  rightsGapCount,
  onGrade,
  gradeCustomized,
  onFrame,
  frameCustomized,
  onLanguage,
  languageMatched,
}: TopBarProps) {
  const [draftBudget, setDraftBudget] = useState<string>("");
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [newWorkspace, setNewWorkspace] = useState("");
  const [newWorkspaceFrom, setNewWorkspaceFrom] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  /** 删空间要按两下：第一下问，第二下真删（C15 / ADR-0201） */
  const [deleting, setDeleting] = useState<string>();
  const [workspaceNote, setWorkspaceNote] = useState<string>();
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const project = useWorkbench((state) => state.project);
  const events = useWorkbench((state) => state.events);
  const undo = useWorkbench((state) => state.undo);
  const setRetryLimit = useWorkbench((state) => state.setRetryLimit);
  const setOnBudgetExceed = useWorkbench((state) => state.setOnBudgetExceed);
  const mode = useWorkbench((state) => state.mode);
  const setMode = useWorkbench((state) => state.setMode);
  const lockedNotice = useWorkbench((state) => state.lockedNotice);
  const dismissLockNotice = useWorkbench((state) => state.dismissLockNotice);
  const workspaceId = useWorkbench((state) => state.workspaceId);
  const workspaces = useWorkbench((state) => state.workspaces);
  const workspaceError = useWorkbench((state) => state.workspaceError);
  const refreshWorkspaces = useWorkbench((state) => state.refreshWorkspaces);
  const createWorkspace = useWorkbench((state) => state.createWorkspace);
  const renameWorkspace = useWorkbench((state) => state.renameWorkspace);
  const deleteWorkspace = useWorkbench((state) => state.deleteWorkspace);
  const currentWorkspace = workspaces.find((item) => item.id === workspaceId);

  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);
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

  /**
   * 换工作空间走整页加载：各页有自己的播放器、选中镜与本地草稿，
   * 在内存里换日志容易留下上一份项目的状态。见 ADR-0188。
   */
  const openWorkspace = (id: string) => {
    if (id === workspaceId) {
      setWorkspaceOpen(false);
      return;
    }
    rememberWorkspace(id);
    window.location.assign("/");
  };

  const submitWorkspace = async () => {
    setWorkspaceBusy(true);
    const id = await createWorkspace(newWorkspace, newWorkspaceFrom || undefined);
    setWorkspaceBusy(false);
    if (id) window.location.assign("/");
  };

  return (
    <header className="flex h-[46px] shrink-0 items-center gap-4 border-b border-line px-4">
      <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
        <Logomark className="h-[21px] w-[21px] text-text" />
        <span className="text-[13px] tracking-[.08em] text-text">{title}</span>
        <span className="tnum text-[9px] text-muted-2">v{version}</span>
        <span className="tnum rounded-token border border-line px-1.5 py-px text-[8.5px] text-muted-2">示例</span>
        {mode === "free" && (
          <span className="tnum rounded-token border border-line-2 px-1.5 py-px text-[8.5px] text-muted">
            自由工作台
          </span>
        )}
        <div className="relative">
          <button
            type="button"
            onClick={() => setWorkspaceOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={workspaceOpen}
            title="工作空间：每个空间是一条独立的完整流程；素材库在这台机器上共用"
            className="tnum flex items-center gap-1 rounded-token border border-line px-1.5 py-px text-[8.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            <span className="text-muted-2">空间</span>
            <span className="max-w-[120px] truncate">
              {currentWorkspace?.name ?? "默认工作空间"}
            </span>
            <span aria-hidden="true" className="text-muted-2">
              ▾
            </span>
          </button>

          {workspaceOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onMouseDown={() => setWorkspaceOpen(false)}
              />
              <div
                role="menu"
                aria-label="工作空间"
                className="absolute left-0 top-full z-50 mt-1.5 w-[280px] border border-line bg-bg px-3 py-2.5 shadow-[0_12px_32px_rgba(0,0,0,.45)]"
              >
                <p className="text-[9px] leading-[1.7] text-muted-2">
                  每个工作空间有自己的一份项目与流程，互不覆盖；素材库在这台机器上共用。
                  换空间会整页加载过去。
                </p>

                <div className="mt-2 flex flex-col gap-1">
                  {workspaces.length === 0 && (
                    <p className="text-[9.5px] text-muted-2">还没有登记工作空间。</p>
                  )}
                  {workspaces.map((item) => {
                    const active = item.id === workspaceId;
                    const isRenaming = renaming?.id === item.id;
                    return (
                      <div key={item.id} className="flex items-center gap-1">
                        {isRenaming ? (
                          <>
                            <input
                              value={renaming.name}
                              autoFocus
                              maxLength={40}
                              aria-label="工作空间名字"
                              onChange={(event) =>
                                setRenaming({ id: item.id, name: event.target.value })
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void renameWorkspace(item.id, renaming.name).then(() =>
                                    setRenaming(undefined),
                                  );
                                }
                                if (event.key === "Escape") setRenaming(undefined);
                              }}
                              className="min-w-0 flex-1 rounded-token border border-line-2 bg-surface px-1.5 py-0.5 text-[10px] text-text focus:border-pick focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                void renameWorkspace(item.id, renaming.name).then(() =>
                                  setRenaming(undefined),
                                )
                              }
                              className="rounded-token border border-line-2 px-1.5 py-0.5 text-[9px] text-text hover:bg-text/10"
                            >
                              存
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              role="menuitem"
                              aria-current={active ? "true" : undefined}
                              onClick={() => openWorkspace(item.id)}
                              className={cn(
                                "min-w-0 flex-1 truncate rounded-token border px-1.5 py-1 text-left text-[10px] transition-colors duration-[var(--dur)]",
                                active
                                  ? "border-pick text-text"
                                  : "border-line text-muted hover:border-line-2 hover:text-text",
                              )}
                            >
                              {item.name}
                              {item.episodeNo !== undefined && (
                                <span className="tnum ml-1.5 text-[8px] text-muted-2">
                                  第 {item.episodeNo} 集
                                </span>
                              )}
                              {active && (
                                <span className="tnum ml-1.5 text-[8px] text-muted-2">
                                  现在
                                </span>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => setRenaming({ id: item.id, name: item.name })}
                              title="改这个名字（只改本机登记，不动项目标题）"
                              className="shrink-0 text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
                            >
                              改
                            </button>
                            {active ? (
                              <span
                                title="正在打开的空间不能删：先切到别的空间"
                                className="shrink-0 text-[9px] text-muted-2 opacity-40"
                              >
                                删
                              </span>
                            ) : deleting === item.id ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => {
                                    void deleteWorkspace(item.id).then((removed) => {
                                      setDeleting(undefined);
                                      setWorkspaceNote(
                                        removed === undefined
                                          ? (useWorkbench.getState().workspaceError ?? "没删掉。")
                                          : `删掉了「${item.name}」：${removed} 条事件。素材文件不动，别处还在用。`,
                                      );
                                    });
                                  }}
                                  title="真删：这个空间的事件日志从本机清掉，取不回来"
                                  className="shrink-0 rounded-token border border-pick px-1 text-[9px] text-pick"
                                >
                                  真删
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeleting(undefined)}
                                  className="shrink-0 text-[9px] text-muted-2 hover:text-text"
                                >
                                  算了
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setDeleting(item.id)}
                                title="删掉这个工作空间的事件日志（不可恢复；素材文件留着）"
                                className="shrink-0 text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-pick"
                              >
                                删
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>

                {workspaceNote && (
                  <p className="mt-2 border-t border-line pt-2 text-[9px] leading-[1.6] text-muted-2">
                    {workspaceNote}
                  </p>
                )}

                <label className="mt-2 flex flex-col gap-1 border-t border-line pt-2 text-[9px] text-muted-2">
                  新空间从哪里开工
                  <select
                    aria-label="新空间从哪里开工"
                    value={newWorkspaceFrom}
                    onChange={(event) => setNewWorkspaceFrom(event.target.value)}
                    className="w-full rounded-token border border-line bg-surface px-1.5 py-0.5 text-[9.5px] text-text focus:border-pick focus:outline-none"
                  >
                    <option value="">示例项目（从零开工）</option>
                    {workspaces.map((item) => (
                      <option key={item.id} value={item.id}>
                        照「{item.name}」的设定开工（带故事 / 演员 / 场景 / 道具，不带成片）
                      </option>
                    ))}
                  </select>
                </label>

                <form
                  className="mt-1 flex items-center gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitWorkspace();
                  }}
                >
                  <input
                    value={newWorkspace}
                    maxLength={40}
                    aria-label="新工作空间名字"
                    placeholder="新工作空间的名字"
                    onChange={(event) => setNewWorkspace(event.target.value)}
                    className="min-w-0 flex-1 rounded-token border border-line-2 bg-surface px-1.5 py-0.5 text-[10px] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={workspaceBusy || newWorkspace.trim().length === 0}
                    className="shrink-0 rounded-token border border-line px-1.5 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
                  >
                    {workspaceBusy ? "建…" : "新建"}
                  </button>
                </form>
                {workspaceError && (
                  <p className="mt-1 text-[9px] leading-[1.6] text-pick">{workspaceError}</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 阶段条要整行读，挤到换行 / 截断都不如收起来：xl 以下只留「下一步」 */}
      <nav
        aria-label="阶段"
        className="tnum hidden shrink-0 items-center gap-2.5 whitespace-nowrap text-[10px] text-muted xl:flex"
      >
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
          className="tnum hidden items-center gap-1.5 whitespace-nowrap border-l border-line pl-4 text-[10px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text md:flex"
        >
          下一步 · {nextStage.name}
          <span className="text-muted-2">→</span>
        </Link>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-4 whitespace-nowrap">
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
          href="/assets"
          className="text-[10px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
        >
          素材库
        </Link>
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
        {shows("polish") && onPolish && (
          <button
            type="button"
            onClick={onPolish}
            title="压台词、标金句：单句 ≤15 字，一镜 ≤2 句；不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            台词
            {polishCount !== undefined && polishCount > 0 && (
              <span className="tnum text-[9px] text-pick">{polishCount}</span>
            )}
          </button>
        )}
        {shows("look") && onLook && (
          <button
            type="button"
            onClick={onLook}
            title="画面风格与摄影参数：所有出图提示词的最后一句由它编译；不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            风格
            {lookCustomized && <span className="text-[9px] text-pick">·</span>}
          </button>
        )}
        {shows("publish") && onPublishLedger && (
          <button
            type="button"
            onClick={onPublishLedger}
            title="每一份发布包发到哪、平台回了什么、哪一版还没发：不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            台账
            {unpublishedCount !== undefined && unpublishedCount > 0 && (
              <span className="tnum text-[9px] text-pick">{unpublishedCount}</span>
            )}
          </button>
        )}
        {shows("rights") && onRights && (
          <button
            type="button"
            onClick={onRights}
            title="肖像 / 声音 / 素材 / 音乐的授权留档：谁给的、到期没到期、凭证在哪；不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            授权
            {rightsGapCount !== undefined && rightsGapCount > 0 && (
              <span className="tnum text-[9px] text-pick">{rightsGapCount}</span>
            )}
          </button>
        )}
        {shows("bilingual") && onBilingual && (
          <button
            type="button"
            onClick={onBilingual}
            title="双语字幕：给每一句写第二行，SRT / ASS / 预览 / 成片一起带；不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            双语
            {untranslatedCount !== undefined && untranslatedCount > 0 && (
              <span className="tnum text-[9px] text-pick">{untranslatedCount}</span>
            )}
          </button>
        )}
        {shows("brand") && onBrand && (
          <button
            type="button"
            onClick={onBrand}
            title="品牌包与头尾卡：片名卡、下一集卡、落款与底色；成片、预览、SRT 一起跟着走，不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            品牌
            {cardCount !== undefined && cardCount > 0 && (
              <span className="tnum text-[9px] text-muted-2">{cardCount}</span>
            )}
          </button>
        )}
        {shows("silent") && onSilent && (
          <button
            type="button"
            onClick={onSilent}
            title="关掉声音看字幕能不能独立讲清剧情：读速、空档、指代与说话人；不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            静音
            {silentCount !== undefined && silentCount > 0 && (
              <span className="tnum text-[9px] text-pick">{silentCount}</span>
            )}
          </button>
        )}
        {shows("space") && onSpace && (
          <button
            type="button"
            onClick={onSpace}
            title="场景空间板：每一镜谁在哪、朝哪、拿什么，跨镜对一遍；不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            空间
            {spaceCount !== undefined && spaceCount > 0 && (
              <span className="tnum text-[9px] text-pick">{spaceCount}</span>
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
        {shows("grade") && onGrade && (
          <button
            type="button"
            onClick={onGrade}
            title="调色与转场：整条片子的色彩倾向、每处接缝的淡入淡出；只影响导出，不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            调色
            {gradeCustomized && <span className="text-[9px] text-pick">·</span>}
          </button>
        )}
        {shows("frame") && onFrame && (
          <button
            type="button"
            onClick={onFrame}
            title="画幅与裁切：竖屏 / 横屏 / 方形，放不下时留边、裁切或模糊填充；只影响导出，不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            画幅
            {frameCustomized && <span className="text-[9px] text-pick">·</span>}
          </button>
        )}
        {shows("language") && onLanguage && (
          <button
            type="button"
            onClick={onLanguage}
            title="镜头语言库：景别 / 机位 / 运镜 / 焦段收成十四套说法，一套一条镜头改动；不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            语言
            {languageMatched === false && <span className="text-[9px] text-pick">·</span>}
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
        {shows("performanceQa") && onPerformanceQa && (
          <button
            type="button"
            onClick={onPerformanceQa}
            title="查表演设计配不配景别：微表情、视线、起转落、过火与情绪断层；不花钱"
            className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            演检
            {performanceQaCount !== undefined && performanceQaCount > 0 && (
              <span className="tnum text-[9px] text-pick">{performanceQaCount}</span>
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
        events={events}
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
      />
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </header>
  );
}
