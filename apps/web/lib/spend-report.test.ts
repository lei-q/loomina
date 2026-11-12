import { describe, expect, it } from "vitest";
import { ProjectSchema, type ProjectEvent } from "@loomina/ir";
import { sampleProject } from "./sample-project";
import { billCsv, projectSegments, spendReport } from "./spend-report";

/**
 * 跨项目账单（H4）。
 *
 * 本地日志是一条只追加的流水，开新项目就是再写一条 `project.created`。
 * 这些用例都从真实日志形状出发：两段日志、各自带花费。
 */

const AT = "2026-11-12T09:00:00+08:00";

function secondProject() {
  return ProjectSchema.parse({
    ...sampleProject,
    id: "proj-second",
    title: "第二部",
    version: 1,
    takes: [],
    assets: [
      {
        id: "a-second",
        kind: "image",
        source: "generated",
        uri: "data:image/png;base64,AA==",
        costCny: 0.12,
        createdAt: AT,
      },
    ],
    story: {
      ...sampleProject.story,
      provenance: {
        modelId: "deepseek-v4.1-flash-1017",
        prompt: "一句想法",
        referenceAssetIds: [],
        createdAt: AT,
        costCny: 0.03,
        usage: { units: 15_000, unit: "tokens" as const },
      },
    },
  });
}

function twoProjectLog(): ProjectEvent[] {
  return [
    { type: "project.created", at: "2026-11-10T00:00:00+08:00", project: sampleProject },
    { type: "project.created", at: AT, project: secondProject() },
  ];
}

describe("跨项目汇总（H4）", () => {
  it("按 project.created 切段，每段各算一份账", () => {
    const { segments, skipped } = projectSegments(twoProjectLog());
    expect(skipped).toBe(0);
    expect(segments.map((item) => item.project.title)).toEqual(["夜班", "第二部"]);
    expect(segments[1]).toMatchObject({ fromEvent: 1, toEvent: 2 });
  });

  it("合计等于各项目已花之和", () => {
    const report = spendReport(twoProjectLog());
    expect(report.rows).toHaveLength(2);
    expect(report.total).toBeCloseTo(
      report.rows.reduce((sum, row) => sum + row.spend.spent, 0),
      6,
    );
    // 第二个项目：一张图 ¥0.12 + 一次文本 ¥0.03
    expect(report.rows[1]?.spend.spent).toBeCloseTo(0.15, 6);
    expect(report.rows[1]?.spend.text).toBeCloseTo(0.03, 6);
  });

  it("只有一个项目时，合计就是这一份的已花", () => {
    const report = spendReport([
      { type: "project.created", at: "2026-11-10T00:00:00+08:00", project: sampleProject },
    ]);
    expect(report.rows).toHaveLength(1);
    expect(report.total).toBe(report.rows[0]!.spend.spent);
  });

  it("回放不了的一段跳过并计数，不连累整份账单", () => {
    // 第二条 project.created 后面挂一条指向不存在资产的删除：这一段回放会抛
    const log: ProjectEvent[] = [
      { type: "project.created", at: "2026-11-10T00:00:00+08:00", project: sampleProject },
      { type: "project.created", at: AT, project: secondProject() },
      { type: "asset.removed", at: AT, assetId: "a-does-not-exist" },
    ];
    const report = spendReport(log);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.title).toBe("夜班");
    expect(report.skipped).toBe(1);
  });

  it("CSV 有 BOM，中文能直接给表格软件打开", () => {
    const csv = billCsv(twoProjectLog());
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("项目,项目 id,起始事件");
    expect(csv).toContain("夜班");
    expect(csv).toContain("第二部");
    // 三段表：项目合计 / 逐镜 / 按阶段
    expect(csv).toContain("镜号,场景");
    expect(csv).toContain("阶段,已花");
  });

  it("CSV 里带逗号或引号的字段会被包起来", () => {
    const log = twoProjectLog().map((event) =>
      event.type === "project.created"
        ? {
            ...event,
            project: ProjectSchema.parse({
              ...event.project,
              title: '带,逗号的"标题"',
            }),
          }
        : event,
    );
    const csv = billCsv(log as ProjectEvent[]);
    expect(csv).toContain('"带,逗号的""标题"""');
  });
});
