import { describe, expect, it } from "vitest";
import { ProjectSchema, type Project } from "@loomina/ir";
import {
  COVERAGE_TEMPLATES,
  coverageEstimate,
  coverageGaps,
  coverageReportText,
  coverageTemplatesFor,
} from "./coverage-plan";
import { analyzeStoryboard } from "./storyboard";

type ShotPatch = Partial<Project["shots"][number]>;

function makeProject(shots: ShotPatch[]): Project {
  return ProjectSchema.parse({
    id: "p-test",
    title: "测试片",
    version: 0,
    locations: [{ id: "loc-1", name: "走廊" }],
    characters: [{ id: "c-a", name: "甲" }],
    scenes: [
      {
        id: "sc-1",
        index: 0,
        locationId: "loc-1",
        shotIds: shots.map((_, index) => `s-${index + 1}`),
      },
    ],
    shots: shots.map((patch, index) => ({
      id: `s-${index + 1}`,
      sceneId: "sc-1",
      index,
      durationMs: 2000,
      description: `第 ${index + 1} 镜`,
      shotSize: "medium",
      camera: { angle: "eye", movement: "static", focalMm: 35 },
      characterIds: ["c-a"],
      dialogueIds: [],
      ...patch,
    })),
  });
}

describe("覆盖率收口（A10 / ADR-0155）", () => {
  const report = analyzeStoryboard(
    makeProject([
      { beat: "hook", purpose: "information" },
      { beat: "setup", purpose: "establish" },
      { beat: "climax", purpose: "emotion" },
    ]),
  );

  it("只列未覆盖的拍，区分缺信息 / 缺情绪 / 都缺", () => {
    const gaps = coverageGaps(report);
    expect(gaps.map((gap) => [gap.label, gap.gap, gap.suggested])).toEqual([
      ["钩子", "emotion", "emotion"],
      ["铺垫", "emotion", "emotion"],
      ["高潮", "information", "information"],
    ]);
  });

  it("按缺口筛模板：缺情绪与缺信息给的候选不一样", () => {
    const emotion = coverageTemplatesFor("emotion");
    const information = coverageTemplatesFor("information");
    expect(emotion.length).toBeGreaterThan(0);
    expect(information.length).toBeGreaterThan(0);
    expect(emotion.every((item) => item.emotion === "emotion" || item.emotion === "reaction")).toBe(true);
    expect(information.some((item) => item.info === "information" || item.info === "establish")).toBe(true);
    expect(coverageTemplatesFor(undefined)).toEqual([]);
    expect(coverageTemplatesFor("both")).toHaveLength(COVERAGE_TEMPLATES.length);
  });

  it("补镜估价与单镜草稿档同口径，缺口数决定镜数", () => {
    const templates = COVERAGE_TEMPLATES.slice(0, 1);
    const estimate = coverageEstimate(report, templates);
    expect(estimate.shots).toBe(6); // 3 个缺口 × 双人对话建议 2 镜
    expect(estimate.perShotCny).toBeCloseTo(1.62, 2);
    expect(estimate.totalCny).toBeCloseTo(9.72, 2);
    expect(estimate.basis).toContain("3 秒草稿档");
    expect(coverageEstimate(analyzeStoryboard(makeProject([])), []).shots).toBe(0);
  });

  it("独立报告写明口径、缺口、模板、成本与校验清单", () => {
    const text = coverageReportText({
      title: "测试片",
      report,
      estimate: coverageEstimate(report, COVERAGE_TEMPLATES.slice(0, 1)),
      templates: COVERAGE_TEMPLATES.slice(0, 1),
    });
    expect(text).toContain("覆盖率报告");
    expect(text).toContain("不评价故事好坏");
    expect(text).toContain("未经授权样片 A/B 标定");
    expect(text).toContain("钩子 · 第 1 场");
    expect(text).toContain("缺情绪：建议补 情绪 镜");
    expect(text).toContain("双人对话：master → OTS A");
    expect(text).toContain("约补 6 镜");
    expect(text).toContain("校验清单");
  });
});
