import type { Project, ProjectSkill } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import { sampleProject } from "./sample-project";
import { sharedSkillsOf } from "./shared-skills";

const clone = (): Project => structuredClone(sampleProject);

const skill = (id: string, name: string, body: string): ProjectSkill => ({
  id,
  name,
  description: "",
  stage: "all",
  body,
  enabled: true,
  createdAt: "2026-11-13T00:00:00Z",
});

describe("跨空间取技能（C.5）", () => {
  it("列出别的空间的技能，标出已经一模一样的那条", () => {
    const current = clone();
    current.skills = [skill("sk-a", "不要现代物品", "场景里不要出现现代物品。")];
    const source = clone();
    source.skills = [
      skill("sk-a", "不要现代物品", "场景里不要出现现代物品。"),
      skill("sk-b", "袖口总是卷起", "两个主角的袖口永远卷到小臂。"),
    ];

    const list = sharedSkillsOf([{ id: "w-1", name: "夜班", project: source }], current);
    expect(list).toHaveLength(2);
    // 能取的排前面
    expect(list[0]!.skill.name).toBe("袖口总是卷起");
    expect(list[0]!.duplicate).toBe(false);
    expect(list[1]!.duplicate).toBe(true);
    expect(list[1]!.workspaceName).toBe("夜班");
  });

  it("同名不同内容算两条；同一批里重复的同一条只列一次", () => {
    const current = clone();
    const source = clone();
    source.skills = [
      skill("sk-1", "不要现代物品", "场景里不要出现现代物品。"),
      skill("sk-2", "不要现代物品", "场景里不要出现手机、汽车、路灯。"),
      skill("sk-3", "不要现代物品", "场景里不要出现现代物品。"),
    ];
    const list = sharedSkillsOf([{ id: "w-1", name: "夜班", project: source }], current);
    expect(list).toHaveLength(2);
    expect(new Set(list.map((item) => item.skill.body)).size).toBe(2);
  });

  it("名字与内容都 trim 后再比；没有技能就是空清单", () => {
    const current = clone();
    current.skills = [skill("sk-a", " 不要现代物品 ", " 场景里不要出现现代物品。 ")];
    const source = clone();
    source.skills = [skill("sk-b", "不要现代物品", "场景里不要出现现代物品。")];
    expect(sharedSkillsOf([{ id: "w-1", name: "夜班", project: source }], current)[0]!.duplicate).toBe(true);

    const empty = clone();
    empty.skills = [];
    expect(sharedSkillsOf([{ id: "w-1", name: "夜班", project: empty }], current)).toEqual([]);
  });
});