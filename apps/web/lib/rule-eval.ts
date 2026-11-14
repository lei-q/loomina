/**
 * 规则评测集与 A/B（I9 / DIRECTOR-GRAMMAR.md §十一）。
 *
 * 规则库要能证明「它确实在起作用」，而不是「写了很多条」。这里提供三件事：
 *
 * 1. **用例结构**：每个用例是一个小项目 + 期望命中 / 不该命中的规则编号；
 * 2. **运行器**：把用例跑一遍 `analyzeStoryboard`，逐条比对期望；
 * 3. **指标**：违规率、景别分布熵、用例通过率。
 *
 * 关于「30 个片段」：DIRECTOR-GRAMMAR.md 要求的是 30 个**真实短剧片段**，
 * 用来标定阈值（比如「同景别连续 ≤ 2」到底该是 2 还是 3）。那需要授权素材，
 * 本档不做。这一档做的是**正反例回归**：每条 must 规则至少一个「该报」的用例
 * 与一个「不该报」的用例，保证规则的判定方向没写反。
 *
 * 纯计算：不读盘、不调模型、不碰 store。
 */

import { ProjectSchema, type Project } from "@loomina/ir";
import {
  analyzeStoryboard,
  type StoryboardIssue,
  type StoryboardOptions,
  type StoryboardRule,
} from "./storyboard";
import { DIRECTOR_RULES } from "./director-grammar";

export const EVAL_SET_VERSION = "2026-11";

/** 一条用例：跑这个项目，期望命中 / 不命中哪些规则 */
export type EvalCase = {
  id: string;
  /** 这条用例在验什么，一句话 */
  what: string;
  /** 对应的规则编号（V1–V12）；用例主要服务于这条规则 */
  rule: StoryboardRule;
  /** 正例 = 不该报；反例 = 该报 */
  kind: "positive" | "negative";
  project: Project;
  /** 额外期望：这些规则必须出现在结果里 */
  expect?: StoryboardRule[];
  /** 额外期望：这些规则不该出现在结果里 */
  forbid?: StoryboardRule[];
  /** 有些规则要外部输入才判（V8 预算、V9 尾帧能力） */
  options?: StoryboardOptions;
};

export type EvalCaseResult = {
  id: string;
  rule: StoryboardRule;
  kind: EvalCase["kind"];
  passed: boolean;
  /** 实际命中的规则编号 */
  hit: StoryboardRule[];
  /** 失败原因；通过时为空 */
  reason?: string;
};

export type EvalReport = {
  version: string;
  results: EvalCaseResult[];
  summary: {
    cases: number;
    passed: number;
    failed: number;
    /** 覆盖到几条规则（每条规则至少一条用例） */
    rulesCovered: number;
    /** 有 must 规则但一条用例都没有的 */
    rulesMissing: StoryboardRule[];
    /** should / may 规则里还没有用例的（不阻塞，但值得补） */
    optionalMissing: StoryboardRule[];
  };
  /** 指标（DIRECTOR-GRAMMAR.md §十一） */
  metrics: {
    /** 违规率：所有反例项目里每 100 镜命中该规则的次数 */
    violationRatePer100: number;
    /** 景别分布熵（所有用例合计），越高越多样 */
    shotSizeEntropy: number;
    /** 全部用例的镜头总数 */
    shots: number;
  };
};

const MUST_RULES: StoryboardRule[] = DIRECTOR_RULES.filter(
  (rule) => rule.priority === "must",
).map((rule) => rule.id as StoryboardRule);

const OPTIONAL_RULES: StoryboardRule[] = DIRECTOR_RULES.filter(
  (rule) => rule.priority !== "must",
).map((rule) => rule.id as StoryboardRule);

/** 跑一条用例 */
export function runCase(testCase: EvalCase): EvalCaseResult {
  const report = analyzeStoryboard(testCase.project, testCase.options ?? {});
  const hit = [...new Set(report.issues.map((issue: StoryboardIssue) => issue.rule))];
  const problems: string[] = [];

  if (testCase.kind === "negative") {
    // 反例：这条规则必须报出来
    if (!hit.includes(testCase.rule)) {
      problems.push(`期望 ${testCase.rule} 报出来，实际没有`);
    }
  } else {
    // 正例：这条规则不该报
    if (hit.includes(testCase.rule)) {
      problems.push(`期望 ${testCase.rule} 不报，实际报了`);
    }
  }
  for (const rule of testCase.expect ?? []) {
    if (!hit.includes(rule)) problems.push(`期望 ${rule} 出现，实际没有`);
  }
  for (const rule of testCase.forbid ?? []) {
    if (hit.includes(rule)) problems.push(`期望 ${rule} 不出现，实际出现了`);
  }

  return {
    id: testCase.id,
    rule: testCase.rule,
    kind: testCase.kind,
    passed: problems.length === 0,
    hit,
    ...(problems.length > 0 ? { reason: problems.join("；") } : {}),
  };
}

/** 景别分布的香农熵（以 2 为底，单位 bit）。全同一种景别时为 0 */
export function shotSizeEntropy(projects: Project[]): number {
  const counts = new Map<string, number>();
  let total = 0;
  for (const project of projects) {
    for (const shot of project.shots) {
      counts.set(shot.shotSize, (counts.get(shot.shotSize) ?? 0) + 1);
      total += 1;
    }
  }
  if (total === 0) return 0;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return Math.round(entropy * 1000) / 1000;
}

/**
 * 跑整套评测。
 *
 * `rulesMissing` 只列 **must** 规则：should / may 不要求每条都有用例，
 * 但 must 是「违反即拦」，没有正反例就等于没验过。
 */
export function runEvalSuite(cases: EvalCase[]): EvalReport {
  const results = cases.map(runCase);
  const covered = new Set(results.map((result) => result.rule));
  const rulesMissing = MUST_RULES.filter((rule) => !covered.has(rule));
  const optionalMissing = OPTIONAL_RULES.filter((rule) => !covered.has(rule));
  const shots = cases.reduce((sum, testCase) => sum + testCase.project.shots.length, 0);

  // 违规率：反例用例里该规则命中数 / 总镜头数 × 100
  const negativeHits = results.filter(
    (result) => result.kind === "negative" && result.hit.includes(result.rule),
  ).length;
  const negativeShots = cases
    .filter((testCase) => testCase.kind === "negative")
    .reduce((sum, testCase) => sum + testCase.project.shots.length, 0);
  const violationRatePer100 =
    negativeShots === 0 ? 0 : Math.round((negativeHits / negativeShots) * 100 * 100) / 100;

  return {
    version: EVAL_SET_VERSION,
    results,
    summary: {
      cases: results.length,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
      rulesCovered: covered.size,
      rulesMissing,
      optionalMissing,
    },
    metrics: {
      violationRatePer100,
      shotSizeEntropy: shotSizeEntropy(cases.map((testCase) => testCase.project)),
      shots,
    },
  };
}

/** 一句话摘要，给界面或 CI 输出用 */
export function evalText(report: EvalReport): string {
  const { summary, metrics } = report;
  const base = `评测集 ${report.version}：${summary.cases} 条用例，${summary.passed} 过 ${summary.failed} 失败；覆盖 ${summary.rulesCovered} 条规则`;
  const gaps = [
    summary.rulesMissing.length > 0
      ? `${summary.rulesMissing.join(" / ")} 是 must 但还没有用例`
      : "",
    summary.optionalMissing.length > 0
      ? `${summary.optionalMissing.join(" / ")} 是 should / may，还没有用例`
      : "",
  ]
    .filter(Boolean)
    .join("；");
  return `${base}${gaps ? `；${gaps}` : ""}。违规率 ${metrics.violationRatePer100} / 100 镜，景别熵 ${metrics.shotSizeEntropy} bit（共 ${metrics.shots} 镜）。`;
}

type ShotPatch = Partial<Project["shots"][number]>;

/**
 * 造一条最小可评的片子：一场，镜头按数组顺序排。
 *
 * 默认值刻意挑成「什么都不违规」：首镜钩子、景别交错、没有台词。
 * 用例只需要覆盖想验的那一条。
 */
function makeProject(shots: ShotPatch[], dialogue: Project["dialogue"] = []): Project {
  const sizes = ["wide", "medium", "close", "medium"] as const;
  return ProjectSchema.parse({
    id: "p-eval",
    title: "评测用例",
    version: 0,
    locations: [{ id: "loc-1", name: "走廊" }],
    characters: [
      { id: "c-a", name: "甲" },
      { id: "c-b", name: "乙" },
    ],
    scenes: [
      {
        id: "sc-1",
        index: 0,
        locationId: "loc-1",
        shotIds: shots.map((_, index) => `s-${index + 1}`),
      },
    ],
    dialogue,
    shots: shots.map((patch, index) => ({
      id: `s-${index + 1}`,
      sceneId: "sc-1",
      index,
      durationMs: 2000,
      description: `第 ${index + 1} 镜`,
      shotSize: sizes[index % sizes.length]!,
      camera: { angle: "eye", movement: "static", focalMm: 35 },
      characterIds: ["c-a"],
      dialogueIds: [],
      ...patch,
    })),
  });
}

const line = (id: string, characterId: string, text: string) => ({
  id,
  characterId,
  text,
  durationMs: 1000,
});

/**
 * 用例集：每条 must 规则至少一正一反。
 *
 * 这一档验的是**判定方向没写反**（该报的报了、不该报的没报），
 * 不是阈值标定——后者要 30 个真实片段，本档不做。
 */
export const EVAL_CASES: EvalCase[] = [
  // V1 建立镜头：每场至少一个 wide
  {
    id: "V1-positive",
    what: "第一镜是全景：有建立镜头，不报",
    rule: "V1",
    kind: "positive",
    project: makeProject([{ shotSize: "wide" }, { shotSize: "close" }, { shotSize: "medium" }]),
  },
  {
    id: "V1-negative",
    what: "整场没有全景：该报没有建立镜头",
    rule: "V1",
    kind: "negative",
    project: makeProject([
      { shotSize: "close" },
      { shotSize: "medium" },
      { shotSize: "close" },
      { shotSize: "medium" },
    ]),
  },

  // V2 台词承载：说话人必须在场
  {
    id: "V2-positive",
    what: "说话人在这一镜里：不报",
    rule: "V2",
    kind: "positive",
    project: makeProject(
      [
        { shotSize: "wide", beat: "hook" },
        { shotSize: "close", dialogueIds: ["d-1"], characterIds: ["c-a"] },
      ],
      [line("d-1", "c-a", "走吧")],
    ),
  },
  {
    id: "V2-negative",
    what: "台词挂在这一镜、说话人不在：该报",
    rule: "V2",
    kind: "negative",
    project: makeProject(
      [
        { shotSize: "wide", beat: "hook" },
        { shotSize: "close", dialogueIds: ["d-1"], characterIds: ["c-b"] },
      ],
      [line("d-1", "c-a", "走吧")],
    ),
  },

  // V6 同景别连续 ≤ 2
  {
    id: "V6-positive",
    what: "连续两个同景别就换：不报",
    rule: "V6",
    kind: "positive",
    project: makeProject([
      { shotSize: "wide", beat: "hook" },
      { shotSize: "medium" },
      { shotSize: "medium" },
      { shotSize: "close" },
      { shotSize: "wide" },
    ]),
  },
  {
    id: "V6-negative",
    what: "连续三个中景：该报",
    rule: "V6",
    kind: "negative",
    project: makeProject([
      { shotSize: "wide", beat: "hook" },
      { shotSize: "medium" },
      { shotSize: "medium" },
      { shotSize: "medium" },
      { shotSize: "close" },
    ]),
  },

  // V11 节拍顺序：首镜要钩子
  {
    id: "V11-positive",
    what: "首镜是钩子、末镜是尾钩、中间不倒退：不报",
    rule: "V11",
    kind: "positive",
    project: makeProject([
      { shotSize: "wide", beat: "hook" },
      { shotSize: "medium", beat: "setup" },
      { shotSize: "close", beat: "turn" },
      { shotSize: "wide", beat: "endHook" },
    ]),
  },
  {
    id: "V11-negative",
    what: "首镜是铺垫不是钩子：该报",
    rule: "V11",
    kind: "negative",
    project: makeProject([
      { shotSize: "wide", beat: "setup" },
      { shotSize: "medium", beat: "escalation" },
      { shotSize: "close", beat: "turn" },
      { shotSize: "wide", beat: "endHook" },
    ]),
  },

  // V4 镜头时长：单镜不超过模型安全上限
  {
    id: "V4-positive",
    what: "每镜都在安全时长内：不报",
    rule: "V4",
    kind: "positive",
    project: makeProject([
      { shotSize: "wide", beat: "hook", durationMs: 2000 },
      { shotSize: "medium", durationMs: 3000 },
      { shotSize: "close", durationMs: 2500 },
    ]),
  },
  {
    id: "V4-negative",
    what: "有一镜远超安全时长：该报",
    rule: "V4",
    kind: "negative",
    project: makeProject([
      { shotSize: "wide", beat: "hook", durationMs: 2000 },
      { shotSize: "medium", durationMs: 30_000 },
      { shotSize: "close", durationMs: 2500 },
    ]),
  },
];

// 以下六条是 should 规则（V5 / V7 / V8 / V9 / V10 / V12）：同样一正一反。
// 它们不拦导出，但方向写反会让作者被误报淹没。
{
  // 共用的表演字段：V10 只查有没有 objective，给了就不报
  const performed = {
    performance: {
      objective: "要她留下",
      emotion: { surface: "", subtext: "" },
      beats: [],
      gaze: { target: "character" as const, targetId: "c-b", direction: "left" as const },
      intensity: 3,
      avoid: [],
    },
  };

  EVAL_CASES.push(
    // V5 每拍信息 + 情绪：同一拍里要有信息镜与情绪镜
    {
      id: "V5-positive",
      what: "每一拍里都既有信息镜（中景台词）也有情绪镜（特写）",
      rule: "V5",
      kind: "positive",
      project: makeProject(
        [
          // 首镜恒为 hook 目的，所以要靠后两镜凑出「信息 + 情绪」
          { shotSize: "wide", beat: "hook", ...performed },
          { shotSize: "medium", beat: "hook", dialogueIds: ["d-1"], ...performed },
          { shotSize: "close", beat: "hook", dialogueIds: ["d-2"], ...performed },
          { shotSize: "medium", beat: "endHook", dialogueIds: ["d-3"], ...performed },
          { shotSize: "close", beat: "endHook", dialogueIds: ["d-4"], ...performed },
        ],
        [
          line("d-1", "c-a", "你走吧"),
          line("d-2", "c-a", "我不走"),
          line("d-3", "c-a", "门没关"),
          line("d-4", "c-a", "留着吧"),
        ],
      ),
    },
    {
      id: "V5-negative",
      what: "钩子这一拍只有情绪镜、没有信息镜",
      rule: "V5",
      kind: "negative",
      project: makeProject(
        [
          // 首镜 wide 让 V1 不报；钩子拍只有「hook 目的 + 特写情绪」→ 缺信息
          { shotSize: "wide", beat: "hook", ...performed },
          { shotSize: "close", beat: "hook", dialogueIds: ["d-1"], ...performed },
          { shotSize: "medium", beat: "endHook", dialogueIds: ["d-2"], ...performed },
          { shotSize: "close", beat: "endHook", dialogueIds: ["d-3"], ...performed },
        ],
        [
          line("d-1", "c-a", "你走吧"),
          line("d-2", "c-a", "门没关"),
          line("d-3", "c-a", "留着吧"),
        ],
      ),
    },

    // V7 切率曲线：该碎的拍不能太长
    {
      id: "V7-positive",
      what: "钩子拍平均两秒一镜：够碎，不报",
      rule: "V7",
      kind: "positive",
      project: makeProject([
        { shotSize: "wide", beat: "hook", durationMs: 2000, ...performed },
        { shotSize: "medium", beat: "hook", durationMs: 2000, ...performed },
        { shotSize: "close", beat: "hook", durationMs: 2000, ...performed },
        { shotSize: "wide", beat: "endHook", durationMs: 2000, ...performed },
      ]),
    },
    {
      id: "V7-negative",
      what: "钩子拍只有一镜、五秒：该碎不碎",
      rule: "V7",
      kind: "negative",
      project: makeProject([
        { shotSize: "wide", beat: "hook", durationMs: 5000, ...performed },
        { shotSize: "close", beat: "endHook", durationMs: 2000, ...performed },
      ]),
    },

    // V8 预算：整片重做一遍超过预算
    {
      id: "V8-positive",
      what: "重做报价在预算内：不报",
      rule: "V8",
      kind: "positive",
      project: makeProject([
        { shotSize: "wide", beat: "hook", ...performed },
        { shotSize: "close", beat: "endHook", ...performed },
      ]),
      options: { requoteCny: 20, budgetCny: 60 },
    },
    {
      id: "V8-negative",
      what: "重做报价超过预算：该报",
      rule: "V8",
      kind: "negative",
      project: makeProject([
        { shotSize: "wide", beat: "hook", ...performed },
        { shotSize: "close", beat: "endHook", ...performed },
      ]),
      options: { requoteCny: 80, budgetCny: 60 },
    },

    // V9 尾帧能力：画了尾帧但模型只吃首帧
    {
      id: "V9-positive",
      what: "模型收尾帧：画了尾帧也不报",
      rule: "V9",
      kind: "positive",
      project: makeProject([
        { shotSize: "wide", beat: "hook", ...performed },
        {
          shotSize: "close",
          beat: "endHook",
          keyframes: { lastAssetId: "a-last" },
          ...performed,
        },
      ]),
      options: { videoAcceptsLastFrame: true },
    },
    {
      id: "V9-negative",
      what: "模型只吃首帧、这一镜却画了尾帧：该报",
      rule: "V9",
      kind: "negative",
      project: makeProject([
        { shotSize: "wide", beat: "hook", ...performed },
        {
          shotSize: "close",
          beat: "endHook",
          keyframes: { lastAssetId: "a-last" },
          ...performed,
        },
      ]),
      options: { videoAcceptsLastFrame: false },
    },

    // V10 表演设计：有没有写 objective
    {
      id: "V10-positive",
      what: "每镜都写了表演目标：不报",
      rule: "V10",
      kind: "positive",
      project: makeProject([
        { shotSize: "wide", beat: "hook", ...performed },
        { shotSize: "close", beat: "endHook", ...performed },
      ]),
    },
    {
      id: "V10-negative",
      what: "整片没有表演设计：该报",
      rule: "V10",
      kind: "negative",
      project: makeProject([
        { shotSize: "wide", beat: "hook" },
        { shotSize: "close", beat: "endHook" },
      ]),
    },
  );

  // V13 手持单场 ≤ 2（M4）
  const handheld = {
    camera: { angle: "eye" as const, movement: "handheld" as const, focalMm: 35 },
  };
  const steady = {
    camera: { angle: "eye" as const, movement: "static" as const, focalMm: 35 },
  };
  EVAL_CASES.push(
    {
      id: "V13-positive",
      what: "一场里两个手持镜：没超，不报",
      rule: "V13",
      kind: "positive",
      project: makeProject([
        { shotSize: "wide", beat: "hook", ...performed },
        { shotSize: "medium", beat: "hook", ...handheld, ...performed },
        { shotSize: "close", beat: "endHook", ...handheld, ...performed },
        { shotSize: "wide", beat: "endHook", ...steady, ...performed },
      ]),
    },
    {
      id: "V13-negative",
      what: "一场里三个手持镜：该报",
      rule: "V13",
      kind: "negative",
      project: makeProject([
        { shotSize: "wide", beat: "hook", ...performed },
        { shotSize: "medium", beat: "hook", ...handheld, ...performed },
        { shotSize: "close", beat: "hook", ...handheld, ...performed },
        { shotSize: "medium", beat: "endHook", ...handheld, ...performed },
        { shotSize: "close", beat: "endHook", ...steady, ...performed },
      ]),
    },
  );

  // V12 需要地点几何与机位坐标，单独构造
  const withGeometry = (
    shots: Parameters<typeof makeProject>[0],
    anchors: unknown[],
  ) => {
    const project = makeProject(shots);
    project.locations[0]!.space = {
      dimensions: [5, 4, 2.8],
      anchors,
    } as never;
    return project;
  };
  const placed = (position: [number, number, number], target: [number, number, number]) => ({
    angle: "eye" as const,
    movement: "static" as const,
    focalMm: 35,
    placement: { position, target },
  });
  EVAL_CASES.push(
    {
      id: "V12-positive",
      what: "视线没被挡住：不报",
      rule: "V12",
      kind: "positive",
      project: withGeometry(
        [
          { shotSize: "wide", beat: "hook", ...performed },
          { shotSize: "close", beat: "endHook", camera: placed([-2, 1.2, 0], [2, 1.2, 0]), ...performed },
        ],
        [],
      ),
    },
    {
      id: "V12-negative",
      what: "书架正好挡在机位与目标之间：该报",
      rule: "V12",
      kind: "negative",
      project: withGeometry(
        [
          { shotSize: "wide", beat: "hook", ...performed },
          { shotSize: "close", beat: "endHook", camera: placed([-2, 1.2, 0], [2, 1.2, 0]), ...performed },
        ],
        [
          {
            id: "shelf",
            kind: "furniture",
            label: "书架",
            position: [0, 1.8, 0],
            facingRad: 0,
            capacity: 0,
          },
        ],
      ),
    },
  );
}

// V3 需要两个角色的走位数据，单独追加（数组字面量里塞不下这么多嵌套）
{
  const staging = (left: string, right: string) => [
    { characterId: left, side: "left" as const, depth: "midground" as const, note: "" },
    { characterId: right, side: "right" as const, depth: "midground" as const, note: "" },
  ];
  const both = { characterIds: ["c-a", "c-b"] };
  EVAL_CASES.push(
    {
      id: "V3-positive",
      what: "两镜都是甲左乙右：关系没翻，不报",
      rule: "V3",
      kind: "positive",
      project: makeProject([
        { shotSize: "wide", beat: "hook", ...both, staging: staging("c-a", "c-b") },
        { shotSize: "medium", ...both, staging: staging("c-a", "c-b") },
        { shotSize: "close", ...both, staging: staging("c-a", "c-b") },
        { shotSize: "wide", beat: "endHook", ...both, staging: staging("c-a", "c-b") },
      ]),
    },
    {
      id: "V3-negative",
      what: "甲从左翻到右、乙从右翻到左：像越轴，该报",
      rule: "V3",
      kind: "negative",
      project: makeProject([
        { shotSize: "wide", beat: "hook", ...both, staging: staging("c-a", "c-b") },
        { shotSize: "medium", ...both, staging: staging("c-b", "c-a") },
        { shotSize: "close", ...both, staging: staging("c-b", "c-a") },
        { shotSize: "wide", beat: "endHook", ...both, staging: staging("c-a", "c-b") },
      ]),
    },
  );
}
