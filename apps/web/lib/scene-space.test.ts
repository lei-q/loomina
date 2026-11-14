import { describe, expect, it } from "vitest";
import { ProjectSchema, type Project, type Shot } from "@loomina/ir";
import { analyzeSceneSpace } from "./scene-space";

type ShotPatch = Partial<Shot>;

function makeProject(shots: ShotPatch[], withSpace = true): Project {
  return ProjectSchema.parse({
    id: "p-space",
    title: "走位台账",
    version: 0,
    locations: [
      {
        id: "loc-1",
        name: "公寓客厅",
        ...(withSpace
          ? { space: { dimensions: [6, 5, 2.8], anchors: [] } }
          : {}),
      },
    ],
    characters: [
      { id: "c-a", name: "林晚" },
      { id: "c-b", name: "周决" },
    ],
    props: [{ id: "pr-1", name: "杯子" }],
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
      characterIds: ["c-a", "c-b"],
      dialogueIds: [],
      ...patch,
    })),
  });
}

const mark = (
  characterId: string,
  side: "left" | "center" | "right",
  depth: "foreground" | "midground" | "background" = "midground",
) => ({ characterId, side, depth, note: "" });

describe("场景空间板 / 走位台账（B11）", () => {
  it("按场列出每一镜的出场人物与站位", () => {
    const report = analyzeSceneSpace(
      makeProject([
        { staging: [mark("c-a", "left"), mark("c-b", "right")] },
        { staging: [mark("c-a", "left"), mark("c-b", "right")] },
      ]),
    );
    expect(report.scenes).toHaveLength(1);
    const row = report.scenes[0]!;
    expect(row.label).toBe("第 1 场");
    expect(row.locationName).toBe("公寓客厅");
    expect(row.entries).toHaveLength(2);
    expect(row.entries[0]!.characters.map((item) => item.name)).toEqual(["林晚", "周决"]);
    expect(row.entries[0]!.characters[0]!.side).toBe("left");
    expect(row.issues).toEqual([]);
    expect(report.summary.checkedPairs).toBe(1);
  });

  it("左右翻面：同一场相邻两镜换了边", () => {
    const report = analyzeSceneSpace(
      makeProject([
        { staging: [mark("c-a", "left"), mark("c-b", "right")] },
        { staging: [mark("c-a", "right"), mark("c-b", "left")] },
      ]),
    );
    const issues = report.scenes[0]!.issues;
    expect(issues).toHaveLength(2);
    expect(issues.every((item) => item.kind === "side")).toBe(true);
    expect(issues[0]!.message).toContain("林晚从画面左换到了画面右");
    expect(report.summary.issues).toBe(2);
  });

  it("居中不算换边：从中间走到左边不报", () => {
    const report = analyzeSceneSpace(
      makeProject([
        { staging: [mark("c-a", "center"), mark("c-b", "right")] },
        { staging: [mark("c-a", "left"), mark("c-b", "right")] },
      ]),
    );
    expect(report.scenes[0]!.issues.filter((item) => item.kind === "side")).toEqual([]);
  });

  it("前后景跳变：前景直接跳到后景", () => {
    const report = analyzeSceneSpace(
      makeProject([
        { staging: [mark("c-a", "left", "foreground")] },
        { staging: [mark("c-a", "left", "background")] },
      ]),
    );
    const depth = report.scenes[0]!.issues.find((item) => item.kind === "depth");
    expect(depth?.message).toContain("从前景跳到了后景");
  });

  it("中景到后景只差一档，不报", () => {
    const report = analyzeSceneSpace(
      makeProject([
        { staging: [mark("c-a", "left", "midground")] },
        { staging: [mark("c-a", "left", "background")] },
      ]),
    );
    expect(report.scenes[0]!.issues).toEqual([]);
  });

  it("朝向翻转：有坐标时判面向角差", () => {
    const report = analyzeSceneSpace(
      makeProject([
        {
          blocking: {
            actors: [{ characterId: "c-a", position: [0, 0, 0], facingRad: 0 }],
            props: [],
          },
        },
        {
          blocking: {
            actors: [{ characterId: "c-a", position: [0, 0, 0], facingRad: Math.PI }],
            props: [],
          },
        },
      ]),
    );
    const facing = report.scenes[0]!.issues.find((item) => item.kind === "facing");
    expect(facing?.message).toContain("180°");
  });

  it("朝向差 90° 不算转身", () => {
    const report = analyzeSceneSpace(
      makeProject([
        {
          blocking: {
            actors: [{ characterId: "c-a", position: [0, 0, 0], facingRad: 0 }],
            props: [],
          },
        },
        {
          blocking: {
            actors: [{ characterId: "c-a", position: [0, 0, 0], facingRad: Math.PI / 2 }],
            props: [],
          },
        },
      ]),
    );
    expect(report.scenes[0]!.issues.filter((item) => item.kind === "facing")).toEqual([]);
  });

  it("道具上一镜带着、下一镜没了：提示一句", () => {
    const report = analyzeSceneSpace(
      makeProject([{ propIds: ["pr-1"] }, { propIds: [] }]),
    );
    const prop = report.scenes[0]!.issues.find((item) => item.kind === "prop");
    expect(prop?.message).toContain("「杯子」在 SH-01 出现，SH-02 里没了");
  });

  it("没有几何时明确说朝向与真实距离判不了", () => {
    const report = analyzeSceneSpace(
      makeProject([{ staging: [mark("c-a", "left")] }], false),
    );
    const row = report.scenes[0]!;
    expect(row.hasSpace).toBe(false);
    expect(row.notes.join("")).toContain("朝向与真实距离判不了");
    expect(report.summary.withGeometry).toBe(0);
  });

  it("没挂进场次的镜头也进台账，标「未进场次」", () => {
    const project = ProjectSchema.parse({
      ...makeProject([{}, {}]),
      scenes: [{ id: "sc-1", index: 0, locationId: "loc-1", shotIds: ["s-1"] }],
    });
    const report = analyzeSceneSpace(project);
    expect(report.scenes.map((row) => row.label)).toEqual(["第 1 场", "未进场次"]);
    expect(report.scenes[1]!.entries[0]!.label).toBe("SH-02");
  });

  it("跨场不判：换场换位置是正常的", () => {
    const project = ProjectSchema.parse({
      ...makeProject([{}, {}]),
      scenes: [
        { id: "sc-1", index: 0, locationId: "loc-1", shotIds: ["s-1"] },
        { id: "sc-2", index: 1, locationId: "loc-1", shotIds: ["s-2"] },
      ],
      shots: makeProject([{}, {}]).shots.map((shot, index) => ({
        ...shot,
        sceneId: index === 0 ? "sc-1" : "sc-2",
        staging: [mark("c-a", index === 0 ? "left" : "right")],
      })),
    });
    const report = analyzeSceneSpace(project);
    expect(report.summary.issues).toBe(0);
    expect(report.summary.checkedPairs).toBe(0);
  });
});

describe("光影跨镜一致性（B4 / ADR-0215）", () => {
  const light = (
    source: "window" | "lamp" | "overhead" | "practical" | "moon",
    position: "front" | "side" | "back" | "top" | "under",
  ) => ({ source, position, mood: "modeled" as const, note: "" });

  it("同一场相邻两镜光源一致：不报", () => {
    const report = analyzeSceneSpace(
      makeProject([
        { lighting: light("window", "side") },
        { lighting: light("window", "side") },
      ]),
    );
    expect(report.scenes[0]!.issues.filter((item) => item.kind === "lighting")).toEqual([]);
  });

  it("主光从侧面变逆光：报一句，说清像换了时间或地点", () => {
    const report = analyzeSceneSpace(
      makeProject([
        { lighting: light("window", "side") },
        { lighting: light("window", "back") },
      ]),
    );
    const issue = report.scenes[0]!.issues.find((item) => item.kind === "lighting")!;
    expect(issue.severity).toBe("review");
    expect(issue.message).toContain("侧面");
    expect(issue.message).toContain("逆光");
    expect(issue.message).toContain("SH-01");
    expect(issue.shotIds).toEqual(["s-1", "s-2"]);
  });

  it("正面与侧面之间互换算软变化，不报", () => {
    const report = analyzeSceneSpace(
      makeProject([
        { lighting: light("window", "front") },
        { lighting: light("window", "side") },
      ]),
    );
    expect(report.scenes[0]!.issues.filter((item) => item.kind === "lighting")).toEqual([]);
  });

  it("光源从窗光变台灯：报一句，提示要有交代", () => {
    const report = analyzeSceneSpace(
      makeProject([
        { lighting: light("window", "side") },
        { lighting: light("lamp", "side") },
      ]),
    );
    const issue = report.scenes[0]!.issues.find((item) => item.kind === "lighting")!;
    expect(issue.message).toContain("窗光");
    expect(issue.message).toContain("台灯");
    expect(issue.fix).toContain("交代");
  });

  it("只有一边写了光影：不判，不知道是没写还是换了", () => {
    const report = analyzeSceneSpace(
      makeProject([{ lighting: light("window", "side") }, {}]),
    );
    expect(report.scenes[0]!.issues.filter((item) => item.kind === "lighting")).toEqual([]);
    expect(report.scenes[0]!.entries[1]!.lighting).toBeNull();
  });

  it("跨场不判光影：换场换光正常", () => {
    const project = ProjectSchema.parse({
      ...makeProject([{}, {}]),
      scenes: [
        { id: "sc-1", index: 0, locationId: "loc-1", shotIds: ["s-1"] },
        { id: "sc-2", index: 1, locationId: "loc-1", shotIds: ["s-2"] },
      ],
      shots: makeProject([{}, {}]).shots.map((shot, index) => ({
        ...shot,
        sceneId: index === 0 ? "sc-1" : "sc-2",
        lighting: index === 0 ? light("window", "side") : light("moon", "back"),
      })),
    });
    expect(analyzeSceneSpace(project).summary.issues).toBe(0);
  });
});
