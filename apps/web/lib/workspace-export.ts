/**
 * 单个工作空间的导出包（C15 / 删除前导出）。
 *
 * 删空间是不可恢复的：`deleteWorkspace` 会把这个空间的事件行、日志版本与登记
 * 一起清掉（素材文件不动，但「这个空间里发生过什么」就没了）。
 *
 * 所以给删除配一个出口：删之前可以把整条日志导成一份 JSON，至少还能留个底。
 * **不是备份恢复格式**——没有任何导入功能会读它；它是「事后能查」的凭证。
 *
 * 纯函数：只拼对象与文件名，不读盘、不写盘、不碰 DOM。
 */

import type { WorkspaceMeta } from "./event-log";

export const WORKSPACE_EXPORT_FORMAT = "loomina.workspace-export";
export const WORKSPACE_EXPORT_VERSION = 1;

/** 一条事件原样带上：导出的是「这个空间收到过什么」，不做任何改写 */
export type WorkspaceExport = {
  format: typeof WORKSPACE_EXPORT_FORMAT;
  version: number;
  /** 导出时间（绝对时刻） */
  exportedAt: string;
  /** 登记表里的那一份（名字 / 集序 / 归档状态） */
  workspace: {
    id: string;
    name: string;
    createdAt: string;
    lastOpenedAt: string;
    seriesId?: string;
    episodeNo?: number;
    archivedAt?: string;
  };
  /** 日志版本与全部事件，按发生顺序 */
  log: { version: number; events: unknown[] };
  /** 这份包能回答什么、不能回答什么，写清楚免得被当备份 */
  note: string;
};

const NOTE =
  "这是这个工作空间的事件日志留底。它不含素材文件本身（素材全机共用、按地址引用），" +
  "也没有导入功能会读它——它只用来事后查「这个空间里发生过什么」。";

export function workspaceExportOf(input: {
  meta: WorkspaceMeta;
  log: { version: number; events: unknown[] };
  exportedAt: string;
}): WorkspaceExport {
  const { meta } = input;
  return {
    format: WORKSPACE_EXPORT_FORMAT,
    version: WORKSPACE_EXPORT_VERSION,
    exportedAt: input.exportedAt,
    workspace: {
      id: meta.id,
      name: meta.name,
      createdAt: meta.createdAt,
      lastOpenedAt: meta.lastOpenedAt,
      ...(meta.seriesId ? { seriesId: meta.seriesId } : {}),
      ...(meta.episodeNo !== undefined ? { episodeNo: meta.episodeNo } : {}),
      ...(meta.archivedAt ? { archivedAt: meta.archivedAt } : {}),
    },
    log: { version: input.log.version, events: input.log.events },
    note: NOTE,
  };
}

/** 文件名里不能出现的字符：与渲染文件名同一套口径 */
function safeName(text: string): string {
  const cleaned = text
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "workspace";
}

export function workspaceExportFileName(name: string, exportedAt: string): string {
  return `${safeName(name)}-${exportedAt.slice(0, 10)}.json`;
}

/** 读回来的导出包像不像一份：只在界面提示时用，不做导入 */
export function looksLikeWorkspaceExport(value: unknown): value is WorkspaceExport {
  if (!value || typeof value !== "object") return false;
  const pack = value as Partial<WorkspaceExport>;
  return (
    pack.format === WORKSPACE_EXPORT_FORMAT &&
    typeof pack.version === "number" &&
    typeof pack.workspace === "object" &&
    pack.workspace !== null
  );
}
