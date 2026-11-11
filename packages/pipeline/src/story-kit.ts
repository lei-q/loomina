import type { BeatKind } from "@loomina/ir";

/**
 * 前提 / logline / 节拍表（A14 / A15 / A17，ADR-0104）。
 *
 * 三件事都只是**策划工具**，不进 IR、不写事件：
 * - 题材矩阵给出受众、生成可行性、竞争与首发优先级（STORY.md §三）；
 * - logline 评分是本地启发式（词法与结构），不是模型判断，分数与理由都摆在台面上；
 * - 节拍表是时间窗 + 任务，能按当前草稿时长换算，也作为一次生成的结构提示。
 */

// ---------------------------------------------------------------- 题材矩阵

export type GenrePriority = "P0" | "P1" | "P2" | "P3";
export type GenreLevel = "大" | "中" | "小";

export interface GenreProfile {
  id: string;
  name: string;
  /** 旧界面用过的叫法，继续能被识别 */
  aliases: string[];
  audience: GenreLevel;
  feasibility: "高" | "中高" | "中" | "低";
  competition: "高" | "中" | "低";
  priority: GenrePriority;
  advice: string;
  /** 用于受众匹配打分与提示词的关键词 */
  tags: string[];
}

export const GENRE_MATRIX: GenreProfile[] = [
  {
    id: "urban-romance",
    name: "都市情感",
    aliases: ["都市", "情感"],
    audience: "大",
    feasibility: "高",
    competition: "高",
    priority: "P0",
    advice: "室内、少人、对话驱动，正好落在模型强项上。",
    tags: ["都市", "情感", "婚姻", "恋爱", "前任", "相亲", "同居", "分手"],
  },
  {
    id: "comeback",
    name: "逆袭打脸",
    aliases: ["都市逆袭", "逆袭"],
    audience: "大",
    feasibility: "高",
    competition: "高",
    priority: "P0",
    advice: "身份反差靠一句台词就能立住；注意别让群演与动作戏超出模型能力。",
    tags: ["逆袭", "打脸", "外卖", "保洁", "董事长", "豪门", "底层", "身份", "少主"],
  },
  {
    id: "sweet-ceo",
    name: "甜宠霸总",
    aliases: ["甜宠", "霸总"],
    audience: "大",
    feasibility: "高",
    competition: "高",
    priority: "P0",
    advice: "两人空间 + 强关系，最省场景；甜点要落在具体动作上。",
    tags: ["甜宠", "霸总", "总裁", "契约", "结婚", "宠", "豪门", "未婚妻", "联姻"],
  },
  {
    id: "family",
    name: "家庭伦理",
    aliases: ["家庭", "伦理"],
    audience: "大",
    feasibility: "高",
    competition: "中",
    priority: "P1",
    advice: "餐桌与客厅就能演完；代际冲突要具体到一件物或一句话。",
    tags: ["家庭", "婆婆", "丈夫", "妻子", "孩子", "离婚", "亲情", "继母", "岳母"],
  },
  {
    id: "revenge-mystery",
    name: "悬疑复仇",
    aliases: ["悬疑", "复仇"],
    audience: "中",
    feasibility: "中高",
    competition: "中",
    priority: "P1",
    advice: "线索要可视化；追逐与打斗先避开，用物件与对话推进。",
    tags: ["悬疑", "复仇", "真相", "凶手", "证据", "警察", "失踪", "监控", "日记"],
  },
  {
    id: "rebirth",
    name: "重生穿越",
    aliases: ["重生", "穿越"],
    audience: "中",
    feasibility: "中",
    competition: "中",
    priority: "P1",
    advice: "前世今生靠妆造与台词区分；穿越设定别依赖大场面。",
    tags: ["重生", "穿越", "前世", "回到", "命运", "重来", "记忆"],
  },
  {
    id: "campus",
    name: "校园青春",
    aliases: ["校园", "青春"],
    audience: "中",
    feasibility: "高",
    competition: "中",
    priority: "P1",
    advice: "教室与操场就够；校服与年龄感要一次锁定。",
    tags: ["校园", "高中", "大学", "同桌", "青春", "老师", "学生", "校服", "毕业"],
  },
  {
    id: "workplace",
    name: "职场",
    aliases: ["职场"],
    audience: "中",
    feasibility: "高",
    competition: "中",
    priority: "P1",
    advice: "办公室是天然舞台；权力关系要靠座位、称呼与文件。",
    tags: ["职场", "公司", "老板", "同事", "升职", "项目", "裁员", "秘书", "会议"],
  },
  {
    id: "palace",
    name: "古装宫斗",
    aliases: ["古装", "宫斗"],
    audience: "中",
    feasibility: "低",
    competition: "高",
    priority: "P2",
    advice: "服化道、群演与建筑都吃模型一致性，首发先不做。",
    tags: ["古装", "宫廷", "皇上", "妃", "宫", "娘娘", "朝代", "太后"],
  },
  {
    id: "war-god",
    name: "战神赘婿",
    aliases: ["战神", "赘婿"],
    audience: "大",
    feasibility: "中",
    competition: "高",
    priority: "P2",
    advice: "动作与群演多；如果要做，先把冲突收进室内对话。",
    tags: ["战神", "赘婿", "上门", "兵王", "将军", "岳母", "豪门", "退伍"],
  },
  {
    id: "kiddie",
    name: "萌宝亲子",
    aliases: ["萌宝", "亲子"],
    audience: "中",
    feasibility: "低",
    competition: "中",
    priority: "P2",
    advice: "儿童跨镜一致性风险高；用背影、手与画外音减压。",
    tags: ["萌宝", "孩子", "亲子", "妈妈", "爸爸", "幼儿园", "宝宝", "女儿", "儿子"],
  },
  {
    id: "rural",
    name: "乡村年代",
    aliases: ["乡村", "年代"],
    audience: "中",
    feasibility: "中",
    competition: "低",
    priority: "P3",
    advice: "竞争小但场景与年代感成本高，放到后面。",
    tags: ["乡村", "年代", "村", "知青", "公社", "土地", "炕", "生产队"],
  },
];

const GENRE_BY_ALIAS = new Map<string, GenreProfile>();
for (const profile of GENRE_MATRIX) {
  GENRE_BY_ALIAS.set(profile.id, profile);
  GENRE_BY_ALIAS.set(profile.name, profile);
  for (const alias of profile.aliases) GENRE_BY_ALIAS.set(alias, profile);
}

export function genreById(idOrName: string | undefined): GenreProfile | undefined {
  if (!idOrName) return undefined;
  const key = idOrName.trim();
  return GENRE_BY_ALIAS.get(key);
}

export type GenreReadiness = {
  level: "推荐" | "可做" | "慎重" | "暂缓";
  tone: "ok" | "warn";
  reason: string;
};

export function genreReadiness(profile: GenreProfile): GenreReadiness {
  const base = `受众 ${profile.audience} · 可行性 ${profile.feasibility} · 竞争 ${profile.competition}`;
  if (profile.priority === "P0") {
    return { level: "推荐", tone: "ok", reason: `${base}。${profile.advice}` };
  }
  if (profile.priority === "P1") {
    return { level: "可做", tone: "ok", reason: `${base}。${profile.advice}` };
  }
  if (profile.priority === "P2") {
    return { level: "慎重", tone: "warn", reason: `${base}。${profile.advice}` };
  }
  return { level: "暂缓", tone: "warn", reason: `${base}。${profile.advice}` };
}

// ---------------------------------------------------------------- logline 评分

export interface LoglineDimension {
  key: "highConcept" | "conflict" | "stake" | "contrast" | "visual" | "audience";
  label: string;
  question: string;
}

export const LOGLINE_DIMENSIONS: LoglineDimension[] = [
  { key: "highConcept", label: "高概念", question: "一句话能听懂吗？" },
  { key: "conflict", label: "冲突", question: "谁想要什么？谁阻挡？" },
  { key: "stake", label: "代价", question: "失败会失去什么？" },
  { key: "contrast", label: "反差", question: "有没有新鲜感 / 意外组合？" },
  { key: "visual", label: "可视化", question: "能拍出来吗？" },
  { key: "audience", label: "受众匹配", question: "目标观众会在意吗？" },
];

export const LOGLINE_PASS = 18;
export const LOGLINE_STRONG = 24;
export const LOGLINE_MAX_CANDIDATES = 10;

export type LoglineVerdict = "淘汰" | "保留" | "优先";

export interface LoglineDimensionScore extends LoglineDimension {
  score: number;
  reason: string;
}

export interface LoglineScore {
  text: string;
  total: number;
  verdict: LoglineVerdict;
  dims: LoglineDimensionScore[];
  /** 低于 3 分的维度，按分数从低到高 */
  weak: LoglineDimensionScore[];
}

const DESIRE = /(想要|想|要|必须|偏要|非要|唯一|只求|求|查|找|夺|抢|救|护|替|嫁|娶|追|赢|证明)/;
const OBSTACLE = /(却|但|可是|然而|直到|除非|挡|拦|抢|夺|反对|不肯|拒绝|消失|失踪|误会|对立|撕|闹|不许|不让)/;
const STAKE = /(失去|丢|毁|死|丧命|破产|身败名裂|净身出户|封杀|来不及|再也|永远|最后一|错过|无家可归|活不过|保不住)/;
const CONTRAST = /(竟是|竟然是|原来|其实|直到|没想到|反而|居然|一夜|突然|真实身份|假装|冒充|竟然)/;
const ROLE = /(身份|豪门|底层|董事长|总裁|老板|保洁|外卖|保姆|继母|前夫|前妻|弟弟|哥哥|姐姐|妹妹|岳母|婆婆|上司|下属|少主|赘婿)/g;
const ABSTRACT = /(觉得|感到|心情|内心|意识到|回忆|明白|感慨|思绪|痛苦地|幸福地|无法接受)/;
const CONCRETE = /(门|窗|电梯|桌|沙发|伞|镯|戒指|手机|合同|病历|照片|钥匙|外卖|餐|车|楼道|办公室|病房|学校|婚礼|机场|车站|电梯|镜子|杯子)/;

function clampScore(value: number): number {
  return Math.max(1, Math.min(5, Math.round(value)));
}

function formatScore(score: number, reason: string): { score: number; reason: string } {
  return { score, reason };
}

/**
 * 六维启发式打分（1–5）。分数是词法与结构的估计，不是模型评审：
 * 只用来把明显说不清的候选先筛掉，最终仍由人拍板。
 */
export function scoreLogline(text: string, genre?: GenreProfile): LoglineScore {
  const raw = text.trim();
  const length = [...raw].length;
  const sentences = raw.split(/[。！？!?]/).filter((part) => part.trim().length > 0);

  const dims: LoglineDimensionScore[] = [];

  // 高概念：短、一句话、有具体主语
  let high = 3;
  if (length === 0) high = 1;
  else if (length <= 40) high += 1;
  else if (length > 60) high -= 1;
  if (sentences.length <= 1 && length > 0) high += 1;
  else if (sentences.length > 3) high -= 1;
  dims.push({
    ...LOGLINE_DIMENSIONS[0]!,
    ...formatScore(
      clampScore(high),
      length === 0
        ? "还没有写 logline。"
        : length > 60
          ? `${length} 字太长了：一句话要能被复述，先压到 40 字以内。`
          : sentences.length > 3
            ? "分了太多句：选一个主句，其余降成从句或删掉。"
            : length <= 40
              ? `一句话 ${length} 字，长度合格。`
              : `${length} 字略长，试着删掉解释性的半句。`,
    ),
  });

  // 冲突：欲望 + 阻挡
  const hasDesire = DESIRE.test(raw);
  const hasObstacle = OBSTACLE.test(raw);
  let conflict = 2;
  if (hasDesire) conflict += 1;
  if (hasObstacle) conflict += 2;
  dims.push({
    ...LOGLINE_DIMENSIONS[1]!,
    ...formatScore(
      clampScore(conflict),
      !hasDesire && !hasObstacle
        ? "看不到谁想要什么、谁在阻挡：补一个主角和一个对立面。"
        : !hasObstacle
          ? "有欲望，但没有阻挡：加上「却 / 直到 / 不肯」这类转折。"
          : !hasDesire
            ? "有阻挡，但没说主角要什么：把目标写成具体动作。"
            : "欲望与阻挡都在，冲突成立。",
    ),
  });

  // 代价：失败会失去什么
  const hasStake = STAKE.test(raw);
  let stake = 2;
  if (hasStake) stake += 2;
  if (hasStake && (hasDesire || hasObstacle)) stake += 1;
  dims.push({
    ...LOGLINE_DIMENSIONS[2]!,
    ...formatScore(
      clampScore(stake),
      hasStake
        ? "写出了会失去的东西，代价具体。"
        : "没有代价：补一句失败会失去什么（婚姻、工作、清白、孩子）。",
    ),
  });

  // 反差：意外组合
  const hasContrast = CONTRAST.test(raw);
  const roles = raw.match(ROLE);
  const distinctRoles = new Set(roles ?? []).size;
  let contrast = 2;
  if (hasContrast) contrast += 1;
  if (distinctRoles >= 1) contrast += 1;
  if (distinctRoles >= 2) contrast += 1;
  dims.push({
    ...LOGLINE_DIMENSIONS[3]!,
    ...formatScore(
      clampScore(contrast),
      hasContrast && distinctRoles >= 2
        ? "有身份反差与意外转折，够新鲜。"
        : distinctRoles >= 2
          ? "两个身份都在，但缺一个「原来 / 其实 / 直到」的翻转。"
          : "反差弱：把两个不该同框的身份放在一句话里。",
    ),
  });

  // 可视化：具体物件与动作，少抽象词
  const hasAbstract = ABSTRACT.test(raw);
  const hasConcrete = CONCRETE.test(raw);
  let visual = 3;
  if (hasConcrete) visual += 2;
  if (hasAbstract) visual -= 2;
  if (length > 60) visual -= 1;
  dims.push({
    ...LOGLINE_DIMENSIONS[4]!,
    ...formatScore(
      clampScore(visual),
      hasAbstract
        ? "有内心描写：改成动作、物件或一句台词。"
        : hasConcrete
          ? "有可拍的物件或地点，能进分镜。"
          : "缺具体场景或物件：给一个能拍到的动作。",
    ),
  });

  // 受众匹配：题材关键词
  let audience = 3;
  let audienceReason = "没有选题材：受众匹配只能按通用短剧判断。";
  if (genre) {
    const hits = genre.tags.filter((tag) => raw.includes(tag));
    audience = hits.length > 0 ? 5 : 3;
    audienceReason =
      hits.length > 0
        ? `命中「${genre.name}」的关键词：${hits.slice(0, 3).join("、")}。`
        : `没命中「${genre.name}」的关键词：确认目标观众能在这一句里认出题材。`;
  }
  dims.push({ ...LOGLINE_DIMENSIONS[5]!, ...formatScore(audience, audienceReason) });

  const total = dims.reduce((sum, dim) => sum + dim.score, 0);
  const verdict: LoglineVerdict =
    total < LOGLINE_PASS ? "淘汰" : total >= LOGLINE_STRONG ? "优先" : "保留";
  const weak = dims.filter((dim) => dim.score < 3).sort((a, b) => a.score - b.score);

  return { text: raw, total, verdict, dims, weak };
}

/** 一行一个候选；空行与超过 10 条的尾巴直接丢掉。 */
export function parseLoglineCandidates(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, LOGLINE_MAX_CANDIDATES);
}

export function scoreLoglines(raw: string, genre?: GenreProfile): LoglineScore[] {
  return parseLoglineCandidates(raw).map((line) => scoreLogline(line, genre));
}

// ---------------------------------------------------------------- 节拍表

export type BeatSheetId = "60s" | "3min" | "series";

export interface BeatSheetBeat {
  beat: BeatKind;
  /** 表中的名字：hook / 升级一 / 中反转 … */
  label: string;
  task: string;
  startSec: number;
  endSec: number;
}

export interface BeatSheet {
  id: BeatSheetId;
  name: string;
  /** 这套时间窗对应的总时长；系列模板按单集 60 秒算 */
  nominalSeconds: number;
  note: string;
  beats: BeatSheetBeat[];
}

export const BEAT_SHEETS: BeatSheet[] = [
  {
    id: "60s",
    name: "60 秒单集",
    nominalSeconds: 60,
    note: "最常用：一秒都不浪费，前 3 秒必须给冲突或反差，最后一拍留新钩。",
    beats: [
      { beat: "hook", label: "hook", task: "冲突 / 悬念 / 反差，抓住注意力", startSec: 0, endSec: 3 },
      { beat: "setup", label: "setup", task: "人物、关系、目标", startSec: 3, endSec: 10 },
      { beat: "escalation", label: "escalation", task: "障碍出现，压力上升", startSec: 10, endSec: 25 },
      { beat: "turn", label: "turn", task: "反转 / 认知变化", startSec: 25, endSec: 40 },
      { beat: "climax", label: "climax", task: "情绪 / 爽点兑现", startSec: 40, endSec: 55 },
      { beat: "endHook", label: "endHook", task: "新悬念，留钩", startSec: 55, endSec: 60 },
    ],
  },
  {
    id: "3min",
    name: "3 分钟单集",
    nominalSeconds: 180,
    note: "两段升级：第一次是外部压力，第二次是关系或立场变化；当前生成仍按 60–90 秒单集，这套表用于拆更长版本。",
    beats: [
      { beat: "hook", label: "hook", task: "先给结果或反差点，不解释", startSec: 0, endSec: 8 },
      { beat: "setup", label: "setup", task: "人物、关系、目标与赌注", startSec: 8, endSec: 25 },
      { beat: "escalation", label: "升级一", task: "外部障碍出现，压力上升", startSec: 25, endSec: 55 },
      { beat: "escalation", label: "升级二", task: "关系或立场变化，退路被切断", startSec: 55, endSec: 95 },
      { beat: "turn", label: "turn", task: "反转 / 认知变化", startSec: 95, endSec: 125 },
      { beat: "climax", label: "climax", task: "情绪 / 爽点兑现", startSec: 125, endSec: 155 },
      { beat: "resolution", label: "resolution", task: "代价落地，关系重新定义", startSec: 155, endSec: 170 },
      { beat: "endHook", label: "endHook", task: "新悬念，留钩", startSec: 170, endSec: 180 },
    ],
  },
  {
    id: "series",
    name: "系列（每集 60 秒）",
    nominalSeconds: 60,
    note: "每集一个小闭环 + 一个大钩子；前 10 集决定留存，每 3–5 集一个中反转。",
    beats: [
      { beat: "hook", label: "这一集的钩子", task: "承接上一集悬念，给出本集问题", startSec: 0, endSec: 6 },
      { beat: "escalation", label: "小闭环", task: "本集冲突推进，主角做出选择", startSec: 6, endSec: 24 },
      { beat: "turn", label: "中反转", task: "每 3–5 集一次：改变观众对角色的判断", startSec: 24, endSec: 36 },
      { beat: "climax", label: "爽点", task: "本集情绪兑现，关系或处境改变", startSec: 36, endSec: 50 },
      { beat: "endHook", label: "大钩子", task: "把问题抛到下一集，留一个未完成的动作", startSec: 50, endSec: 60 },
    ],
  },
];

export function beatSheetById(id: string | undefined): BeatSheet | undefined {
  if (!id) return undefined;
  return BEAT_SHEETS.find((sheet) => sheet.id === id);
}

export interface BeatWindow extends BeatSheetBeat {
  startMs: number;
  endMs: number;
}

/** 按实际时长等比换算每拍的时间窗；总时长缺失时按表里的名义时长。 */
export function beatWindows(sheet: BeatSheet, totalMs?: number): BeatWindow[] {
  const total = totalMs && totalMs > 0 ? totalMs : sheet.nominalSeconds * 1000;
  const scale = total / (sheet.nominalSeconds * 1000);
  return sheet.beats.map((beat) => ({
    ...beat,
    startMs: Math.round(beat.startSec * 1000 * scale),
    endMs: Math.round(beat.endSec * 1000 * scale),
  }));
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  return `${Math.round(seconds * 10) / 10}s`;
}

/** 给生成提示词用的一行一款结构。 */
export function beatSheetPrompt(sheet: BeatSheet): string {
  const windows = sheet.beats
    .map((beat) => `${beat.label} ${beat.startSec}–${beat.endSec}s：${beat.task}`)
    .join("；");
  return `结构参考「${sheet.name}」：${windows}。各镜的 beat 按这套时间窗安排；当前仍按 60–90 秒、10–14 镜生成。`;
}
