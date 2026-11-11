import { describe, expect, it } from "vitest";
import {
  MIN_SIGHT_DISTANCE_M,
  blockingProblem,
  boundsOf,
  distance,
  insideSpace,
  placementProblem,
  spaceProblem,
} from "../src/geometry";
import type { LocationSpace } from "../src/schema";

const SPACE: LocationSpace = {
  dimensions: [5, 4, 2.8],
  anchors: [
    { id: "door", kind: "door", position: [2.5, 0, -1.6], facingRad: 0, capacity: 0 },
    { id: "window", kind: "window", position: [-2.5, 1.2, 0], facingRad: 0, capacity: 0 },
  ],
};

const SHOT = { characterIds: ["c-a", "c-b"], propIds: ["p-cup"] };

describe("场地几何（B13.1 / ADR-0126）", () => {
  it("原点是房间中心地面：半宽半深由尺寸得出", () => {
    expect(boundsOf(SPACE)).toEqual({ halfWidth: 2.5, halfDepth: 2, height: 2.8 });
  });

  it("界内通过、越界拒绝，容差 0.1 m", () => {
    expect(insideSpace(SPACE, [0, 0, 0])).toBe(true);
    expect(insideSpace(SPACE, [2.5, 2.8, -2])).toBe(true);
    expect(insideSpace(SPACE, [2.58, 0, 0])).toBe(true); // 差 8 cm，在容差里
    expect(insideSpace(SPACE, [2.7, 0, 0])).toBe(false);
    expect(insideSpace(SPACE, [0, -0.2, 0])).toBe(false);
    expect(insideSpace(SPACE, [0, 3, 0])).toBe(false);
  });

  it("走位里的人必须在场、不能重复、坐标要在场地内", () => {
    expect(
      blockingProblem(SPACE, SHOT, {
        actors: [{ characterId: "c-a", position: [0, 0, 0], facingRad: 0 }],
        props: [],
      }),
    ).toBeNull();

    expect(
      blockingProblem(SPACE, SHOT, {
        actors: [{ characterId: "c-x", position: [0, 0, 0], facingRad: 0 }],
        props: [],
      })?.message,
    ).toContain("不在这一镜出场");

    expect(
      blockingProblem(SPACE, SHOT, {
        actors: [
          { characterId: "c-a", position: [0, 0, 0], facingRad: 0 },
          { characterId: "c-a", position: [1, 0, 0], facingRad: 0 },
        ],
        props: [],
      })?.message,
    ).toContain("只能有一个走位");

    expect(
      blockingProblem(SPACE, SHOT, {
        actors: [{ characterId: "c-a", position: [9, 0, 0], facingRad: 0 }],
        props: [],
      })?.message,
    ).toContain("超出场地");
  });

  it("道具走位同样校验：不在这一镜、重复、越界", () => {
    expect(
      blockingProblem(SPACE, SHOT, {
        actors: [],
        props: [{ propId: "p-cup", position: [0, 0.4, 0] }],
      }),
    ).toBeNull();
    expect(
      blockingProblem(SPACE, SHOT, { actors: [], props: [{ propId: "p-x", position: [0, 0, 0] }] })
        ?.message,
    ).toContain("不在这一镜");
    expect(
      blockingProblem(SPACE, SHOT, {
        actors: [],
        props: [
          { propId: "p-cup", position: [0, 0, 0] },
          { propId: "p-cup", position: [1, 0, 0] },
        ],
      })?.message,
    ).toContain("只能有一个位置");
  });

  it("没有几何时不查边界，但仍在场校验", () => {
    expect(
      blockingProblem(undefined, SHOT, {
        actors: [{ characterId: "c-a", position: [99, 0, 0], facingRad: 0 }],
        props: [],
      }),
    ).toBeNull();
    expect(
      blockingProblem(undefined, SHOT, {
        actors: [{ characterId: "c-x", position: [0, 0, 0], facingRad: 0 }],
        props: [],
      })?.message,
    ).toContain("不在这一镜出场");
  });

  it("机位与目标重合被拒，越界也拒", () => {
    expect(
      placementProblem(SPACE, { position: [0, 1.5, 1], target: [0, 1.2, 0] }),
    ).toBeNull();
    expect(
      placementProblem(SPACE, { position: [0, 1.5, 1], target: [0, 1.5, 1.02] })?.message,
    ).toContain("同一个点");
    expect(
      placementProblem(SPACE, { position: [9, 1.5, 1], target: [0, 1.2, 0] })?.message,
    ).toContain("机位坐标超出场地");
    expect(
      placementProblem(SPACE, { position: [0, 1.5, 1], target: [9, 1.2, 0] })?.message,
    ).toContain("机位目标超出场地");
    expect(distance([0, 0, 0], [0, 0, MIN_SIGHT_DISTANCE_M])).toBeCloseTo(MIN_SIGHT_DISTANCE_M);
  });

  it("地点几何自身：尺寸为正、锚点不重复且落在场地内", () => {
    expect(spaceProblem(SPACE)).toBeNull();
    expect(
      spaceProblem({ ...SPACE, dimensions: [0, 4, 2.8] })?.message,
    ).toContain("尺寸必须是正数");
    expect(
      spaceProblem({
        ...SPACE,
        anchors: [
          { id: "door", kind: "door", position: [0, 0, 0], facingRad: 0, capacity: 0 },
          { id: "door", kind: "door", position: [1, 0, 0], facingRad: 0, capacity: 0 },
        ],
      })?.message,
    ).toContain("锚点 id 重复");
    expect(
      spaceProblem({
        ...SPACE,
        anchors: [{ id: "door", kind: "door", position: [9, 0, 0], facingRad: 0, capacity: 0 }],
      })?.message,
    ).toContain("超出场地");
  });
});
