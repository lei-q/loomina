import { describe, expect, it } from "vitest";
import { ProjectSchema, clone, type Project } from "@loomina/ir";
import minimalJson from "../../../examples/minimal.json";
import {
  buildVideoPrompt,
  previousShotOf,
  shotMaterial,
} from "../src/index";

function load(): Project {
  return ProjectSchema.parse(clone(minimalJson));
}

describe("接上一段（C.6 / ADR-0192）", () => {
  it("找上一段：按分镜数组；第一段没有上一段", () => {
    const project = load();
    const [first, second] = project.shots;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(previousShotOf(project, first!.id)).toBeUndefined();
    expect(previousShotOf(project, second!.id)?.id).toBe(first!.id);
  });

  it("排进时间线后按成片顺序找；时间线第一条没有上一段", () => {
    const project = load();
    const [first, second] = project.shots;
    const reordered: Project = {
      ...project,
      timeline: {
        ...project.timeline,
        items: project.timeline.items.map((item) =>
          item.shotId === first!.id
            ? { ...item, startMs: 2500 }
            : { ...item, startMs: 0 },
        ),
      },
    };
    // 时间线里 sh-2 在前：sh-1 的上一段是 sh-2
    expect(previousShotOf(reordered, first!.id)?.id).toBe(second!.id);
    // sh-2 是时间线第一条：不能再退回分镜数组，把 sh-1 当上一段
    expect(previousShotOf(reordered, second!.id)).toBeUndefined();
  });

  it("打开接续后，视频提示词写上「先重复上一段最后 N 秒」", () => {
    const project = load();
    const [first, second] = project.shots;
    const withContinuation = { ...second!, continuation: { tailMs: 3000 } };
    const material = shotMaterial(project, withContinuation);
    expect(material.continuation).toEqual({
      previous: first!.description,
      tailMs: 3000,
    });
    const prompt = buildVideoPrompt(material);
    expect(prompt).toContain("接上一段：本段开头先重复上一段最后 3 秒");
    expect(prompt).toContain("不要直接切到新剧情");
    expect(prompt.indexOf("接上一段")).toBeLessThan(prompt.indexOf("从首帧起势"));
  });

  it("没开接续或没有上一段时，提示词不带这一句", () => {
    const project = load();
    const [first, second] = project.shots;
    expect(buildVideoPrompt(shotMaterial(project, second!))).not.toContain("接上一段");
    const solo = { ...first!, continuation: { tailMs: 3000 } };
    expect(shotMaterial(project, solo).continuation).toBeUndefined();
    expect(buildVideoPrompt(shotMaterial(project, solo))).not.toContain("接上一段");
  });

  it("时长按毫秒换算成秒写进提示词", () => {
    const project = load();
    const second = project.shots[1]!;
    const prompt = buildVideoPrompt(
      shotMaterial(project, { ...second, continuation: { tailMs: 4500 } }),
    );
    expect(prompt).toContain("最后 4.5 秒");
  });
});
