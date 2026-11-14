/**
 * 表演语法库（I11 / PERFORMANCE.md）。
 *
 * 与导演语法库（I8）同源：**把「情绪」翻译成模型能稳定生成的具体动作，
 * 而不是形容词**。`PerformanceSpec` 已经有了 objective / emotion / beats /
 * gaze / intensity / avoid 这些字段，缺的是一份「什么意图配什么微动作」的目录。
 *
 * 这个目录回答三件事：
 * 1. 这个意图在 AI 里**能演成什么**（可生成的手段）；
 * 2. **要避开什么**（模型的已知短板：夸张表情、复杂手部、大动作）；
 * 3. 情绪强度与动作幅度的关系（PERFORMANCE.md 的铁律：**情绪越强，动作越小**）。
 *
 * 目录只提供建议，不自动写 IR：作者在分镜页的表演区自己挑，
 * 挑完仍然落成 `Shot.performance` 的普通字段，走同一条事件。
 */

export const PERFORMANCE_GRAMMAR_VERSION = "2026-11";

/**
 * 意图 → 可生成的微动作。
 *
 * 来源是 PERFORMANCE.md §五 的七组，逐条对应。`micro` 进 `ActionBeat.micro`，
 * `body` 进 `ActionBeat.body`，`avoid` 直接并进 `PerformanceSpec.avoid`。
 */
export type PerformanceIntent = {
  id: string;
  name: string;
  /** 微表情：眼、眉、嘴、呼吸 —— 镜头里看得见的小动作 */
  micro: string[];
  /** 姿态 / 手：身体怎么摆、手在干什么 */
  body: string[];
  /** 明确不做什么：模型的已知短板，写进 avoid */
  avoid: string[];
  /** 这一组适合的强度档；情绪越强动作越小 */
  intensityHint: 1 | 2 | 3 | 4 | 5;
};

export const PERFORMANCE_INTENTS: PerformanceIntent[] = [
  {
    id: "suppressed-anger",
    name: "压抑的愤怒",
    micro: ["下颌收紧", "眨眼变慢", "鼻翼轻微起伏"],
    body: ["手指慢慢收拢", "肩膀绷住不动"],
    avoid: ["面部扭曲", "大吼", "挥手砸东西"],
    intensityHint: 4,
  },
  {
    id: "guilty",
    name: "心虚",
    micro: ["视线下移", "假笑（只有嘴角动）"],
    body: ["摸脖子或耳后", "重心往后挪半步"],
    avoid: ["复杂手部动作", "四处张望"],
    intensityHint: 3,
  },
  {
    id: "shock",
    name: "震惊",
    micro: ["瞳孔放大", "呼吸停一拍"],
    body: ["后退半步", "手停在半空"],
    avoid: ["夸张后仰", "张大嘴", "抱头"],
    intensityHint: 4,
  },
  {
    id: "intimacy",
    name: "亲密",
    micro: ["视线停留变长", "呼吸起伏变明显"],
    body: ["距离缩短", "手轻轻搭上"],
    avoid: ["长拥抱", "复杂接触", "亲吻特写"],
    intensityHint: 2,
  },
  {
    id: "resolve",
    name: "决绝",
    micro: ["眼神定住不闪"],
    body: ["起身", "转身", "留一个背影"],
    avoid: ["边走边说长台词", "回头"],
    intensityHint: 4,
  },
  {
    id: "contempt",
    name: "轻蔑",
    micro: ["单侧嘴角上扬", "抬眼"],
    body: ["缓慢转头", "下巴微抬"],
    avoid: ["大幅挥手", "翻白眼"],
    intensityHint: 3,
  },
  {
    id: "collapse",
    name: "崩溃",
    micro: ["眼睛失焦"],
    body: ["低头", "肩膀塌下去", "手遮脸"],
    avoid: ["嚎哭", "剧烈抖动", "跪地"],
    intensityHint: 5,
  },
];

/**
 * 动作幅度与情绪强度的关系（PERFORMANCE.md：「情绪越强，动作越小」）。
 *
 * 这不是建议而是**约束**：模型演不了「大」，但能演「准」。
 * 强度越高，可用的动作幅度越小；写成表是为了让分镜检查能直接判
 * 「这一镜标了 5 分强度却写了大幅动作」。
 */
export const INTENSITY_ACTION_SCALE: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "日常动作幅度，可以走位、可以多人互动",
  2: "小幅动作，手与上半身为主",
  3: "微动作 + 一次明确的动作转折",
  4: "只做微表情与极小的身体变化，不要大动作",
  5: "只有微表情（眼、呼吸、下颌），身体几乎不动",
};

/** 幅度过大的词：强度 4–5 时出现在 beat 里就该提醒 */
const LARGE_ACTION_WORDS = [
  "跑",
  "跳",
  "扑",
  "砸",
  "摔",
  "大喊",
  "嚎哭",
  "挥",
  "推倒",
  "抱住",
  "跪",
  "翻滚",
];

export type PerformanceAdvice = {
  intent?: PerformanceIntent;
  /** 强度与动作幅度是否对得上；空表示没问题 */
  problems: string[];
  /** 可以直接并进 `PerformanceSpec.avoid` 的建议 */
  avoid: string[];
};

/**
 * 按意图名 / 关键词找一组语法。
 *
 * 只做词面匹配（与 H19 的一句话指令同一口径）：认不出就返回 undefined，
 * 由作者自己写，不猜。
 */
export function intentOf(text: string): PerformanceIntent | undefined {
  const said = text.trim();
  if (!said) return undefined;
  const direct = PERFORMANCE_INTENTS.find(
    (intent) => said.includes(intent.name) || intent.name.includes(said),
  );
  if (direct) return direct;
  // 常见同义说法：只说「愤怒」也认，但取的是「压抑的愤怒」那一组
  const aliases: [RegExp, string][] = [
    [/愤怒|生气|恼火|压着火/, "suppressed-anger"],
    [/心虚|撒谎|不安|露馅/, "guilty"],
    [/震惊|吃惊|愣住|难以置信/, "shock"],
    [/亲密|靠近|暧昧|温柔/, "intimacy"],
    [/决绝|下定决心|离开|告别/, "resolve"],
    [/轻蔑|不屑|看不起|嘲讽/, "contempt"],
    [/崩溃|垮掉|撑不住|绝望/, "collapse"],
  ];
  for (const [pattern, id] of aliases) {
    if (pattern.test(said)) return PERFORMANCE_INTENTS.find((intent) => intent.id === id);
  }
  return undefined;
}

/**
 * 给一镜的表演参数提建议。
 *
 * 只判两件能确定的事：
 * 1. 强度 4–5 却写了大幅动作 —— 与「情绪越强动作越小」冲突；
 * 2. 意图认得出来、但 `avoid` 没写 —— 模型会按字面演，越夸张越容易崩。
 */
export function performanceAdvice(input: {
  objective: string;
  intensity: number;
  beats: { micro?: string; body?: string; action?: string }[];
  avoid: string[];
}): PerformanceAdvice {
  const intent = intentOf(input.objective);
  const problems: string[] = [];
  const level = Math.min(5, Math.max(1, Math.round(input.intensity))) as 1 | 2 | 3 | 4 | 5;

  if (level >= 4) {
    const said = input.beats
      .map((beat) => `${beat.micro ?? ""}${beat.body ?? ""}${beat.action ?? ""}`)
      .join(" ");
    const found = LARGE_ACTION_WORDS.filter((word) => said.includes(word));
    if (found.length > 0) {
      problems.push(
        `强度 ${level} 却写了「${found.join("、")}」这类大幅动作：情绪越强动作越小，模型演不了「大」但能演「准」。`,
      );
    }
  }

  if (intent && input.avoid.length === 0) {
    problems.push(
      `这一镜是「${intent.name}」，但没写「不做什么」：不写清楚，模型会按字面把表情演过火。`,
    );
  }

  return { intent, problems, avoid: intent ? [...intent.avoid] : [] };
}

/** 目录覆盖了多少组意图，界面上一句话说清 */
export function performanceCoverage(): { intents: number; version: string } {
  return { intents: PERFORMANCE_INTENTS.length, version: PERFORMANCE_GRAMMAR_VERSION };
}
