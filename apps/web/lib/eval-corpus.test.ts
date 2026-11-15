import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "./rule-eval";
import { sampleProject } from "./sample-project";
import {
  CORPUS_TARGET,
  actualRulesOf,
  clipsByScene,
  corpusText,
  parseCorpusClip,
  runCorpus,
  type CorpusClip,
} from "./eval-corpus";

const negative = EVAL_CASES.find((item) => item.kind === "negative")!;

function clipOf(project: CorpusClip["project"], expected: CorpusClip["expected"]): CorpusClip {
  return {
    meta: { id: "clip-test", source: "测试", license: "self-made" },
    project,
    expected,
  };
}

describe("parseCorpusClip", () => {
  it("接受带 meta / project / expected 的素材", () => {
    const clip = parseCorpusClip({
      meta: { id: "clip-a01", source: "自制", license: "self-made", genre: "悬疑复仇" },
      project: negative.project,
      expected: ["V6"],
    });
    expect(clip.meta.id).toBe("clip-a01");
    expect(clip.meta.genre).toBe("悬疑复仇");
    expect(clip.expected).toEqual(["V6"]);
  });

  it("缺授权时拒绝：没有授权的素材不进库", () => {
    expect(() =>
      parseCorpusClip({
        meta: { id: "clip-a01", source: "自制" },
        project: negative.project,
        expected: [],
      }),
    ).toThrow(/license/);
  });

  it("规则编号不在 V1–V14 时拒绝", () => {
    expect(() =>
      parseCorpusClip({
        meta: { id: "clip-a01", source: "自制", license: "self-made" },
        project: negative.project,
        expected: ["V99"],
      }),
    ).toThrow(/V99/);
  });
});

describe("runCorpus", () => {
  it("空素材库如实报 0 段与缺口", () => {
    const report = runCorpus([]);
    expect(report.summary.clips).toBe(0);
    expect(report.summary.short).toBe(CORPUS_TARGET);
    expect(corpusText(report)).toContain("0 / 30");
  });

  it("标注与规则一致时精确率 / 召回率都是 1", () => {
    const actual = actualRulesOf(negative.project);
    expect(actual.length).toBeGreaterThan(0);
    const report = runCorpus([clipOf(negative.project, actual)]);
    expect(report.summary.precision).toBe(1);
    expect(report.summary.recall).toBe(1);
    expect(report.summary.falsePositives).toBe(0);
    expect(report.summary.missed).toBe(0);
  });

  it("标注为空时，规则报出来的都算误报", () => {
    const report = runCorpus([clipOf(negative.project, [])]);
    expect(report.summary.falsePositives).toBe(actualRulesOf(negative.project).length);
    expect(report.summary.recall).toBeUndefined();
    expect(report.summary.precision).toBe(0);
  });

  it("按规则统计命中次数，14 条规则全列", () => {
    const report = runCorpus([clipOf(negative.project, [])]);
    expect(Object.keys(report.byRule)).toHaveLength(14);
    expect(report.byRule.V6 + report.byRule.V14 >= 0).toBe(true);
  });
});

describe("clipsByScene", () => {
  it("一场一段，镜头数与场次一致", () => {
    const clips = clipsByScene(sampleProject);
    expect(clips).toHaveLength(sampleProject.scenes.length);
    for (const clip of clips) {
      const scene = sampleProject.scenes.find((item) => item.id === clip.sceneId)!;
      expect(clip.project.shots).toHaveLength(scene.shotIds.length);
      expect(clip.project.scenes).toHaveLength(1);
      expect(clip.project.shots.every((shot) => shot.sceneId === scene.id)).toBe(true);
    }
  });

  it("切完的素材不再引用被切掉的 take / 时间线", () => {
    for (const clip of clipsByScene(sampleProject)) {
      expect(clip.project.takes).toEqual([]);
      expect(clip.project.timeline.items).toEqual([]);
      expect(clip.project.shots.every((shot) => shot.takeIds.length === 0)).toBe(true);
    }
  });

  it("不改原项目", () => {
    const before = sampleProject.shots.length;
    clipsByScene(sampleProject);
    expect(sampleProject.shots).toHaveLength(before);
  });
});
