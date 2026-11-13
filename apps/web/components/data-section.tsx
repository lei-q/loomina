"use client";

import { useState } from "react";
import { LOG_VERSION } from "@/lib/event-log";
import { buildDataExport, dataExportFileName, type StoreFile } from "@/lib/data-export";
import { downloadFile } from "@/lib/export-cut";
import { useWorkbench } from "@/lib/workbench-store";

/**
 * 数据导出与删除（H9）。
 *
 * 两件事，都要说清楚边界：
 * - **导出**：项目 IR + 整条事件日志 + 资产清单装进一个 JSON。素材字节不内嵌——
 *   一段几十兆的视频编成 base64 会让这份文件打不开；素材按清单里的 `href` 取。
 * - **删除**：这一版删的是**这台机器上的**东西（本机资产库文件 + 这个浏览器里的
 *   项目日志）。对象存储里的、你导出到别处的文件、`.loomina/config.json` 里的
 *   密钥都不动。配了对象存储时服务端直接拒绝，不给你「顺手清空桶」的按钮。
 */
export function DataSection({
  readOnly,
  storageConfigured = false,
}: {
  readOnly: boolean;
  /** 配了对象存储：本机删除会被服务端拒绝，这里先说清楚，按钮直接禁用 */
  storageConfigured?: boolean;
}) {
  const project = useWorkbench((state) => state.project);
  const events = useWorkbench((state) => state.events);
  const reset = useWorkbench((state) => state.reset);

  const blocked = storageConfigured;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  const exportData = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      // 资产库清单用来填文件数与总字节；取不到也照样导出，只是那两个数是 null
      const storeFiles = await fetch("/api/assets", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { files?: StoreFile[] } | null) => data?.files)
        .catch(() => undefined);
      const exportedAt = new Date().toISOString();
      const doc = buildDataExport({ project, events, exportedAt, logVersion: LOG_VERSION, storeFiles });
      downloadFile(
        dataExportFileName(project.title, exportedAt),
        JSON.stringify(doc, null, 2),
        "application/json",
      );
      setNotice(
        `数据包已导出：${doc.totals.events} 条事件、${doc.totals.assets} 个资产${
          doc.totals.storeFiles === null
            ? "（这次没取到资产库清单，文件大小那两个数是空的）"
            : `、资产库 ${doc.totals.storeFiles} 个文件`
        }。素材字节不在这个文件里——按 assets 里的 href 逐个取。`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "导不出来");
    } finally {
      setBusy(false);
    }
  };

  const deleteLocal = async () => {
    setDeleting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch("/api/data", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: confirmText }),
      });
      const result = (await response.json()) as { error?: string; note?: string };
      if (!response.ok) throw new Error(result.error || `删除失败（${response.status}）`);
      // 项目日志是浏览器里的这一份：清成示例项目，原来的日志不再留着
      reset();
      setConfirmText("");
      setNotice(
        `${result.note ?? "已删除本机数据。"} 这个浏览器里的项目日志也清掉了，现在打开的是示例项目「夜班」——不是原来那一份。`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删不掉");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="mt-9 border-t border-line pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[12px] tracking-[.04em]">数据</h2>
          <span className="tnum text-[9px] text-muted-2">H9</span>
        </div>
        <span className="tnum text-[9.5px] text-muted-2">
          {events.length} 条事件 · {project.assets.length} 个资产
        </span>
      </div>
      <p className="mt-1 max-w-[640px] text-[9.5px] leading-[1.7] text-muted-2">
        项目是这台浏览器里的事件日志；素材在本机资产库或你自己的对象存储里。
        导出给你一份完整的记录，删除只清这台机器上的东西。
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void exportData()}
          disabled={busy}
          className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
        >
          导出一份数据包（JSON）
        </button>
        <span className="text-[9px] text-muted-2">
          项目 IR + 整条事件日志 + 资产清单；素材字节不内嵌
        </span>
      </div>

      <div className="mt-4 rounded-token border border-line bg-surface/40 p-3">
        <p className="max-w-[640px] text-[9.5px] leading-[1.7] text-muted-2">
          删除会清掉两样：本机资产库（<span className="tnum">.loomina/assets/</span>）里的素材文件，
          和这个浏览器里的项目日志。不碰：对象存储里的素材、你导出到别处的文件、
          <span className="tnum">.loomina/config.json</span> 里的密钥与供应商配置。
          {blocked
            ? "这台机器已经配了对象存储：删除被禁用，素材请在对象存储那边删——本机删除不该有清空桶的能力。"
            : "配了对象存储时这里会直接拒绝——本机删除不该有清空桶的能力。"}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={confirmText}
            disabled={readOnly || deleting}
            onChange={(event) => setConfirmText(event.target.value)}
            placeholder="输入「删除」"
            aria-label="输入删除以确认"
            className="w-[120px] rounded-token border border-line bg-transparent px-2 py-1 text-[10px] text-text placeholder:text-muted-2/70 focus:border-line-2 focus:outline-none disabled:opacity-40"
          />
          <button
            type="button"
            onClick={() => void deleteLocal()}
            disabled={readOnly || blocked || deleting || confirmText !== "删除"}
            title={
              blocked
                ? "已经配了对象存储：本机删除只清 .loomina/assets/，不碰你的桶"
                : readOnly
                ? "另一个标签页在编辑：这一页只读"
                : confirmText === "删除"
                  ? "真的删：本机素材与这个浏览器里的项目日志"
                  : "先输入「删除」两个字"
            }
            className="rounded-token border border-pick px-2.5 py-1 text-[10px] text-pick transition-colors duration-[var(--dur)] hover:bg-pick/10 disabled:opacity-40"
          >
            {deleting ? "正在删…" : "删除本机数据"}
          </button>
        </div>
      </div>

      {notice && (
        <p className="mt-2 rounded-token border border-line bg-surface/60 px-2 py-1.5 text-[9.5px] leading-[1.6] text-muted">
          {notice}
        </p>
      )}
      {error && (
        <p className="mt-2 rounded-token border border-pick/40 bg-pick/10 px-2 py-1.5 text-[9.5px] leading-[1.6] text-pick">
          {error}
        </p>
      )}
    </section>
  );
}
