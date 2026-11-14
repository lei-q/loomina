import { describe, expect, it } from "vitest";
import { ProjectSchema, type Project } from "@loomina/ir";
import {
  REVERB_PRESETS,
  REVERB_VERSION,
  presetById,
  reverbFilterOf,
  reverbPlanOf,
  reverbPresetOf,
  reverbText,
} from "./reverb";

function makeProject(
  locations: { id: string; name: string; space?: "int" | "ext"; description?: string }[],
  scenes: { id: string; locationId: string; shotIds: string[] }[],
): Project {
  return ProjectSchema.parse({
    id: "p-reverb",
    title: "空间混响",
    version: 0,
    locations,
    scenes: scenes.map((scene, index) => ({ ...scene, index })),
    shots: scenes.flatMap((scene) =>
      scene.shotIds.map((id) => ({
        id,
        sceneId: scene.id,
        index: 0,
        durationMs: 2000,
        description: id,
        shotSize: "medium",
        camera: { angle: "eye", movement: "static", focalMm: 35 },
        characterIds: [],
        dialogueIds: [],
      })),
    ),
  });
}

describe("空间混响（C11 / ADR-0226）", () => {
  it("版本号可追溯，六套预设 id 唯一", () => {
    expect(REVERB_VERSION).toMatch(/^\d{4}-\d{2}$/);
    expect(REVERB_PRESETS).toHaveLength(6);
    expect(new Set(REVERB_PRESETS.map((preset) => preset.id)).size).toBe(6);
  });

  it("按名字认空间：走廊、大厅、卧室、客厅各给不同的套", () => {
    expect(reverbPresetOf({ id: "l", name: "公寓走廊" } as never).preset.id).toBe("hallway");
    expect(reverbPresetOf({ id: "l", name: "商场大厅" } as never).preset.id).toBe("large-hall");
    expect(reverbPresetOf({ id: "l", name: "林晚卧室" } as never).preset.id).toBe("small-room");
    expect(reverbPresetOf({ id: "l", name: "公寓客厅" } as never).preset.id).toBe("living-room");
  });

  it("名字认不出时按场的内景 / 外景给默认档，并说明", () => {
    const ext = reverbPresetOf({ id: "l", name: "无名之地" } as never, "ext");
    expect(ext.preset.id).toBe("outdoor");
    expect(ext.reason).toContain("外景");

    const int = reverbPresetOf({ id: "l", name: "某个地方" } as never, "int");
    expect(int.preset.id).toBe("living-room");
    expect(int.reason).toContain("认不出");
  });

  it("没有地点时给默认档并如实说", () => {
    const result = reverbPresetOf(undefined);
    expect(result.preset.id).toBe("living-room");
    expect(result.reason).toContain("找不到地点");
  });

  it("同一场只用一套：按场列，不按镜列", () => {
    const plan = reverbPlanOf(
      makeProject(
        [{ id: "loc-1", name: "公寓客厅" }],
        [{ id: "sc-1", locationId: "loc-1", shotIds: ["s-1", "s-2", "s-3"] }],
      ),
    );
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]!.shots).toBe(3);
    expect(plan.lines[0]!.preset.id).toBe("living-room");
  });

  it("多场多套，汇总列出用了几种", () => {
    const plan = reverbPlanOf(
      makeProject(
        [
          { id: "loc-1", name: "公寓客厅" },
          { id: "loc-2", name: "公寓走廊" },
        ],
        [
          { id: "sc-1", locationId: "loc-1", shotIds: ["s-1"] },
          { id: "sc-2", locationId: "loc-2", shotIds: ["s-2"] },
        ],
      ),
    );
    expect(plan.summary.scenes).toBe(2);
    expect(plan.summary.presets).toEqual(["living-room", "hallway"]);
  });

  it("找不到地点的场如实计数", () => {
    const plan = reverbPlanOf(
      makeProject([], [{ id: "sc-1", locationId: "loc-none", shotIds: ["s-1"] }]),
    );
    expect(plan.summary.unresolved).toBe(1);
    expect(reverbText(plan)).toContain("找不到地点");
  });

  it("干声不挂滤镜，与旧命令同构", () => {
    expect(reverbFilterOf(presetById("dry"))).toBe("");
  });

  it("房间越大、尾巴越长：延迟与衰减都递增", () => {
    const small = reverbFilterOf(presetById("small-room"));
    const hall = reverbFilterOf(presetById("large-hall"));
    expect(small).toContain("aecho=");
    expect(hall).toContain("aecho=");
    // 取第三层延迟比较
    const delayOf = (filter: string) => Number(filter.split(":")[2]!.split("|")[2]);
    expect(delayOf(hall)).toBeGreaterThan(delayOf(small));
  });

  it("室外湿声最低、大厅最高", () => {
    const wet = (id: string) => presetById(id).wet;
    expect(wet("outdoor")).toBeLessThan(wet("small-room"));
    expect(wet("small-room")).toBeLessThan(wet("large-hall"));
  });

  it("一句话摘要说清几场几套", () => {
    const plan = reverbPlanOf(
      makeProject(
        [{ id: "loc-1", name: "公寓客厅" }],
        [{ id: "sc-1", locationId: "loc-1", shotIds: ["s-1"] }],
      ),
    );
    const text = reverbText(plan);
    expect(text).toContain("1 场");
    expect(text).toContain("1 套混响");
    expect(text).toContain("同一场只用一套");
  });

  it("没有场次时如实说", () => {
    expect(reverbText(reverbPlanOf(makeProject([], [])))).toBe("还没有场次。");
  });
});
