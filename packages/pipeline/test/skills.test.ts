import { describe, expect, it } from "vitest";
import { ProjectSchema, clone, type ProjectSkill } from "@loomina/ir";
import minimalJson from "../../../examples/minimal.json";
import {
  buildMasterPrompt,
  buildPropPrompt,
  buildSheetPrompt,
  buildVideoPrompt,
  compileLook,
  compileSkills,
  skillCharsOf,
  skillsForStage,
  skillsForStages,
  SKILL_TOTAL_BUDGET,
  shotMaterial,
  storyMessages,
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

describe("技能作用到各阶段提示词（C18 / ADR-0252）", () => {
  const project = ProjectSchema.parse(clone(minimalJson));
  const material = shotMaterial(project, project.shots[0]!);

  it("视频阶段：技能进视频提示词，风格仍是最后一句", () => {
    const prompt = buildVideoPrompt(material, [
      skill({ id: "sk-v", stage: "video", body: "不要出现文字水印。" }),
    ]);
    expect(prompt).toContain("不要出现文字水印");
    // 风格永远最后一句：技能插在它之前
    expect(prompt.endsWith(compileLook(material.look))).toBe(true);
  });

  it("故事阶段：技能进系统提示词", () => {
    const messages = storyMessages("夜班护士", undefined, undefined, [
      skill({ id: "sk-s", stage: "story", body: "主角必须是女性。" }),
    ]);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("主角必须是女性");
  });

  it("别的阶段的技能不串味", () => {
    const messages = storyMessages("夜班护士", undefined, undefined, [
      skill({ id: "sk-k", stage: "keyframe", body: "关键帧不要运动模糊。" }),
    ]);
    expect(messages[0]!.content).not.toContain("运动模糊");
  });
});

describe("每页技能抽屉的筛选与预算（ADR-0252 落地节）", () => {
  it("多个阶段取并集，all 算进来，关掉的不算，重复不重复计", () => {
    const skills = [
      skill({ id: "sk-all", stage: "all", body: "统一要求。" }),
      skill({ id: "sk-sheet", stage: "sheet", body: "定妆只穿旧衣。" }),
      skill({ id: "sk-master", stage: "master", body: "场景不要霓虹。" }),
      skill({ id: "sk-video", stage: "video", body: "视频不要水印。" }),
      skill({ id: "sk-off", stage: "sheet", body: "关掉的。", enabled: false }),
    ];
    const cast = skillsForStages(skills, ["sheet", "master", "prop"]);
    expect(cast.map((item) => item.id)).toEqual(["sk-all", "sk-sheet", "sk-master"]);
    expect(skillCharsOf(cast)).toBe("统一要求。".length + "定妆只穿旧衣。".length + "场景不要霓虹。".length);
  });

  it("总预算是软上限：超了不截断，只是一个数字给界面提示", () => {
    const big = skill({ id: "sk-big", stage: "all", body: "甲".repeat(SKILL_TOTAL_BUDGET + 1) });
    expect(skillCharsOf(skillsForStages([big], ["story"]))).toBeGreaterThan(SKILL_TOTAL_BUDGET);
  });
});
