"use client";

import { useEffect, useMemo, useState } from "react";
import { SHEET_LABELS, type Asset, type SheetView } from "@loomina/ir";
import {
  buildMasterPrompt,
  buildPropPrompt,
  buildSheetPrompt,
  describeSceneTemplate,
  SCENE_TEMPLATES,
  sceneTemplateById,
  templateSpace,
} from "@loomina/pipeline";
import { fetchImagePrice } from "@/lib/image-price";
import { BlockingBoard } from "@/components/blocking-board";
import { Bust } from "@/components/bust";
import { PropObject } from "@/components/prop-object";
import { PromptEditor } from "@/components/prompt-editor";
import { Scene } from "@/components/scene";
import { StageGate } from "@/components/stage-gate";
import { TopBar } from "@/components/top-bar";
import {
  castTextHistory,
  sheetAssetHistory,
  toCastView,
  undoableRemoval,
  type SheetCellVersion,
  type CastCharacterView,
  type CastLocationView,
  type CastPropView,
  type CastReference,
  type CastTextHistory,
  type CastTextVersion,
} from "@/lib/read-model";
import { useWorkbench } from "@/lib/workbench-store";
import { cn } from "@/lib/utils";
import { assetHref } from "@/lib/asset-uri";

function clock(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * 地点模板（B15 / ADR-0103）：上半是 SCENE-TEMPLATES.md 的 10 个场景模板，
 * 决定主镜提示词里的空间、主光与锚点；下半是旧的方位模板，只决定剪影（ADR-0059）。
 */
const LOCATION_TEMPLATES = [
  ...SCENE_TEMPLATES.map((template) => ({
    id: template.id,
    label: template.name,
    group: "scene" as const,
    hint: describeSceneTemplate(template),
  })),
  { id: "apartment-living", label: "公寓客厅（旧 id）", group: "legacy" as const, hint: "" },
  { id: "corridor", label: "走廊（旧方位）", group: "legacy" as const, hint: "" },
  { id: "doorway", label: "门口（旧方位）", group: "legacy" as const, hint: "" },
  { id: "table", label: "桌边（旧方位）", group: "legacy" as const, hint: "" },
  { id: "door", label: "门厅（旧方位）", group: "legacy" as const, hint: "" },
];

function StatusChip({
  status,
  missing,
  missingText,
}: {
  status: string;
  missing?: number;
  missingText?: string;
}) {
  if (status === "locked") {
    return (
      <span className="tnum flex items-center gap-1.5 text-[9px] text-text">
        <span className="h-[5px] w-[5px] bg-text" />
        已锁定
      </span>
    );
  }
  if (status === "incomplete") {
    return (
      <span className="tnum text-[9px] text-muted-2">
        {missingText ?? (missing !== undefined && missing > 0 ? `缺 ${missing} 格` : "缺 主镜")}
      </span>
    );
  }
  return <span className="tnum text-[9px] text-muted">可锁定</span>;
}

/** 参考图一排：三视图之外的表情 / 服装 / 手挂图（ADR-0079） */
function ReferenceStrip({
  references,
  startAt,
  readOnly,
  emptyText,
  onAdd,
  onRemove,
}: {
  references: CastReference[];
  /** 第一张叫 ref 几：人物从 1 数，道具的第一张已经在大图上 */
  startAt: number;
  readOnly: boolean;
  emptyText?: string;
  onAdd: (uri: string) => boolean;
  onRemove: (assetId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const submit = () => {
    if (!onAdd(draft)) return;
    setAdding(false);
    setDraft("");
  };

  return (
    <div className="max-w-[430px]">
      <p className="tnum text-[9px] tracking-[.14em] text-muted-2">参考</p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {references.map((reference, index) => (
          <figure key={reference.assetId} className="w-[72px]">
            <div className="relative aspect-[9/16] overflow-hidden rounded-[1px] border border-line bg-[#0f1013]">
              {reference.uri ? (
                <img
                  src={assetHref(reference.uri)}
                  alt={`参考图 ${startAt + index}`}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="absolute inset-0 grid place-items-center text-[9px] text-muted-2">
                  无图
                </span>
              )}
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`摘掉第 ${startAt + index} 张参考图`}
                  title="摘掉：图还留在资产里，可以再挂回来"
                  onClick={() => onRemove(reference.assetId)}
                  className="absolute right-0.5 top-0.5 grid h-3.5 w-3.5 place-items-center rounded-[1px] bg-bg/80 text-[9px] leading-none text-muted-2 transition-colors duration-[var(--dur)] hover:text-pick"
                >
                  ×
                </button>
              )}
            </div>
            <figcaption className="tnum mt-1 text-[9px] text-muted-2">ref {startAt + index}</figcaption>
          </figure>
        ))}
        {!readOnly && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            title="贴一张图的地址挂进来：http(s):// 或 data:image/ 开头"
            className="grid aspect-[9/16] w-[72px] place-items-center rounded-[1px] border border-dashed border-line-2 text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line hover:text-text"
          >
            ＋ 挂一张
          </button>
        )}
      </div>
      {adding && (
        <form
          className="mt-2 flex flex-wrap items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setAdding(false);
                setDraft("");
              }
            }}
            autoFocus
            aria-label="参考图地址"
            placeholder="https://… 或 data:image/…"
            className="w-[280px] rounded-token border border-line-2 bg-surface px-2 py-1 text-[10.5px] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-token border border-line-2 px-2 py-0.5 text-[10px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
          >
            挂上
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setDraft("");
            }}
            className="rounded-token border border-line px-2 py-0.5 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            取消
          </button>
          <span className="text-[9px] text-muted-2">最多 8 张；这里还没有上传，先贴地址</span>
        </form>
      )}
      {emptyText && references.length === 0 && !adding && (
        <p className="mt-1 text-[9px] leading-[1.5] text-muted-2">{emptyText}</p>
      )}
    </div>
  );
}

/** 名字 / 描述的历史：点一行展开，一版一行，可以整版写回（ADR-0082） */
function TextHistoryLine({
  history,
  name,
  body,
  readOnly,
  onRestore,
}: {
  history?: CastTextHistory;
  /** 现在的名字 / 描述：用来标出"正在用"的那一版 */
  name: string;
  body: string;
  readOnly: boolean;
  onRestore: (version: CastTextVersion) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!history || history.edits.length === 0) return null;

  const summary = (version: CastTextVersion) =>
    [version.name, version.body].filter(Boolean).join(" · ");
  const isCurrent = (version: CastTextVersion) => version.name === name && version.body === body;

  const row = (version: CastTextVersion, label?: string) => (
    <li
      key={`${version.at}-${label ?? version.name}`}
      className="flex flex-wrap items-baseline gap-2 text-[9.5px] leading-[1.5]"
    >
      <span className="tnum shrink-0 text-muted-2">{clock(version.at)}</span>
      <span
        className={cn("min-w-0 flex-1 truncate", isCurrent(version) ? "text-text" : "text-muted")}
        title={summary(version)}
      >
        {label && <span className="text-muted-2">{label} · </span>}
        {summary(version) || "（空）"}
      </span>
      {isCurrent(version) ? (
        <span className="shrink-0 text-[9px] text-muted-2">正在用</span>
      ) : (
        !readOnly && (
          <button
            type="button"
            onClick={() => onRestore(version)}
            title="整版写回：名字与描述一起换回这一版，也会记一笔历史"
            className="shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
          >
            用这版
          </button>
        )
      )}
    </li>
  );

  // 最后一版就是现在这一版：上一版要往前再退一格，退到头就是最初那版
  const previous = history.edits[history.edits.length - 2] ?? history.original;

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title="改名、改描述都会留一版；可以整版回退"
        className="flex max-w-full items-baseline gap-1.5 text-left text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
      >
        <span className="shrink-0">{open ? "收起历史" : `改过 ${history.edits.length} 次`}</span>
        {!open && <span className="min-w-0 truncate">· 上一版「{summary(previous)}」</span>}
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1 border-l border-line pl-2">
          {[...history.edits].reverse().map((version) => row(version))}
          {row(history.original, "最初")}
        </ul>
      )}
    </div>
  );
}

function CharacterRow({
  character,
  readOnly,
  generating,
  quoteCny,
  onGenerate,
  onLock,
  onUnlock,
  onEdit,
  onRemove,
  onAddMustNotChange,
  onRemoveMustNotChange,
  onAddReference,
  onRemoveReference,
  history,
  onRestoreText,
  sheetHistory,
  onRestoreSheet,
}: {
  character: CastCharacterView;
  readOnly: boolean;
  /** 正在生成的那一格 */
  generating?: SheetView;
  /** 这一次生成要花多少（元）；价目不知道就不给 */
  quoteCny?: number;
  onGenerate: () => void;
  onLock: () => void;
  onUnlock: () => void;
  /** 改名字 / 外形描述：成功返回 true，表单据此收起（ADR-0071） */
  onEdit: (name: string, appearance: string) => boolean;
  /** 删掉这个人物：成功返回 true（ADR-0073） */
  onRemove: () => boolean;
  /** 加一条「不许变」：成功返回 true，输入框据此收起（ADR-0074） */
  onAddMustNotChange: (text: string) => boolean;
  /** 划掉一条「不许变」（ADR-0074） */
  onRemoveMustNotChange: (text: string) => boolean;
  /** 挂一张参考图：成功返回 true，输入框据此收起（ADR-0079） */
  onAddReference: (uri: string) => boolean;
  onRemoveReference: (assetId: string) => void;
  /** 名字 / 外形改过哪几版（ADR-0082） */
  history?: CastTextHistory;
  /** 整版写回：名字与外形一起换回那一版（ADR-0082） */
  onRestoreText: (version: CastTextVersion) => void;
  /** 四格每一格出过哪些旧版（B1） */
  sheetHistory?: Map<string, SheetCellVersion[]>;
  /** 换回某一版旧图：写一条 asset.updated，不花钱 */
  onRestoreSheet: (assetId: string, version: Asset) => boolean;
}) {
  const promptOverrides = useWorkbench((state) => state.promptOverrides);
  const setPromptOverride = useWorkbench((state) => state.setPromptOverride);
  const missing = character.panels.filter((panel) => !panel.assetId).length;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftAppearance, setDraftAppearance] = useState("");
  const [addingRule, setAddingRule] = useState(false);
  const [draftRule, setDraftRule] = useState("");
  /** 正在看哪一格的历史；null 表示收起 */
  const [historyAngle, setHistoryAngle] = useState<SheetView | null>(null);

  const beginEdit = () => {
    setDraftName(character.name);
    setDraftAppearance(character.appearance);
    setEditing(true);
  };

  return (
    <section className="border-t border-line py-5">
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-[168px] shrink-0">
          {editing ? (
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (onEdit(draftName, draftAppearance)) setEditing(false);
              }}
            >
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditing(false);
                }}
                autoFocus
                aria-label="人物名字"
                className="w-full rounded-token border border-line-2 bg-surface px-2 py-1.5 text-[13px] text-text focus:border-pick focus:outline-none"
              />
              <textarea
                value={draftAppearance}
                onChange={(event) => setDraftAppearance(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditing(false);
                }}
                rows={3}
                aria-label="外形描述"
                placeholder="外形：短发、深色外套、左眼下一颗痣"
                className="w-full resize-none rounded-token border border-line bg-surface px-2 py-1.5 text-[11.5px] leading-[1.6] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
              />
              <p className="text-[9px] leading-[1.5] text-muted-2">
                外形整句进提示词，200 字以内；三视图与参考图不跟着变。
              </p>
              <div className="flex gap-1.5">
                <button
                  type="submit"
                  className="rounded-token border border-line-2 px-2 py-0.5 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-token border border-line px-2 py-0.5 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  取消
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-2.5">
                <h2 className="text-[17px] leading-none text-text">{character.name}</h2>
                <StatusChip status={character.status} missing={missing} />
                {!readOnly && (
                  <button
                    type="button"
                    onClick={beginEdit}
                    title="改名字或外形描述"
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
                  >
                    改
                  </button>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => setDeleting(true)}
                    disabled={deleting}
                    title="删掉这个人：还在镜头里 / 还有台词时删不掉"
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-pick disabled:cursor-default"
                  >
                    删
                  </button>
                )}
              </div>
              {deleting && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[9px]">
                  <span className="text-muted-2">删这个人？</span>
                  <button
                    type="button"
                    onClick={() => {
                      // 删不掉也收起确认：原因写在页头，停在原地只会让几个确认框叠在一起
                      onRemove();
                      setDeleting(false);
                    }}
                    className="rounded-token border border-pick/70 px-1.5 py-px text-pick transition-colors duration-[var(--dur)] hover:bg-pick hover:text-bg"
                  >
                    确认删
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleting(false)}
                    className="rounded-token border border-line px-1.5 py-px text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                  >
                    取消
                  </button>
                </div>
              )}
              <p className="mt-2 text-[11.5px] leading-[1.5] text-muted">
                {character.appearance || "还没写外形描述。"}
              </p>
              <TextHistoryLine
                history={history}
                name={character.name}
                body={character.appearance}
                readOnly={readOnly}
                onRestore={onRestoreText}
              />
            </>
          )}
          <p className="tnum mt-4 text-[8.5px] tracking-[.12em] text-muted-2">不许变</p>
          <ul className="mt-1.5 space-y-1">
            {character.mustNotChange.map((item) => (
              <li
                key={item}
                className="flex items-baseline gap-1.5 text-[10.5px] leading-[1.5] text-muted"
              >
                <span className="flex-1">{item}</span>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => onRemoveMustNotChange(item)}
                    title={`划掉「${item}」：从之后的每一张图里去掉了`}
                    aria-label={`划掉${item}`}
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-pick"
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
          {!readOnly &&
            (addingRule ? (
              <form
                className="mt-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (onAddMustNotChange(draftRule)) {
                    setDraftRule("");
                    setAddingRule(false);
                  }
                }}
              >
                <input
                  type="text"
                  value={draftRule}
                  onChange={(event) => setDraftRule(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setDraftRule("");
                      setAddingRule(false);
                    }
                  }}
                  autoFocus
                  maxLength={60}
                  aria-label="新的一条不许变"
                  placeholder="左耳后有一颗小痣"
                  className="w-full rounded-token border border-line-2 bg-surface px-1.5 py-1 text-[10.5px] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
                />
                <div className="mt-1 flex items-center gap-1.5">
                  <button
                    type="submit"
                    className="rounded-token border border-line-2 px-1.5 py-px text-[9.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDraftRule("");
                      setAddingRule(false);
                    }}
                    className="rounded-token border border-line px-1.5 py-px text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                  >
                    取消
                  </button>
                  <span className="text-[9px] text-muted-2">整句进提示词，60 字以内</span>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setAddingRule(true)}
                title="痣、疤、发型分缝、耳饰：每一张图都得原样带上"
                className="mt-1.5 text-[9.5px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
              >
                ＋ 加一条
              </button>
            ))}
          {!readOnly && character.mustNotChange.length === 0 && !addingRule && (
            <p className="mt-1 text-[9px] leading-[1.5] text-muted-2">
              还没写：痣、疤、发型分缝这些必须原样带进每一张图。
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {character.panels.map((panel) => (
            <figure key={panel.angle} className="w-[96px]">
              <div
                className={cn(
                  "relative aspect-[9/16] overflow-hidden rounded-[1px] border bg-[#0f1013]",
                  panel.assetId ? "border-line" : "border-dashed border-line-2",
                )}
              >
                {panel.uri ? (
                  <img
                    src={assetHref(panel.uri)}
                    alt={`${character.name} · ${panel.label}`}
                    className="h-full w-full object-cover"
                  />
                ) : panel.assetId ? (
                  <Bust view={panel.angle} className="h-full w-full" />
                ) : (
                  <span className="absolute inset-0 grid place-items-center text-[9px] text-muted-2">
                    待生成
                  </span>
                )}
                {generating === panel.angle && (
                  <span className="absolute inset-0 grid place-items-center bg-bg/75 text-[9px] text-text">
                    生成中…
                  </span>
                )}
                {panel.stale && (
                  <span
                    title={`出图之后改过：${panel.stale.reasons.join("、")}；重新生成或换回旧版`}
                    className="absolute left-1 top-1 h-1.5 w-1.5 rounded-full bg-pick"
                  />
                )}
              </div>
              <figcaption className="tnum mt-1.5 text-[9px] text-muted-2">{panel.label}</figcaption>
              {(() => {
                const versions = panel.assetId
                  ? (sheetHistory?.get(panel.assetId) ?? [])
                  : [];
                if (versions.length === 0) return null;
                return (
                  <button
                    type="button"
                    onClick={() =>
                      setHistoryAngle(historyAngle === panel.angle ? null : panel.angle)
                    }
                    aria-expanded={historyAngle === panel.angle}
                    className="tnum mt-0.5 text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
                  >
                    历史 {versions.length}
                  </button>
                );
              })()}
            </figure>
            ))}
          </div>
          {(() => {
            const panel = character.panels.find((item) => item.angle === historyAngle);
            const versions = panel?.assetId
              ? (sheetHistory?.get(panel.assetId) ?? [])
              : [];
            if (!panel || !panel.assetId || versions.length === 0) return null;
            return (
              <div className="rounded-token border border-line px-2.5 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted">
                    {panel.label} · 旧版 {versions.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => setHistoryAngle(null)}
                    className="text-[9.5px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
                  >
                    收起
                  </button>
                </div>
                <div className="mt-1.5 flex gap-2 overflow-x-auto">
                  {versions.map((version) => (
                    <figure key={version.asset.uri} className="w-[52px] shrink-0">
                      <div className="aspect-[9/16] overflow-hidden rounded-[1px] border border-line bg-[#0f1013]">
                        <img
                          src={assetHref(version.asset.uri ?? "")}
                          alt={`${character.name} · ${panel.label} · 旧版`}
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <button
                        type="button"
                        disabled={readOnly || character.status === "locked"}
                        onClick={() => {
                          if (onRestoreSheet(panel.assetId!, version.asset)) {
                            setHistoryAngle(null);
                          }
                        }}
                        title="把这一张换回当前版本：写一条 asset.updated，不重新生成、不花钱"
                        className="mt-0.5 w-full text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text disabled:pointer-events-none disabled:opacity-40"
                      >
                        用这版
                      </button>
                      <figcaption className="tnum mt-0.5 text-center text-[8px] text-muted-2">
                        {clock(version.at)}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            );
          })()}
          <ReferenceStrip
            references={character.references}
            startAt={1}
            readOnly={readOnly}
            emptyText="还没有参考图：表情表、服装变体、手拿道具都挂在这里。"
            onAdd={onAddReference}
            onRemove={onRemoveReference}
          />
          {/* 四格各自会送出的提示词（ADR-0148）：标一个角度改一段 */}
          <PromptEditor
            className="mt-1"
            tabs={character.panels.map((panel) => ({
              key: `sheet:${character.id}:${panel.angle}`,
              label: panel.label,
              prompt: buildSheetPrompt(
                {
                  name: character.name,
                  appearance: character.appearance,
                  mustNotChange: character.mustNotChange,
                },
                panel.angle,
              ),
            }))}
            values={promptOverrides}
            onChange={setPromptOverride}
            readOnly={readOnly}
          />
        </div>

        <div className="ml-auto flex w-[120px] shrink-0 flex-col items-end gap-2">
          {character.status === "locked" ? (
            <>
              <span className="tnum text-[9px] text-muted-2">{clock(character.lockedAt)} 锁</span>
              <button
                type="button"
                onClick={onUnlock}
                className="rounded-token border border-line px-3 py-1.5 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
              >
                解锁
              </button>
            </>
          ) : (
            <>
              {generating ? (
                <span className="tnum text-[9px] text-muted">生成中 · {SHEET_LABELS[generating]}</span>
              ) : (
                <button
                  type="button"
                  onClick={onGenerate}
                  className="rounded-token border border-line px-3 py-1.5 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  生成三视图
                  {quoteCny !== undefined && (
                    <span className="tnum mt-0.5 block text-[9.5px] text-muted-2">¥{quoteCny.toFixed(2)}</span>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={onLock}
                disabled={character.status === "incomplete"}
                title={
                  character.status === "incomplete"
                    ? "三视图缺格，补齐才能锁"
                    : "锁定后下游只能引用，不能替换"
                }
                className="rounded-token bg-text px-3 py-1.5 text-[11.5px] text-bg transition-opacity duration-[var(--dur)] hover:opacity-85 disabled:pointer-events-none disabled:opacity-30"
              >
                锁定定妆
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function LocationRow({
  location,
  generating,
  quoteCny,
  readOnly,
  onGenerate,
  onLock,
  onUnlock,
  onRename,
  onDescribe,
  onRemove,
  onBuildSpace,
  onAddReference,
  onRemoveReference,
  otherLocations,
  history,
  onRestoreText,
}: {
  location: CastLocationView;
  /** 主镜正在生成 */
  generating: boolean;
  /** 这一次生成要花多少（元）；价目不知道就不给 */
  quoteCny?: number;
  readOnly: boolean;
  onGenerate: () => void;
  onLock: () => void;
  onUnlock: () => void;
  /** 改名 / 换模板：成功返回 true，表单据此收起 */
  onRename: (name: string, templateId: string) => boolean;
  /** 改场景描述：成功返回 true，表单据此收起（ADR-0063） */
  onDescribe: (description: string) => boolean;
  /** 存量地点补几何（B13.1）：按模板写一条 location.updated { space } */
  onBuildSpace: () => void;
  /** 删掉这个地点：成功返回 true（ADR-0061 / ADR-0062） */
  onRemove: (moveToId?: string) => boolean;
  /** 挂一张参考图：成功返回 true（B8） */
  onAddReference: (uri: string) => boolean;
  onRemoveReference: (assetId: string) => void;
  /** 还有哪些地点可以搬：这一行自己不在里面 */
  otherLocations: { id: string; name: string }[];
  /** 名字 / 场景描述改过哪几版（ADR-0082） */
  history?: CastTextHistory;
  /** 整版写回：名字与描述一起换回那一版（ADR-0082） */
  onRestoreText: (version: CastTextVersion) => void;
}) {
  const promptOverrides = useWorkbench((state) => state.promptOverrides);
  const setPromptOverride = useWorkbench((state) => state.setPromptOverride);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moveTarget, setMoveTarget] = useState(otherLocations[0]?.id ?? "");
  const [draftName, setDraftName] = useState("");
  const [draftTemplate, setDraftTemplate] = useState(location.templateId ?? "doorway");
  const [describing, setDescribing] = useState(false);
  const [draftDescription, setDraftDescription] = useState("");
  const [showSpace, setShowSpace] = useState(false);

  const beginDescribe = () => {
    setDraftDescription(location.description);
    setDescribing(true);
  };

  const beginEdit = () => {
    setDraftName(location.name);
    setDraftTemplate(location.templateId ?? "doorway");
    setEditing(true);
  };

  return (
    <section className="border-t border-line py-5">
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-[168px] shrink-0">
          {editing ? (
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (onRename(draftName, draftTemplate)) setEditing(false);
              }}
            >
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditing(false);
                }}
                autoFocus
                aria-label="地点名字"
                className="w-full rounded-token border border-line-2 bg-surface px-2 py-1.5 text-[13px] text-text focus:border-pick focus:outline-none"
              />
              <select
                value={draftTemplate}
                onChange={(event) => setDraftTemplate(event.target.value)}
                aria-label="地点模板"
                className="w-full rounded-token border border-line bg-surface px-2 py-1.5 text-[11.5px] text-muted focus:border-pick focus:outline-none"
              >
                <optgroup label="场景模板">
                  {LOCATION_TEMPLATES.filter((item) => item.group === "scene").map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="旧方位模板">
                  {LOCATION_TEMPLATES.filter((item) => item.group === "legacy").map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </optgroup>
              </select>
              {(() => {
                const hint = LOCATION_TEMPLATES.find((item) => item.id === draftTemplate)?.hint;
                return hint ? (
                  <p className="text-[8.5px] leading-[1.55] text-muted-2">{hint}</p>
                ) : null;
              })()}
              <div className="flex gap-1.5">
                <button
                  type="submit"
                  className="rounded-token border border-line-2 px-2 py-0.5 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-token border border-line px-2 py-0.5 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  取消
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-2.5">
                <h2 className="text-[17px] leading-none text-text">{location.name}</h2>
                <StatusChip
                  status={location.status}
                  missingText={location.required ? "缺 主镜" : "未挂场次"}
                />
                {!readOnly && (
                  <button
                    type="button"
                    onClick={beginEdit}
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
                  >
                    改名
                  </button>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoveTarget(otherLocations[0]?.id ?? "");
                      setDeleting(true);
                    }}
                    disabled={location.required && otherLocations.length === 0}
                    title={
                      location.required && otherLocations.length === 0
                        ? "还有场次在这个地点，又没有别的地点可搬：先新建一个地点"
                        : location.required
                          ? "还有场次在这个地点：把它们搬到别处，再删"
                          : "删掉这个地点：日志里留一条记录，已经出的主镜图不删"
                    }
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-pick disabled:cursor-default disabled:opacity-40"
                  >
                    删
                  </button>
                )}
              </div>
              {(() => {
                const template = sceneTemplateById(location.templateId);
                return template ? (
                  <p className="mt-1.5 max-w-[168px] text-[8.5px] leading-[1.55] text-muted-2">
                    {describeSceneTemplate(template)}
                  </p>
                ) : null;
              })()}
              {location.space ? (
                <button
                  type="button"
                  onClick={() => setShowSpace((value) => !value)}
                  aria-expanded={showSpace}
                  className="mt-1.5 text-[9px] text-muted-2 underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
                >
                  {showSpace ? "收起空间" : "看空间"}
                </button>
              ) : sceneTemplateById(location.templateId) && !readOnly ? (
                <button
                  type="button"
                  onClick={onBuildSpace}
                  title="按模板生成锚点坐标：之后才能在分镜页摆位、判越轴"
                  className="mt-1.5 text-left text-[9px] text-muted-2 underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
                >
                  补空间坐标
                </button>
              ) : null}
              {deleting ? (
                <form
                  className="mt-2 flex flex-col gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (onRemove(location.required ? moveTarget : undefined)) setDeleting(false);
                  }}
                >
                  {location.required && (
                    <label className="flex flex-col gap-1 text-[9px] text-muted-2">
                      这一地点还有场次，先搬到哪里
                      <select
                        value={moveTarget}
                        onChange={(event) => setMoveTarget(event.target.value)}
                        autoFocus
                        aria-label="搬到哪个地点"
                        className="w-full rounded-token border border-line bg-surface px-1.5 py-1 text-[10.5px] text-text focus:border-pick focus:outline-none"
                      >
                        {otherLocations.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="flex gap-1.5">
                    <button
                      type="submit"
                      className="rounded-token border border-pick/70 px-2 py-0.5 text-[10.5px] text-pick transition-colors duration-[var(--dur)] hover:bg-pick hover:text-bg"
                    >
                      {location.required ? "搬过去再删" : "确认删"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleting(false)}
                      className="rounded-token border border-line px-2 py-0.5 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                    >
                      取消
                    </button>
                  </div>
                </form>
              ) : (
                <p className="tnum mt-2 text-[10px] text-muted-2">
                  {location.required ? "主镜 · 全场共用" : "主镜 · 还没挂场次"}
                </p>
              )}
            </>
          )}
        </div>

        <figure className="w-[120px]">
          <div className="relative aspect-[9/16] overflow-hidden rounded-[1px] border border-line bg-[#0f1013]">
            {location.masterUri ? (
              <img
                src={assetHref(location.masterUri)}
                alt={`${location.name} · 主镜`}
                className="h-full w-full object-cover"
              />
            ) : location.masterAssetId ? (
              <Scene kind={location.art} className="h-full w-full" />
            ) : (
              <span className="absolute inset-0 grid place-items-center text-[9px] text-muted-2">
                待生成
              </span>
            )}
            {location.masterStale && location.masterAssetId && !generating && (
              <span
                title={`主镜出图之后改过：${location.masterStale.reasons.join("、")}（${clock(location.masterStale.at)}），建议重生成`}
                className="absolute bottom-1.5 left-1.5 rounded-[1px] bg-pick/85 px-1 text-[8.5px] leading-[1.5] text-white"
              >
                过期
              </span>
            )}
            {generating && (
              <span className="absolute inset-0 grid place-items-center bg-bg/75 text-[9px] text-text">
                生成中…
              </span>
            )}
          </div>
          <figcaption className="tnum mt-1.5 text-[9px] text-muted-2">master</figcaption>
        </figure>

        <div className="flex max-w-[38ch] flex-col gap-1.5 self-center">
          {describing ? (
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (onDescribe(draftDescription)) setDescribing(false);
              }}
            >
              <textarea
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setDescribing(false);
                }}
                autoFocus
                rows={3}
                aria-label="场景描述"
                placeholder="老楼走廊，声控灯，墙皮起了卷"
                className="w-full resize-none rounded-token border border-line-2 bg-surface px-2 py-1.5 text-[11.5px] leading-[1.6] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
              />
              <p className="text-[9px] leading-[1.5] text-muted-2">
                整句进主镜提示词：空间、陈设、光线，200 字以内。
              </p>
              <div className="flex gap-1.5">
                <button
                  type="submit"
                  className="rounded-token border border-line-2 px-2 py-0.5 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => setDescribing(false)}
                  className="rounded-token border border-line px-2 py-0.5 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  取消
                </button>
              </div>
            </form>
          ) : (
            <>
              {readOnly ? (
                <p className="text-[11.5px] leading-[1.6] text-text">
                  {location.description || "这个地点还没写场景描述。"}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={beginDescribe}
                  title="写一句这地方长什么样：会整句进主镜提示词"
                  className="text-left transition-colors duration-[var(--dur)]"
                >
                  {location.description ? (
                    <span className="text-[11.5px] leading-[1.6] text-text">{location.description}</span>
                  ) : (
                    <span className="text-[11px] leading-[1.6] text-muted-2">＋ 写一句这地方长什么样</span>
                  )}
                </button>
              )}
              <p className="text-[9px] leading-[1.6] text-muted-2">
                同一场的所有镜头都带这张图进生成，房间不许每镜重新想象。
              </p>
              <TextHistoryLine
                history={history}
                name={location.name}
                body={location.description}
                readOnly={readOnly}
                onRestore={onRestoreText}
              />
            </>
          )}
        </div>

        <div className="ml-auto flex w-[120px] shrink-0 flex-col items-end gap-2">
          {location.status === "locked" ? (
            <>
              <span className="tnum text-[9px] text-muted-2">{clock(location.lockedAt)} 锁</span>
              <button
                type="button"
                onClick={onUnlock}
                className="rounded-token border border-line px-3 py-1.5 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
              >
                解锁
              </button>
            </>
          ) : (
            <>
              {generating ? (
                <span className="tnum text-[9px] text-muted">生成中…</span>
              ) : (
                <button
                  type="button"
                  onClick={onGenerate}
                  className="rounded-token border border-line px-3 py-1.5 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  生成主镜
                  {quoteCny !== undefined && (
                    <span className="tnum mt-0.5 block text-[9.5px] text-muted-2">¥{quoteCny.toFixed(2)}</span>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={onLock}
                disabled={location.status === "incomplete"}
                title={location.status === "incomplete" ? "还没有主镜" : "锁定后下游只能引用，不能替换"}
                className="rounded-token bg-text px-3 py-1.5 text-[11.5px] text-bg transition-opacity duration-[var(--dur)] hover:opacity-85 disabled:pointer-events-none disabled:opacity-30"
              >
                锁定主镜
              </button>
            </>
          )}
        </div>
      </div>
      {/* 主镜这一版会送出的提示词（ADR-0148） */}
      <div className="mt-3 max-w-[560px]">
        <PromptEditor
          tabs={[
            {
              key: `master:${location.id}`,
              label: "主镜",
              prompt: buildMasterPrompt({
                name: location.name,
                description: location.description,
              }),
            },
          ]}
          values={promptOverrides}
          onChange={setPromptOverride}
          readOnly={readOnly}
        />
      </div>

      <div className="mt-3 max-w-[560px]">
        <ReferenceStrip
          references={location.references}
          startAt={1}
          readOnly={readOnly}
          emptyText="还没有参考图：同一个房间的别的角度、细节、光线参考都挂在这里。"
          onAdd={onAddReference}
          onRemove={onRemoveReference}
        />
      </div>

      {showSpace && location.space && (
        <div className="mt-4 flex flex-wrap items-start gap-4">
          <BlockingBoard
            space={location.space}
            actors={[]}
            className="w-[300px] shrink-0"
            caption="场地几何 · 锚点与尺寸"
          />
          <div className="max-w-[38ch] text-[9px] leading-[1.7] text-muted-2">
            <p>
              坐标单位米，原点在房间中心地面。人物与机位的摆位在分镜页的「走位」里做——
              那里才有镜头。
            </p>
            <p className="mt-1.5">
              {location.space.anchors.length} 个锚点：
              {location.space.anchors
                .slice(0, 6)
                .map((anchor) => anchor.label || anchor.id)
                .join("、")}
              {location.space.anchors.length > 6 ? "…" : ""}
            </p>
            <p className="mt-1.5">这是俯视平面图，不是最终画面：没有相机高度与遮挡。</p>
          </div>
        </div>
      )}
    </section>
  );
}

function PropRow({
  prop,
  readOnly,
  generating,
  quoteCny,
  onGenerate,
  onLock,
  onUnlock,
  onEdit,
  onRemove,
  onAddReference,
  onRemoveReference,
  history,
  onRestoreText,
}: {
  prop: CastPropView;
  readOnly: boolean;
  /** 参考图正在生成 */
  generating: boolean;
  /** 这一次生成要花多少（元）；价目不知道就不给 */
  quoteCny?: number;
  onGenerate: () => void;
  onLock: () => void;
  onUnlock: () => void;
  /** 改名字 / 描述：成功返回 true，表单据此收起（ADR-0072） */
  onEdit: (name: string, description: string) => boolean;
  /** 删掉这件道具：成功返回 true（ADR-0073） */
  onRemove: () => boolean;
  /** 挂一张参考图：成功返回 true（ADR-0079） */
  onAddReference: (uri: string) => boolean;
  onRemoveReference: (assetId: string) => void;
  /** 名字 / 描述改过哪几版（ADR-0082） */
  history?: CastTextHistory;
  /** 整版写回：名字与描述一起换回那一版（ADR-0082） */
  onRestoreText: (version: CastTextVersion) => void;
}) {
  const promptOverrides = useWorkbench((state) => state.promptOverrides);
  const setPromptOverride = useWorkbench((state) => state.setPromptOverride);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");

  const beginEdit = () => {
    setDraftName(prop.name);
    setDraftDescription(prop.description);
    setEditing(true);
  };

  return (
    <section className="border-t border-line py-5">
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-[168px] shrink-0">
          {editing ? (
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (onEdit(draftName, draftDescription)) setEditing(false);
              }}
            >
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditing(false);
                }}
                autoFocus
                aria-label="道具名字"
                className="w-full rounded-token border border-line-2 bg-surface px-2 py-1.5 text-[13px] text-text focus:border-pick focus:outline-none"
              />
              <textarea
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditing(false);
                }}
                rows={3}
                aria-label="道具描述"
                placeholder="长什么样：白底蓝边搪瓷缸，杯沿有一道旧磕痕"
                className="w-full resize-none rounded-token border border-line bg-surface px-2 py-1.5 text-[11px] leading-[1.6] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
              />
              <p className="text-[9px] leading-[1.5] text-muted-2">
                描述整句进提示词，200 字以内；参考图不跟着变。
              </p>
              <div className="flex gap-1.5">
                <button
                  type="submit"
                  className="rounded-token border border-line-2 px-2 py-0.5 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-token border border-line px-2 py-0.5 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  取消
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-2.5">
                <h2 className="text-[17px] leading-none text-text">{prop.name}</h2>
                <StatusChip status={prop.status} missingText="缺参考图" />
                {!readOnly && (
                  <button
                    type="button"
                    onClick={beginEdit}
                    title="改名字或描述"
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
                  >
                    改
                  </button>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => setDeleting(true)}
                    disabled={deleting}
                    title="删掉这件道具：还在镜头里时删不掉"
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-pick disabled:cursor-default"
                  >
                    删
                  </button>
                )}
              </div>
              {deleting && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[9px]">
                  <span className="text-muted-2">删这件道具？</span>
                  <button
                    type="button"
                    onClick={() => {
                      // 删不掉也收起确认：原因写在页头，停在原地只会让几个确认框叠在一起
                      onRemove();
                      setDeleting(false);
                    }}
                    className="rounded-token border border-pick/70 px-1.5 py-px text-pick transition-colors duration-[var(--dur)] hover:bg-pick hover:text-bg"
                  >
                    确认删
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleting(false)}
                    className="rounded-token border border-line px-1.5 py-px text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                  >
                    取消
                  </button>
                </div>
              )}
              <p className="mt-2 text-[11px] leading-[1.5] text-muted">
                {prop.description || "还没写道具描述。"}
              </p>
              <TextHistoryLine
                history={history}
                name={prop.name}
                body={prop.description}
                readOnly={readOnly}
                onRestore={onRestoreText}
              />
            </>
          )}
        </div>

        <figure className="w-[120px]">
          <div className="relative aspect-[9/16] overflow-hidden rounded-[1px] border border-line bg-[#0f1013]">
            {prop.referenceUri ? (
              <img
                src={assetHref(prop.referenceUri)}
                alt={`${prop.name} · 参考图`}
                className="h-full w-full object-cover"
              />
            ) : prop.referenceAssetId ? (
              <PropObject kind={prop.art} className="h-full w-full" />
            ) : (
              <span className="absolute inset-0 grid place-items-center text-[9px] text-muted-2">
                待生成
              </span>
            )}
            {generating && (
              <span className="absolute inset-0 grid place-items-center bg-bg/75 text-[9px] text-text">
                生成中…
              </span>
            )}
            {!readOnly && prop.referenceAssetId && (
              <button
                type="button"
                aria-label="摘掉第 1 张参考图"
                title="摘掉：图还留在资产里，可以再挂回来"
                onClick={() => onRemoveReference(prop.referenceAssetId!)}
                className="absolute right-0.5 top-0.5 grid h-3.5 w-3.5 place-items-center rounded-[1px] bg-bg/80 text-[9px] leading-none text-muted-2 transition-colors duration-[var(--dur)] hover:text-pick"
              >
                ×
              </button>
            )}
          </div>
          <figcaption className="tnum mt-1.5 text-[9px] text-muted-2">ref 1</figcaption>
        </figure>

        <ReferenceStrip
          references={prop.references.slice(1)}
          startAt={2}
          readOnly={readOnly}
          onAdd={onAddReference}
          onRemove={onRemoveReference}
        />

        <div className="max-w-[38ch] self-center">
          <p className="text-[11px] leading-[1.6] text-muted-2">
            在镜头里出现，就要有一张参考图。锁住后，带它的镜头都引这一张。
          </p>
        </div>

        <div className="ml-auto flex w-[120px] shrink-0 flex-col items-end gap-2">
          {prop.status === "locked" ? (
            <>
              <span className="tnum text-[9px] text-muted-2">{clock(prop.lockedAt)} 锁</span>
              <button
                type="button"
                onClick={onUnlock}
                className="rounded-token border border-line px-3 py-1.5 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
              >
                解锁
              </button>
            </>
          ) : (
            <>
              {generating ? (
                <span className="tnum text-[9px] text-muted">生成中…</span>
              ) : (
                <button
                  type="button"
                  onClick={onGenerate}
                  className="rounded-token border border-line px-3 py-1.5 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  生成参考图
                  {quoteCny !== undefined && (
                    <span className="tnum mt-0.5 block text-[9.5px] text-muted-2">¥{quoteCny.toFixed(2)}</span>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={onLock}
                disabled={prop.status === "incomplete"}
                title={prop.status === "incomplete" ? "还没有参考图" : "锁定后下游只能引用，不能替换"}
                className="rounded-token bg-text px-3 py-1.5 text-[11.5px] text-bg transition-opacity duration-[var(--dur)] hover:opacity-85 disabled:pointer-events-none disabled:opacity-30"
              >
                锁定道具
              </button>
            </>
          )}
        </div>
      </div>

      {/* 参考图这一版会送出的提示词（ADR-0148） */}
      <div className="mt-3 max-w-[560px]">
        <PromptEditor
          tabs={[
            {
              key: `prop:${prop.id}`,
              label: "参考图",
              prompt: buildPropPrompt({ name: prop.name, description: prop.description }),
            },
          ]}
          values={promptOverrides}
          onChange={setPromptOverride}
          readOnly={readOnly}
        />
      </div>
    </section>
  );
}

export function CastScreen() {
  const project = useWorkbench((state) => state.project);
  const lockCast = useWorkbench((state) => state.lockCast);
  const unlockCast = useWorkbench((state) => state.unlockCast);
  const generateSheet = useWorkbench((state) => state.generateSheet);
  const restoreSheetAsset = useWorkbench((state) => state.restoreSheetAsset);
  const generateMaster = useWorkbench((state) => state.generateMaster);
  const generateProp = useWorkbench((state) => state.generateProp);
  const jobs = useWorkbench((state) => state.jobs);
  const castError = useWorkbench((state) => state.castError);
  const hydrate = useWorkbench((state) => state.hydrate);
  const storageError = useWorkbench((state) => state.storageError);
  const readOnly = useWorkbench((state) => state.readOnly);
  const imageCny = useWorkbench((state) => state.imageCny);
  const setImagePrice = useWorkbench((state) => state.setImagePrice);
  const setBudget = useWorkbench((state) => state.setBudget);
  const addLocation = useWorkbench((state) => state.addLocation);
  const editLocation = useWorkbench((state) => state.editLocation);
  const removeLocation = useWorkbench((state) => state.removeLocation);
  const addCharacter = useWorkbench((state) => state.addCharacter);
  const addCharacterReference = useWorkbench((state) => state.addCharacterReference);
  const removeCharacterReference = useWorkbench((state) => state.removeCharacterReference);
  const addPropReference = useWorkbench((state) => state.addPropReference);
  const removePropReference = useWorkbench((state) => state.removePropReference);
  const addLocationReference = useWorkbench((state) => state.addLocationReference);
  const removeLocationReference = useWorkbench((state) => state.removeLocationReference);
  const editCharacter = useWorkbench((state) => state.editCharacter);
  const addProp = useWorkbench((state) => state.addProp);
  const editProp = useWorkbench((state) => state.editProp);
  const removeCharacter = useWorkbench((state) => state.removeCharacter);
  const addMustNotChange = useWorkbench((state) => state.addMustNotChange);
  const removeMustNotChange = useWorkbench((state) => state.removeMustNotChange);
  const undoLastRemoval = useWorkbench((state) => state.undoLastRemoval);
  const removeProp = useWorkbench((state) => state.removeProp);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTemplate, setNewTemplate] = useState<string>("doorway");
  const [newDescription, setNewDescription] = useState("");
  const [creatingCharacter, setCreatingCharacter] = useState(false);
  const [newCharacterName, setNewCharacterName] = useState("");
  const [newCharacterAppearance, setNewCharacterAppearance] = useState("");
  const [creatingProp, setCreatingProp] = useState(false);
  const [newPropName, setNewPropName] = useState("");
  const [newPropDescription, setNewPropDescription] = useState("");

  const closeCreateCharacter = () => {
    setCreatingCharacter(false);
    setNewCharacterName("");
    setNewCharacterAppearance("");
  };

  const closeCreateProp = () => {
    setCreatingProp(false);
    setNewPropName("");
    setNewPropDescription("");
  };

  const closeCreate = () => {
    setCreating(false);
    setNewName("");
    setNewTemplate("doorway");
    setNewDescription("");
  };

  useEffect(() => {
    void hydrate();
    // 单价在服务端：进页面问一次，用来显示"这一格多少钱"并在提交前拦超预算
    void fetchImagePrice().then((price) => {
      if (price) setImagePrice(price);
    });
  }, [hydrate, setImagePrice, project.models.image]);

  const events = useWorkbench((state) => state.events);
  const cast = useMemo(() => toCastView(project, events), [project, events]);
  const sheetHistory = useMemo(() => sheetAssetHistory(events), [events]);
  const removal = useMemo(() => undoableRemoval(events, project), [events, project]);
  /** 定妆页只管人物 / 道具 / 地点的撤销：场次与镜头在剧本页 */
  const pageRemoval =
    removal && (removal.kind === "character" || removal.kind === "prop" || removal.kind === "location")
      ? removal
      : undefined;
  const removalNoun =
    pageRemoval?.kind === "character" ? "人物" : pageRemoval?.kind === "prop" ? "道具" : "地点";
  const progress = cast.totalRequired === 0 ? 0 : (cast.lockedCount / cast.totalRequired) * 100;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
      <TopBar
        title={project.title}
        version={project.version}
        stage="定妆"
        spentCny={cast.spend.spent}
        budgetCny={project.budgetCny}
        unpriced={cast.spend.unpriced}
        spendBreakdown={cast.spend}
        storageError={storageError}
        readOnly={readOnly}
        onBudgetChange={setBudget}
      />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1080px] px-5 pb-10 pt-7 sm:px-8">
          <header>
            <h1 className="text-[20px] leading-none tracking-[.02em] text-text">定妆</h1>
            <p className="mt-2.5 max-w-[52ch] text-[12.5px] leading-[1.6] text-muted">
              先把脸和空间钉住，再谈镜头。锁定的资产下游只能引用，换人要重新解锁并留痕。
            </p>

            <div className="mt-5 flex items-center gap-3">
              <span className="tnum text-[10px] text-muted">
                {cast.lockedCount} / {cast.totalRequired} 已锁定
              </span>
              <span className="h-px flex-1 bg-line">
                <span
                  className="block h-px bg-text transition-[width] duration-[var(--dur)]"
                  style={{ width: `${progress}%` }}
                />
              </span>
            </div>

            {castError && (
              <p className="mt-3 max-w-[60ch] text-[10.5px] leading-[1.6] text-pick">
                {castError}
              </p>
            )}

            {!readOnly && pageRemoval && (
              <p className="mt-2 flex flex-wrap items-center gap-2 text-[10.5px] text-muted">
                <span className="text-muted-2">
                  刚删掉{removalNoun}「{pageRemoval.label}」
                </span>
                <button
                  type="button"
                  onClick={() => undoLastRemoval()}
                  title="把它和它的资产引用一起放回来"
                  className="rounded-token border border-line px-1.5 py-px text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  撤销
                </button>
              </p>
            )}
          </header>

          <section className="mt-7">
            <div className="flex items-center justify-between gap-3">
              <h2 className="tnum text-[9px] tracking-[.14em] text-muted-2">人物 · 三视图</h2>
              {!readOnly && !creatingCharacter && (
                <button
                  type="button"
                  onClick={() => setCreatingCharacter(true)}
                  className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  新建人物
                </button>
              )}
            </div>

            {creatingCharacter && (
              <form
                className="mt-3 flex flex-wrap items-center gap-2 rounded-token border border-dashed border-line-2 px-3 py-2.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (addCharacter(newCharacterName, newCharacterAppearance)) closeCreateCharacter();
                }}
              >
                <input
                  type="text"
                  value={newCharacterName}
                  onChange={(event) => setNewCharacterName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") closeCreateCharacter();
                  }}
                  autoFocus
                  aria-label="新人物名字"
                  placeholder="人物名字：林 · 周 · 阿棠"
                  className="min-w-[220px] flex-1 bg-transparent text-[12.5px] text-text placeholder:text-muted-2 focus:outline-none"
                />
                <button
                  type="submit"
                  className="rounded-token border border-line-2 px-2.5 py-1 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                >
                  创建
                </button>
                <button
                  type="button"
                  onClick={closeCreateCharacter}
                  className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  取消
                </button>
                <textarea
                  value={newCharacterAppearance}
                  onChange={(event) => setNewCharacterAppearance(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") closeCreateCharacter();
                  }}
                  rows={2}
                  aria-label="新人物外形"
                  placeholder="外形：短发、深色外套、左眼下一颗痣（选填，会进提示词）"
                  className="w-full resize-none rounded-token border border-line bg-surface px-2 py-1.5 text-[11.5px] leading-[1.6] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
                />
                <span className="w-full text-[10px] text-muted-2">
                  三视图随后一张张生成；外形描述 200 字以内。
                </span>
              </form>
            )}

            {cast.characters.map((character) => {
              const job = jobs[character.id];
              return (
                <CharacterRow
                  key={character.id}
                  character={character}
                  readOnly={readOnly ?? false}
                  generating={job?.kind === "sheet" ? job.angle : undefined}
                  quoteCny={
                    imageCny === undefined
                      ? undefined
                      : imageCny * character.panels.filter((panel) => panel.assetId).length
                  }
                  onGenerate={() => void generateSheet(character.id)}
                  onLock={() => lockCast("character", character.id)}
                  onUnlock={() => unlockCast("character", character.id)}
                  onEdit={(name, appearance) =>
                    editCharacter(character.id, { name, appearance })
                  }
                  onRemove={() => removeCharacter(character.id)}
                  onAddMustNotChange={(text) => addMustNotChange(character.id, text)}
                  onRemoveMustNotChange={(text) =>
                    removeMustNotChange(character.id, text)
                  }
                  onAddReference={(uri) => addCharacterReference(character.id, uri)}
                  onRemoveReference={(assetId) =>
                    removeCharacterReference(character.id, assetId)
                  }
                  history={castTextHistory(events, "character", character.id)}
                  onRestoreText={(version) =>
                    editCharacter(character.id, { name: version.name, appearance: version.body })
                  }
                  sheetHistory={sheetHistory}
                  onRestoreSheet={restoreSheetAsset}
                />
              );
            })}
          </section>

          <section className="mt-8">
            <div className="flex items-center justify-between gap-3">
              <h2 className="tnum text-[9px] tracking-[.14em] text-muted-2">场景 · 主镜</h2>
              {!readOnly && !creating && (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  新建地点
                </button>
              )}
            </div>

            {creating && (
              <form
                className="mt-3 flex flex-wrap items-center gap-2 rounded-token border border-dashed border-line-2 px-3 py-2.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (addLocation(newName, newTemplate, newDescription)) closeCreate();
                }}
              >
                <input
                  type="text"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") closeCreate();
                  }}
                  autoFocus
                  aria-label="新地点名字"
                  placeholder="地点名字：阳台 · 楼梯间 · 便利店门口"
                  className="min-w-[220px] flex-1 bg-transparent text-[12.5px] text-text placeholder:text-muted-2 focus:outline-none"
                />
                <select
                  value={newTemplate}
                  onChange={(event) => setNewTemplate(event.target.value)}
                  aria-label="新地点模板"
                  className="rounded-token border border-line bg-surface px-2 py-1 text-[11px] text-muted focus:border-pick focus:outline-none"
                >
                  {LOCATION_TEMPLATES.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="rounded-token border border-line-2 px-2.5 py-1 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                >
                  创建
                </button>
                <button
                  type="button"
                  onClick={closeCreate}
                  className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  取消
                </button>
                <textarea
                  value={newDescription}
                  onChange={(event) => setNewDescription(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") closeCreate();
                  }}
                  rows={2}
                  aria-label="新地点描述"
                  placeholder="这地方长什么样：空间、陈设、光线（选填，会进主镜提示词）"
                  className="w-full resize-none rounded-token border border-line bg-surface px-2 py-1.5 text-[11.5px] leading-[1.6] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
                />
                <span className="w-full text-[10px] text-muted-2">
                  建好后到剧本页把它挂到场上，场次才有地方发生。
                </span>
              </form>
            )}

            {cast.locations.map((location) => (
              <LocationRow
                key={location.id}
                location={location}
                generating={jobs[location.id]?.kind === "master"}
                quoteCny={imageCny}
                readOnly={readOnly ?? false}
                onGenerate={() => void generateMaster(location.id)}
                onLock={() => lockCast("location", location.id)}
                onUnlock={() => unlockCast("location", location.id)}
                onRename={(name, templateId) => editLocation(location.id, { name, templateId })}
                onDescribe={(description) => editLocation(location.id, { description })}
                onBuildSpace={() => {
                  const template = sceneTemplateById(location.templateId);
                  if (template) editLocation(location.id, { space: templateSpace(template) });
                }}
                onRemove={(moveToId) => removeLocation(location.id, moveToId)}
                onAddReference={(uri) => addLocationReference(location.id, uri)}
                onRemoveReference={(assetId) =>
                  removeLocationReference(location.id, assetId)
                }
                otherLocations={cast.locations
                  .filter((item) => item.id !== location.id)
                  .map((item) => ({ id: item.id, name: item.name }))}
                history={castTextHistory(events, "location", location.id)}
                onRestoreText={(version) =>
                  editLocation(location.id, { name: version.name, description: version.body })
                }
              />
            ))}
          </section>

          {cast.props.length > 0 && (
            <section className="mt-8">
              <div className="flex items-center justify-between gap-3">
                <h2 className="tnum text-[9px] tracking-[.14em] text-muted-2">道具 · 参考</h2>
                {!readOnly && !creatingProp && (
                  <button
                    type="button"
                    onClick={() => setCreatingProp(true)}
                    className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                  >
                    新建道具
                  </button>
                )}
              </div>

              {creatingProp && (
                <form
                  className="mt-3 flex flex-wrap items-center gap-2 rounded-token border border-dashed border-line-2 px-3 py-2.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (addProp(newPropName, newPropDescription)) closeCreateProp();
                  }}
                >
                  <input
                    type="text"
                    value={newPropName}
                    onChange={(event) => setNewPropName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") closeCreateProp();
                    }}
                    autoFocus
                    aria-label="新道具名字"
                    placeholder="道具名字：搪瓷杯 · 台灯 · 旧钥匙"
                    className="min-w-[220px] flex-1 bg-transparent text-[12.5px] text-text placeholder:text-muted-2 focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="rounded-token border border-line-2 px-2.5 py-1 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                  >
                    创建
                  </button>
                  <button
                    type="button"
                    onClick={closeCreateProp}
                    className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                  >
                    取消
                  </button>
                  <textarea
                    value={newPropDescription}
                    onChange={(event) => setNewPropDescription(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") closeCreateProp();
                    }}
                    rows={2}
                    aria-label="新道具描述"
                    placeholder="长什么样：白底蓝边搪瓷缸，杯沿有一道旧磕痕（选填，会进提示词）"
                    className="w-full resize-none rounded-token border border-line bg-surface px-2 py-1.5 text-[11.5px] leading-[1.6] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
                  />
                  <span className="w-full text-[10px] text-muted-2">
                    参考图随后生成；描述 200 字以内。
                  </span>
                </form>
              )}

              {cast.props.length === 0 && (
                <p className="mt-3 rounded-token border border-dashed border-line px-3 py-5 text-center text-[10.5px] leading-[1.8] text-muted-2">
                  还没有道具。上面新建一件，再到分镜页把它点进出场。
                </p>
              )}

              {cast.props.map((prop) => (
                <PropRow
                  key={prop.id}
                  prop={prop}
                  readOnly={readOnly ?? false}
                  generating={jobs[prop.id]?.kind === "prop"}
                  quoteCny={imageCny}
                  onGenerate={() => void generateProp(prop.id)}
                  onLock={() => lockCast("prop", prop.id)}
                  onUnlock={() => unlockCast("prop", prop.id)}
                  onEdit={(name, description) => editProp(prop.id, { name, description })}
                  onRemove={() => removeProp(prop.id)}
                  onAddReference={(uri) => addPropReference(prop.id, uri)}
                  onRemoveReference={(assetId) => removePropReference(prop.id, assetId)}
                  history={castTextHistory(events, "prop", prop.id)}
                  onRestoreText={(version) =>
                    editProp(prop.id, { name: version.name, description: version.body })
                  }
                />
              ))}
            </section>
          )}
        </div>
      </main>

      <StageGate stage="cast" />
    </div>
  );
}
