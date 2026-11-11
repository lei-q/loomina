import { describe, expect, it } from "vitest";
import { clone } from "../src/clone";
import { ProjectSchema } from "../src/schema";
import minimalJson from "../../../examples/minimal.json";

describe("ProjectSchema", () => {
  it("能解析示例项目", () => {
    const project = ProjectSchema.parse(minimalJson);
    expect(project.shots).toHaveLength(2);
    expect(project.characters).toHaveLength(2);
    expect(project.timeline.items).toHaveLength(2);
  });

  it("拒绝缺失必填字段", () => {
    expect(() => ProjectSchema.parse({ id: "p" })).toThrow();
  });

  it("拒绝非正数的镜头时长", () => {
    const bad = clone(minimalJson);
    const first = bad.shots[0]!;
    first.durationMs = 0;
    expect(() => ProjectSchema.parse(bad)).toThrow();
  });

  it("拒绝未知景别", () => {
    const bad = clone(minimalJson) as unknown as {
      shots: { shotSize: string }[];
    };
    bad.shots[0]!.shotSize = "super-wide";
    expect(() => ProjectSchema.parse(bad)).toThrow();
  });

  it("旧项目没有 story 时补一份空的 Story Bible（ADR-0088）", () => {
    const project = ProjectSchema.parse(clone(minimalJson));
    expect(project.story.logline).toBe("");
    expect(project.story.arcs).toEqual([]);
    expect(project.story.hooks.opening).toBe("");
  });
});
