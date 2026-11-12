import { describe, expect, it } from "vitest";
import { ProjectSchema, type ProjectInput } from "@loomina/ir";
import { FEASIBILITY_LIMITS, analyzeScript } from "./script-doctor";

type ShotInput = NonNullable<ProjectInput["shots"]>[number];
type SceneInput = NonNullable<ProjectInput["scenes"]>[number];

/** 一份「合格」的底稿：钩子短、有转折、结尾留钩、台词短。 */
function makeProject(patch: Partial<ProjectInput> = {}) {
  const shots: ShotInput[] = [
    { id: "s-1", sceneId: "sc-1", index: 0, durationMs: 2600, description: "门被撞开", shotSize: "close", camera: { angle: "eye", movement: "push", focalMm: 35 }, characterIds: ["c-a"], dialogueIds: [], beat: "hook" },
    { id: "s-2", sceneId: "sc-1", index: 1, durationMs: 4000, description: "他把合同推过去", shotSize: "medium", camera: { angle: "eye", movement: "static", focalMm: 35 }, characterIds: ["c-a", "c-b"], dialogueIds: ["d-1"], beat: "setup" },
    { id: "s-3", sceneId: "sc-1", index: 2, durationMs: 4000, description: "她认出签名", shotSize: "close", camera: { angle: "eye", movement: "static", focalMm: 50 }, characterIds: ["c-b"], dialogueIds: ["d-2"], beat: "turn" },
    { id: "s-4", sceneId: "sc-1", index: 3, durationMs: 4000, description: "灯灭了", shotSize: "wide", camera: { angle: "eye", movement: "static", focalMm: 24 }, characterIds: [], dialogueIds: [], beat: "climax" },
    { id: "s-5", sceneId: "sc-1", index: 4, durationMs: 3000, description: "门外有人", shotSize: "medium", camera: { angle: "low", movement: "static", focalMm: 40 }, characterIds: ["c-a"], dialogueIds: [], beat: "endHook" },
  ];

  return ProjectSchema.parse({
    id: "p-doctor",
    title: "剧本医生测试",
    version: 0,
    story: {
      logline: "外卖员想要拿回父亲的房子，却撞上当年签字的董事长。",
      hooks: { opening: "门被撞开", ending: "门外还有一个人" },
      arcs: [
        { characterId: "c-a", want: "拿回房子", need: "承认父亲已经走了", flaw: "只信证据" },
        { characterId: "c-b", want: "保住名声", need: "被人看见", flaw: "先发火" },
      ],
      relationships: [{ fromCharacterId: "c-a", toCharacterId: "c-b", tension: "他想要真相，她怕真相" }],
    },
    locations: [{ id: "loc-1", name: "办公室" }],
    characters: [
      { id: "c-a", name: "甲" },
      { id: "c-b", name: "乙" },
    ],
    scenes: [{ id: "sc-1", index: 0, locationId: "loc-1", shotIds: shots.map((shot) => shot.id) }],
    dialogue: [
      { id: "d-1", characterId: "c-a", text: "签字的人是你。", durationMs: 2000 },
      { id: "d-2", characterId: "c-b", text: "你认错了。", durationMs: 1800 },
    ],
    shots,
    ...patch,
  });
}

describe("剧本医生：12 维报告（A18 / ADR-0123）", () => {
  it("合格的底稿：已测 10 维，情绪兑现与原创性标未测", () => {
    const report = analyzeScript(makeProject());
    expect(report.dims).toHaveLength(12);
    expect(report.measured).toBe(10);
    expect(report.total).toBe(12);

    const payoff = report.dims.find((dim) => dim.key === "emotionalPayoff")!;
    expect(payoff.source).toBe("model");
    expect(payoff.score).toBeNull();

    const originality = report.dims.find((dim) => dim.key === "originality")!;
    expect(originality.source).toBe("unmeasured");
    expect(originality.score).toBeNull();
  });

  it("未测维度不写 0 分，也不进总分", () => {
    const report = analyzeScript(makeProject());
    const measured = report.dims.filter((dim) => dim.score !== null);
    const average =
      measured.reduce((sum, dim) => sum + (dim.score ?? 0), 0) / measured.length;
    expect(report.overall).toBeCloseTo(Math.round(average * 10) / 10, 5);
    expect(report.overall).not.toBe(0);
  });

  it("钩子是结构代理：首镜不是钩子拍且太长时触发 warn", () => {
    const report = analyzeScript(
      makeProject({
        shots: [
          { id: "s-1", sceneId: "sc-1", index: 0, durationMs: 6000, description: "环境", shotSize: "wide", camera: { angle: "eye", movement: "static", focalMm: 24 }, characterIds: [], dialogueIds: [], beat: "setup" },
        ],
        scenes: [{ id: "sc-1", index: 0, locationId: "loc-1", shotIds: ["s-1"] }],
      }),
    );
    const hook = report.dims.find((dim) => dim.key === "hook")!;
    expect(hook.score).toBeLessThan(3);
    expect(report.findings.some((item) => item.key === "hook" && item.severity === "warn")).toBe(true);
    expect(hook.reason).toContain("不判断钩子抓不抓人");
  });

  it("Beat 密度低于每 20 秒 1 拍时触发", () => {
    // 一场一拍、90 秒 → 每 20 秒 0.22 拍
    const shots = Array.from({ length: 3 }, (_, index) => ({
      id: `s-${index + 1}`,
      sceneId: "sc-1",
      index,
      durationMs: 30_000,
      description: `第 ${index + 1} 镜`,
      shotSize: "medium" as const,
      camera: { angle: "eye" as const, movement: "static" as const, focalMm: 35 },
      characterIds: ["c-a"],
      dialogueIds: [],
      beat: "setup" as const,
    }));
    const report = analyzeScript(
      makeProject({
        shots,
        scenes: [{ id: "sc-1", index: 0, locationId: "loc-1", shotIds: shots.map((shot) => shot.id) }],
      }),
    );
    const density = report.dims.find((dim) => dim.key === "beatDensity")!;
    expect(density.score).toBeLessThan(3);
    expect(report.findings.some((item) => item.key === "beatDensity")).toBe(true);
  });

  it("台词平均超过 15 字触发删解释，并点出最长的三句", () => {
    const long = "我早就知道你会来，当年那份合同上的签字也是你亲手写下的，对吧。";
    const report = analyzeScript(
      makeProject({
        dialogue: [
          { id: "d-1", characterId: "c-a", text: long, durationMs: 5000 },
          { id: "d-2", characterId: "c-b", text: long, durationMs: 5000 },
        ],
      }),
    );
    const efficiency = report.dims.find((dim) => dim.key === "dialogueEfficiency")!;
    expect(efficiency.score).toBeLessThan(3);
    const finding = report.findings.find((item) => item.key === "dialogueLength")!;
    expect(finding.severity).toBe("warn");
    expect(efficiency.reason).toContain(long.slice(0, 6));
  });

  it("没有台词时这一项是「没有可算的内容」，不按 0 分处理", () => {
    const report = analyzeScript(makeProject({ dialogue: [] }));
    const efficiency = report.dims.find((dim) => dim.key === "dialogueEfficiency")!;
    expect(efficiency.score).toBeNull();
    expect(efficiency.reason).toContain("没有可算的内容");
  });

  it("没有结尾钩子时触发，并指出末镜不是尾钩拍", () => {
    const report = analyzeScript(
      makeProject({
        story: {
          logline: "外卖员想要拿回父亲的房子，却撞上董事长。",
          hooks: { opening: "", ending: "" },
          arcs: [],
          relationships: [],
        },
      }),
    );
    const finding = report.findings.find((item) => item.key === "endHook")!;
    expect(finding.message).toContain("没有结尾钩子");
  });

  it("可拍性按场 / 人 / 镜 / 时长四件事扣分", () => {
    const manyScenes = Array.from({ length: FEASIBILITY_LIMITS.scenes + 2 }, (_, index) => ({
      id: `sc-${index + 1}`,
      index,
      locationId: "loc-1",
      shotIds: [`s-${index + 1}`],
    }));
    const shots = manyScenes.map((scene, index) => ({
      id: scene.shotIds[0]!,
      sceneId: scene.id,
      index,
      durationMs: 8000,
      description: `第 ${index + 1} 镜`,
      shotSize: "medium" as const,
      camera: { angle: "eye" as const, movement: "static" as const, focalMm: 35 },
      characterIds: ["c-a"],
      dialogueIds: [],
    }));
    const report = analyzeScript(makeProject({ scenes: manyScenes, shots }));
    const feasibility = report.dims.find((dim) => dim.key === "feasibility")!;
    expect(feasibility.score).toBeLessThan(5);
    expect(report.findings.some((item) => item.key === "tooManyScenes")).toBe(true);
    expect(feasibility.reason).toContain(`${manyScenes.length} 场`);
  });

  it("空项目：能算的维度照样算，算不出的仍然不写 0 分", () => {
    const report = analyzeScript(
      ProjectSchema.parse({ id: "p-empty", title: "空", version: 0 }),
    );
    // 空项目不是「未测」：钩子、结尾这些维度确实能判定为不合格，给低分
    expect(report.overall).not.toBeNull();
    expect(report.summary.verdict).toBe("偏低");
    expect(report.measured).toBeLessThan(12);
    // 但情绪兑现与原创性依然没有数据
    expect(report.dims.find((dim) => dim.key === "emotionalPayoff")!.score).toBeNull();
    expect(report.dims.find((dim) => dim.key === "originality")!.score).toBeNull();
  });

  it("六种改写模式都有建议，且只给方向不写事件", () => {
    const project = makeProject();
    const before = JSON.stringify(project);
    const report = analyzeScript(project);
    expect(report.suggestions.map((item) => item.mode)).toEqual([
      "strengthenHook",
      "addReversal",
      "trimExposition",
      "sharpenConflict",
      "reduceCast",
      "rewriteEnding",
    ]);
    for (const suggestion of report.suggestions) {
      expect(suggestion.direction.length).toBeGreaterThan(0);
      expect(suggestion.target.length).toBeGreaterThan(0);
    }
    // 纯函数：不碰项目
    expect(JSON.stringify(project)).toBe(before);
  });

  it("已经写了张力时，锐化冲突指出「让对手先出手」而不是补关系", () => {
    const report = analyzeScript(makeProject());
    const sharpen = report.suggestions.find((item) => item.mode === "sharpenConflict")!;
    expect(sharpen.direction).toContain("对手");
    expect(sharpen.applicable).toBe(true);
  });

  it("纯函数：同一份项目两次结果一致", () => {
    const project = makeProject();
    expect(JSON.stringify(analyzeScript(project))).toBe(
      JSON.stringify(analyzeScript(project)),
    );
  });
});

/**
 * 爽点曲线与逐场节奏（A2 / ADR-0161）。
 *
 * 这两块仍然只回答结构问题：哪一段有兑现、哪一场太慢或太平。
 * 权重来自拍子、目的和一组能被当场看见的词，不判断「好不好看」。
 */
describe("剧本医生：爽点曲线与逐场节奏（A2 / ADR-0161）", () => {
  const CAMERA = { angle: "eye" as const, movement: "static" as const, focalMm: 35 };

  it("有实拍镜头时给出曲线、峰值段与兑现总数", () => {
    const report = analyzeScript(makeProject());
    expect(report.payoff.flat).toBe(false);
    expect(report.payoff.total).toBeGreaterThan(0);
    expect(report.payoff.windows.length).toBe(Math.ceil(report.seconds / 5));
    const peak = report.payoff.windows.find((window) => window.score === 100);
    expect(peak).toBeDefined();
    expect(report.payoff.peakLabel).toBe(peak!.label);
    // 每一段都有可读的秒数标签，分数封在 0–100
    for (const window of report.payoff.windows) {
      expect(window.label).toMatch(/^\d+\.\ds$/);
      expect(window.score).toBeGreaterThanOrEqual(0);
      expect(window.score).toBeLessThanOrEqual(100);
    }
  });

  it("把一句兑现写进镜头，总权重会涨：曲线认的是场面里的动作", () => {
    const base = makeProject();
    const spicyShots = base.shots.map((shot) =>
      shot.id === "s-3"
        ? { ...shot, description: "她当场把账本摔在桌上，揭穿了签字的人" }
        : shot,
    );
    const spicy = analyzeScript(makeProject({ shots: spicyShots }));
    expect(spicy.payoff.total).toBeGreaterThan(analyzeScript(base).payoff.total);
  });

  it("没有镜头时曲线是平的，不伪造波形", () => {
    const report = analyzeScript(
      makeProject({ shots: [], scenes: [{ id: "sc-1", index: 0, locationId: "loc-1", shotIds: [] }] }),
    );
    expect(report.payoff.flat).toBe(true);
    expect(report.payoff.windows).toEqual([]);
    expect(report.scenes[0]!.issue).toBe("flat");
    expect(report.scenes[0]!.advice).toContain("还没有镜头");
  });

  it("逐场诊断：偏慢 / 偏碎 / 偏平各有各的结论", () => {
    const shots = [
      { id: "s-1", sceneId: "sc-1", index: 0, durationMs: 6000, description: "她坐下来", shotSize: "wide" as const, camera: CAMERA, characterIds: ["c-a"], dialogueIds: [], beat: "setup" as const },
      { id: "s-2", sceneId: "sc-2", index: 1, durationMs: 500, description: "门开", shotSize: "close" as const, camera: CAMERA, characterIds: ["c-a"], dialogueIds: [], beat: "setup" as const },
      { id: "s-3", sceneId: "sc-2", index: 2, durationMs: 500, description: "他回头", shotSize: "close" as const, camera: CAMERA, characterIds: ["c-a"], dialogueIds: [], beat: "setup" as const },
      { id: "s-4", sceneId: "sc-2", index: 3, durationMs: 500, description: "灯灭", shotSize: "wide" as const, camera: CAMERA, characterIds: [], dialogueIds: [], beat: "setup" as const },
      { id: "s-5", sceneId: "sc-3", index: 4, durationMs: 2000, description: "两人坐下", shotSize: "medium" as const, camera: CAMERA, characterIds: ["c-a", "c-b"], dialogueIds: [], beat: "resolution" as const },
      { id: "s-6", sceneId: "sc-3", index: 5, durationMs: 2000, description: "窗外下雨", shotSize: "wide" as const, camera: CAMERA, characterIds: [], dialogueIds: [], beat: "resolution" as const },
    ];
    const report = analyzeScript(
      makeProject({
        shots,
        scenes: [
          { id: "sc-1", index: 0, locationId: "loc-1", shotIds: ["s-1"] },
          { id: "sc-2", index: 1, locationId: "loc-1", shotIds: ["s-2", "s-3", "s-4"] },
          { id: "sc-3", index: 2, locationId: "loc-1", shotIds: ["s-5", "s-6"] },
        ],
      }),
    );
    expect(report.scenes).toHaveLength(3);

    const [slow, rushed, flat] = report.scenes;
    expect(slow!.issue).toBe("slow");
    expect(slow!.aslSeconds).toBe(6);
    expect(slow!.advice).toContain("平均镜长偏慢");

    expect(rushed!.issue).toBe("rushed");
    expect(rushed!.aslSeconds).toBeCloseTo(0.5, 5);
    expect(rushed!.advice).toContain("偏碎");

    expect(flat!.issue).toBe("flat");
    expect(flat!.payoff).toBe(0);
    expect(flat!.advice).toContain("加一次拒绝");
  });

  it("同一场里拍子越重，兑现权重越高；节奏结论不影响 12 维", () => {
    const base = makeProject();
    const report = analyzeScript(base);
    const dims = report.dims.map((dim) => `${dim.key}:${dim.score}`);
    const heavier = analyzeScript(
      makeProject({
        shots: base.shots.map((shot) =>
          shot.id === "s-2" ? { ...shot, beat: "climax" as const } : shot,
        ),
      }),
    );
    expect(heavier.payoff.total).toBeGreaterThan(report.payoff.total);
    // 新增报告字段不改原有 12 维结论
    expect(heavier.dims.map((dim) => `${dim.key}:${dim.score}`)).toEqual(dims);
  });
});
