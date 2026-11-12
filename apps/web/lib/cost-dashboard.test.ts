import { describe, expect, it } from "vitest";
import { ProjectSchema } from "@loomina/ir";
import { costDashboard, firstPassOf, MIN_SPIKE_SAMPLES, SPIKE_RATIO } from "./cost-dashboard";
import { sampleProject } from "./sample-project";

/**
 * 成本看板（H15 / ADR-0156）。
 *
 * 用一条手工项目把四种读数都摆出来：单镜成本、第一版采纳率、
 * 淘汰 take 占比、以及一镜明显贵过其他镜的突增。
 */

function take(id: string, shotId: string, status: "draft" | "approved" | "rejected", costCny: number) {
  return {
    id,
    shotId,
    assetId: `asset-${id}`,
    status,
    costCny,
    provenance: { modelId: "minimax-h3", createdAt: "2026-11-13T10:00:00+08:00" },
  };
}

function project() {
  const shots = [1, 2, 3, 4, 5].map((n) => ({
    id: `s-${n}`,
    sceneId: "sc-1",
    index: n - 1,
    durationMs: 3000,
    description: `第 ${n} 镜`,
    shotSize: "medium" as const,
    camera: { angle: "eye" as const, movement: "static" as const, focalMm: 35 },
    takeIds: [`t-${n}-1`],
  }));
  return ProjectSchema.parse({
    id: "p-cost",
    title: "成本测试",
    version: 0,
    locations: [{ id: "loc-1", name: "走廊" }],
    scenes: [{ id: "sc-1", index: 0, locationId: "loc-1", shotIds: shots.map((shot) => shot.id) }],
    shots,
    takes: [
      take("t-1-1", "s-1", "approved", 1),
      take("t-2-1", "s-2", "rejected", 1),
      take("t-2-2", "s-2", "approved", 1),
      take("t-3-1", "s-3", "draft", 1),
      take("t-4-1", "s-4", "rejected", 1),
      take("t-5-1", "s-5", "approved", 10),
    ],
  });
}

describe("成本看板（H15 / ADR-0156）", () => {
  it("单镜成本只按有花钱的镜算，零花费不摊薄均值", () => {
    const board = costDashboard(project());
    expect(board.shots).toBe(5);
    expect(board.pricedShots).toBe(5);
    expect(board.spent).toBe(15);
    expect(board.avgCnyPerShot).toBe(3);
    expect(board.medianCnyPerShot).toBe(1);
    expect(board.topShots[0]).toMatchObject({ label: "SH-05", spent: 10 });
  });

  it("第一版采纳率排除还没判定的 draft 镜", () => {
    const board = costDashboard(project());
    expect(board.judgedShots).toBe(4);
    expect(board.firstPassShots).toBe(2);
    expect(board.firstPassRate).toBe(0.5);
    expect(firstPassOf([])).toBeUndefined();
    const takes = project().takes;
    expect(firstPassOf(takes.filter((item) => item.shotId === "s-1"))).toBe(true);
    expect(firstPassOf(takes.filter((item) => item.shotId === "s-2"))).toBe(false);
    expect(firstPassOf(takes.filter((item) => item.shotId === "s-3"))).toBeUndefined();
  });

  it("重试占比按淘汰 take 数算，同时给出淘汰金额", () => {
    const board = costDashboard(project());
    expect(board.takes).toBe(6);
    expect(board.rejectedTakes).toBe(2);
    expect(board.retryShare).toBeCloseTo(0.333, 3);
    expect(board.retryCny).toBe(2);
  });

  it("贵过中位数 3 倍且多花至少 ¥1 的镜才叫突增", () => {
    const board = costDashboard(project());
    expect(board.anomalies.map((item) => item.label)).toEqual(["SH-05"]);
    expect(board.anomalies[0]).toMatchObject({ times: 10, medianCny: 1 });
    expect(board.anomalies[0]?.reason).toContain("中位数");

    expect(MIN_SPIKE_SAMPLES).toBe(4);
    expect(SPIKE_RATIO).toBe(3);
  });

  it("没有 take 的示例项目不硬给通过率", () => {
    const board = costDashboard(ProjectSchema.parse({ ...sampleProject, takes: [] }));
    expect(board.takes).toBe(0);
    expect(board.retryShare).toBeUndefined();
    expect(board.firstPassRate).toBeUndefined();
    expect(board.anomalies).toEqual([]);
  });
});
