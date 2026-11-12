/**
 * 钩子设计器（A19 / ADR-0160）。
 *
 * 开场钩子只要做一件事：前 3 秒让人不划走。结尾钩子也只要一件事：让人点下一集。
 * 这里不训练模型、不假装懂审美，只用一组可解释的规则给四个维度打分——
 * 好奇、紧迫、可视化、新鲜——并把命中 / 扣分的词写出来，作者能自己判断。
 *
 * 评的是「这一句作为钩子的形状」，不是故事好坏；分数不写 IR、不阻断生成。
 */

export type HookPosition = "opening" | "ending";

export type HookType = {
  id: string;
  name: string;
  note: string;
  /** 填空式写法，给作者一个可改的骨架 */
  pattern: string;
  example: string;
  /** 更适合开场、结尾，还是都行 */
  positions: HookPosition[];
  /** 命中这些词就认为属于这一类 */
  matches: string[];
};

export const HOOK_TYPES: HookType[] = [
  {
    id: "contrast",
    name: "反差",
    note: "身份、处境或预期被一句话翻过来；不解释，先给结果。",
    pattern: "直到 ___，才发现 ___。",
    example: "被叫破身份的下一秒，他先把外卖递了过去。",
    positions: ["opening", "ending"],
    matches: ["直到", "竟然", "反而", "却是", "没想到"],
  },
  {
    id: "mystery",
    name: "悬念",
    note: "抛一个观众想知道答案的问题，但先不给答案。",
    pattern: "___ 不见了，只有 ___ 知道。",
    example: "合租第三个月，她发现室友每晚都擦同一块地板。",
    positions: ["opening", "ending"],
    matches: ["为什么", "谁", "怎么", "秘密", "不知道"],
  },
  {
    id: "danger",
    name: "危机",
    note: "把人物放进一个马上要付出的代价里。",
    pattern: "还有 ___ 分钟，___ 就会 ___。",
    example: "距离发布会开始只剩三分钟，大屏上还挂着那份假数据。",
    positions: ["opening"],
    matches: ["血", "死", "追", "报警", "来不及", "最后"],
  },
  {
    id: "secret",
    name: "秘密",
    note: "让一个具体物件替人物保守秘密。",
    pattern: "___ 里藏着一份 ___。",
    example: "母亲去世后，账本里每个月都有一笔转给陌生人的钱。",
    positions: ["opening", "ending"],
    matches: ["秘密", "日记", "监控", "账本", "录音", "照片"],
  },
  {
    id: "deadline",
    name: "倒计时",
    note: "把「什么时候」说死，压力立刻有了形状。",
    pattern: "距离 ___ 只剩 ___。",
    example: "离婚协议明天生效，今晚他必须把监控交出去。",
    positions: ["opening"],
    matches: ["三分钟", "明天", "最后", "只剩", "倒计时", "今晚"],
  },
  {
    id: "reveal",
    name: "身份揭露",
    note: "让一个称呼或工牌把关系当场改写。",
    pattern: "他/她不是 ___，是 ___。",
    example: "答辩第一页不是 PPT，是三个月的聊天记录。",
    positions: ["opening", "ending"],
    matches: ["少主", "董事长", "原来", "竟是", "身份", "不是"],
  },
  {
    id: "mistake",
    name: "误会",
    note: "让所有人相信一件错的事，观众先看见裂缝。",
    pattern: "所有人都以为 ___，其实 ___。",
    example: "所有人都以为她认错了人，其实她等这一天等了三年。",
    positions: ["opening", "ending"],
    matches: ["以为", "误会", "其实"],
  },
  {
    id: "oddity",
    name: "反常动作",
    note: "给一个每天重复、但说不通的动作。",
    pattern: "每天 ___，直到 ___。",
    example: "凌晨三点，拖把声准时响起，像在擦掉什么。",
    positions: ["opening", "ending"],
    matches: ["每天", "准时", "重复", "一直", "总在"],
  },
];

export type HookScore = {
  /** 0–100 的总分；四个分项按 3 / 2.5 / 2.5 / 2 加权 */
  total: number;
  curiosity: number;
  urgency: number;
  visual: number;
  novelty: number;
  /** 命中的钩子类型名称 */
  types: string[];
  /** 得分 / 扣分的原因，给作者看 */
  notes: string[];
};

const TIME_WORDS = ["现在", "今天", "今晚", "明天", "最后", "三分钟", "倒计时", "只剩", "来不及", "立刻", "马上", "当天"];
const DANGER_WORDS = ["血", "死", "坠", "逃", "追", "报警", "离婚", "开除", "断", "危险", "失踪"];
const CONCRETE_WORDS = [
  "电梯", "门", "手机", "监控", "账本", "日记", "照片", "伞", "血", "雨", "桌", "手",
  "灯", "合同", "工牌", "外卖", "拖把", "大屏", "房产证", "录音", "信", "楼道", "工位",
];
const ABSTRACT_WORDS = ["命运", "内心", "感情", "回忆", "人生", "灵魂", "氛围", "情绪"];
const CLICHES = ["总裁", "重生", "穿越", "系统", "打脸", "车祸", "失忆", "豪门", "契约", "复仇", "霸总"];
const QUESTION_WORDS = ["谁", "为什么", "怎么", "哪", "？", "?", "……", "…", "..."];
const ACTION_WORDS = ["递", "擦", "摔", "推", "跑", "喊", "放", "投", "翻", "签", "捡", "关", "打开", "拨"];

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function hits(text: string, words: string[]): string[] {
  return words.filter((word) => text.includes(word));
}

/** 这一句命中哪些钩子类型（可能不止一类） */
export function hookTypesOf(text: string): HookType[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return HOOK_TYPES.filter((type) => type.matches.some((word) => trimmed.includes(word)));
}

/**
 * 给一句钩子打分。
 *
 * 规则全部可解释：命中时间词加紧迫、命中具体物件加可视化、命中套话扣新鲜；
 * 四个分项各自封顶 0–100，总分按权重合成。空字符串返回全 0。
 */
export function scoreHook(text: string, position: HookPosition = "opening"): HookScore {
  const trimmed = text.trim();
  const notes: string[] = [];
  if (!trimmed) {
    return {
      total: 0,
      curiosity: 0,
      urgency: 0,
      visual: 0,
      novelty: 0,
      types: [],
      notes: ["还没写：开场钩子决定前 3 秒，结尾钩子决定下一集。"],
    };
  }

  let curiosity = 50;
  const questions = hits(trimmed, QUESTION_WORDS);
  if (questions.length > 0) {
    curiosity += 14;
    notes.push(`有未解的问题（${questions.slice(0, 2).join(" / ")}），好奇度加分。`);
  }
  const secretWords = hits(trimmed, ["秘密", "真相", "监控", "账本", "日记", "照片", "录音"]);
  if (secretWords.length > 0) curiosity += 10;
  if (trimmed.length < 8) {
    curiosity -= 16;
    notes.push("太短：不到 8 个字，信息还没立住。");
  }
  if (trimmed.length > 60) {
    curiosity -= 10;
    notes.push("偏长：超过 60 字，前 3 秒读不完。");
  }

  let urgency = 40;
  const times = hits(trimmed, TIME_WORDS);
  if (times.length > 0) {
    urgency += 18;
    notes.push(`有时间压力（${times.slice(0, 2).join(" / ")}），紧迫度加分。`);
  }
  const dangers = hits(trimmed, DANGER_WORDS);
  if (dangers.length > 0) urgency += 16;
  if (position === "ending" && times.length === 0) {
    urgency -= 4;
    notes.push("结尾钩子没有时间压力：下一集的理由会弱一些。");
  }

  let visual = 45;
  const concrete = hits(trimmed, CONCRETE_WORDS);
  if (concrete.length > 0) {
    visual += Math.min(24, concrete.length * 8);
    notes.push(`有具体物件（${concrete.slice(0, 3).join(" / ")}），可视化加分。`);
  } else {
    visual -= 10;
    notes.push("缺少具体物件：AI 不好拍，观众也难在脑里成像。");
  }
  if (hits(trimmed, ACTION_WORDS).length > 0) visual += 10;
  const abstracts = hits(trimmed, ABSTRACT_WORDS);
  if (abstracts.length > 0 && concrete.length === 0) {
    visual -= 10;
    notes.push(`抽象词多（${abstracts.slice(0, 2).join(" / ")}），没有落成画面。`);
  }

  let novelty = 55;
  const cliches = hits(trimmed, CLICHES);
  if (cliches.length > 0) {
    novelty -= Math.min(30, cliches.length * 12);
    notes.push(`有套话（${cliches.join(" / ")}）：换成一个具体动作会更新。`);
  }
  if (/\d|[一二三四五六七八九十百千万两]/.test(trimmed)) {
    novelty += 12;
    notes.push("有具体数字：比「很多 / 很久」更可信。");
  }
  if (/[「」“”"']/.test(trimmed)) novelty += 8;
  if (trimmed.length > 12 && trimmed.length <= 40) novelty += 4;

  const total = clamp(curiosity * 0.3 + urgency * 0.25 + visual * 0.25 + novelty * 0.2);
  const types = hookTypesOf(trimmed).map((type) => type.name);
  if (types.length === 0) notes.push("没有命中固定类型：不是坏事，但作者要自己确认它抓不抓人。");
  else notes.push(`类型：${types.join(" / ")}。`);

  return {
    total,
    curiosity: clamp(curiosity),
    urgency: clamp(urgency),
    visual: clamp(visual),
    novelty: clamp(novelty),
    types,
    notes,
  };
}

/** 钩子类型的落点：开场 / 结尾 */
export function hookTypesFor(position: HookPosition): HookType[] {
  return HOOK_TYPES.filter((type) => type.positions.includes(position));
}
