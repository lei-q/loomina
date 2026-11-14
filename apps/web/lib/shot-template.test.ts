import { describe, expect, it } from "vitest";
import { sampleProject } from "./sample-project";
import {
  looksLikeShotTemplate,
  sanitizeShotTemplate,
  shotTemplateOf,
  shotTemplatePatch,
  type ShotTemplate,
} from "./shot-template";

const AT = "2026-11-14T00:00:00Z";
const shotOf = (id: string) => structuredClone(sampleProject.shots.find((shot) => shot.id === id)!);

describe("镜头模板（F3 / ADR-0207）", () => {
  it("只取摄影做法：四参数 + 已有光影 / 构图，不带动作与台词", () => {
    const shot = shotOf("s-05");
    shot.lighting = { source: "window", position: "side", mood: "modeled", note: "台灯" };
    const template = shotTemplateOf(sampleProject, shot, {
      id: "st-1",
      name: "低机位关灯",
      at: AT,
      shotLabel: "第 2 场 · 第 2 镜",
    });

    expect(template.format).toBe("loomina.shot-template");
    expect(template.shotSize).toBe(shot.shotSize);
    expect(template.angle).toBe(shot.camera.angle);
    expect(template.movement).toBe(shot.camera.movement);
    expect(template.focalMm).toBe(shot.camera.focalMm);
    expect(template.lighting?.note).toBe("台灯");
    expect(template.from).toEqual({
      projectId: sampleProject.id,
      title: sampleProject.title,
      shotId: "s-05",
      shotLabel: "第 2 场 · 第 2 镜",
    });
    // 动作与台词不在模板里
    expect(JSON.stringify(template)).not.toContain(shot.description);
    expect(template).not.toHaveProperty("description");
    expect(template).not.toHaveProperty("durationMs");
  });

  it("套用只产出摄影四项：没有光影 / 构图就不清空原值", () => {
    const template = shotTemplateOf(sampleProject, shotOf("s-05"), {
      id: "st-1",
      name: "低机位",
      at: AT,
      shotLabel: "第 2 场 · 第 2 镜",
    });
    const patch = shotTemplatePatch(template);
    expect(Object.keys(patch).sort()).toEqual(["camera", "shotSize"]);
    expect(patch.camera).toEqual({
      angle: template.angle,
      movement: template.movement,
      focalMm: template.focalMm,
    });
    // 不带 undefined 键：那会把这一镜原来的模板清掉
    expect("lighting" in patch).toBe(false);
    expect("composition" in patch).toBe(false);
  });

  it("名字裁剪到 40 字；坏的可选模板读回来被丢掉", () => {
    const base: ShotTemplate = {
      format: "loomina.shot-template",
      version: 1,
      id: "st-1",
      name: "  " + "长".repeat(60) + "  ",
      createdAt: AT,
      from: { projectId: "p", title: "夜班", shotId: "s-1", shotLabel: "第 1 镜" },
      shotSize: "close",
      angle: "low",
      movement: "push",
      focalMm: 0,
      lighting: { source: "window", position: "side", mood: "modeled", note: "" },
      composition: { rule: "不存在" } as never,
    };
    const clean = sanitizeShotTemplate(base);
    expect(clean.name).toHaveLength(40);
    expect(clean.focalMm).toBe(35);
    expect(clean.lighting?.note).toBe("");
    expect(clean.composition).toBeUndefined();
  });

  it("认得出镜头模板，不误认班底模板", () => {
    expect(looksLikeShotTemplate({ format: "loomina.shot-template", id: "a", name: "b", focalMm: 35, shotSize: "wide", angle: "eye", movement: "static" })).toBe(true);
    expect(looksLikeShotTemplate({ format: "loomina.template", id: "a", name: "b" })).toBe(false);
    expect(looksLikeShotTemplate(null)).toBe(false);
  });
});