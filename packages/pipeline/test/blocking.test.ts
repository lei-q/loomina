import { describe, expect, it } from "vitest";
import { ProjectSchema, rebuild, type Project } from "@loomina/ir";
import { blockingOf, checkAxis, hasGeometry, suggestBlocking } from "../src/blocking";
import { mergeTemplateSpace, templateSpace, sceneTemplateById } from "../src/scene-templates";

const AT = "2026-11-12T10:00:00Z";

/** 一个带客厅几何的最小项目：两个人在客厅里对白 */
function livingProject(options: { tension?: string; solo?: boolean } = {}): Project {
  const template = sceneTemplateById("living-room")!;
  const characters = options.solo
    ? [{ id: "c-lin", name: "林", appearance: "", sheet: {}, referenceImages: [], mustNotChange: [] }]
    : [
        { id: "c-lin", name: "林", appearance: "", sheet: {}, referenceImages: [], mustNotChange: [] },
        { id: "c-zhou", name: "周", appearance: "", sheet: {}, referenceImages: [], mustNotChange: [] },
      ];
  return ProjectSchema.parse({
    id: "p-blocking",
    title: "走位",
    version: 1,
    story: {
      logline: "",
      synopsis: "",
      genre: "",
      audience: "",
      tone: "",
      hooks: { opening: "", ending: "" },
      arcs: [],
      relationships: options.tension
        ? [{ fromCharacterId: "c-lin", toCharacterId: "c-zhou", tension: options.tension }]
        : [],
    },
    locations: [
      {
        id: "loc-living",
        name: "公寓客厅",
        templateId: "living-room",
        description: "",
        referenceImages: [],
        space: templateSpace(template),
      },
    ],
    characters,
    props: [],
    scenes: [{ id: "sc-1", index: 0, code: "", locationId: "loc-living", space: "int", timeOfDay: "day", shotIds: ["s-1", "s-2"] }],
    shots: [
      {
        id: "s-1",
        sceneId: "sc-1",
        index: 0,
        durationMs: 2000,
        description: "",
        promptNotes: [],
        shotSize: "medium",
        camera: { angle: "eye", movement: "static", focalMm: 35 },
        staging: [],
        characterIds: options.solo ? ["c-lin"] : ["c-lin", "c-zhou"],
        propIds: [],
        dialogueIds: [],
        takeIds: [],
        keyframes: {},
        locked: false,
      },
      {
        id: "s-2",
        sceneId: "sc-1",
        index: 1,
        durationMs: 2000,
        description: "",
        promptNotes: [],
        shotSize: "medium",
        camera: { angle: "eye", movement: "static", focalMm: 50 },
        staging: [],
        characterIds: options.solo ? ["c-lin"] : ["c-lin", "c-zhou"],
        propIds: [],
        dialogueIds: [],
        takeIds: [],
        keyframes: {},
        locked: false,
      },
    ],
    dialogue: [],
    takes: [],
    assets: [],
    approvals: [],
    gates: [],
    timeline: { items: [] },
    subtitleOverrides: [],
    publishPackages: [],
  });
}

describe("自动摆位（B13.1 / ADR-0126 §5）", () => {
  it("没有几何时说清楚原因，不给空建议", () => {
    const project = livingProject();
    project.locations[0]!.space = undefined;
    const result = suggestBlocking(project, "sc-1");
    expect("reason" in result && result.reason).toContain("还没有几何");
  });

  it("双人对白：两个人隔桌对面，朝向相对", () => {
    const result = suggestBlocking(livingProject(), "sc-1");
    if ("reason" in result) throw new Error(result.reason);
    expect(result.actors).toHaveLength(2);
    const [a, b] = result.actors;
    // 两人分居 Z 轴两侧，面对面
    expect(Math.sign(a!.position[2])).toBe(-Math.sign(b!.position[2]));
    expect(Math.abs(a!.facingRad)).toBeGreaterThan(2.5);
    expect(result.axis).toEqual({ aId: "c-lin", bId: "c-zhou" });
    expect(result.note).toContain("隔桌");
  });

  it("关系里有权力词：一个坐桌后、一个站桌前", () => {
    const result = suggestBlocking(livingProject({ tension: "上司压着下属" }), "sc-1");
    if ("reason" in result) throw new Error(result.reason);
    expect(result.note).toContain("权力");
    const [a, b] = result.actors;
    expect(Math.abs(a!.position[2] - b!.position[2])).toBeCloseTo(1.8, 1);
  });

  it("关系里有亲密词：同侧相邻", () => {
    const result = suggestBlocking(livingProject({ tension: "情侣，亲密" }), "sc-1");
    if ("reason" in result) throw new Error(result.reason);
    expect(result.note).toContain("同侧");
    const [a, b] = result.actors;
    expect(a!.position[2]).toBeCloseTo(b!.position[2], 5);
    expect(Math.abs(a!.position[0] - b!.position[0])).toBeCloseTo(1.1, 1);
  });

  it("独处：偏一侧，另一侧留负空间", () => {
    const result = suggestBlocking(livingProject({ solo: true }), "sc-1");
    if ("reason" in result) throw new Error(result.reason);
    expect(result.actors).toHaveLength(1);
    expect(result.actors[0]!.position[0]).toBeLessThan(0);
    expect(result.note).toContain("负空间");
  });

  it("三个机位全部落在轴线同一侧，且机位与目标不重合", () => {
    const result = suggestBlocking(livingProject(), "sc-1");
    if ("reason" in result) throw new Error(result.reason);
    expect(result.cameras).toHaveLength(2);
    for (const camera of result.cameras) {
      expect(
        Math.hypot(
          camera.placement.position[0] - camera.placement.target[0],
          camera.placement.position[2] - camera.placement.target[2],
        ),
      ).toBeGreaterThan(0.2);
    }
    // 相邻两镜的机位同侧：checkAxis 不应该报越轴
    const project = livingProject();
    const applied = rebuild([
      { type: "project.created", at: AT, project },
      ...result.cameras.map(
        (camera) =>
          ({
            type: "shot.updated" as const,
            at: AT,
            shotId: camera.shotId,
            patch: {
              camera: { angle: "eye" as const, movement: "static" as const, focalMm: camera.focalMm, placement: camera.placement },
              blocking: blockingOf(result.actors),
            },
          }),
      ),
    ]);
    expect(checkAxis(applied, "sc-1").violations).toEqual([]);
    expect(checkAxis(applied, "sc-1").checked).toBe(1);
  });

  it("建议是纯函数：同样输入两次结果一致，且 1 秒内", () => {
    const project = livingProject();
    const started = performance.now();
    const first = suggestBlocking(project, "sc-1");
    const elapsed = performance.now() - started;
    const second = suggestBlocking(project, "sc-1");
    expect(second).toEqual(first);
    expect(elapsed).toBeLessThan(1000);
    // 建议不写事件：原项目一个字都没变
    expect(project.shots.every((shot) => shot.blocking === undefined)).toBe(true);
  });

  it("建议里的坐标全部落在场地内", () => {
    const project = livingProject();
    const result = suggestBlocking(project, "sc-1");
    if ("reason" in result) throw new Error(result.reason);
    const [width, depth, height] = project.locations[0]!.space!.dimensions;
    for (const actor of result.actors) {
      expect(Math.abs(actor.position[0])).toBeLessThanOrEqual(width / 2 + 0.1);
      expect(Math.abs(actor.position[2])).toBeLessThanOrEqual(depth / 2 + 0.1);
      expect(actor.position[1]).toBeLessThanOrEqual(height);
    }
    for (const camera of result.cameras) {
      for (const point of [camera.placement.position, camera.placement.target]) {
        expect(Math.abs(point[0])).toBeLessThanOrEqual(width / 2 + 0.1);
        expect(Math.abs(point[2])).toBeLessThanOrEqual(depth / 2 + 0.1);
      }
    }
  });
});

describe("越轴（B13.1 / ADR-0126 §4）", () => {
  const line = {
    a: [-1, 0, 0] as [number, number, number],
    b: [1, 0, 0] as [number, number, number],
  };

  function withPlacements(
    positions: [[number, number, number], [number, number, number]],
  ): Project {
    const project = livingProject();
    const events = positions.map((position, index) => ({
      type: "shot.updated" as const,
      at: AT,
      shotId: index === 0 ? "s-1" : "s-2",
      patch: {
        camera: {
          angle: "eye" as const,
          movement: "static" as const,
          focalMm: 35,
          placement: { position, target: [0, 1.2, 0] as [number, number, number] },
        },
        blocking: {
          actors: [
            { characterId: "c-lin", position: line.a, facingRad: 0 },
            { characterId: "c-zhou", position: line.b, facingRad: Math.PI },
          ],
          props: [],
        },
      },
    }));
    return rebuild([{ type: "project.created", at: AT, project }, ...events]);
  }

  it("相邻两镜机位在轴线两侧：判越轴，并指出是哪两镜", () => {
    const project = withPlacements([
      [0, 1.5, 1.2],
      [0, 1.5, -1.2],
    ]);
    const report = checkAxis(project, "sc-1");
    expect(report.checked).toBe(1);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.shotIds).toEqual(["s-1", "s-2"]);
    expect(report.axis).toEqual({ aId: "c-lin", bId: "c-zhou" });
  });

  it("同一侧不判；没有机位坐标时不判", () => {
    const sameSide = withPlacements([
      [0, 1.5, 1.2],
      [0.5, 1.5, 1.1],
    ]);
    expect(checkAxis(sameSide, "sc-1").violations).toEqual([]);

    const noPlacement = livingProject();
    const report = checkAxis(noPlacement, "sc-1");
    expect(report.checked).toBe(0);
    expect(report.violations).toEqual([]);
  });

  it("只有一个人在场时不判越轴", () => {
    const project = livingProject({ solo: true });
    expect(checkAxis(project, "sc-1").axis).toBeNull();
    expect(checkAxis(project, "sc-1").violations).toEqual([]);
  });

  it("hasGeometry：有 space 才有，没选模板就没有", () => {
    const project = livingProject();
    expect(hasGeometry(project, "sc-1")).toBe(true);
    project.locations[0]!.space = undefined;
    expect(hasGeometry(project, "sc-1")).toBe(false);
  });
});

describe("模板几何（B13.1）", () => {
  it("十个模板都有几何，锚点都在场地内", () => {
    for (const id of [
      "living-room",
      "bedroom",
      "office",
      "elevator",
      "street",
      "cafe",
      "hospital-corridor",
      "car-interior",
      "rooftop",
      "classroom",
    ]) {
      const template = sceneTemplateById(id)!;
      const space = templateSpace(template);
      expect(space.anchors.length).toBeGreaterThanOrEqual(3);
      const [width, depth, height] = space.dimensions;
      for (const anchor of space.anchors) {
        expect(Math.abs(anchor.position[0])).toBeLessThanOrEqual(width / 2 + 0.01);
        expect(Math.abs(anchor.position[2])).toBeLessThanOrEqual(depth / 2 + 0.01);
        expect(anchor.position[1]).toBeGreaterThanOrEqual(0);
        expect(anchor.position[1]).toBeLessThanOrEqual(height);
      }
    }
  });

  it("每个模板都有门或窗这类可摆位的锚点", () => {
    for (const template of ["living-room", "bedroom", "office", "elevator"]) {
      const kinds = templateSpace(sceneTemplateById(template)!).anchors.map((a) => a.kind);
      expect(kinds.some((kind) => kind === "door" || kind === "window")).toBe(true);
    }
  });

  it("换模板按锚点 id 保留作者改过的位置", () => {
    const living = templateSpace(sceneTemplateById("living-room")!);
    const edited = {
      ...living,
      anchors: living.anchors.map((anchor) =>
        anchor.id === "sofa" ? { ...anchor, position: [1, 0.45, 1.2] as [number, number, number] } : anchor,
      ),
    };
    const merged = mergeTemplateSpace(edited, templateSpace(sceneTemplateById("living-room")!));
    expect(merged.anchors.find((anchor) => anchor.id === "sofa")?.position).toEqual([1, 0.45, 1.2]);
    // 没动过的锚点跟着模板走
    expect(merged.anchors.find((anchor) => anchor.id === "door")?.position).toEqual(
      living.anchors.find((anchor) => anchor.id === "door")?.position,
    );
  });

  it("换到另一套模板：新模板没有的锚点丢掉", () => {
    const living = templateSpace(sceneTemplateById("living-room")!);
    const merged = mergeTemplateSpace(living, templateSpace(sceneTemplateById("elevator")!));
    expect(merged.anchors.map((anchor) => anchor.id)).toEqual(["door", "panel", "mirror", "handrail", "ceiling"]);
    expect(merged.dimensions).toEqual([2, 2, 2.6]);
  });
});
