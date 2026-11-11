import { describe, expect, it } from "vitest";
import { ProjectSchema, type Project } from "@loomina/ir";
import {
  ACTOR_HEAD_M,
  ANGLE_LABEL,
  angleFromPitch,
  elevationExtent,
  elevationOf,
  occlusionsOf,
} from "../src/elevation";
import { sceneTemplateById, templateSpace } from "../src/scene-templates";

const AT = "2026-11-12T10:00:00Z";

function project(options: {
  camera?: { position: [number, number, number]; target: [number, number, number] };
  angle?: "eye" | "low" | "high" | "top";
  blocking?: {
    actors: { characterId: string; position: [number, number, number]; facingRad: number }[];
  };
  anchors?: { id: string; kind: string; position: [number, number, number]; label?: string }[];
} = {}): Project {
  const template = sceneTemplateById("living-room")!;
  const space = templateSpace(template);
  if (options.anchors) {
    space.anchors = options.anchors.map((anchor) => ({
      id: anchor.id,
      kind: anchor.kind as never,
      label: anchor.label,
      position: anchor.position,
      facingRad: 0,
      capacity: 0,
    }));
  }
  return ProjectSchema.parse({
    id: "p-elev",
    title: "立面",
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
        space,
      },
    ],
    characters: [
      { id: "c-lin", name: "林", appearance: "", sheet: {}, referenceImages: [], mustNotChange: [] },
      { id: "c-zhou", name: "周", appearance: "", sheet: {}, referenceImages: [], mustNotChange: [] },
    ],
    props: [],
    scenes: [
      {
        id: "sc-1",
        index: 0,
        code: "",
        locationId: "loc-living",
        space: "int",
        timeOfDay: "day",
        shotIds: ["s-1"],
      },
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
          angle: options.angle ?? "eye",
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
}

describe("立面读数（B13.2 / ADR-0126 §1）", () => {
  it("俯仰角换档：≥60 顶拍、≥10 稍高、≤−10 仰拍、其余平视", () => {
    expect(angleFromPitch(75)).toBe("top");
    expect(angleFromPitch(60)).toBe("top");
    expect(angleFromPitch(25)).toBe("high");
    expect(angleFromPitch(10)).toBe("high");
    expect(angleFromPitch(5)).toBe("eye");
    expect(angleFromPitch(-5)).toBe("eye");
    expect(angleFromPitch(-10)).toBe("low");
    expect(angleFromPitch(-40)).toBe("low");
    expect(Object.keys(ANGLE_LABEL)).toEqual(["eye", "low", "high", "top"]);
  });

  it("没有机位坐标就没有立面：不编造高度", () => {
    const shot = project().shots[0]!;
    expect(elevationOf(project(), shot)).toBeUndefined();
  });

  it("平视：机位与目标同高，距离与地面距离一致，几何档位与作者写的一致", () => {
    const withCamera = project({
      camera: { position: [0, 1.2, 2], target: [0, 1.2, 0] },
      angle: "eye",
    });
    const report = elevationOf(withCamera, withCamera.shots[0]!)!;
    expect(report.distanceM).toBeCloseTo(2, 5);
    expect(report.groundDistanceM).toBeCloseTo(2, 5);
    expect(report.pitchDeg).toBeCloseTo(0, 5);
    expect(report.angleFromGeometry).toBe("eye");
    expect(report.agrees).toBe(true);
    expect(report.summary).toContain("平视");
  });

  it("高机位俯拍：几何说是「稍高」，作者写「平视」时 agrees 为假", () => {
    const withCamera = project({
      camera: { position: [0, 2.2, 2], target: [0, 1.2, 0] },
      angle: "eye",
    });
    const report = elevationOf(withCamera, withCamera.shots[0]!)!;
    expect(report.pitchDeg).toBeGreaterThan(10);
    expect(report.angleFromGeometry).toBe("high");
    expect(report.agrees).toBe(false);
    expect(report.declaredAngle).toBe("eye");
    // 三维距离比地面距离长
    expect(report.distanceM).toBeGreaterThan(report.groundDistanceM);
  });

  it("低机位仰拍：俯仰角为负，档位是「仰拍」", () => {
    const withCamera = project({
      camera: { position: [0, 0.4, 2], target: [0, 1.6, 0] },
      angle: "low",
    });
    const report = elevationOf(withCamera, withCamera.shots[0]!)!;
    expect(report.pitchDeg).toBeLessThan(0);
    expect(report.angleFromGeometry).toBe("low");
    expect(report.agrees).toBe(true);
  });

  it("立面跨度跟着视线走，但不超过房间的尺度", () => {
    const withCamera = project({ camera: { position: [0, 1.5, 1.8], target: [0, 1.2, 0] } });
    const report = elevationOf(withCamera, withCamera.shots[0]!)!;
    const extent = elevationExtent(report, withCamera.locations[0]!.space);
    expect(extent).toBeGreaterThanOrEqual(report.groundDistanceM);
    expect(extent).toBeLessThanOrEqual(5);
  });
});

describe("遮挡（B13.2 / ADR-0126 §1）", () => {
  it("视线穿过比它高的家具：算遮挡，位置在视线中段", () => {
    // 机位与目标都 1.2 m 高，中间一张 1.4 m 高的桌子挡在 x=0
    const withBlock = project({
      camera: { position: [-2, 1.2, 0], target: [2, 1.2, 0] },
      anchors: [
        { id: "table", kind: "furniture", position: [0, 1.4, 0], label: "高桌" },
      ],
    });
    const found = occlusionsOf(withBlock, withBlock.shots[0]!);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("anchor");
    expect(found[0]!.label).toBe("高桌");
    expect(found[0]!.at).toBeCloseTo(0.5, 1);
    expect(found[0]!.heightM).toBeCloseTo(1.4, 5);
  });

  it("家具比视线矮：不算遮挡", () => {
    // 茶几 0.4 m 高，视线在 1.2 m
    const lowTable = project({
      camera: { position: [-2, 1.2, 0], target: [2, 1.2, 0] },
      anchors: [{ id: "table", kind: "furniture", position: [0, 0.4, 0], label: "茶几" }],
    });
    expect(occlusionsOf(lowTable, lowTable.shots[0]!)).toEqual([]);
  });

  it("横向离视线够远：不算遮挡", () => {
    const offside = project({
      camera: { position: [-2, 1.2, 0], target: [2, 1.2, 0] },
      anchors: [{ id: "shelf", kind: "furniture", position: [0, 1.6, 1.5], label: "柜子" }],
    });
    expect(occlusionsOf(offside, offside.shots[0]!)).toEqual([]);
  });

  it("门窗是开口、顶灯在天花：都不算遮挡", () => {
    const openings = project({
      camera: { position: [-2, 1.2, 0], target: [2, 1.2, 0] },
      anchors: [
        { id: "door", kind: "door", position: [0, 2.1, 0], label: "门" },
        { id: "window", kind: "window", position: [0, 2.1, 0], label: "窗" },
        { id: "light", kind: "light", position: [0, 2.7, 0], label: "顶灯" },
      ],
    });
    expect(occlusionsOf(openings, openings.shots[0]!)).toEqual([]);
  });

  it("另一个人站在视线中间：算遮挡；被摄者本人不算", () => {
    const people = project({
      camera: { position: [-2, 1.5, 0], target: [1.5, 1.2, 0] },
      blocking: {
        actors: [
          { characterId: "c-zhou", position: [1.5, 0, 0], facingRad: 0 },
          { characterId: "c-lin", position: [0, 0, 0], facingRad: 0 },
        ],
      },
    });
    const found = occlusionsOf(people, people.shots[0]!);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("actor");
    expect(found[0]!.label).toBe("林");
    expect(found[0]!.heightM).toBe(ACTOR_HEAD_M);
    expect(found[0]!.at).toBeGreaterThan(0.3);
    expect(found[0]!.at).toBeLessThan(0.8);
  });

  it("房间边界的墙不算遮挡：屋里两点之间穿不过边界墙", () => {
    // 电视墙在 z=+2（房间边界），视线从 -2 到 +2 会「碰到」它，但那是墙本身
    const boundary = project({
      camera: { position: [-2, 1.2, 0], target: [2, 1.2, 0] },
      anchors: [{ id: "tv-wall", kind: "wall", position: [0, 1.4, 2], label: "电视墙" }],
    });
    expect(occlusionsOf(boundary, boundary.shots[0]!)).toEqual([]);
  });

  it("屋里的隔断墙按整面墙算：挡住视线", () => {
    const partition = project({
      camera: { position: [-2, 1.2, 0], target: [2, 1.2, 0] },
      anchors: [{ id: "partition", kind: "wall", position: [0, 1.4, 0], label: "隔断" }],
    });
    const found = occlusionsOf(partition, partition.shots[0]!);
    expect(found).toHaveLength(1);
    // 隔断按房间层高算，不是锚点的代表高度
    expect(found[0]!.heightM).toBe(2.8);
  });

  it("没有机位坐标时什么都不判", () => {
    const shot = project().shots[0]!;
    expect(occlusionsOf(project(), shot)).toEqual([]);
  });

  it("多个遮挡按离机位由近到远排", () => {
    const stacked = project({
      camera: { position: [-2, 1.2, 0], target: [2, 1.2, 0] },
      anchors: [
        { id: "far", kind: "furniture", position: [1, 1.5, 0], label: "远的" },
        { id: "near", kind: "furniture", position: [-1, 1.5, 0], label: "近的" },
      ],
    });
    const found = occlusionsOf(stacked, stacked.shots[0]!);
    expect(found.map((item) => item.label)).toEqual(["近的", "远的"]);
    expect(found[0]!.at).toBeLessThan(found[1]!.at);
  });
});
