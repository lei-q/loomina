import type { Project, ProjectEvent } from "@loomina/ir";
import { assetHref } from "./asset-uri";
import { inventoryOf } from "./asset-inventory";

/**
 * 数据包（H9）：把「用户自己的东西」整份装进一个文件。
 *
 * 三样东西：当前项目 IR、整条事件日志、资产清单。**素材字节不在这里**——
 * 一段 30 MB 的视频编码成 base64 会让这一份文件大到打不开。素材按
 * `assets[].href` 逐个取（本机资产库给的 `/api/asset/<hash>.<ext>`），
 * 对象存储里的就在你自己的桶里。
 *
 * 这份文件不假设能导入回来：导入还没做。它是备份、迁移与「我要看看我有什么」
 * 用的完整记录，界面上照实这么写。
 */

export type DataExportAsset = {
  id: string;
  kind: "image" | "video" | "audio";
  /** 地址在日志里（data:）/ 本机资产库 / 对象存储 / 没有地址 */
  placement: "inline" | "store" | "remote" | "none";
  /** IR 里记的地址；`none` 时是空串 */
  uri: string;
  /** 浏览器能直接取到的地址；取不到就不写 */
  href?: string;
  /** 有没有被任何一镜 / 角色 / 台词引用 */
  referenced: boolean;
  /** 内嵌在日志里的字节数；在资产库或对象存储里的记 0（字节不在这份文件里） */
  inlineBytes: number;
};

export type DataExport = {
  format: "loomina.export";
  /** 这一份格式自己的版本：将来加字段时读的一方好分辨 */
  version: 1;
  app: "loomina";
  exportedAt: string;
  /** 事件日志的结构版本（H18 / LOG_VERSION） */
  logVersion: number;
  project: Project;
  events: ProjectEvent[];
  assets: DataExportAsset[];
  totals: {
    events: number;
    assets: number;
    /** 内嵌在日志里的字节数 */
    inlineBytes: number;
    /** 资产库里的文件数（取不到清单时是 null） */
    storeFiles: number | null;
    storeBytes: number | null;
  };
  notes: string[];
};

export type StoreFile = { uri: string; bytes: number };

export function buildDataExport(input: {
  project: Project;
  events: ProjectEvent[];
  exportedAt: string;
  logVersion: number;
  /** 资产库清单（`/api/assets` 的结果）；取不到就不传 */
  storeFiles?: StoreFile[];
}): DataExport {
  const inventory = inventoryOf(input.project);
  const sizeByUri = new Map(
    (input.storeFiles ?? []).map((file) => [file.uri, file.bytes] as const),
  );
  const assets = input.project.assets.map((asset) => {
    const usage = inventory.usage.find((item) => item.id === asset.id);
    const uri = asset.uri ?? "";
    return {
      id: asset.id,
      kind: asset.kind,
      placement: usage?.placement ?? "none",
      uri,
      ...(uri ? { href: assetHref(uri) } : {}),
      referenced: usage?.referenced ?? false,
      inlineBytes: usage?.inlineBytes ?? 0,
    } satisfies DataExportAsset;
  });

  const storeFiles = input.storeFiles;
  return {
    format: "loomina.export",
    version: 1,
    app: "loomina",
    exportedAt: input.exportedAt,
    logVersion: input.logVersion,
    project: input.project,
    events: input.events,
    assets,
    totals: {
      events: input.events.length,
      assets: assets.length,
      inlineBytes: inventory.inlineBytes,
      storeFiles: storeFiles ? storeFiles.length : null,
      storeBytes: storeFiles
        ? storeFiles.reduce((sum, file) => sum + file.bytes, 0)
        : null,
    },
    notes: [
      "素材字节不在这份文件里：本机资产库的文件按 assets[].href 逐个取，对象存储里的就在你自己的桶里。",
      "项目 = 整条事件日志；project 是回放到底之后的当前状态，events 是每一步。",
      "这一版没有导入：这份文件是备份、迁移与清点用的完整记录。",
      ...(storeFiles
        ? ["资产库清单已取到，totals.storeFiles / storeBytes 是取到那一刻的实数。"]
        : ["这次没取到资产库清单：storeFiles / storeBytes 为 null，文件大小以资产库页面为准。"]),
    ],
  };
}

/** 数据包文件名：`夜班-数据包-2026-11-13.json` */
export function dataExportFileName(title: string, exportedAt: string): string {
  const safe = title.trim().replace(/[\\/:*?"<>|]+/g, "").slice(0, 40) || "loomina";
  const day = exportedAt.slice(0, 10);
  return `${safe}-数据包-${day}.json`;
}
