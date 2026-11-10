import { describe, expect, it } from "vitest";
import type { ProjectInput } from "../src/schema";
import { ProjectSchema } from "../src/schema";
import {
  castReadiness,
  missingSheetAngles,
  requiresSheet,
  SHEET_ANGLES,
  targetAssetIds,
} from "../src/cast";

const asset = (id: string) => ({
  id,
  kind: "image" as const,
  source: "generated" as const,
  createdAt: "2026-11-10T09:00:00+08:00",
});

const sheet = {
  front: "a-lin-front",
  threeQuarter: "a-lin-34",
  side: "a-lin-side",
  back: "a-lin-back",
};

const raw: ProjectInput = {
  id: "p-cast",
  title: "定妆测试",
  version: 1,
  locations: [{ id: "loc-1", name: "走廊", masterShotId: "a-loc-1" }],
  characters: [
    { id: "c-lin", name: "林", sheet, referenceImages: ["a-lin-expr"] },
    { id: "c-zhou", name: "周" }, // 只有远景，不要求三视图
  ],
  scenes: [{ id: "sc-1", index: 0, locationId: "loc-1", shotIds: ["s-1", "s-2"] }],
  shots: [
    {
      id: "s-1", sceneId: "sc-1", index: 0, durationMs: 2400,
      shotSize: "close", characterIds: ["c-lin"], takeIds: [],
      camera: { angle: "eye", movement: "static", focalMm: 50 },
    },
    {
      id: "s-2", sceneId: "sc-1", index: 1, durationMs: 2400,
      shotSize: "wide", characterIds: ["c-zhou"], takeIds: [],
      camera: { angle: "eye", movement: "static", focalMm: 24 },
    },
  ],
  assets: [
    ...SHEET_ANGLES.map((angle) => asset(sheet[angle])),
    asset("a-lin-expr"),
    asset("a-zhou-front"),
    asset("a-loc-1"),
  ],
};

const project = ProjectSchema.parse(raw);

describe("定妆闸门", () => {
  it("近景角色要求三视图，远景角色不要求", () => {
    expect(requiresSheet(project, "c-lin")).toBe(true);
    expect(requiresSheet(project, "c-zhou")).toBe(false);
  });

  it("缺哪几格说得出来", () => {
    expect(missingSheetAngles(project.characters[0]!)).toEqual([]);
    expect(missingSheetAngles(project.characters[1]!)).toEqual([
      "front", "threeQuarter", "side", "back",
    ]);
  });

  it("锁定一个角色时，锁住三视图与参考图", () => {
    expect(targetAssetIds(project, "character", "c-lin")).toEqual([
      "a-lin-front", "a-lin-34", "a-lin-side", "a-lin-back", "a-lin-expr",
    ]);
    expect(targetAssetIds(project, "location", "loc-1")).toEqual(["a-loc-1"]);
  });

  it("四格齐全但没锁，是待锁定；锁了才是已锁定", () => {
    const before = castReadiness(project);
    const lin = before.characters.find((item) => item.targetId === "c-lin")!;
    expect(lin.status).toBe("ready");
    expect(before.complete).toBe(false);

    const locked = ProjectSchema.parse({
      ...raw,
      approvals: [
        {
          id: "ap-character-c-lin",
          targetType: "character",
          targetId: "c-lin",
          status: "approved",
          approvedAt: "2026-11-10T09:30:00+08:00",
          lockedAssetIds: targetAssetIds(project, "character", "c-lin"),
        },
        {
          id: "ap-location-loc-1",
          targetType: "location",
          targetId: "loc-1",
          status: "approved",
          lockedAssetIds: ["a-loc-1"],
        },
      ],
    });

    const after = castReadiness(locked);
    expect(after.complete).toBe(true);
    expect(after.lockedCount).toBe(after.totalRequired);
    expect(
      after.characters.find((item) => item.targetId === "c-zhou")!.required,
    ).toBe(false);
  });

  it("近景角色缺一格就算不完整，不能锁", () => {
    const partial = ProjectSchema.parse({
      ...raw,
      characters: [
        { id: "c-lin", name: "林", sheet: { front: "a-lin-front" } },
        { id: "c-zhou", name: "周" },
      ],
    });
    const lin = castReadiness(partial).characters.find(
      (item) => item.targetId === "c-lin",
    )!;
    expect(lin.status).toBe("incomplete");
    expect(lin.missingAngles).toHaveLength(3);
  });

  it("场景有镜头就必须有主镜", () => {
    const noMaster = ProjectSchema.parse({
      ...raw,
      locations: [{ id: "loc-1", name: "走廊" }],
    });
    const loc = castReadiness(noMaster).locations[0]!;
    expect(loc.required).toBe(true);
    expect(loc.status).toBe("incomplete");
  });
});
