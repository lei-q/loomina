import { describe, expect, it } from "vitest";
import { ProjectSchema, type Project } from "@loomina/ir";
import {
  DEFAULT_SIZE,
  FAR_PLANE_M,
  NEAR_PLANE_M,
  STRUCTURE_HEIGHT,
  STRUCTURE_WIDTH,
  basisOf,
  depthColor,
  focalPxOf,
  project,
  structureOf,
  withAlpha,
} from "../src/structure";
import { sceneTemplateById, templateSpace } from "../src/scene-templates";

const AT = "2026-11-12T10:00:00Z";

function space(anchors?: { id: string; kind: string; position: [number, number, number]; label?: string }[]) {
  const template = sceneTemplateById("living-room")!;
  const result = templateSpace(template);
  if (anchors) {
    result.anchors = anchors.map((anchor) => ({
      id: anchor.id,
      kind: anchor.kind as never,
      label: anchor.label,
      position: anchor.position,
      facingRad: 0,
      capacity: 0,
    }));
  }
  return result;
}

function projectWith(options: {
  camera?: { position: [number, number, number]; target: [number, number, number] };
  anchors?: { id: string; kind: string; position: [number, number, number]; label?: string }[];
  blocking?: { actors: { characterId: string; position: [number, number, number]; facingRad: number }[] };
} = {}): Project {
  const result = ProjectSchema.parse({
    id: "p-struct",
    title: "结构",
    version: 1,
    story: {
      logline: "",
      synopsis: "",
      genre: "",
      audience: "",
      tone: "",
      hooks: { opening: "", ending: "" },
      arcs: [],
      relationships: [],
    },
    locations: [
      {
        id: "loc-living",
        name: "公寓客厅",
        templateId: "living-room",
        description: "",
        referenceImages: [],
        space: space(options.anchors),
      },
    ],
    characters: [
      { id: "c-lin", name: "林", appearance: "", sheet: {}, referenceImages: [], mustNotChange: [] },
      { id: "c-zhou", name: "周", appearance: "", sheet: {}, referenceImages: [], mustNotChange: [] },
    ],
    props: [],
    scenes: [
      { id: "sc-1", index: 0, code: "", locationId: "loc-living", space: "int", timeOfDay: "day", shotIds: ["s-1"] },
    ],
    shots: [
      {
        id: "s-1",
        sceneId: "sc-1",
        index: 0,
        durationMs: 2000,
        description: "",
        promptNotes: [],
        shotSize: "medium",
        camera: {
          angle: "eye",
          movement: "static",
          focalMm: 35,
          ...(options.camera ? { placement: options.camera } : {}),
        },
        staging: [],
        characterIds: ["c-lin", "c-zhou"],
        propIds: [],
        dialogueIds: [],
        takeIds: [],
        keyframes: {},
        locked: false,
        ...(options.blocking ? { blocking: options.blocking } : {}),
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
  return result;
}

const PLACEMENT = { position: [0, 1.5, 2] as [number, number, number], target: [0, 1.2, 0] as [number, number, number] };

describe("投影（B13.3 / ADR-0129 §2）", () => {
  it("目标点投在画面正中，深度等于机位到目标的距离", () => {
    const basis = basisOf(PLACEMENT);
    const at = project(basis, PLACEMENT.target);
    expect(at).toBeDefined();
    expect(at!.x).toBeCloseTo(STRUCTURE_WIDTH / 2, 5);
    expect(at!.y).toBeCloseTo(STRUCTURE_HEIGHT / 2, 5);
    expect(at!.depth).toBeCloseTo(Math.hypot(2, 0.3), 5);
  });

  it("机位右边的点投在画面右半边，上方的点投在画面上半", () => {
    const basis = basisOf(PLACEMENT);
    const right = project(basis, [1, 1.2, 0])!;
    const up = project(basis, [0, 2.2, 0])!;
    expect(right.x).toBeGreaterThan(STRUCTURE_WIDTH / 2);
    // 屏幕 y 向下：高处的点 y 更小
    expect(up.y).toBeLessThan(STRUCTURE_HEIGHT / 2);
  });

  it("机位背后的点投不出来", () => {
    const basis = basisOf(PLACEMENT);
    expect(project(basis, [0, 1.5, 4])).toBeUndefined();
  });

  it("贴到镜头上的点也投不出来", () => {
    const basis = basisOf(PLACEMENT);
    expect(project(basis, [0, 1.5, 2 - NEAR_PLANE_M / 2])).toBeUndefined();
  });

  it("焦段越长，像素焦距越大（同一个点更靠边）", () => {
    expect(focalPxOf(DEFAULT_SIZE, 50)).toBeGreaterThan(focalPxOf(DEFAULT_SIZE, 35));
    const wide = basisOf(PLACEMENT);
    const long = { ...wide, focalPx: focalPxOf(DEFAULT_SIZE, 50) };
    const point: [number, number, number] = [0.8, 1.2, 0];
    expect(project(long, point)!.x).toBeGreaterThan(project(wide, point)!.x);
  });

  it("深度色标：近处暖、远处冷", () => {
    const near = depthColor(0.3);
    const far = depthColor(FAR_PLANE_M);
    const hueOf = (color: string) => Number(/hsl\((\d+)/.exec(color)![1]);
    expect(hueOf(near)).toBeLessThan(90);
    expect(hueOf(far)).toBeGreaterThan(180);
    // 两端之外夹住，不会出现越界色相
    expect(depthColor(-5)).toBe(depthColor(NEAR_PLANE_M));
    expect(depthColor(100)).toBe(depthColor(FAR_PLANE_M));
  });
});

describe("结构参考图（B13.3 / ADR-0129 §2）", () => {
  it("没有人物也有图：地面网格与房间框", () => {
    const frame = structureOf({ space: space(), placement: PLACEMENT, actors: [] });
    expect(frame.width).toBe(STRUCTURE_WIDTH);
    expect(frame.height).toBe(STRUCTURE_HEIGHT);
    expect(frame.shapes.length).toBeGreaterThan(0);
    expect(frame.shapes.some((shape) => shape.kind === "line")).toBe(true);
  });

  it("人物画成柱子 + 头 + 名字，且按由远到近排好", () => {
    const frame = structureOf({
      space: space(),
      placement: PLACEMENT,
      actors: [
        { characterId: "c-lin", name: "林", position: [0, 0, 0] },
        { characterId: "c-zhou", name: "周", position: [0, 0, 1] },
      ],
    });
    const labels = frame.shapes.filter((shape) => shape.kind === "label");
    expect(labels.map((shape) => (shape.kind === "label" ? shape.text : ""))).toEqual(["林", "周"]);
    expect(frame.shapes.filter((shape) => shape.kind === "disc")).toHaveLength(2);
    const depths = frame.shapes.map((shape) => shape.depth);
    expect(depths).toEqual([...depths].sort((a, b) => b - a));
  });

  it("家具画成矮盒，按模板给的高度", () => {
    const frame = structureOf({
      space: space([{ id: "table", kind: "furniture", position: [0, 0.75, 0], label: "茶几" }]),
      placement: PLACEMENT,
      actors: [],
    });
    const quads = frame.shapes.filter((shape) => shape.kind === "quad");
    expect(quads.length).toBeGreaterThan(0);
    // 盒子的四个角都在画布范围内或至少有限
    for (const quad of quads) {
      for (const [x, y] of quad.kind === "quad" ? quad.points : []) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
      }
    }
  });

  it("机位背后的人不画，但数进 culled", () => {
    const frame = structureOf({
      space: space(),
      placement: PLACEMENT,
      actors: [
        { characterId: "c-lin", name: "林", position: [0, 0, 0] },
        { characterId: "c-zhou", name: "周", position: [0, 0, 3.5] },
      ],
    });
    expect(frame.culled).toBe(1);
    const labels = frame.shapes.filter((shape) => shape.kind === "label");
    expect(labels).toHaveLength(1);
  });

  it("自定义尺寸与焦段生效", () => {
    const frame = structureOf({
      space: space(),
      placement: PLACEMENT,
      actors: [{ characterId: "c-lin", name: "林", position: [0.6, 0, 0] }],
      size: { width: 720, height: 1280 },
      focalMm: 50,
    });
    expect(frame.width).toBe(720);
    const wide = structureOf({
      space: space(),
      placement: PLACEMENT,
      actors: [{ characterId: "c-lin", name: "林", position: [0.6, 0, 0] }],
    });
    const center = (f: typeof frame) => {
      // 人物柱：描边是亮色（家具顶面是淡色描边）
      const quad = f.shapes.find(
        (shape) => shape.kind === "quad" && shape.stroke === "rgba(255,255,255,.55)",
      );
      if (!quad || quad.kind !== "quad") return 0;
      return (quad.points[0]![0] + quad.points[1]![0]) / 2;
    };
    // 长焦把同一个点推得离中线更远（按画面比例）
    expect(center(frame) / frame.width).toBeGreaterThan(center(wide) / wide.width);
  });

  it("半透明只改透明度，不改颜色", () => {
    expect(withAlpha("#8fb2d6", 0.5)).toBe("rgba(143,178,214,0.5)");
    expect(withAlpha("hsl(28 62% 58%)", 0.5)).toBe("hsl(28 62% 58% / 0.5)");
    // 认不出的写法原样返回：宁可实心，也不要画出没有颜色的东西
    expect(withAlpha("rebeccapurple", 0.5)).toBe("rebeccapurple");
  });

  it("名字不被家具盖住：标签的深度排在最后", () => {
    const frame = structureOf({
      space: space([{ id: "table", kind: "furniture", position: [0, 0.9, 0.4], label: "高桌" }]),
      placement: PLACEMENT,
      actors: [{ characterId: "c-lin", name: "林", position: [0, 0, 0.4] }],
    });
    const last = frame.shapes.at(-1);
    expect(last?.kind).toBe("label");
  });

  it("整个偏出画面的人不画半截柱子：标「画面外」并计数", () => {
    const frame = structureOf({
      space: space(),
      placement: PLACEMENT,
      actors: [{ characterId: "c-zhou", name: "周", position: [4, 0, 0] }],
    });
    expect(frame.outside).toBe(1);
    const labels = frame.shapes.filter((shape) => shape.kind === "label");
    expect(labels).toHaveLength(1);
    expect(labels[0]!.kind === "label" && labels[0]!.text).toContain("画面外");
    // 没有柱子与头
    expect(frame.shapes.filter((shape) => shape.kind === "disc")).toHaveLength(0);
  });

  it("在画面内的人 outside 为 0", () => {
    const frame = structureOf({
      space: space(),
      placement: PLACEMENT,
      actors: [{ characterId: "c-lin", name: "林", position: [0, 0, 0] }],
    });
    expect(frame.outside).toBe(0);
  });

  it("俯拍也能画：机位在正上方时基不退化", () => {
    const frame = structureOf({
      space: space(),
      placement: { position: [0, 2.7, 0], target: [0, 0, 0] },
      actors: [{ characterId: "c-lin", name: "林", position: [0.8, 0, 0.4] }],
    });
    expect(frame.shapes.some((shape) => shape.kind === "label")).toBe(true);
    expect(Number.isFinite(frame.shapes[0]!.depth)).toBe(true);
  });
});
