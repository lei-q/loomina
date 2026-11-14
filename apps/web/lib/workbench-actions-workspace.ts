/**
 * 工作空间的 action 切片（C15 / ADR-0188 / 0201 / 0210 / 0234）。
 *
 * 从 `workbench-store.ts` 拆出的第一批 action（2026-11-15）。
 * 七个动作都只碰「本机登记表 + 各空间日志」，与项目内容无关，
 * 所以是最独立的一组，先拆它。
 *
 * 写成工厂函数而不是直接导出对象：这些 action 要读 `get()` 的最新状态、
 * 用 store 的 `set`（它带阶段硬锁闸口），不能自己造一份。
 */

import type { Project } from "@loomina/ir";
import {
  deleteWorkspace as deleteWorkspaceRows,
  hasWorkspaces,
  indexedDbLogFor,
  listWorkspaces,
  migrateLog,
  rememberWorkspace,
  saveWorkspace,
  type WorkspaceMeta,
} from "@/lib/event-log";
import { nextEpisodeNo } from "@/lib/series";
import { bootstrap, registerWorkspace } from "@/lib/workbench-helpers";
import { sampleProject } from "@/lib/sample-project";
import { ProjectSchema, rebuild } from "@loomina/ir";
import { projectFromSetup, setupSourceProblem } from "@/lib/workspace-template";
import { workspaceExportFileName, workspaceExportOf } from "@/lib/workspace-export";
import type { WorkbenchState } from "@/lib/workbench-types";

type Store = {
  get: () => WorkbenchState;
  set: (partial: Partial<WorkbenchState>) => void;
};

/** 时间戳：与 store 的 `stamp` 同一口径（严格递增） */
type Stamp = () => string;

/** 这一片负责的动作：从 WorkbenchState 里挑出来，签名与主接口保持一致 */
export type WorkspaceActions = Pick<
  WorkbenchState,
  | "refreshWorkspaces"
  | "createWorkspace"
  | "renameWorkspace"
  | "archiveWorkspace"
  | "deleteWorkspace"
  | "exportWorkspace"
  | "deleteArchivedWorkspaces"
>;

export function workspaceActions({ get, set }: Store, stamp: Stamp): WorkspaceActions {
  return {
  refreshWorkspaces: async () => {
    if (!hasWorkspaces()) return [];
    try {
      let list = await listWorkspaces();
      // 第一次打开：当前空间还没登记，用项目名补一条
      if (list.length === 0) {
        await registerWorkspace(get().workspaceId, get().project.title, set);
        list = await listWorkspaces();
      }
      set({ workspaces: list, workspaceError: undefined });
      return list;
    } catch (error) {
      set({ workspaceError: error instanceof Error ? error.message : "读不到工作空间列表。" });
      return [];
    }
  },

  createWorkspace: async (rawName, fromWorkspaceId) => {
    const name = rawName.trim();
    if (!name) {
      set({ workspaceError: "工作空间要有名字。" });
      return undefined;
    }
    if (name.length > 40) {
      set({ workspaceError: "名字最多 40 个字。" });
      return undefined;
    }
    if (!hasWorkspaces()) {
      set({ workspaceError: "这个浏览器不支持多工作空间。" });
      return undefined;
    }

    try {
      const list = await listWorkspaces();
      if (list.some((item) => item.name === name)) {
        set({ workspaceError: "已经有同名的工作空间。" });
        return undefined;
      }

      const id = `w-${Date.now().toString(36)}`;
      const now = new Date().toISOString();
      let seed: Project;
      let source: WorkspaceMeta | undefined;
      if (fromWorkspaceId) {
        // 照别的空间的设定开新一集：读它的日志、回放，再只搬设定（ADR-0197）
        source = list.find((item) => item.id === fromWorkspaceId);
        // 找不到 / 归档了都不建空间（C22 / ADR-0213）：判定与顶栏下拉共用一份
        const problem = setupSourceProblem(list, fromWorkspaceId);
        if (!source || problem) throw new Error(problem ?? "找不到这个来源空间。");
        const stored = migrateLog(await indexedDbLogFor(fromWorkspaceId).load());
        if (!stored) throw new Error("来源空间的日志读不出来。");
        // 空日志没有 project.created，rebuild 会抛「事件日志为空」——那句话对作者没有意义
        if (stored.length === 0) {
          throw new Error(`「${source.name}」还没有任何内容，没有设定可以照。`);
        }
        seed = ProjectSchema.parse(
          projectFromSetup(rebuild(stored), { id: `p-${id}`, title: name }),
        );
      } else {
        // 新空间从示例项目开工：作者随后可以在故事页换成自己的项目
        seed = ProjectSchema.parse({ ...sampleProject, id: `p-${id}`, title: name });
      }
      await indexedDbLogFor(id).replace(bootstrap(seed));
      // 连载（A6 / ADR-0209）：照来源空间开工就继承它的系列并排到下一集；
      // 从零开工则自成一部剧的第一集。集序只是本机编排，不进事件日志。
      const seriesId = source?.seriesId ?? source?.id ?? id;
      const episodeNo = fromWorkspaceId
        ? nextEpisodeNo(list, seriesId)
        : 1;
      await saveWorkspace({
        id,
        name,
        createdAt: now,
        lastOpenedAt: now,
        seriesId,
        episodeNo,
      });
      rememberWorkspace(id);
      set({ workspaces: await listWorkspaces(), workspaceError: undefined });
      return id;
    } catch (error) {
      set({ workspaceError: error instanceof Error ? error.message : "工作空间没建成。" });
      return undefined;
    }
  },

  renameWorkspace: async (id, rawName) => {
    const name = rawName.trim();
    if (!name) {
      set({ workspaceError: "工作空间要有名字。" });
      return false;
    }
    if (name.length > 40) {
      set({ workspaceError: "名字最多 40 个字。" });
      return false;
    }
    if (!hasWorkspaces()) return false;
    try {
      const list = await listWorkspaces();
      if (list.some((item) => item.id !== id && item.name === name)) {
        set({ workspaceError: "已经有同名的工作空间。" });
        return false;
      }
      const target = list.find((item) => item.id === id);
      if (!target) {
        set({ workspaceError: "找不到这个工作空间。" });
        return false;
      }
      await saveWorkspace({ ...target, name });
      set({ workspaces: await listWorkspaces(), workspaceError: undefined });
      return true;
    } catch (error) {
      set({ workspaceError: error instanceof Error ? error.message : "名字没改成。" });
      return false;
    }
  },

  archiveWorkspace: async (id, archived) => {
    if (id === get().workspaceId) {
      set({ workspaceError: "不能归档正在打开的空间：先切到别的空间。" });
      return false;
    }
    if (!hasWorkspaces()) {
      set({ workspaceError: "这个浏览器不支持多工作空间。" });
      return false;
    }
    try {
      const list = await listWorkspaces();
      const target = list.find((item) => item.id === id);
      if (!target) {
        set({ workspaceError: "找不到这个工作空间。" });
        return false;
      }
      const next = { ...target };
      if (archived) next.archivedAt = new Date().toISOString();
      else delete next.archivedAt;
      await saveWorkspace(next);
      set({ workspaces: await listWorkspaces(), workspaceError: undefined });
      return true;
    } catch (error) {
      set({ workspaceError: error instanceof Error ? error.message : "归档没改成。" });
      return false;
    }
  },

  deleteWorkspace: async (id) => {
    // 先拦「删当前空间」：这条与浏览器能力无关，是最该说清楚的一句
    if (id === get().workspaceId) {
      set({ workspaceError: "不能删正在打开的空间：先切到别的空间，再回来删。" });
      return undefined;
    }
    if (!hasWorkspaces()) {
      set({ workspaceError: "这个浏览器不支持多工作空间。" });
      return undefined;
    }
    try {
      const removed = await deleteWorkspaceRows(id);
      set({ workspaces: await listWorkspaces(), workspaceError: undefined });
      return removed;
    } catch (error) {
      set({ workspaceError: error instanceof Error ? error.message : "工作空间没删掉。" });
      return undefined;
    }
  },

  exportWorkspace: async (id) => {
    if (!hasWorkspaces()) {
      set({ workspaceError: "这个浏览器不支持多工作空间。" });
      return undefined;
    }
    try {
      const metas = await listWorkspaces();
      const meta = metas.find((item) => item.id === id);
      if (!meta) {
        set({ workspaceError: "找不到这个工作空间。" });
        return undefined;
      }
      const stored = await indexedDbLogFor(id).load();
      const exportedAt = new Date().toISOString();
      const pack = workspaceExportOf({ meta, log: stored, exportedAt });
      set({ workspaceError: undefined });
      return {
        fileName: workspaceExportFileName(meta.name, exportedAt),
        json: JSON.stringify(pack, null, 2),
      };
    } catch (error) {
      set({ workspaceError: error instanceof Error ? error.message : "导出没做成。" });
      return undefined;
    }
  },

  deleteArchivedWorkspaces: async () => {
    if (!hasWorkspaces()) {
      set({ workspaceError: "这个浏览器不支持多工作空间。" });
      return 0;
    }
    try {
      const metas = await listWorkspaces();
      const archived = metas.filter((item) => item.archivedAt && item.id !== get().workspaceId);
      for (const item of archived) await deleteWorkspaceRows(item.id);
      set({ workspaces: await listWorkspaces(), workspaceError: undefined });
      return archived.length;
    } catch (error) {
      set({ workspaceError: error instanceof Error ? error.message : "清理没做成。" });
      return 0;
    }
  },

  };
}
