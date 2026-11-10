import { describe, expect, it } from "vitest";
import { shotAnchors, ProjectSchema, type Project } from "../src";

const SHEET = (prefix: string) => ({
  front: `a-${prefix}-front`,
  threeQuarter: `a-${prefix}-34`,
  side: `a-${prefix}-side`,
  back: `a-${prefix}-back`,
});

function build(overrides: {
  characters?: unknown[];
  location?: unknown;
  shot?: unknown;
  approvals?: unknown[];
} = {}): Project {
  return ProjectSchema.parse({
    id: "p-1",
    title: "锚点测试",
    version: 1,
    locations: [
      overrides.location ?? {
        id: "loc-1",
        name: "客厅",
        masterShotId: "a-master",
      },
    ],
    characters: overrides.characters ?? [
      { id: "c-1", name: "林", sheet: SHEET("lin"), mustNotChange: ["左眼下的痣"] },
    ],
    scenes: [{ id: "sc-1", index: 0, locationId: "loc-1", shotIds: ["s-1"] }],
    shots: [
      overrides.shot ?? {
        id: "s-1",
        sceneId: "sc-1",
        index: 0,
        durationMs: 2000,
        shotSize: "close",
        camera: { angle: "eye", movement: "static", focalMm: 50 },
        characterIds: ["c-1"],
      },
    ],
    assets: [
      ...Object.values(SHEET("lin")).map((id) => ({
        id,
        kind: "image",
        source: "generated",
        createdAt: "2026-11-10T00:00:00Z",
      })),
      ...Object.values(SHEET("zhou")).map((id) => ({
        id,
        kind: "image",
        source: "generated",
        createdAt: "2026-11-10T00:00:00Z",
      })),
      ...Object.values(SHEET("misc")).map((id) => ({
        id,
        kind: "image",
        source: "generated",
        createdAt: "2026-11-10T00:00:00Z",
      })),
      {
        id: "a-master",
        kind: "image",
        source: "generated",
        createdAt: "2026-11-10T00:00:00Z",
      },
    ],
    approvals: overrides.approvals ?? [],
  });
}

describe("镜头锚点装配", () => {
  it("单人近景取正面与 3/4，再加场景主镜", () => {
    const project = build();
    const anchors = shotAnchors(project, project.shots[0]!);

    expect(anchors.assetIds).toEqual(["a-lin-front", "a-lin-34", "a-master"]);
    expect(anchors.refs.map((ref) => ref.label)).toEqual([
      "林 · 正面",
      "林 · 3/4",
      "客厅 · 主镜",
    ]);
    expect(anchors.missing).toEqual([]);
  });

  it("多人同框每人只取一张，把名额留给场景", () => {
    const project = build({
      characters: [
        { id: "c-1", name: "林", sheet: SHEET("lin") },
        { id: "c-2", name: "周", sheet: SHEET("zhou") },
      ],
      shot: {
        id: "s-1",
        sceneId: "sc-1",
        index: 0,
        durationMs: 2000,
        shotSize: "medium",
        camera: { angle: "eye", movement: "static", focalMm: 35 },
        characterIds: ["c-1", "c-2"],
      },
    });
    const anchors = shotAnchors(project, project.shots[0]!);

    expect(anchors.assetIds).toEqual(["a-lin-front", "a-zhou-front", "a-master"]);
    expect(anchors.missing).toEqual([]);
  });

  it("参考图最多四张，先保场景再保人物", () => {
    const many = ["c-1", "c-2", "c-3", "c-4", "c-5"];
    const project = build({
      characters: many.map((id) => ({
        id,
        name: id,
        sheet: { front: `a-${id}-front` },
      })),
      shot: {
        id: "s-1",
        sceneId: "sc-1",
        index: 0,
        durationMs: 2000,
        shotSize: "wide",
        camera: { angle: "eye", movement: "static", focalMm: 24 },
        characterIds: many,
      },
    });
    // 给五个人各补一张正面
    for (const id of many) {
      project.assets.push({
        id: `a-${id}-front`,
        kind: "image",
        source: "generated",
        createdAt: "2026-11-10T00:00:00Z",
      });
    }

    const anchors = shotAnchors(project, project.shots[0]!);
    expect(anchors.assetIds).toHaveLength(4);
    expect(anchors.assetIds.at(-1)).toBe("a-master");
  });

  it("有近景的角色缺一格，装配时记为缺失", () => {
    const project = build({
      characters: [
        {
          id: "c-1",
          name: "林",
          sheet: { front: "a-lin-front", threeQuarter: "a-lin-34", side: "a-lin-side" },
        },
      ],
    });
    const anchors = shotAnchors(project, project.shots[0]!);
    expect(anchors.missing).toEqual(["角色「林」缺背面"]);
  });

  it("场景没有主镜，装配时记为缺失", () => {
    const project = build({ location: { id: "loc-1", name: "客厅" } });
    const anchors = shotAnchors(project, project.shots[0]!);
    expect(anchors.missing).toEqual(["场景「客厅」缺主镜"]);
  });

  it("闸门锁定的资产才是下游能用的那批", () => {
    const project = build({
      approvals: [
        {
          id: "ap-1",
          targetType: "character",
          targetId: "c-1",
          status: "approved",
          approvedAt: "2026-11-10T00:00:00Z",
          lockedAssetIds: ["a-lin-front", "a-lin-34", "a-lin-side"],
        },
      ],
    });
    const anchors = shotAnchors(project, project.shots[0]!);

    // 背面没锁住，不能悄悄进生成
    expect(anchors.missing).toEqual(["角色「林」缺背面"]);
    expect(anchors.assetIds).toEqual(["a-lin-front", "a-lin-34", "a-master"]);
  });

  it("不强制三视图的角色，退回普通参考图且不算缺失", () => {
    const project = build({
      characters: [
        {
          id: "c-1",
          name: "路人",
          sheet: {},
          referenceImages: ["a-lin-front"],
        },
      ],
      shot: {
        id: "s-1",
        sceneId: "sc-1",
        index: 0,
        durationMs: 2000,
        shotSize: "medium",
        camera: { angle: "eye", movement: "static", focalMm: 50 },
        characterIds: ["c-1"],
      },
    });
    const anchors = shotAnchors(project, project.shots[0]!);

    expect(anchors.missing).toEqual([]);
    expect(anchors.refs[0]).toEqual({ assetId: "a-lin-front", label: "路人 · 参考图" });
  });
});
