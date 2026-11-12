import { describe, expect, it } from "vitest";
import { ProjectSchema, type ProjectEvent } from "@loomina/ir";
import { costAlerts, mergeAlerts, rankAlerts, type HealthAlert } from "./alerts";

/**
 * 告警（H8 / ADR-0157）。
 *
 * 成本告警只从本机事件日志派生：一镜突增是留意，项目超预算是告警。
 * 合并时同 id 只留一条，告警排在留意前面。
 */

function take(id: string, shotId: string, costCny: number) {
  return {
    id,
    shotId,
    assetId: `asset-${id}`,
    status: "approved" as const,
    costCny,
    provenance: { modelId: "minimax-h3", createdAt: "2026-11-13T10:00:00+08:00" },
  };
}

function project(budgetCny: number) {
  const shots = [1, 2, 3, 4, 5].map((n) => ({
    id: `s-${n}`,
    sceneId: "sc-1",
    index: n - 1,
    durationMs: 3000,
    description: `第 ${n} 镜`,
    shotSize: "medium" as const,
    camera: { angle: "eye" as const, movement: "static" as const, focalMm: 35 },
  }));
  return ProjectSchema.parse({
    id: "p-alert",
    title: "告警测试",
    version: 0,
    budgetCny,
    locations: [{ id: "loc-1", name: "走廊" }],
    scenes: [{ id: "sc-1", index: 0, locationId: "loc-1", shotIds: shots.map((shot) => shot.id) }],
    shots,
    takes: [
      take("t-1", "s-1", 1),
      take("t-2", "s-2", 1),
      take("t-3", "s-3", 1),
      take("t-4", "s-4", 1),
      take("t-5", "s-5", 10),
    ],
  });
}

function log(budgetCny: number): ProjectEvent[] {
  return [
    {
      type: "project.created",
      at: "2026-11-13T09:00:00+08:00",
      project: project(budgetCny),
    },
  ];
}

describe("成本告警（H8 / ADR-0157）", () => {
  it("一镜贵过中位数 3 倍记一条留意", () => {
    const alerts = costAlerts(log(100));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "cost", level: "watch" });
    expect(alerts[0]?.title).toContain("SH-05 成本突增");
    expect(alerts[0]?.detail).toContain("中位数");
  });

  it("项目已花超过预算记一条告警，并排在最前", () => {
    const alerts = costAlerts(log(5));
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ kind: "cost", level: "alarm" });
    expect(alerts[0]?.title).toContain("已超预算");
    expect(alerts[0]?.detail).toContain("¥14.00");
    expect(alerts[0]?.detail).toContain("¥5.00");
  });

  it("当前项目直接传进来：日志分段回放失败也照样报警", () => {
    const alerts = costAlerts([], project(5));
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ level: "alarm", title: "告警测试 已超预算" });
  });

  it("合并同 id、告警优先、最多留 20 条", () => {
    const alert = (id: string, level: HealthAlert["level"]): HealthAlert => ({
      id,
      level,
      kind: "failure",
      title: id,
      detail: "",
    });
    expect(mergeAlerts([alert("a", "watch")], [alert("a", "watch"), alert("b", "alarm")]))
      .toMatchObject([{ id: "b" }, { id: "a" }]);
    const many = rankAlerts(
      Array.from({ length: 25 }, (_, index) => alert(`x-${index}`, "watch")),
    );
    expect(many).toHaveLength(20);
  });
});
