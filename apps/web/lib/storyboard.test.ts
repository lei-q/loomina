import { describe, expect, it } from "vitest";
import { ProjectSchema, type Project } from "@loomina/ir";
import {
  analyzeStoryboard,
  digestBeats,
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

describe("节拍摘要（A11 / ADR-0115）", () => {
  it("一拍一行：镜号、时长、占比、覆盖与缺什么", () => {
    const project = makeProject([
      { beat: "hook", purpose: "hook", durationMs: 3000 },
      { beat: "setup", purpose: "information", durationMs: 2000 },
      { beat: "setup", purpose: "reaction", durationMs: 1000 },
      { beat: "turn", purpose: "information", durationMs: 4000 },
    ]);
    const digest = digestBeats(analyzeStoryboard(project).beats);

    expect(digest.count).toBe(3);
    expect(digest.totalSeconds).toBeCloseTo(10, 5);
    expect(digest.lines.map((line) => line.label)).toEqual(["钩子", "铺垫", "转折"]);
    expect(digest.arc).toBe("钩子 → 铺垫 → 转折");
    expect(digest.covered).toBe(1);

    const setup = digest.lines[1]!;
    expect(setup.shotNos).toEqual([2, 3]);
    expect(setup.shotCount).toBe(2);
    expect(setup.seconds).toBeCloseTo(3, 5);
    expect(setup.sharePct).toBe(30);
    expect(setup.covered).toBe(true);
    expect(setup.missing).toBeNull();

    // 转折只有信息镜头，缺情绪
    expect(digest.lines[2]!.covered).toBe(false);
    expect(digest.lines[2]!.missing).toBe("emotion");
  });

  it("缺信息时写「缺信息」，不是笼统的不覆盖", () => {
    const project = makeProject([{ beat: "setup", purpose: "reaction" }]);
    const digest = digestBeats(analyzeStoryboard(project).beats);
    expect(digest.lines[0]!.missing).toBe("information");
  });

  it("最长的一拍能点出来；没有拍时不编一个", () => {
    const project = makeProject([
      { beat: "hook", purpose: "hook", durationMs: 1000 },
      { beat: "climax", purpose: "emotion", durationMs: 5000 },
    ]);
    const digest = digestBeats(analyzeStoryboard(project).beats);
    expect(digest.longest?.label).toBe("高潮");
    expect(digest.longest?.sharePct).toBe(83);

    const empty = digestBeats([]);
    expect(empty.count).toBe(0);
    expect(empty.longest).toBeUndefined();
    expect(empty.arc).toBe("");
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

describe("V3 轴线近似（B17 调度 / ADR-0108）", () => {
  it("同一场相邻两镜里两个角色的左右关系翻了", () => {
    const project = makeProject([
      {
        staging: [
          { characterId: "c-a", side: "left", depth: "midground", note: "" },
          { characterId: "c-b", side: "right", depth: "midground", note: "" },
        ],
      },
      {
        staging: [
          { characterId: "c-a", side: "right", depth: "midground", note: "" },
          { characterId: "c-b", side: "left", depth: "midground", note: "" },
        ],
      },
    ]);
    const v3 = analyzeStoryboard(project).issues.filter((issue) => issue.rule === "V3");
    expect(v3).toHaveLength(1);
    expect(v3[0]?.message).toContain("甲、乙");
    expect(v3[0]?.message).toContain("像越过了 180° 轴线");
    expect(v3[0]?.shotIds).toEqual(["s-1", "s-2"]);
  });

  it("只共享一个角色、有人站中间或跨场，都不判越轴", () => {
    const single = makeProject([
      {
        staging: [{ characterId: "c-a", side: "left", depth: "midground", note: "" }],
      },
      {
        staging: [
          { characterId: "c-a", side: "right", depth: "midground", note: "" },
          { characterId: "c-b", side: "right", depth: "midground", note: "" },
        ],
      },
    ]);
    expect(analyzeStoryboard(single).issues.some((issue) => issue.rule === "V3")).toBe(false);

    const center = makeProject([
      {
        staging: [
          { characterId: "c-a", side: "left", depth: "midground", note: "" },
          { characterId: "c-b", side: "center", depth: "midground", note: "" },
        ],
      },
      {
        staging: [
          { characterId: "c-a", side: "right", depth: "midground", note: "" },
          { characterId: "c-b", side: "center", depth: "midground", note: "" },
        ],
      },
    ]);
    expect(analyzeStoryboard(center).issues.some((issue) => issue.rule === "V3")).toBe(false);

    const crossScene = makeProject([
      {
        sceneId: "sc-1",
        staging: [
          { characterId: "c-a", side: "left", depth: "midground", note: "" },
          { characterId: "c-b", side: "right", depth: "midground", note: "" },
        ],
      },
      {
        sceneId: "sc-2",
        staging: [
          { characterId: "c-a", side: "right", depth: "midground", note: "" },
          { characterId: "c-b", side: "left", depth: "midground", note: "" },
        ],
      },
    ]);
    expect(analyzeStoryboard(crossScene).issues.some((issue) => issue.rule === "V3")).toBe(false);
  });
});

describe("V3 精确越轴（B13.1 / ADR-0126）：有坐标时不再说「像」", () => {
  function geometric(
    placements: ([number, number, number] | null)[],
  ): Project {
    const project = makeProject(
      placements.map(() => ({
        characterIds: ["c-a", "c-b"],
        blocking: {
          actors: [
            { characterId: "c-a", position: [-1, 0, 0] as [number, number, number], facingRad: 0 },
            { characterId: "c-b", position: [1, 0, 0] as [number, number, number], facingRad: Math.PI },
          ],
          props: [],
        },
      })),
    );
    project.locations[0]!.space = {
      dimensions: [5, 4, 2.8],
      anchors: [],
    };
    placements.forEach((placement, index) => {
      if (!placement) return;
      const shot = project.shots[index]!;
      shot.camera = {
        ...shot.camera,
        placement: { position: placement, target: [0, 1.2, 0] },
      };
    });
    return project;
  }

  it("机位分居轴线两侧：报「越轴」，不说「像」", () => {
    const project = geometric([
      [0, 1.5, 1.2],
      [0, 1.5, -1.2],
    ]);
    const v3 = analyzeStoryboard(project).issues.filter((issue) => issue.rule === "V3");
    expect(v3).toHaveLength(1);
    expect(v3[0]!.message).toContain("越轴");
    expect(v3[0]!.message).not.toContain("像越过了");
    expect(v3[0]!.shotIds).toEqual(["s-1", "s-2"]);
  });

  it("机位同侧不报；有坐标时不再用调度近似重复报一次", () => {
    const sameSide = geometric([
      [0, 1.5, 1.2],
      [0.6, 1.5, 1.1],
    ]);
    // 同时给了相反的调度：精确版判同侧，调度近似不该再插一脚
    sameSide.shots[0]!.staging = [
      { characterId: "c-a", side: "left", depth: "midground", note: "" },
      { characterId: "c-b", side: "right", depth: "midground", note: "" },
    ];
    sameSide.shots[1]!.staging = [
      { characterId: "c-a", side: "right", depth: "midground", note: "" },
      { characterId: "c-b", side: "left", depth: "midground", note: "" },
    ];
    expect(
      analyzeStoryboard(sameSide).issues.some((issue) => issue.rule === "V3"),
    ).toBe(false);
  });

  it("没有坐标的场次仍走调度近似，文案是「像越轴」", () => {
    const project = makeProject([
      {
        staging: [
          { characterId: "c-a", side: "left", depth: "midground", note: "" },
          { characterId: "c-b", side: "right", depth: "midground", note: "" },
        ],
      },
      {
        staging: [
          { characterId: "c-a", side: "right", depth: "midground", note: "" },
          { characterId: "c-b", side: "left", depth: "midground", note: "" },
        ],
      },
    ]);
    const v3 = analyzeStoryboard(project).issues.filter((issue) => issue.rule === "V3");
    expect(v3).toHaveLength(1);
    expect(v3[0]!.message).toContain("像越过了");
  });
});

describe("V7 切率（ADR-0108）", () => {
  it("该碎的拍只有一镜 4 秒以上，提示补反应镜", () => {
    const project = makeProject([
      { beat: "setup", purpose: "information", durationMs: 1000 },
      { beat: "climax", purpose: "emotion", durationMs: 5000 },
      { beat: "endHook", purpose: "information", durationMs: 1000 },
    ]);
    const v7 = analyzeStoryboard(project).issues.filter((issue) => issue.rule === "V7");
    expect(v7).toHaveLength(1);
    expect(v7[0]?.message).toContain("只有 1 个镜头");
    expect(v7[0]?.message).toContain("这一拍要更碎");
  });

  it("多镜但平均镜长明显高于全片，也提示；不到 4 秒的单镜不提示", () => {
    const slow = makeProject([
      { beat: "setup", purpose: "information", durationMs: 1000 },
      { beat: "climax", purpose: "emotion", durationMs: 4000 },
      { beat: "climax", purpose: "reaction", durationMs: 4000 },
      { beat: "endHook", purpose: "information", durationMs: 1000 },
    ]);
    const slowV7 = analyzeStoryboard(slow).issues.filter((issue) => issue.rule === "V7");
    expect(slowV7).toHaveLength(1);
    expect(slowV7[0]?.message).toContain("平均 4.0 秒一镜");
    expect(slowV7[0]?.message).toContain("全片平均 2.5 秒一镜");

    const short = makeProject([
      { beat: "setup", purpose: "information", durationMs: 1000 },
      { beat: "climax", purpose: "emotion", durationMs: 3900 },
      { beat: "endHook", purpose: "information", durationMs: 1000 },
    ]);
    expect(analyzeStoryboard(short).issues.some((issue) => issue.rule === "V7")).toBe(false);
  });

  it("拍级统计带上平均镜长与 10 秒切数", () => {
    const project = makeProject([
      { beat: "setup", purpose: "information", durationMs: 1000 },
      { beat: "setup", purpose: "emotion", durationMs: 2000 },
    ]);
    const beat = groupBeats(planShots(project))[0]!;
    expect(beat.aslSeconds).toBeCloseTo(1.5);
    expect(beat.cutsPer10s).toBeCloseTo(6.67, 1);
  });
});

describe("V9 尾帧能力（ADR-0108）", () => {
  it("画了尾帧但模型只吃首帧，点名这些镜头", () => {
    const project = makeProject([
      { keyframes: { firstAssetId: "a-first", lastAssetId: "a-last" } },
      { keyframes: { firstAssetId: "a-first-2" } },
    ]);
    const v9 = analyzeStoryboard(project).issues.filter((issue) => issue.rule === "V9");
    expect(v9).toHaveLength(1);
    expect(v9[0]?.message).toContain("第 1 镜");
    expect(v9[0]?.message).not.toContain("第 2 镜");
    expect(v9[0]?.shotIds).toEqual(["s-1"]);
  });

  it("模型支持尾帧时不再提示", () => {
    const project = makeProject([{ keyframes: { lastAssetId: "a-last" } }]);
    expect(
      analyzeStoryboard(project, { videoAcceptsLastFrame: true }).issues.some(
        (issue) => issue.rule === "V9",
      ),
    ).toBe(false);
  });
});

describe("V11 节拍顺序（A11 / ADR-0108）", () => {
  it("开场不是钩子、结尾不是尾钩各提一条", () => {
    const project = makeProject([
      { beat: "setup", purpose: "information" },
      { beat: "setup", purpose: "emotion" },
    ]);
    const v11 = analyzeStoryboard(project).issues.filter((issue) => issue.rule === "V11");
    expect(v11).toHaveLength(2);
    expect(v11[0]?.message).toContain("全片第一镜是「铺垫」");
    expect(v11[1]?.message).toContain("最后一镜是「铺垫」");
  });

  it("同一场里节拍倒退才点名，跨场重新起势不算", () => {
    const regress = makeProject([
      { beat: "hook", purpose: "information" },
      { beat: "climax", purpose: "emotion" },
      { beat: "setup", purpose: "information" },
      { beat: "endHook", purpose: "emotion" },
    ]);
    const regression = analyzeStoryboard(regress).issues.filter((issue) =>
      issue.message.includes("在倒退"),
    );
    expect(regression).toHaveLength(1);
    expect(regression[0]?.shotIds).toEqual(["s-2", "s-3"]);

    const crossScene = makeProject([
      { sceneId: "sc-1", beat: "hook", purpose: "information" },
      { sceneId: "sc-1", beat: "climax", purpose: "emotion" },
      { sceneId: "sc-2", beat: "setup", purpose: "information" },
      { sceneId: "sc-2", beat: "endHook", purpose: "emotion" },
    ]);
    expect(
      analyzeStoryboard(crossScene).issues.some((issue) => issue.message.includes("在倒退")),
    ).toBe(false);
  });

  it("只有一个镜头时不查首尾顺序", () => {
    const project = makeProject([{ beat: "setup", purpose: "information" }]);
    expect(analyzeStoryboard(project).issues.some((issue) => issue.rule === "V11")).toBe(false);
  });
});
