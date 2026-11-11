import { describe, expect, it } from "vitest";
import { ProjectSchema, type Project } from "@loomina/ir";
import {
  analyzeStoryboard,
  groupBeats,
  inferBeat,
  inferPurpose,
  planShots,
} from "./storyboard";

type ShotPatch = Partial<Project["shots"][number]>;

/**
 * 造一个小项目：默认一场，镜头按数组顺序排。
 * 需要两场时传 sceneId 切换，scene 列表会自动补齐。
 */
function makeProject(shots: ShotPatch[], dialogue: Project["dialogue"] = []): Project {
  const sceneIds = [...new Set(shots.map((shot) => shot.sceneId ?? "sc-1"))];
  const scenes = sceneIds.map((id, index) => ({
    id,
    index,
    locationId: "loc-1",
    shotIds: shots
      .map((shot, shotIndex) => ({ id: `s-${shotIndex + 1}`, sceneId: shot.sceneId ?? "sc-1" }))
      .filter((item) => item.sceneId === id)
      .map((item) => item.id),
  }));

  return ProjectSchema.parse({
    id: "p-test",
    title: "测试片",
    version: 0,
    locations: [{ id: "loc-1", name: "走廊" }],
    characters: [
      { id: "c-a", name: "甲" },
      { id: "c-b", name: "乙" },
    ],
    scenes,
    dialogue,
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

describe("分镜推断", () => {
  it("没有标注时按镜序推断节拍：首镜钩子、末镜尾钩", () => {
    expect(inferBeat(0, 4)).toBe("hook");
    expect(inferBeat(1, 4)).toBe("setup");
    expect(inferBeat(2, 4)).toBe("turn");
    expect(inferBeat(3, 4)).toBe("endHook");
    expect(inferBeat(0, 1)).toBe("hook");
  });

  it("推断镜头目的：首镜钩子、特写台词是情绪、全景是建立、无人是过渡", () => {
    expect(
      inferPurpose(
        { shotSize: "medium", characterIds: ["c-a"], dialogueIds: [] },
        { index: 0, firstInScene: true, previousHadDialogue: false },
      ),
    ).toBe("hook");
    expect(
      inferPurpose(
        { shotSize: "close", characterIds: ["c-a"], dialogueIds: ["d-1"] },
        { index: 1, firstInScene: false, previousHadDialogue: false },
      ),
    ).toBe("emotion");
    expect(
      inferPurpose(
        { shotSize: "wide", characterIds: [], dialogueIds: [] },
        { index: 1, firstInScene: false, previousHadDialogue: false },
      ),
    ).toBe("establish");
    expect(
      inferPurpose(
        { shotSize: "medium", characterIds: [], dialogueIds: [] },
        { index: 1, firstInScene: false, previousHadDialogue: false },
      ),
    ).toBe("transition");
    expect(
      inferPurpose(
        { shotSize: "close", characterIds: ["c-b"], dialogueIds: [] },
        { index: 2, firstInScene: false, previousHadDialogue: true },
      ),
    ).toBe("reaction");
  });

  it("显式标注优先于推断，并且读模型不改写 IR", () => {
    const project = makeProject([
      { beat: "climax", purpose: "emotion" },
      { shotSize: "wide", dialogueIds: ["d-1"] },
    ]);
    const plans = planShots(project);

    expect(plans[0]).toMatchObject({
      beat: "climax",
      purpose: "emotion",
      beatFrom: "shot",
      purposeFrom: "shot",
    });
    expect(plans[1]).toMatchObject({ beatFrom: "inferred", purposeFrom: "inferred" });
    expect(project.shots[0]?.beat).toBe("climax");
    expect(project.shots[1]?.beat).toBeUndefined();
  });

  it("同场连续同一拍合成一段，跨场不合并，时长累加", () => {
    const project = makeProject([
      { beat: "setup", purpose: "information", durationMs: 1000 },
      { beat: "setup", purpose: "emotion", durationMs: 2000 },
      { beat: "turn", purpose: "information", durationMs: 3000 },
      { sceneId: "sc-2", beat: "turn", purpose: "emotion", durationMs: 4000 },
    ]);
    const beats = groupBeats(planShots(project));

    expect(beats).toHaveLength(3);
    expect(beats[0]).toMatchObject({
      kind: "setup",
      shotIds: ["s-1", "s-2"],
      shotNos: [1, 2],
      startMs: 0,
      durationMs: 3000,
      hasInformation: true,
      hasEmotion: true,
    });
    expect(beats[1]).toMatchObject({ kind: "turn", shotIds: ["s-3"], startMs: 3000 });
    expect(beats[2]).toMatchObject({ kind: "turn", sceneId: "sc-2", durationMs: 4000 });
  });
});

describe("覆盖率", () => {
  it("同时有信息与情绪 / 反应镜头的拍才算覆盖", () => {
    const project = makeProject([
      { beat: "setup", purpose: "information" },
      { beat: "setup", purpose: "reaction" },
      { beat: "turn", purpose: "transition" },
      { beat: "turn", purpose: "transition" },
    ]);
    const report = analyzeStoryboard(project);

    expect(report.summary).toMatchObject({
      shots: 4,
      beats: 2,
      coveredBeats: 1,
      coveragePct: 50,
    });
  });

  it("没有镜头时覆盖率是 0，不除零", () => {
    const report = analyzeStoryboard(makeProject([]));
    expect(report.summary).toMatchObject({ shots: 0, beats: 0, coveragePct: 0 });
  });
});

describe("分镜校验", () => {
  it("V1：这一场没有建立镜头", () => {
    const project = makeProject([
      { purpose: "information", shotSize: "medium" },
      { purpose: "emotion", shotSize: "close" },
    ]);
    const v1 = analyzeStoryboard(project).issues.filter((issue) => issue.rule === "V1");
    expect(v1).toHaveLength(1);
    expect(v1[0]?.message).toContain("没有建立镜头");
  });

  it("V1：有全景就算有建立镜头，不再提示", () => {
    const project = makeProject([
      { purpose: "information", shotSize: "wide" },
      { purpose: "emotion", shotSize: "close" },
    ]);
    expect(
      analyzeStoryboard(project).issues.some((issue) => issue.rule === "V1"),
    ).toBe(false);
  });

  it("V2：有台词但说话人不在场", () => {
    const project = makeProject(
      [{ characterIds: [], dialogueIds: ["d-1"] }, { characterIds: ["c-a"] }],
      [{ id: "d-1", characterId: "c-b", text: "谁？", durationMs: 1000 }],
    );
    const v2 = analyzeStoryboard(project).issues.filter((issue) => issue.rule === "V2");
    expect(v2).toHaveLength(1);
    expect(v2[0]?.message).toContain("乙");
  });

  it("V4：单镜超出 1–8 秒是错误，排在提示前面", () => {
    const project = makeProject([
      { durationMs: 900 },
      { durationMs: 9000 },
    ]);
    const issues = analyzeStoryboard(project).issues;
    expect(issues[0]).toMatchObject({ rule: "V4", severity: "error" });
    expect(issues.filter((issue) => issue.rule === "V4")).toHaveLength(2);
    expect(issues.filter((issue) => issue.severity === "error")).toHaveLength(2);
  });

  it("V5：一拍缺信息、缺情绪各给一条", () => {
    const project = makeProject([
      { beat: "setup", purpose: "transition" },
      { beat: "setup", purpose: "transition" },
    ]);
    const v5 = analyzeStoryboard(project).issues.filter((issue) => issue.rule === "V5");
    expect(v5).toHaveLength(2);
    expect(v5.map((issue) => issue.message).join("\n")).toContain("没有信息镜头");
    expect(v5.map((issue) => issue.message).join("\n")).toContain("没有情绪或反应镜头");
  });

  it("V6：同场连续三个同景别", () => {
    const project = makeProject([
      { shotSize: "medium", purpose: "information" },
      { shotSize: "medium", purpose: "information" },
      { shotSize: "medium", purpose: "emotion" },
    ]);
    const v6 = analyzeStoryboard(project).issues.filter((issue) => issue.rule === "V6");
    expect(v6).toHaveLength(1);
    expect(v6[0]?.message).toContain("连续 3 个中景");
    expect(v6[0]?.shotIds).toEqual(["s-1", "s-2", "s-3"]);
  });

  it("V6：跨场同景别不算连续", () => {
    const project = makeProject([
      { sceneId: "sc-1", shotSize: "medium" },
      { sceneId: "sc-1", shotSize: "medium" },
      { sceneId: "sc-2", shotSize: "medium" },
      { sceneId: "sc-2", shotSize: "medium" },
    ]);
    expect(
      analyzeStoryboard(project).issues.some((issue) => issue.rule === "V6"),
    ).toBe(false);
  });

  it("V8：整片重做报价超过预算才提示，没给报价就不查", () => {
    const project = makeProject([{ durationMs: 2000 }]);
    expect(
      analyzeStoryboard(project, { requoteCny: 100, budgetCny: 60 }).issues.some(
        (issue) => issue.rule === "V8",
      ),
    ).toBe(true);
    expect(
      analyzeStoryboard(project, { requoteCny: 100, budgetCny: 60 }).issues.find(
        (issue) => issue.rule === "V8",
      )?.message,
    ).toContain("超过预算");
    expect(
      analyzeStoryboard(project, { budgetCny: 60 }).issues.some(
        (issue) => issue.rule === "V8",
      ),
    ).toBe(false);
  });

  it("全部合规时没有错误，摘要统计正确", () => {
    const project = makeProject([
      { beat: "setup", purpose: "establish", shotSize: "wide" },
      { beat: "setup", purpose: "information", shotSize: "medium" },
      { beat: "setup", purpose: "emotion", shotSize: "close" },
      { beat: "turn", purpose: "reaction", shotSize: "close" },
      { beat: "turn", purpose: "information", shotSize: "medium" },
    ]);
    const report = analyzeStoryboard(project);
    expect(report.summary.errors).toBe(0);
    expect(report.summary.coveragePct).toBe(100);
    expect(report.issues.filter((issue) => issue.rule === "V5")).toHaveLength(0);
  });
});

describe("V10 表演设计（B16 / B17 / ADR-0103）", () => {
  it("没写表演设计的镜头会被点名，但不升级成错误", () => {
    const project = makeProject([
      { beat: "setup", purpose: "information" },
      { beat: "turn", purpose: "emotion" },
    ]);
    const report = analyzeStoryboard(project);
    const issue = report.issues.find((item) => item.rule === "V10");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("第 1 镜");
    expect(issue?.message).toContain("第 2 镜");
    expect(issue?.shotIds).toEqual(["s-1", "s-2"]);
    expect(report.summary.errors).toBe(0);
  });

  it("objective 空白也算没写；补上 objective 与视线后不再提示", () => {
    const blank = makeProject([
      {
        beat: "setup",
        purpose: "information",
        performance: {
          objective: "  ",
          emotion: { surface: "", subtext: "" },
          beats: [],
          gaze: { target: "camera" as const, direction: "center" as const },
          intensity: 3,
          avoid: [],
        },
      },
    ]);
    expect(
      analyzeStoryboard(blank).issues.some((issue) => issue.rule === "V10"),
    ).toBe(true);

    const project = makeProject([
      {
        beat: "setup",
        purpose: "information",
        performance: {
          objective: "让她留下来",
          emotion: { surface: "克制", subtext: "在试探" },
          beats: [],
          gaze: { target: "character" as const, targetId: "c-b", direction: "right" as const },
          intensity: 4,
          avoid: [],
        },
      },
    ]);
    expect(
      analyzeStoryboard(project).issues.some((issue) => issue.rule === "V10"),
    ).toBe(false);
  });
});
