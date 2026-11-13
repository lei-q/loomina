import { describe, expect, it } from "vitest";
import { rebuild, type ProjectEvent } from "@loomina/ir";
import { buildDataExport, dataExportFileName } from "./data-export";
import { sampleProject } from "./sample-project";

const AT = "2026-11-13T08:00:00.000Z";

function events(): ProjectEvent[] {
  return [
    { type: "project.created", at: AT, project: sampleProject },
    { type: "project.updated", at: AT, budgetCny: 88 },
  ];
}

describe("数据包（H9）", () => {
  it("装进项目 IR、整条事件日志与资产清单", () => {
    const doc = buildDataExport({
      project: sampleProject,
      events: events(),
      exportedAt: AT,
      logVersion: 3,
    });
    expect(doc.format).toBe("loomina.export");
    expect(doc.version).toBe(1);
    expect(doc.app).toBe("loomina");
    expect(doc.logVersion).toBe(3);
    expect(doc.events).toHaveLength(2);
    expect(doc.project.title).toBe(sampleProject.title);
    expect(doc.totals.events).toBe(2);
    expect(doc.totals.assets).toBe(sampleProject.assets.length);
  });

  it("素材只记地址，不内嵌字节；取不到清单时两个大小是 null", () => {
    const doc = buildDataExport({
      project: sampleProject,
      events: events(),
      exportedAt: AT,
      logVersion: 3,
    });
    expect(doc.totals.storeFiles).toBeNull();
    expect(doc.totals.storeBytes).toBeNull();
    for (const asset of doc.assets) {
      expect(asset).not.toHaveProperty("bytes");
      expect(asset).toHaveProperty("uri");
    }
    expect(doc.notes.join(" ")).toContain("素材字节不在这份文件里");
  });

  it("取到资产库清单时记下文件数与总字节", () => {
    const doc = buildDataExport({
      project: sampleProject,
      events: events(),
      exportedAt: AT,
      logVersion: 3,
      storeFiles: [
        { uri: "loomina://assets/aaa.png", bytes: 1000 },
        { uri: "loomina://assets/bbb.mp4", bytes: 2000 },
      ],
    });
    expect(doc.totals.storeFiles).toBe(2);
    expect(doc.totals.storeBytes).toBe(3000);
  });

  it("资产带上放在哪、有没有人用；本机库的给得出取件地址", () => {
    const doc = buildDataExport({
      project: sampleProject,
      events: events(),
      exportedAt: AT,
      logVersion: 3,
    });
    for (const asset of doc.assets) {
      expect(["inline", "store", "remote", "none"]).toContain(asset.placement);
      expect(typeof asset.referenced).toBe("boolean");
      if (asset.uri.startsWith("loomina://")) {
        expect(asset.href).toMatch(/^\/api\/asset\//);
      }
    }
  });

  it("导出的 project 就是回放到最后的当前状态", () => {
    const doc = buildDataExport({
      project: rebuild(events()),
      events: events(),
      exportedAt: AT,
      logVersion: 3,
    });
    expect(doc.project.budgetCny).toBe(88);
    expect(doc.events.at(-1)).toMatchObject({ type: "project.updated" });
  });

  it("文件名带片名与日期，去掉不能进文件名的字符", () => {
    expect(dataExportFileName("夜班", "2026-11-13T08:00:00.000Z")).toBe(
      "夜班-数据包-2026-11-13.json",
    );
    expect(dataExportFileName(' 夜/班: "一" ', "2026-11-13T08:00:00.000Z")).toBe(
      "夜班 一-数据包-2026-11-13.json",
    );
    expect(dataExportFileName("   ", "2026-11-13T08:00:00.000Z")).toBe(
      "loomina-数据包-2026-11-13.json",
    );
  });
});
