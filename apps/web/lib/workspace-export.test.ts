import { describe, expect, it } from "vitest";
import type { WorkspaceMeta } from "./event-log";
import {
  WORKSPACE_EXPORT_FORMAT,
  WORKSPACE_EXPORT_VERSION,
  looksLikeWorkspaceExport,
  workspaceExportFileName,
  workspaceExportOf,
} from "./workspace-export";

const meta = (patch: Partial<WorkspaceMeta> = {}): WorkspaceMeta => ({
  id: "w-1",
  name: "夜班",
  createdAt: "2026-11-13T00:00:00Z",
  lastOpenedAt: "2026-11-14T00:00:00Z",
  ...patch,
});

describe("工作空间导出（C15 / 删除前导出 / ADR-0234）", () => {
  it("带上登记信息与完整日志，版本号可追溯", () => {
    const pack = workspaceExportOf({
      meta: meta({ seriesId: "s-a", episodeNo: 2, archivedAt: "2026-11-14T00:00:00Z" }),
      log: { version: 4, events: [{ type: "project.created" }, { type: "shot.updated" }] },
      exportedAt: "2026-11-14T10:00:00Z",
    });
    expect(pack.format).toBe(WORKSPACE_EXPORT_FORMAT);
    expect(pack.version).toBe(WORKSPACE_EXPORT_VERSION);
    expect(pack.workspace).toMatchObject({
      id: "w-1",
      name: "夜班",
      seriesId: "s-a",
      episodeNo: 2,
    });
    expect(pack.workspace.archivedAt).toBe("2026-11-14T00:00:00Z");
    expect(pack.log.version).toBe(4);
    expect(pack.log.events).toHaveLength(2);
  });

  it("没有可选字段时不写空键（与 IR 的省略口径一致）", () => {
    const pack = workspaceExportOf({
      meta: meta(),
      log: { version: 4, events: [] },
      exportedAt: "2026-11-14T10:00:00Z",
    });
    expect("seriesId" in pack.workspace).toBe(false);
    expect("episodeNo" in pack.workspace).toBe(false);
    expect("archivedAt" in pack.workspace).toBe(false);
  });

  it("说明写清它是什么、不是什么：不是备份格式", () => {
    const pack = workspaceExportOf({
      meta: meta(),
      log: { version: 4, events: [] },
      exportedAt: "2026-11-14T10:00:00Z",
    });
    expect(pack.note).toContain("不含素材文件");
    expect(pack.note).toContain("没有导入功能会读它");
  });

  it("文件名去掉非法字符，带绝对日期", () => {
    expect(workspaceExportFileName("夜班", "2026-11-14T10:00:00Z")).toBe("夜班-2026-11-14.json");
    expect(workspaceExportFileName("a/b:c*d", "2026-11-14T10:00:00Z")).toBe(
      "abcd-2026-11-14.json",
    );
    expect(workspaceExportFileName("   ", "2026-11-14T10:00:00Z")).toBe(
      "workspace-2026-11-14.json",
    );
  });

  it("认得出自己导出的包，认不出别的东西", () => {
    const pack = workspaceExportOf({
      meta: meta(),
      log: { version: 4, events: [] },
      exportedAt: "2026-11-14T10:00:00Z",
    });
    expect(looksLikeWorkspaceExport(pack)).toBe(true);
    expect(looksLikeWorkspaceExport({ format: "loomina.template" })).toBe(false);
    expect(looksLikeWorkspaceExport(null)).toBe(false);
    expect(looksLikeWorkspaceExport("x")).toBe(false);
  });
});
