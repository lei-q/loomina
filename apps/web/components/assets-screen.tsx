"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Logomark } from "@/components/icons";
import {
  filterLibrary,
  libraryOf,
  type AssetFilter,
  type LibraryRow,
  type LibraryView,
} from "@/lib/asset-inventory";
import { assetHref } from "@/lib/asset-uri";
import { formatSize } from "@/lib/platforms";
import { useWorkbench } from "@/lib/workbench-store";
import { cn } from "@/lib/utils";

/**
 * 资产库（F4）。
 *
 * 回答四个问题：一共多少、各多大、谁在用、哪些文件找不到了。
 * 只列不删：删素材是花钱买来的东西，得有一个明确的删除入口与确认，
 * 那属于「批量删除」的下一步；这里先把「看得见」做出来。
 */

const FILTERS: { key: AssetFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "used", label: "在用" },
  { key: "unused", label: "没人用" },
  { key: "missing", label: "文件缺失" },
];

const KIND_CN: Record<LibraryRow["kind"], string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  lut: "调色表",
};

const SOURCE_CN: Record<string, string> = {
  generated: "生成",
  upload: "上传",
  library: "素材库",
  imported: "导入",
};

const PLACEMENT_CN: Record<LibraryRow["placement"], string> = {
  inline: "日志里",
  store: "本机库",
  remote: "对象存储",
  none: "没地址",
};

export function AssetsScreen() {
  const project = useWorkbench((state) => state.project);
  const hydrate = useWorkbench((state) => state.hydrate);
  const storageError = useWorkbench((state) => state.storageError);
  const readOnly = useWorkbench((state) => state.readOnly);
  const removeAsset = useWorkbench((state) => state.removeAsset);
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [files, setFiles] = useState<Map<string, number>>();
  const [storeError, setStoreError] = useState<string>();
  /** 两步确认：先点「删」再点「确认删」，与删场 / 删镜同一条规矩（ADR-0067） */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState<string>();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // 库清单从服务端取：本机库或对象存储，看当前配的是哪一处
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/assets", { cache: "no-store" });
        const payload = (await response.json()) as {
          files?: { uri: string; bytes: number }[];
          error?: string;
        };
        if (cancelled) return;
        if (!response.ok) {
          setStoreError(payload.error ?? `读不到资产库（${response.status}）`);
          return;
        }
        setStoreError(undefined);
        setFiles(new Map((payload.files ?? []).map((file) => [file.uri, file.bytes])));
      } catch (error) {
        if (!cancelled) {
          setStoreError(error instanceof Error ? error.message : "读不到资产库");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project]);

  const library = useMemo(() => libraryOf(project, files), [project, files]);
  const rows = useMemo(() => filterLibrary(library.rows, filter), [library.rows, filter]);

  return (
    <div className="flex h-dvh flex-col bg-bg text-text">
      <header className="flex h-[46px] shrink-0 items-center gap-6 border-b border-line px-4">
        <div className="flex items-center gap-2">
          <Logomark className="h-[21px] w-[21px] text-text" />
          <span className="text-[13px] tracking-[.08em]">{project.title}</span>
          <span className="tnum text-[9px] text-muted-2">v{project.version}</span>
        </div>
        <nav className="flex items-center gap-3 text-[10px] text-muted-2">
          <Link href="/" className="transition-colors duration-[var(--dur)] hover:text-text">
            分镜
          </Link>
          <Link href="/edit" className="transition-colors duration-[var(--dur)] hover:text-text">
            成片
          </Link>
          <Link href="/settings" className="transition-colors duration-[var(--dur)] hover:text-text">
            设置
          </Link>
        </nav>
        <span className="ml-auto text-[10px] text-muted-2">资产库</span>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto max-w-[1080px]">
          {storageError && (
            <p className="mb-3 rounded-token border border-pick/40 bg-pick/10 px-3 py-2 text-[10px] text-pick">
              {storageError}
            </p>
          )}
          <Summary library={library} storeError={storeError} />
          {note && (
            <p className="mt-3 text-[9.5px] leading-[1.7] text-muted-2">{note}</p>
          )}
          <ul className="mt-5 border-t border-line">
            {rows.length === 0 ? (
              <li className="py-8 text-center text-[10px] text-muted-2">
                {filter === "missing"
                  ? "没有文件缺失的素材。"
                  : filter === "unused"
                    ? "每一个素材都在用。"
                    : "这个项目还没有素材。"}
              </li>
            ) : (
              rows.map((row) => (
                <Row
                  key={row.assetId}
                  row={row}
                  readOnly={Boolean(readOnly)}
                  confirming={confirming === row.assetId}
                  onAskDelete={() => {
                    setConfirming(row.assetId);
                    setNote(undefined);
                  }}
                  onCancel={() => setConfirming(null)}
                  onConfirm={() => {
                    const ok = removeAsset(row.assetId);
                    setConfirming(null);
                    setNote(
                      ok
                        ? `删掉了 ${row.assetId}。盘上的文件还在：「清理没人引用的文件」会把它一起清掉。`
                        : (useWorkbench.getState().castError ?? "删不掉这一条。"),
                    );
                  }}
                />
              ))
            )}
          </ul>
        </div>
      </main>

      <footer className="flex h-[38px] shrink-0 items-center gap-4 border-t border-line px-4 text-[9.5px] text-muted-2">
        <span className="flex items-center gap-1">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilter(item.key)}
              className={cn(
                "rounded-token border px-2 py-0.5 transition-colors duration-[var(--dur)]",
                filter === item.key
                  ? "border-line-2 text-text"
                  : "border-line text-muted-2 hover:border-line-2 hover:text-text",
              )}
            >
              {item.label}
              <span className="tnum ml-1 text-[8.5px]">
                {item.key === "all"
                  ? library.total
                  : item.key === "used"
                    ? library.used
                    : item.key === "unused"
                      ? library.unused
                      : library.missing}
              </span>
            </button>
          ))}
        </span>
        <span className="ml-auto">
          同一段字节只存一份：资产按内容寻址，重复上传不会多占一份空间。
        </span>
      </footer>
    </div>
  );
}

function Summary({ library, storeError }: { library: LibraryView; storeError?: string }) {
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[10px] sm:grid-cols-4">
        <div>
          <dt className="text-[9px] text-muted-2">素材</dt>
          <dd className="tnum text-text">{library.total} 个</dd>
        </div>
        <div>
          <dt className="text-[9px] text-muted-2">日志里</dt>
          <dd className="tnum text-text">{formatSize(library.inlineBytes)}</dd>
        </div>
        <div>
          <dt className="text-[9px] text-muted-2">资产库</dt>
          <dd className="tnum text-text">
            {storeError ? "—" : formatSize(library.storeBytes)}
          </dd>
        </div>
        <div>
          <dt className="text-[9px] text-muted-2">没人用</dt>
          <dd className="tnum text-text">{library.unused} 个</dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[9.5px] text-muted-2">
        {library.byKind
          .filter((entry) => entry.count > 0)
          .map((entry) => (
            <span key={entry.kind} className="tnum">
              {KIND_CN[entry.kind]} {entry.count} 个 · {formatSize(entry.bytes)}
            </span>
          ))}
        {library.bySource.map((entry) => (
          <span key={entry.source} className="tnum">
            {SOURCE_CN[entry.source] ?? entry.source} {entry.count} 个
          </span>
        ))}
      </div>

      {library.missing > 0 && (
        <p className="mt-3 rounded-token border border-pick/40 bg-pick/10 px-3 py-2 text-[10px] leading-[1.7] text-pick">
          有 {library.missing} 个素材在库里找不到文件：地址还在项目里，但磁盘 / 桶里没有。
          可能是清了 <code>.loomina/</code>、换了存储配置，或文件被手动删掉了。
          这些格子会显示成空的。
        </p>
      )}
      {storeError && (
        <p className="mt-3 text-[9.5px] text-muted-2">
          读不到资产库清单（{storeError}）：下面只按日志里的地址判断，看不出文件缺失。
        </p>
      )}
    </>
  );
}

function Row({
  row,
  readOnly,
  confirming,
  onAskDelete,
  onCancel,
  onConfirm,
}: {
  row: LibraryRow;
  readOnly: boolean;
  confirming: boolean;
  onAskDelete: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const href = row.uri ? assetHref(row.uri) : undefined;
  const bytes = row.inlineBytes + (row.storeBytes ?? 0);
  const deletable = row.usedBy.length === 0 && !readOnly;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line py-2">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[2px] border border-line bg-surface">
        {row.kind === "image" && href ? (
          <img src={href} alt={row.assetId} className="h-full w-full object-cover" />
        ) : row.kind === "video" && href ? (
          <video
            src={href}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="text-[8.5px] text-muted-2">
            {row.kind === "audio"
              ? "音"
              : row.kind === "video"
                ? "影"
                : row.kind === "lut"
                  ? "色"
                  : "图"}
          </span>
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="truncate text-[10px] text-text">{row.assetId}</span>
          <span className="shrink-0 text-[8.5px] text-muted-2">{KIND_CN[row.kind]}</span>
          <span className="shrink-0 text-[8.5px] text-muted-2">
            {SOURCE_CN[row.source] ?? row.source}
          </span>
          <span className="shrink-0 text-[8.5px] text-muted-2">{PLACEMENT_CN[row.placement]}</span>
          {row.fileMissing && (
            <span className="shrink-0 text-[8.5px] text-pick">文件缺失</span>
          )}
          {row.usedBy.length === 0 && (
            <span className="shrink-0 text-[8.5px] text-muted">没人用</span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[8.5px] text-muted-2">
          {row.usedBy.length > 0 ? row.usedBy.slice(0, 3).join(" · ") : "没有被任何地方引用"}
          {row.usedBy.length > 3 && ` 等 ${row.usedBy.length} 处`}
        </span>
      </span>

      <span className="tnum shrink-0 text-[9px] text-muted-2">
        {bytes > 0 ? formatSize(bytes) : "—"}
      </span>
      {row.costCny !== undefined && (
        <span className="tnum shrink-0 text-[9px] text-muted-2">¥{row.costCny.toFixed(2)}</span>
      )}
      <span className="tnum shrink-0 text-[9px] text-muted-2">
        {row.createdAt.slice(5, 16).replace("T", " ")}
      </span>

      {/* 删一条没人用的资产（F4 / ADR-0136）：两步确认，与删场 / 删镜同一规矩 */}
      {deletable &&
        (confirming ? (
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onConfirm}
              title="从项目里删掉这条资产记录；盘上的文件由「清理没人引用的文件」处理"
              className="tnum rounded-token border border-pick/70 px-1 py-px text-[9px] text-pick transition-colors duration-[var(--dur)] hover:bg-pick hover:text-bg"
            >
              确认删
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="tnum rounded-token border border-line px-1 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
            >
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={onAskDelete}
            title="没人引用的资产可以删：记录先删，盘上的文件另走「清理没人引用的文件」"
            className="tnum shrink-0 rounded-token border border-line px-1 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
          >
            删
          </button>
        ))}
    </li>
  );
}
