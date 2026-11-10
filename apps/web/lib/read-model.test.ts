import { describe, expect, it } from "vitest";
import { ProjectSchema, type ProjectInput } from "@loomina/ir";
import { toStageView } from "./read-model";
import { sampleProject } from "./sample-project";

describe("toStageView", () => {
  it("按场次顺序、场内镜序排，镜号从 1 开始", () => {
    const view = toStageView(sampleProject);
    expect(view.shots.map((shot) => shot.id)).toEqual([
      "s-01", "s-02", "s-03", "s-04", "s-05", "s-06",
      "s-07", "s-08", "s-09", "s-10", "s-11", "s-12",
    ]);
    expect(view.shots[0]?.no).toBe(1);
    expect(view.shots[11]?.no).toBe(12);
  });

  it("固定镜头不因 take 状态而丢失", () => {
    const view = toStageView(sampleProject);
    expect(view.shots).toHaveLength(12);
  });

  it("take 状态映射成留用 / 淘汰 / 待定", () => {
    const view = toStageView(sampleProject);
    const stateById = new Map(view.shots.map((shot) => [shot.id, shot.state]));
    expect(stateById.get("s-01")).toBe("reject"); // t-01 rejected
    expect(stateById.get("s-02")).toBe("pick"); // t-02 approved
    expect(stateById.get("s-03")).toBe("open"); // t-03 draft
    expect(stateById.get("s-08")).toBe("pick"); // approved + locked
  });

  it("已花是全部 take 的成本之和", () => {
    const view = toStageView(sampleProject);
    expect(view.spent).toBeCloseTo(18.96, 2);
  });

  it("重做报价跟着当前镜头的时长走，不再是一个写死的数", () => {
    const short = toStageView(sampleProject, { currentShotId: "s-03" }); // 2.4s
    const long = toStageView(sampleProject, { currentShotId: "s-09" }); // 3.0s
    expect(short.requote.totalCny).toBeCloseTo(1.32, 2);
    expect(long.requote.totalCny).toBeCloseTo(1.62, 2);
    expect(short.requote.basis).toContain("2.4s");
  });

  it("不指定当前镜时，落在第一个还没定的镜头上", () => {
    const view = toStageView(sampleProject);
    expect(view.shots[view.current]?.id).toBe("s-03");
  });

  it("字幕取当前镜的台词，没有台词就是空串", () => {
    const withDialogue = toStageView(sampleProject, { currentShotId: "s-04" });
    expect(withDialogue.subtitle).toBe("灯是我关的。");

    const withoutDialogue = toStageView(sampleProject, { currentShotId: "s-05" });
    expect(withoutDialogue.subtitle).toBe("");
  });

  it("同一镜头多条 take 时取最新的一条", () => {
    const input: ProjectInput = {
      id: "p-1",
      title: "测试",
      version: 1,
      scenes: [{ id: "sc-1", index: 0, locationId: "loc-1", shotIds: ["s-1"] }],
      locations: [{ id: "loc-1", name: "门口", templateId: "doorway" }],
      shots: [
        {
          id: "s-1",
          sceneId: "sc-1",
          index: 0,
          durationMs: 2000,
          shotSize: "close",
          camera: { angle: "eye", movement: "static", focalMm: 50 },
          takeIds: ["t-old", "t-new"],
        },
      ],
      takes: [
        {
          id: "t-old",
          shotId: "s-1",
          assetId: "a-old",
          status: "approved",
          provenance: { modelId: "m", createdAt: "2026-11-09T10:00:00+08:00" },
        },
        {
          id: "t-new",
          shotId: "s-1",
          assetId: "a-new",
          status: "draft",
          provenance: { modelId: "m", createdAt: "2026-11-09T12:00:00+08:00" },
        },
      ],
    };

    const view = toStageView(ProjectSchema.parse(input));
    expect(view.shots[0]?.state).toBe("open"); // 最新一版是 draft
    expect(view.shots[0]?.take).toBe(2);
  });

  it("两个及以上角色用双人剪影，否则按场景模板", () => {
    const view = toStageView(sampleProject);
    const artById = new Map(view.shots.map((shot) => [shot.id, shot.art]));
    expect(artById.get("s-04")).toBe("two"); // 林 + 周
    expect(artById.get("s-06")).toBe("corridor"); // 走廊
    expect(artById.get("s-09")).toBe("table");
  });
});
