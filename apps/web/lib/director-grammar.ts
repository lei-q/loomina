/**
 * 导演语法库（I8 / DIRECTOR-GRAMMAR.md）。
 *
 * 规则不是提示词，是**可执行、可校验、可版本化**的约束（ADR-0015）：
 * 分镜检查里跑的那些判定（V1–V12）在这里登记成一份目录，每条都写清
 * 它属于哪一类、优先级、判的是什么、违反了怎么修。
 *
 * 目录与实现分开的原因：
 * - 目录要能被界面读出来（「这条检查在查什么」），实现留在 `storyboard.ts`；
 * - 规则会随版本演化（RULE-EVOLUTION.md），目录带版本号，将来能说清
 *   「这一次是按哪一版规则查的」——与平台规格表 `PLATFORM_SPEC_VERSION` 同一做法；
 * - 只有登记在这里的规则才算「已上线」：`storyboard.ts` 里多写一条判定但没登记，
 *   测试会拦住（见 `storyboard.test.ts` 的目录一致性用例）。
 *
 * 这一版只收**已经能可靠判断**的 12 条。DIRECTOR-GRAMMAR.md 里其余 25 条
 * （需要视觉模型、需要参考片标定、或只是审美默认值）暂不进目录，如实列在
 * `UNIMPLEMENTED` 里——不进目录不等于不存在，只是还不能自动查。
 */

export const GRAMMAR_VERSION = "2026-11";

/** 规则类别，与 DIRECTOR-GRAMMAR.md 的章节一一对应 */
export type RuleCategory =
  | "shot-size"
  | "angle"
  | "movement"
  | "axis"
  | "rhythm"
  | "lighting"
  | "feasibility";

export const RULE_CATEGORY_CN: Record<RuleCategory, string> = {
  "shot-size": "景别",
  angle: "机位",
  movement: "运镜",
  axis: "轴线与空间",
  rhythm: "节奏",
  lighting: "光影",
  feasibility: "生成可行性",
};

/** must 违反即拦；should 给警告可覆盖；may 是风格化选项 */
export type RulePriority = "must" | "should" | "may";

export type DirectorRule = {
  /** 分镜检查里用的编号（V1–V12），与 DIRECTOR-GRAMMAR.md 的 S/A/M/X/R/L/F 编号分开 */
  id: string;
  /** 文档里的对应编号，如 "S6"；没有直接对应时为 undefined */
  docId?: string;
  name: string;
  category: RuleCategory;
  priority: RulePriority;
  /** 判什么 */
  checks: string;
  /** 违反了怎么修 */
  fix: string;
  /** 检查实现落在哪 */
  source: "storyboard";
};

export const DIRECTOR_RULES: DirectorRule[] = [
  {
    id: "V1",
    docId: "S1",
    name: "建立镜头",
    category: "shot-size",
    priority: "must",
    checks: "每一场至少一个建立镜头（wide 或 purpose=establish）",
    fix: "补一个全景，先让观众看清空间",
    source: "storyboard",
  },
  {
    id: "V2",
    docId: "S5",
    name: "台词承载",
    category: "axis",
    priority: "must",
    checks: "有台词时说话人必须在这一镜出场",
    fix: "把说话人加进这一镜，或把台词挪到他在场的镜头",
    source: "storyboard",
  },
  {
    id: "V3",
    docId: "X1",
    name: "轴线近似",
    category: "axis",
    priority: "must",
    checks: "同一场里同两个人反复出现时，左右关系不应无故翻转",
    fix: "把其中一镜的调度改回同一侧；真要越轴，中间插一个中性镜",
    source: "storyboard",
  },
  {
    id: "V4",
    docId: "F1",
    name: "镜头时长",
    category: "feasibility",
    priority: "must",
    checks: "单镜时长不超过模型安全上限",
    fix: "拆成两镜，或缩短这一镜",
    source: "storyboard",
  },
  {
    id: "V5",
    docId: "R2",
    name: "每拍信息 + 情绪",
    category: "rhythm",
    priority: "should",
    checks: "每个叙事拍至少有一镜给信息、一镜给情绪",
    fix: "给这一拍补一个 insert 或反应镜",
    source: "storyboard",
  },
  {
    id: "V6",
    docId: "S6",
    name: "同景别连续",
    category: "shot-size",
    priority: "must",
    checks: "连续同景别不超过 2 个",
    fix: "换一个景别，画面才有节奏",
    source: "storyboard",
  },
  {
    id: "V7",
    docId: "R3",
    name: "切率曲线",
    category: "rhythm",
    priority: "should",
    checks: "该碎的拍（钩子 / 升级 / 转折 / 高潮 / 尾钩）不能比全片平均慢太多",
    fix: "补反应镜或拆镜，让这一拍更碎",
    source: "storyboard",
  },
  {
    id: "V8",
    docId: "R3",
    name: "预算",
    category: "feasibility",
    priority: "should",
    checks: "整片重做一遍的报价是否超出预算",
    fix: "减少镜头数，或提高预算",
    source: "storyboard",
  },
  {
    id: "V9",
    docId: "F2",
    name: "尾帧能力",
    category: "feasibility",
    priority: "should",
    checks: "画了尾帧但当前视频模型只吃首帧时如实提示",
    fix: "换支持尾帧的模型，或接受尾帧只作参考",
    source: "storyboard",
  },
  {
    id: "V10",
    docId: "F3",
    name: "表演设计",
    category: "feasibility",
    priority: "should",
    checks:
      "有台词的镜头是否写了 objective 与视线；强度 4–5 却写大幅动作、认出意图却没写 avoid 也会点名（I11 / ADR-0220）",
    fix: "补上表演目标与看谁；强度高的镜头改成微动作，并把「不做什么」写进 avoid",
    source: "storyboard",
  },
  {
    id: "V11",
    docId: "R1",
    name: "节拍顺序",
    category: "rhythm",
    priority: "must",
    checks: "全片第一镜要是钩子；同一场里节拍不能倒退",
    fix: "把钩子放到第一镜，或调整场内的节拍顺序",
    source: "storyboard",
  },
  {
    id: "V12",
    docId: "X3",
    name: "立面与遮挡",
    category: "axis",
    priority: "should",
    checks: "有机位坐标时，视线是否被挡住、机位高度与角度档位是否对得上",
    fix: "挪开挡在前面的人或家具，或改机位高度 / 角度",
    source: "storyboard",
  },
  {
    id: "V13",
    docId: "M4",
    name: "手持单场 ≤ 2",
    category: "movement",
    priority: "may",
    checks: "同一场里的手持镜不超过 2 个",
    fix: "把多余的手持改成固定或推拉；手持过量会晕",
    source: "storyboard",
  },
];

/**
 * 文档里有、但还查不了的规则。
 *
 * 如实登记比假装有更重要：作者看界面时要知道哪些是「已经替你查了」，
 * 哪些仍然只能自己看。这一批的阻塞原因分三类：
 * - 要视觉模型（画面里实际发生了什么）；
 * - 要参考片标定（阈值还没有依据）；
 * - 只是审美默认值（工具不该替作者判死）。
 */
export const UNIMPLEMENTED: { docId: string; name: string; reason: string }[] = [
  { docId: "S2", name: "双人对话用 medium / medium-close", reason: "审美默认值，工具不该替作者判死" },
  { docId: "S3", name: "情绪转折用 close", reason: "要判断「这一镜是不是转折」，得读懂剧情" },
  { docId: "S4", name: "信息 / 细节用 insert", reason: "要判断画面里有没有关键信息，需视觉模型" },
  { docId: "S7", name: "特写连续 ≤ 2", reason: "与 V6 重叠，V6 已覆盖更宽的连续同景别" },
  { docId: "S8", name: "场景收尾可用 wide 拉远", reason: "may 级风格选项，默认关闭" },
  { docId: "A1", name: "权力 / 威胁用低机位", reason: "要读懂「谁是威胁」，需剧情理解" },
  { docId: "A2", name: "脆弱 / 被压用高机位", reason: "要判断「谁处于弱势」，需读懂剧情" },
  { docId: "A3", name: "中立对话用 eye-level", reason: "审美默认值" },
  {
    docId: "A4",
    name: "dutch 单场 ≤ 1",
    reason: "IR 的 camera.angle 只有平 / 仰 / 俯 / 顶，没有 dutch —— 要先扩枚举才能查",
  },
  { docId: "A5", name: "对话优先 OTS", reason: "审美默认值" },
  { docId: "A6", name: "POV 需动机，单场 ≤ 1", reason: "「动机」要读懂剧情" },
  { docId: "M1", name: "发现 / 逼近用 push-in", reason: "审美默认值" },
  { docId: "M2", name: "抽离 / 揭示用 pull-out", reason: "审美默认值" },
  { docId: "M3", name: "跟随 / 连接用 track / pan", reason: "审美默认值" },
  { docId: "M5", name: "固定镜头用于控制 / 压迫", reason: "审美默认值" },
  { docId: "X2", name: "越轴必须有过渡镜", reason: "要判断「有没有过渡镜」需读懂镜序意图" },
  { docId: "X4", name: "屏幕方向一致", reason: "要看画面里的移动方向，需视觉模型" },
  { docId: "R4", name: "情绪高点前留呼吸", reason: "要识别情绪高点，需剧情理解" },
  { docId: "R5", name: "结尾留 hook", reason: "已由 A19 钩子设计器在故事页覆盖，不在分镜检查里重复" },
  { docId: "L1", name: "高光比用于冲突", reason: "要测画面实际光比，需视觉模型" },
  { docId: "L2", name: "低光比用于温情", reason: "要测画面实际光比，需视觉模型" },
  { docId: "L3", name: "暖色温用于记忆 / 亲密", reason: "要测画面实际色温，需视觉模型" },
  { docId: "L4", name: "冷色温用于疏离 / 科技", reason: "要测画面实际色温，需视觉模型" },
  { docId: "L5", name: "主光方向决定情绪", reason: "结构化的主光方向跨镜检查已由 B4 落地（ADR-0215）；「情绪对不对」仍需人判断" },
];

/** 某条规则；查不到就是 undefined（不会静默返回第一条） */
export function ruleOf(id: string): DirectorRule | undefined {
  return DIRECTOR_RULES.find((rule) => rule.id === id);
}

/** 按类别分组，界面上按 DIRECTOR-GRAMMAR.md 的章节顺序读 */
export function rulesByCategory(): { category: RuleCategory; label: string; rules: DirectorRule[] }[] {
  const order: RuleCategory[] = [
    "shot-size",
    "angle",
    "movement",
    "axis",
    "rhythm",
    "lighting",
    "feasibility",
  ];
  return order.map((category) => ({
    category,
    label: RULE_CATEGORY_CN[category],
    rules: DIRECTOR_RULES.filter((rule) => rule.category === category),
  }));
}

/** 目录里能自动查的 / 还查不了的条数，给界面一句话说清覆盖率 */
export function grammarCoverage(): { implemented: number; pending: number; total: number } {
  const implemented = DIRECTOR_RULES.length;
  const pending = UNIMPLEMENTED.length;
  return { implemented, pending, total: implemented + pending };
}
