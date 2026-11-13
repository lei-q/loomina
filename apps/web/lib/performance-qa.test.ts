import { describe, expect, it } from "vitest";
import { ProjectSchema, type PerformanceSpec, type Project, type Shot } from "@loomina/ir";
import { analyzePerformanceQa, performanceFocusOf, performanceQaCount } from "./performance-qa";

type ShotPatch = Partial<Shot>;

function performance(patch: Partial<PerformanceSpec> = {}): PerformanceSpec {
  return {
    objective: "让她相信自己",
    emotion: { surface: "克制", subtext: "其实在试探" },
    beats: [
      { phase: "before", micro: "眼睛先垂下", body: "肩膀绷着", startMs: 0, endMs: 700 },
      { phase: "after", micro: "抬眼看向他", body: "肩膀松下来", startMs: 1300, endMs: 2000 },
    ],
    gaze: { target: "character", targetId: "c-b", direction: "right" },
    intensity: 3,
    avoid: [],
    ...patch,
  };
}

function makeProject(shots: ShotPatch[]): Project {
  return ProjectSchema.parse({
    id: "p-qa",
    title: "表演 QA",
    version: 0,
    locations: [{ id: "loc-1", name: "走廊" }],
    characters: [
      { id: "c-a", name: "甲" },
      { id: "c-b", name: "乙" },
    ],
    props: [{ id: "pr-1", name: "杯子" }],
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
      characterIds: ["c-a", "c-b"],
      dialogueIds: [],
      ...patch,
    })),
  });
}

describe("表演 QA（B18）", () => {
  it("景别决定看什么：特写看微表情、中景看姿态、全景看调度", () => {
    expect(performanceFocusOf("close")).toBe("micro");
    expect(performanceFocusOf("extreme-close")).toBe("micro");
    expect(performanceFocusOf("medium")).toBe("body");
    expect(performanceFocusOf("wide")).toBe("staging");
  });

  it("没写表演设计的镜头算「未写」，不算失败", () => {
    const report = analyzePerformanceQa(makeProject([{}]));
    expect(report.shots[0]!.verdict).toBe("unknown");
    expect(report.summary.unknown).toBe(1);
    expect(performanceQaCount(report)).toBe(0);
  });

  it("写全了的一镜通过", () => {
    const report = analyzePerformanceQa(makeProject([{ performance: performance() }]));
    expect(report.shots[0]!.verdict).toBe("pass");
    expect(report.shots[0]!.findings).toEqual([]);
  });

  it("特写没写微表情是硬伤：模型会给中性脸", () => {
    const report = analyzePerformanceQa(
      makeProject([
        {
          shotSize: "close",
          performance: performance({
            beats: [
              { phase: "before", micro: "", body: "肩膀绷着", startMs: 0, endMs: 2000 },
            ],
          }),
        },
      ]),
    );
    expect(report.shots[0]!.verdict).toBe("fail");
    expect(report.shots[0]!.findings.some((item) => item.rule === "size")).toBe(true);
  });

  it("全景没写调度只提示，不判死", () => {
    const report = analyzePerformanceQa(
      makeProject([{ shotSize: "wide", performance: performance() }]),
    );
    const size = report.shots[0]!.findings.find((item) => item.rule === "size");
    expect(size?.severity).toBe("review");
    expect(report.shots[0]!.verdict).toBe("review");
  });

  it("视线看的人不在这一镜里：判死", () => {
    const report = analyzePerformanceQa(
      makeProject([
        {
          characterIds: ["c-a"],
          performance: performance({ gaze: { target: "character", targetId: "c-b", direction: "right" } }),
        },
      ]),
    );
    const gaze = report.shots[0]!.findings.find((item) => item.rule === "gaze");
    expect(gaze?.severity).toBe("fail");
    expect(gaze?.message).toContain("乙");
  });

  it("视线看道具但道具不在这一镜里：判死", () => {
    const report = analyzePerformanceQa(
      makeProject([
        {
          performance: performance({ gaze: { target: "prop", targetId: "pr-1", direction: "down" } }),
        },
      ]),
    );
    expect(
      report.shots[0]!.findings.some((item) => item.rule === "gaze" && item.severity === "fail"),
    ).toBe(true);
  });

  it("非特写看镜头：提示会出戏", () => {
    const report = analyzePerformanceQa(
      makeProject([
        { shotSize: "medium", performance: performance({ gaze: { target: "camera", direction: "center" } }) },
      ]),
    );
    expect(
      report.shots[0]!.findings.some(
        (item) => item.rule === "gaze" && item.message.includes("出戏"),
      ),
    ).toBe(true);
  });

  it("视线方向与调度左右相反：提示可能写反", () => {
    // 乙标在画面右边，甲却朝左看：方向与站位对不上
    const report = analyzePerformanceQa(
      makeProject([
        {
          performance: performance({ gaze: { target: "character", targetId: "c-b", direction: "left" } }),
          staging: [{ characterId: "c-b", side: "right", depth: "midground", note: "" }],
        },
      ]),
    );
    expect(
      report.shots[0]!.findings.some((item) => item.message.includes("方向可能写反")),
    ).toBe(true);
  });

  it("看右边的人、标在右边：方向一致，不提示", () => {
    const report = analyzePerformanceQa(
      makeProject([
        {
          performance: performance({ gaze: { target: "character", targetId: "c-b", direction: "right" } }),
          staging: [{ characterId: "c-b", side: "right", depth: "midground", note: "" }],
        },
      ]),
    );
    expect(
      report.shots[0]!.findings.some((item) => item.message.includes("方向可能写反")),
    ).toBe(false);
  });

  it("强度副词算过火：改成具体微动作", () => {
    const report = analyzePerformanceQa(
      makeProject([
        { performance: performance({ emotion: { surface: "极度崩溃", subtext: "" } }) },
      ]),
    );
    expect(
      report.shots[0]!.findings.some((item) => item.message.includes("强度副词")),
    ).toBe(true);
  });

  it("特写给 5 级强度算过火；钩子拍只给 1 级算不够", () => {
    const over = analyzePerformanceQa(
      makeProject([{ shotSize: "close", performance: performance({ intensity: 5 }) }]),
    );
    expect(over.shots[0]!.findings.some((item) => item.message.includes("5 级强度"))).toBe(true);

    const flat = analyzePerformanceQa(
      makeProject([{ beat: "hook", performance: performance({ intensity: 1 }) }]),
    );
    expect(flat.shots[0]!.findings.some((item) => item.message.includes("看不出戏"))).toBe(true);
  });

  it("起 / 落拍里写了动作：首尾帧只该定住那一刻", () => {
    const report = analyzePerformanceQa(
      makeProject([
        {
          performance: performance({
            beats: [
              { phase: "before", micro: "垂眼", body: "站着", action: "走过来", startMs: 0, endMs: 2000 },
            ],
          }),
        },
      ]),
    );
    expect(report.shots[0]!.findings.some((item) => item.message.includes("首尾帧"))).toBe(true);
  });

  it("节拍只写到一半：后面空着", () => {
    const report = analyzePerformanceQa(
      makeProject([
        {
          durationMs: 4000,
          performance: performance({
            beats: [{ phase: "before", micro: "垂眼", body: "站着", startMs: 0, endMs: 1000 }],
          }),
        },
      ]),
    );
    expect(report.shots[0]!.findings.some((item) => item.message.includes("后面"))).toBe(true);
  });

  it("情绪从 5 级掉到 1 级且不是反应镜：提示剪辑点会跳", () => {
    const report = analyzePerformanceQa(
      makeProject([
        { performance: performance({ intensity: 5 }) },
        { performance: performance({ intensity: 1 }) },
      ]),
    );
    expect(
      report.shots[1]!.findings.some((item) => item.rule === "continuity"),
    ).toBe(true);
  });

  it("标成反应镜就不提情绪断层", () => {
    const report = analyzePerformanceQa(
      makeProject([
        { performance: performance({ intensity: 5 }) },
        { purpose: "reaction", performance: performance({ intensity: 1 }) },
      ]),
    );
    expect(
      report.shots[1]!.findings.some((item) => item.rule === "continuity"),
    ).toBe(false);
  });

  it("跨场不判情绪连续", () => {
    const project = ProjectSchema.parse({
      ...makeProject([
        { performance: performance({ intensity: 5 }) },
        { performance: performance({ intensity: 1 }) },
      ]),
      scenes: [
        { id: "sc-1", index: 0, locationId: "loc-1", shotIds: ["s-1"] },
        { id: "sc-2", index: 1, locationId: "loc-1", shotIds: ["s-2"] },
      ],
      shots: makeProject([{}, {}]).shots.map((shot, index) => ({
        ...shot,
        sceneId: index === 0 ? "sc-1" : "sc-2",
        ...(index === 0
          ? { performance: performance({ intensity: 5 }) }
          : { performance: performance({ intensity: 1 }) }),
      })),
    });
    const report = analyzePerformanceQa(project);
    expect(report.shots[1]!.findings.some((item) => item.rule === "continuity")).toBe(false);
  });

  it("要改的镜头：fail 排前面，同档按镜号", () => {
    const report = analyzePerformanceQa(
      makeProject([
        { performance: performance() },
        { shotSize: "close", performance: performance({ beats: [] }) },
        { shotSize: "wide", performance: performance() },
      ]),
    );
    expect(report.attention.map((item) => item.label)).toEqual(["SH-02", "SH-03"]);
    expect(performanceQaCount(report)).toBe(2);
  });
});
