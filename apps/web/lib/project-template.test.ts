import { describe, expect, it } from "vitest";
import { ProjectSchema } from "@loomina/ir";
import { sampleProject } from "./sample-project";
import { projectFromTemplate, templateNameOf, templateOf, templateCounts } from "./project-template";

const AT = "2026-11-13T08:00:00.000Z";

/** 示例项目的 14 个资产全是班底用的；再加一个只属于 take 的，看模板会不会把它带走 */
function withTakeAsset() {
  return ProjectSchema.parse({
    ...sampleProject,
    assets: [
      ...sampleProject.assets,
      {
        id: "a-take-only",
        kind: "video",
        uri: "loomina://assets/" + "e".repeat(64) + ".mp4",
        source: "generated",
        createdAt: AT,
      },
    ],
  });
}

describe("班底模板（F3 / ADR-0180）", () => {
  it("只带走班底与它们的资产，不带 take 与分镜", () => {
    const project = withTakeAsset();
    const template = templateOf(project, { id: "tpl-1", name: "夜班 · 班底", at: AT });

    expect(template.format).toBe("loomina.template");
    expect(template.from).toEqual({ projectId: project.id, title: project.title });
    expect(template.cast).toHaveLength(project.characters.length);
    expect(template.locations).toHaveLength(project.locations.length);

    const ids = template.assets.map((asset) => asset.id);
    expect(ids).toContain("a-lin-front");
    expect(ids).toContain("a-table");
    // take 的资产不是班底的一部分
    expect(ids).not.toContain("a-take-only");
    expect(templateCounts(template).cast).toBe(project.characters.length);
  });

  it("用模板开工：班底照搬，故事与分镜从零开始", () => {
    const project = withTakeAsset();
    const template = templateOf(project, { id: "tpl-1", name: "夜班 · 班底", at: AT });
    const next = projectFromTemplate(template, {
      id: "proj-new",
      at: AT,
      title: "第二集",
      budgetCny: 88,
    });

    expect(next.id).toBe("proj-new");
    expect(next.title).toBe("第二集");
    expect(next.version).toBe(0);
    expect(next.budgetCny).toBe(88);
    expect(next.characters).toEqual(project.characters);
    expect(next.locations).toEqual(project.locations);
    expect(next.props).toEqual(project.props);
    expect(next.assets.map((asset) => asset.id)).toEqual(
      template.assets.map((asset) => asset.id),
    );
    // 风格与品牌跟着走，内容不跟着走
    expect(next.look).toEqual(project.look);
    expect(next.frame).toEqual(project.frame);
    expect(next.brand).toEqual(project.brand);
    expect(next.scenes).toEqual([]);
    expect(next.shots).toEqual([]);
    expect(next.dialogue).toEqual([]);
    expect(next.takes).toEqual([]);
    expect(next.timeline.items).toEqual([]);
    expect(next.story.logline).toBe("");
  });

  it("没填片名就用模板名；空白片名当没填", () => {
    const project = withTakeAsset();
    const template = templateOf(project, { id: "tpl-1", name: "夜班 · 班底", at: AT });
    expect(
      projectFromTemplate(template, { id: "p", at: AT, title: "  ", budgetCny: 60 }).title,
    ).toBe("夜班 · 班底");
  });

  it("模板名字带片名与日期；片名空着就只写「班底」", () => {
    expect(templateNameOf(" 夜班 ", AT)).toBe("夜班 · 2026-11-13");
    expect(templateNameOf("", AT)).toBe("班底 · 2026-11-13");
  });
});
