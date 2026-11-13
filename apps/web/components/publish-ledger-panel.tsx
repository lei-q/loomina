"use client";

import { useEffect, useMemo, useState } from "react";
import type { Project, PublishPackage } from "@loomina/ir";
import { PLATFORM_SPECS } from "@/lib/platforms";
import { cn } from "@/lib/utils";

export type PublishReceiptPatch = Partial<
  Pick<PublishPackage, "publishedAt" | "url" | "receipt" | "note">
>;

export type PublishLedgerPanelProps = {
  project: Project;
  /** 记一次回执：只写有变化的字段；返回是否真的写了 */
  onSave: (packageId: string, patch: PublishReceiptPatch) => boolean;
  readOnly?: boolean;
  onClose: () => void;
};

const FIELD_KEYS = ["publishedAt", "url", "receipt", "note"] as const;

function platformName(id: string): string {
  return PLATFORM_SPECS.find((spec) => spec.id === id)?.name ?? id;
}

/** 本机时间 → `2026-11-13 21:04`；回执里存的是人看得懂的绝对时间 */
function nowText(): string {
  const at = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * 记录时间 → `2026-11-13 14:04`。
 *
 * `recordedAt` 是 ISO 的 UTC（`2026-11-13T06:04:00.000Z`），直接切前 16 位
 * 会把 UTC 当成本机时间显示——下午两点导的片子写着早上六点。
 */
function recordedText(iso?: string): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function sizeText(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 发布台账（G10 / ADR-0166）。
 *
 * 每一份发布包都是导出那一刻的事实：平台、档位、文件、指纹，这里只读。
 * 能改的只有发布之后才有的四项——什么时候发出去、发在哪、平台回了什么、这一版为什么发。
 * 已发 / 未发按 `publishedAt` 分，不按导出时间猜。
 */
export function PublishLedgerPanel({
  project,
  onSave,
  readOnly = false,
  onClose,
}: PublishLedgerPanelProps) {
  const packs = useMemo(
    () => [...project.publishPackages].reverse(),
    [project.publishPackages],
  );
  const published = packs.filter((pack) => pack.publishedAt?.trim()).length;
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState<Record<(typeof FIELD_KEYS)[number], string>>({
    publishedAt: "",
    url: "",
    receipt: "",
    note: "",
  });
  const [flash, setFlash] = useState("");

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const openEditor = (pack: PublishPackage) => {
    setEditing(pack.id);
    setFlash("");
    setDraft({
      publishedAt: pack.publishedAt ?? "",
      url: pack.url ?? "",
      receipt: pack.receipt ?? "",
      note: pack.note ?? "",
    });
  };

  const save = (pack: PublishPackage) => {
    const ok = onSave(pack.id, {
      publishedAt: draft.publishedAt,
      url: draft.url,
      receipt: draft.receipt,
      note: draft.note,
    });
    setFlash(
      ok
        ? "回执已记进台账。"
        : readOnly
          ? "项目是只读的，这次没有记上。"
          : "没有改动：四项和原来一样。",
    );
    if (ok) setEditing(undefined);
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="发布台账"
        className="flex h-full w-[470px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">发布台账</h2>
            <span className="tnum text-[9px] text-muted-2">
              {packs.length} 份 · {published} 份已发
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
            导出发布包时自动记一条。平台、档位、文件与 AI 指纹是导出那一刻的事实，这里只读；
            发出去之后把时间、链接和平台回执贴回来，台账才说得出「哪一版真的发了」。
          </p>

          {packs.length === 0 ? (
            <p className="mt-4 border border-line px-3 py-3 text-[10.5px] leading-[1.7] text-muted">
              还没有发布记录。在下面「导出发布包」之后，这里会出现第一条。
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {packs.map((pack, index) => {
                const isEditing = editing === pack.id;
                const isPublished = Boolean(pack.publishedAt?.trim());
                return (
                  <li
                    key={pack.id}
                    className={cn(
                      "border px-3 py-2.5",
                      isPublished ? "border-line" : "border-line-2 border-dashed",
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-[10.5px] text-text">{platformName(pack.platform)}</span>
                        <span className="tnum text-[9px] text-muted-2">
                          {packs.length - index} / {packs.length}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "text-[8.5px] tracking-[.06em]",
                          isPublished ? "text-muted" : "text-pick",
                        )}
                      >
                        {isPublished ? "已发布" : "未发布"}
                      </span>
                    </div>

                    <dl className="mt-1.5 space-y-0.5 text-[9px] leading-[1.6] text-muted-2">
                      <div className="flex gap-1.5">
                        <dt className="shrink-0">导出</dt>
                        <dd className="tnum min-w-0 break-all">
                          {recordedText(pack.recordedAt)}
                          {pack.quality ? ` · ${pack.quality === "final" ? "定稿" : "草稿"}` : ""}
                          {pack.fileName ? ` · ${pack.fileName}` : ""}
                          {pack.bytes !== undefined ? ` · ${sizeText(pack.bytes)}` : ""}
                        </dd>
                      </div>
                      <div className="flex gap-1.5">
                        <dt className="shrink-0">指纹</dt>
                        <dd className="tnum min-w-0 break-all">
                          {pack.aiLabel?.contentHash ?? "—"}
                          {pack.renderMs !== undefined
                            ? ` · 渲染 ${(pack.renderMs / 1000).toFixed(1)}s`
                            : ""}
                        </dd>
                      </div>
                      {!isEditing && pack.publishedAt?.trim() && (
                        <div className="flex gap-1.5">
                          <dt className="shrink-0">发布</dt>
                          <dd className="tnum min-w-0 break-all">{pack.publishedAt}</dd>
                        </div>
                      )}
                      {!isEditing && pack.url?.trim() && (
                        <div className="flex gap-1.5">
                          <dt className="shrink-0">链接</dt>
                          <dd className="min-w-0 break-all text-muted">{pack.url}</dd>
                        </div>
                      )}
                      {!isEditing && pack.receipt?.trim() && (
                        <div className="flex gap-1.5">
                          <dt className="shrink-0">回执</dt>
                          <dd className="min-w-0 break-words text-muted">{pack.receipt}</dd>
                        </div>
                      )}
                      {!isEditing && pack.note?.trim() && (
                        <div className="flex gap-1.5">
                          <dt className="shrink-0">备注</dt>
                          <dd className="min-w-0 break-words text-muted">{pack.note}</dd>
                        </div>
                      )}
                    </dl>

                    {isEditing ? (
                      <div className="mt-2 space-y-1.5 border-t border-line pt-2">
                        <label className="block">
                          <span className="text-[9px] text-muted-2">发布时间</span>
                          <span className="mt-0.5 flex gap-1.5">
                            <input
                              id={`pub-at-${pack.id}`}
                              value={draft.publishedAt}
                              onChange={(event) =>
                                setDraft((prev) => ({ ...prev, publishedAt: event.target.value }))
                              }
                              placeholder="2026-11-13 21:04"
                              maxLength={40}
                              className="min-w-0 flex-1 rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                            />
                            <button
                              type="button"
                              disabled={readOnly}
                              onClick={() =>
                                setDraft((prev) => ({ ...prev, publishedAt: nowText() }))
                              }
                              title="填成现在的时间"
                              className="shrink-0 rounded-token border border-line px-2 py-1 text-[9.5px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
                            >
                              现在
                            </button>
                          </span>
                        </label>
                        <label className="block">
                          <span className="text-[9px] text-muted-2">链接</span>
                          <input
                            id={`pub-url-${pack.id}`}
                            value={draft.url}
                            onChange={(event) =>
                              setDraft((prev) => ({ ...prev, url: event.target.value }))
                            }
                            placeholder="https://"
                            maxLength={300}
                            className="mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                          />
                        </label>
                        <label className="block">
                          <span className="text-[9px] text-muted-2">平台回执</span>
                          <input
                            id={`pub-receipt-${pack.id}`}
                            value={draft.receipt}
                            onChange={(event) =>
                              setDraft((prev) => ({ ...prev, receipt: event.target.value }))
                            }
                            placeholder="已通过审核 / 播放量 / 驳回原因"
                            maxLength={200}
                            className="mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                          />
                        </label>
                        <label className="block">
                          <span className="text-[9px] text-muted-2">备注</span>
                          <input
                            id={`pub-note-${pack.id}`}
                            value={draft.note}
                            onChange={(event) =>
                              setDraft((prev) => ({ ...prev, note: event.target.value }))
                            }
                            placeholder="投了哪个号 / 为什么重发"
                            maxLength={200}
                            className="mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                          />
                        </label>
                        <div className="flex items-center gap-1.5 pt-0.5">
                          <button
                            type="button"
                            onClick={() => save(pack)}
                            disabled={readOnly}
                            className="rounded-token border border-pick bg-pick px-2.5 py-1 text-[10px] text-white transition-opacity duration-[var(--dur)] enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            记进台账
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditing(undefined)}
                            className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                          >
                            取消
                          </button>
                          {flash && <span className="text-[9px] text-muted">{flash}</span>}
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openEditor(pack)}
                        className="mt-2 rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                      >
                        {isPublished || pack.url || pack.receipt || pack.note
                          ? "改回执"
                          : "贴回执"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {flash && !editing && (
            <p className="mt-2 text-[9.5px] text-muted">{flash}</p>
          )}
        </div>
      </aside>
    </div>
  );
}
