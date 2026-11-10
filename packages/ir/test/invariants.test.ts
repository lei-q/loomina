import { describe, expect, it } from "vitest";
import { clone } from "../src/clone";
import { validateProject } from "../src/invariants";
import { ProjectSchema, type Project } from "../src/schema";
import minimalJson from "../../../examples/minimal.json";

function load(): Project {
  return ProjectSchema.parse(clone(minimalJson));
}

function codes(project: Project): string[] {
  return validateProject(project).map((violation) => violation.code);
}

describe("validateProject", () => {
  it("示例项目通过全部不变量", () => {
    expect(validateProject(load())).toEqual([]);
  });

  it("台词引用不存在的角色", () => {
    const project = load();
    project.dialogue[0]!.characterId = "c-ghost";
    expect(codes(project)).toContain("REF_DIALOGUE_CHARACTER");
  });

  it("镜头引用不存在的角色", () => {
    const project = load();
    project.shots[0]!.characterIds = ["c-ghost"];
    expect(codes(project)).toContain("REF_SHOT_CHARACTER");
  });

  it("场景引用不存在的地点", () => {
    const project = load();
    project.scenes[0]!.locationId = "loc-ghost";
    expect(codes(project)).toContain("REF_LOCATION");
  });

  it("镜头与场景归属不一致", () => {
    const project = load();
    project.scenes[0]!.shotIds = ["sh-1"];
    expect(codes(project)).toContain("SCENE_SHOT_BIDIRECTIONAL");
  });

  it("同场景镜头序号不连续", () => {
    const project = load();
    project.shots[1]!.index = 5;
    expect(codes(project)).toContain("SHOT_INDEX_CONTIGUOUS");
  });

  it("镜头时长与对白时长不一致", () => {
    const project = load();
    project.shots[0]!.durationMs = 9000;
    expect(codes(project)).toContain("SHOT_DURATION_VS_DIALOGUE");
  });

  it("时间线引用了不属于该镜头的 take", () => {
    const project = load();
    project.timeline.items[0]!.takeId = "take-2";
    expect(codes(project)).toContain("TIMELINE_TAKE_OWNERSHIP");
  });

  it("时间线片段重叠", () => {
    const project = load();
    project.timeline.items[1]!.startMs = 1000;
    expect(codes(project)).toContain("TIMELINE_OVERLAP");
  });

  it("定妆引用了不存在的资产", () => {
    const project = load();
    project.characters[0]!.sheet.front = "a-ghost";
    expect(codes(project)).toContain("REF_ASSET");
  });

  it("闸门指向不存在的目标", () => {
    const project = load();
    project.approvals.push({
      id: "ap-ghost",
      targetType: "character",
      targetId: "c-ghost",
      status: "approved",
      lockedAssetIds: [],
    });
    expect(codes(project)).toContain("APPROVAL_TARGET");
  });

  it("闸门锁住了不存在的资产", () => {
    const project = load();
    project.approvals.push({
      id: "ap-lin",
      targetType: "character",
      targetId: project.characters[0]!.id,
      status: "approved",
      lockedAssetIds: ["a-ghost"],
    });
    expect(codes(project)).toContain("APPROVAL_LOCKED_ASSET");
  });

  it("发布包缺少隐式 AI 标识", () => {
    const project = load();
    project.publishPackages[0]!.aiLabel = {
      explicit: true,
      implicit: false,
    };
    expect(codes(project)).toContain("PUBLISH_AI_LABEL");
  });
});
