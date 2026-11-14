import type { ProjectSkill } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import {
  SKILLS_FILE_MAX,
  parseSkillsFile,
  skillsFileOf,
  skillsFileProblem,
} from "./skills-file";

const AT = "2026-11-14T00:00:00Z";
const skill = (name: string, body: string, enabled = true): ProjectSkill => ({
  id: `sk-${name}`,
  name,
  description: "",
  stage: "all",
  body,
  enabled,
  createdAt: AT,
});

describe("技能导入导出（C18 / ADR-0210）", () => {
  it("导出只带可跨机器的字段：不带 id 与 createdAt", () => {
    const file = skillsFileOf([skill("不要现代物品", "场景里不要出现现代物品。")], AT);
    expect(file.format).toBe("loomina.skills");
    expect(file.skills).toHaveLength(1);
    expect(Object.keys(file.skills[0]!).sort()).toEqual(
      ["body", "description", "enabled", "name", "stage"].sort(),
    );
  });

  it("导入重编 id、用现在的 createdAt；同名同内容跳过并计数", () => {
    const file = skillsFileOf(
      [skill("A", "a"), skill("B", "b"), skill("A", "a")],
      AT,
    );
    const result = parseSkillsFile(file, {
      existing: [skill("A", "a")],
      at: AT,
      tag: "t1",
    });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.name).toBe("B");
    expect(result.skills[0]!.id).toBe("sk-t1-1");
    expect(result.skills[0]!.createdAt).toBe(AT);
    // 文件里两条 A 都算重复（一条对上项目、一条对上刚加进 known 的）
    expect(result.duplicates).toBe(2);
  });

  it("坏条目跳过并计数；格式不对整包不导", () => {
    const raw = {
      format: "loomina.skills",
      version: 1,
      skills: [{ name: "", body: "没有名字" }, { name: "好", body: "内容" }],
    };
    const result = parseSkillsFile(raw, { existing: [], at: AT, tag: "t" });
    expect(result.invalid).toBe(1);
    expect(result.skills.map((item) => item.name)).toEqual(["好"]);

    expect(parseSkillsFile({ format: "other" }, { existing: [], at: AT, tag: "t" }).skills).toEqual([]);
    expect(parseSkillsFile(null, { existing: [], at: AT, tag: "t" }).skills).toEqual([]);
  });

  it("超过条数只取前 100 条；文件问题如实说", () => {
    const raw = {
      format: "loomina.skills",
      version: 1,
      skills: Array.from({ length: SKILLS_FILE_MAX + 5 }, (_, index) => ({
        name: `技能 ${index}`,
        body: `内容 ${index}`,
        description: "",
        stage: "all",
        enabled: true,
      })),
    };
    const result = parseSkillsFile(raw, { existing: [], at: AT, tag: "t" });
    expect(result.skills).toHaveLength(SKILLS_FILE_MAX);
    expect(skillsFileProblem(300 * 1024, 1)).toContain("200 KB");
    expect(skillsFileProblem(1000, SKILLS_FILE_MAX + 1)).toContain("最多");
    expect(skillsFileProblem(1000, 1)).toBeUndefined();
  });
});