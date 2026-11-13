import { describe, expect, it } from "vitest";
import { ProjectSchema, clone, type ProjectSkill } from "@loomina/ir";
import minimalJson from "../../../examples/minimal.json";
import {
  buildMasterPrompt,
  buildPropPrompt,
  buildSheetPrompt,
  compileSkills,
  skillsForStage,
  shotMaterial,
  buildKeyframePrompt,
} from "../src/index";

const NOW = "2026-11-09T12:00:00Z";

function skill(overrides: Partial<ProjectSkill> = {}): ProjectSkill {
  return {
    id: "sk-1",
    name: "禁止现代物品",
    description: "",
    stage: "all",
    body: "场景里不要出现现代物品。",
    enabled: true,
    createdAt: NOW,
    ...overrides,
  };
}

describe("技能拼进提示词（C.5 / ADR-0191）", () => {
  it("按阶段筛选：all 与同阶段生效，别的阶段和关掉的不算", () => {
    const skills = [
      skill({ id: "sk-1", stage: "all" }),
      skill({ id: "sk-2", stage: "sheet", body: "定妆只穿旧衣。" }),
      skill({ id: "sk-3", stage: "keyframe", body: "关键帧不要运动模糊。" }),
      skill({ id: "sk-4", stage: "sheet", body: "关掉的。", enabled: false }),
    ];
    expect(skillsForStage(skills, "sheet").map((item) => item.id)).toEqual(["sk-1", "sk-2"]);
    expect(skillsForStage(skills, "master").map((item) => item.id)).toEqual(["sk-1"]);
  });

  it("按作者排的顺序拼，名字带进提示词", () => {
    const text = compileSkills(
      [skill({ name: "A", body: "第一条。" }), skill({ name: "B", body: "第二条。" })],
      "master",
    );
    expect(text).toBe("技能「A」：第一条。；技能「B」：第二条。");
  });

  it("没有可用技能返回空串", () => {
    expect(compileSkills(undefined, "master")).toBe("");
    expect(compileSkills([skill({ enabled: false })], "master")).toBe("");
  });

  it("四种提示词都带上，且风格仍是最后一句", () => {
    const skills = [skill({ body: "不要现代物品。" })];
    const project = ProjectSchema.parse(clone(minimalJson));
    const character = project.characters[0]!;
    const sheet = buildSheetPrompt(character, "front", project.look, skills);
    expect(sheet).toContain("技能「禁止现代物品」：不要现代物品。");
    expect(sheet.endsWith("柔光棚拍")).toBe(true);
    expect(sheet.indexOf("技能「")).toBeLessThan(sheet.indexOf("柔光棚拍"));

    const location = project.locations[0]!;
    expect(buildMasterPrompt(location, project.look, skills)).toContain("不要现代物品。");

    const prop = { name: "搪瓷杯", description: "掉了一块瓷" };
    expect(buildPropPrompt(prop, project.look, skills)).toContain("不要现代物品。");

    const shot = project.shots[0]!;
    const keyframe = buildKeyframePrompt(shotMaterial(project, shot), "first", skills);
    expect(keyframe).toContain("不要现代物品。");
    expect(keyframe.indexOf("技能「")).toBeLessThan(keyframe.length - 20);
  });

  it("不传技能时提示词一个字节都不变", () => {
    const project = ProjectSchema.parse(clone(minimalJson));
    const character = project.characters[0]!;
    expect(buildSheetPrompt(character, "front", project.look)).toBe(
      buildSheetPrompt(character, "front", project.look, []),
    );
  });
});
