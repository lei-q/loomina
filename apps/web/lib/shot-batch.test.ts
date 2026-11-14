import { describe, expect, it } from "vitest";
import { ProjectSchema, type Project } from "@loomina/ir";
import { FOCAL_MAX, FOCAL_MIN, batchPatchProblem, batchPlanOf, batchText } from "./shot-batch";

function makeProject(shots: Partial<Project["shots"][number]>[]): Project {
  return ProjectSchema.parse({
    id: "p-batch",
    title: "批量套用",
    version: 0,
    locations: [{ id: "loc-1", name: "走廊" }],
    characters: [{ id: "c-a", name: "甲" }],
    scenes: [
      {
        id: "sc-1",
        index: 0,
        locationId: "loc-1",
        shotIds: shots.map((_, index) => `s-${index + 1}`),
      },
    ],
    shots: shots.map((patch, index) => ({
      id: `s-${index + 1}`,
      sceneId: "sc-1",
      index,
      durationMs: 2000,
      description: `第 ${index + 1} 镜`,
      shotSize: "medium",
      camera: { angle: "eye", movement: "static", focalMm: 35 },
      characterIds: ["c-a"],
      dialogueIds: [],
      ...patch,
    })),
  });
}

describe("按场批量套用（I7 第三档 / ADR-0225）", () => {
  it("整场都换景别：每镜都算会变，写同样多条事件", () => {
    const plan = batchPlanOf(makeProject([{}, {}, {}]), "sc-1", { shotSize: "close" });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.summary.shots).toBe(3);
    expect(plan.summary.changing).toBe(3);
    expect(plan.summary.events).toBe(3);
    expect(plan.changes[0]!.changes[0]).toContain("景别");
    expect(plan.changes[0]!.changes[0]).toContain("特写");
  });

  it("锁定的镜跳过，并说清为什么", () => {
    const plan = batchPlanOf(
      makeProject([{}, { locked: true }, {}]),
      "sc-1",
      { shotSize: "close" },
    );
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.summary.changing).toBe(2);
    expect(plan.summary.skipped).toBe(1);
    expect(plan.skipped[0]!.reason).toContain("锁定");
  });

  it("已经是这样的镜跳过，不写空事件", () => {
    const plan = batchPlanOf(
      makeProject([{ shotSize: "close" }, { shotSize: "medium" }]),
      "sc-1",
      { shotSize: "close" },
    );
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.summary.changing).toBe(1);
    expect(plan.skipped[0]!.reason).toContain("已经是这样");
  });

  it("机位整份写回：走位坐标保留", () => {
    const plan = batchPlanOf(
      makeProject([
        {
          camera: {
            angle: "eye",
            movement: "static",
            focalMm: 35,
            placement: { position: [1, 2, 3], target: [0, 0, 0] },
          },
        },
      ]),
      "sc-1",
      { angle: "low" },
    );
    if ("error" in plan) throw new Error(plan.error);
    const next = plan.changes[0]!.next.camera!;
    expect(next.angle).toBe("low");
    expect(next.placement).toEqual({ position: [1, 2, 3], target: [0, 0, 0] });
  });

  it("焦段越界报错，不出计划", () => {
    const plan = batchPlanOf(makeProject([{}]), "sc-1", { focalMm: 500 });
    expect("error" in plan && plan.error).toContain("焦段");
    expect(batchPatchProblem({ focalMm: FOCAL_MAX + 1 })).toContain("焦段");
    expect(batchPatchProblem({ focalMm: FOCAL_MIN })).toBeUndefined();
  });

  it("空补丁报「没有要改的参数」", () => {
    expect(batchPatchProblem({})).toContain("没有要改");
    const plan = batchPlanOf(makeProject([{}]), "sc-1", {});
    expect("error" in plan).toBe(true);
  });

  it("找不到这一场", () => {
    const plan = batchPlanOf(makeProject([{}]), "sc-nope", { shotSize: "close" });
    expect("error" in plan && plan.error).toContain("找不到");
  });

  it("一句话说清会改几镜、写几条事件", () => {
    const plan = batchPlanOf(
      makeProject([{}, { locked: true }, { shotSize: "close" }]),
      "sc-1",
      { shotSize: "close" },
    );
    if ("error" in plan) throw new Error(plan.error);
    const text = batchText(plan);
    expect(text).toContain("会改 1 镜");
    expect(text).toContain("写 1 条事件");
    expect(text).toContain("2 镜跳过");
  });

  it("都不用改时如实说", () => {
    const plan = batchPlanOf(
      makeProject([{ shotSize: "close" }, { shotSize: "close" }]),
      "sc-1",
      { shotSize: "close" },
    );
    if ("error" in plan) throw new Error(plan.error);
    expect(batchText(plan)).toContain("都不用改");
  });
});
