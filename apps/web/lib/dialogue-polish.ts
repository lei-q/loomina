/**
 * 台词压缩与金句（A20 / ADR-0163）。
 *
 * 短剧的台词只有两个任务：把信息压到最短，把该响的那一句留到最后。
 * 这里不调模型、不猜剧情，只用一组可解释的规则回答三件事：
 *
 * 1. 这一句是不是太长（> 15 字）、有没有一镜塞了两句以上；
 * 2. 能删什么——填充词、解释性的从句、前面铺垫的那半句；
 * 3. 这一句像不像金句（短、有拒绝 / 反转的词、没有废话）。
 *
 * 建议文本只用于「用这版」那一刻；不自动改写、不写 IR。
 */

/** 单句上限：超过就该压（STORY.md / A20） */
export const MAX_LINE_CHARS = 15;
/** 一镜最多几句台词：超过就该拆或删 */
export const MAX_LINES_PER_SHOT = 2;
/** 金句候选的分数线 */
export const PUNCH_LINE = 70;

/** 可以直接删掉、不改变意思的填充词 */
const FILLERS = [
  "其实",
  "我觉得",
  "我认为",
  "你知道",
  "你知道吗",
  "就是说",
  "然后",
  "那个",
  "我想说",
  "说实话",
  "老实说",
  "真的",
  "非常",
  "十分",
  "有点儿",
  "有点",
  "大概",
  "可能",
  "应该",
  "反正",
];

/** 解释性的引导词：出现时，后面的从句往往可以整段删 */
const EXPLAIN_LEADS = ["因为", "所以", "如果", "虽然", "但是", "不过", "而且", "并且", "于是", "结果"];

/** 拒绝 / 反转 / 揭穿类词：金句最常见的落点 */
const PUNCH_WORDS = [
  "凭什么",
  "不可能",
  "滚",
  "闭嘴",
  "我不",
  "谁",
  "真相",
  "假的",
  "骗",
  "签字",
  "监控",
  "账本",
  "离婚",
  "开除",
  "报警",
  "还你",
  "换我",
  "现在",
];

/** 具体物件：有物件的短句比抽象短句更像金句 */
const CONCRETE_WORDS = [
  "门", "手", "灯", "雨", "伞", "合同", "账本", "监控", "照片", "手机",
  "刀", "血", "钱", "钥匙", "信", "酒", "药", "车", "电梯", "楼",
];

export type PolishIssue = "long" | "explained" | "filled" | "crowded";

export const POLISH_ISSUE_LABEL: Record<PolishIssue, string> = {
  long: "太长",
  explained: "在解释",
  filled: "有废话",
  crowded: "一镜两句以上",
};

export type LinePolish = {
  lineId: string;
  shotId: string;
  /** 全片镜号 */
  shotNo: number;
  speaker: string;
  text: string;
  chars: number;
  issues: PolishIssue[];
  /** 压缩后的建议；给不出具体文本时为 undefined，只给方向 */
  suggestion?: string;
  /** 为什么这么压，作者看得懂 */
  reason: string;
  /** 金句分 0–100；不是金句也照实给分，不做「是不是好台词」的判断 */
  punch: number;
  punchNotes: string[];
};

export type PolishShot = {
  shotId: string;
  shotNo: number;
  /** 这一镜的台词条数 */
  lines: number;
  issue?: "crowded";
};

export type PolishReport = {
  lines: LinePolish[];
  /** 需要改的句子（长 / 解释 / 废话），按镜号排 */
  problems: LinePolish[];
  /** 金句候选，分高的在前 */
  punches: LinePolish[];
  shots: PolishShot[];
  /** 全片平均字数 */
  averageChars: number;
  totalLines: number;
  /** 压完能省下多少字（只算给出了具体建议的句子） */
  savedChars: number;
};

export type PolishLineInput = {
  lineId: string;
  shotId: string;
  shotNo: number;
  speaker: string;
  text: string;
};

function charsOf(text: string): number {
  return [...text].length;
}

function hits(text: string, words: string[]): string[] {
  return words.filter((word) => text.includes(word));
}

/** 去掉填充词；同时收掉因此留下的空标点与重复逗号 */
function stripFillers(text: string): string {
  let next = text;
  for (const filler of FILLERS) next = next.split(filler).join("");
  return next
    .replace(/[，,、]{2,}/g, "，")
    .replace(/^[，,、。！？!?\s]+/, "")
    .replace(/[，,、]+([。！？!?])/g, "$1")
    .trim();
}

/**
 * 压一句台词。
 *
 * 只做「删」不做「写」：删填充词 → 删解释性从句 → 留最后半句。
 * 三步都压不到 15 字以内时不给文本，只给方向——硬截断会毁掉原意。
 */
export function compressLine(text: string): { text?: string; reason: string } {
  const original = charsOf(text);
  if (original <= MAX_LINE_CHARS) {
    return { reason: "已经在 15 字以内，不用压。" };
  }

  const filled = stripFillers(text);
  if (charsOf(filled) < original && charsOf(filled) >= 2) {
    if (charsOf(filled) <= MAX_LINE_CHARS) {
      return { text: filled, reason: `删掉填充词，${original} → ${charsOf(filled)} 字。` };
    }
  }

  const body = charsOf(filled) >= 2 ? filled : text;
  const leads = hits(body, EXPLAIN_LEADS);
  if (leads.length > 0) {
    // 从句通常在前半句：去掉含引导词的那一段，留主句
    const parts = body.split(/[，,。；;]/).map((part) => part.trim()).filter(Boolean);
    const kept = parts.filter((part) => !hits(part, EXPLAIN_LEADS).length);
    if (kept.length > 0 && kept.length < parts.length) {
      const joined = kept.join("，");
      if (charsOf(joined) >= 2 && charsOf(joined) < charsOf(body)) {
        return {
          text: joined,
          reason: `删掉「${leads.join("、")}」带出的解释，${original} → ${charsOf(joined)} 字。`,
        };
      }
    }
  }

  // 还有逗号就留最后半句：短剧的响点通常在句尾
  const parts = body.split(/[，,]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    const last = parts.at(-1)!;
    if (charsOf(last) >= 2 && charsOf(last) <= MAX_LINE_CHARS) {
      return {
        text: last,
        reason: `只留最后半句（响点通常在句尾），${original} → ${charsOf(last)} 字。`,
      };
    }
  }

  return {
    reason: `还是 ${charsOf(body)} 字：整句拆成两句，或把说明改成动作。工具不替你硬截断。`,
  };
}

/**
 * 金句分：短、有落点词、没有废话。
 *
 * 分数只回答「这一句像不像一句能被记住的短台词」，不回答它写得好不好。
 */
export function punchScore(text: string): { score: number; notes: string[] } {
  const trimmed = text.trim();
  const notes: string[] = [];
  const chars = charsOf(trimmed);
  if (!trimmed) return { score: 0, notes: ["还没有台词。"] };

  let score = 40;
  if (chars <= 8) {
    score += 20;
    notes.push(`只有 ${chars} 字，短。`);
  } else if (chars <= 12) {
    score += 12;
    notes.push(`${chars} 字，还算短。`);
  } else if (chars <= 16) {
    score += 4;
  } else {
    score -= 15;
    notes.push(`${chars} 字，偏长：金句通常一口气说完。`);
  }

  const punches = hits(trimmed, PUNCH_WORDS);
  if (punches.length > 0) {
    score += 12;
    notes.push(`有落点词（${punches.slice(0, 3).join(" / ")}）。`);
  }

  if (/[。！!]$/.test(trimmed)) score += 10;
  if (hits(trimmed, CONCRETE_WORDS).length > 0) {
    score += 8;
    notes.push("有具体物件，画面能落地。");
  }

  const fillers = hits(trimmed, FILLERS);
  if (fillers.length > 0) {
    score -= Math.min(24, fillers.length * 8);
    notes.push(`有填充词（${fillers.slice(0, 3).join(" / ")}），先删。`);
  } else {
    score += 8;
    notes.push("没有填充词。");
  }

  if (/[「」“”"']/.test(trimmed)) score += 4;

  return { score: Math.max(0, Math.min(100, Math.round(score))), notes };
}

/** 把整份剧本的台词过一遍，返回逐句结论与汇总 */
export function polishDialogue(input: PolishLineInput[]): PolishReport {
  const perShot = new Map<string, number>();
  for (const line of input) perShot.set(line.shotId, (perShot.get(line.shotId) ?? 0) + 1);

  const lines: LinePolish[] = input.map((line) => {
    const chars = charsOf(line.text);
    const issues: PolishIssue[] = [];
    if (chars > MAX_LINE_CHARS) issues.push("long");
    if (hits(line.text, EXPLAIN_LEADS).length > 0) issues.push("explained");
    if (hits(line.text, FILLERS).length > 0) issues.push("filled");
    if ((perShot.get(line.shotId) ?? 0) > MAX_LINES_PER_SHOT) issues.push("crowded");

    const compressed = compressLine(line.text);
    const punch = punchScore(line.text);
    return {
      lineId: line.lineId,
      shotId: line.shotId,
      shotNo: line.shotNo,
      speaker: line.speaker,
      text: line.text,
      chars,
      issues,
      ...(compressed.text ? { suggestion: compressed.text } : {}),
      reason: compressed.reason,
      punch: punch.score,
      punchNotes: punch.notes,
    };
  });

  const problems = lines.filter(
    (line) =>
      line.issues.includes("long") ||
      line.issues.includes("explained") ||
      line.issues.includes("filled"),
  );
  const punches = lines
    .filter((line) => line.punch >= PUNCH_LINE)
    .sort((a, b) => b.punch - a.punch);
  const shots: PolishShot[] = [...perShot.entries()]
    .map(([shotId, count]) => {
      const shotNo = lines.find((line) => line.shotId === shotId)?.shotNo ?? 0;
      return {
        shotId,
        shotNo,
        lines: count,
        ...(count > MAX_LINES_PER_SHOT ? { issue: "crowded" as const } : {}),
      };
    })
    .sort((a, b) => a.shotNo - b.shotNo);

  const totalChars = lines.reduce((sum, line) => sum + line.chars, 0);
  const savedChars = lines.reduce(
    (sum, line) => sum + (line.suggestion ? line.chars - charsOf(line.suggestion) : 0),
    0,
  );

  return {
    lines,
    problems,
    punches,
    shots,
    averageChars: lines.length > 0 ? totalChars / lines.length : 0,
    totalLines: lines.length,
    savedChars,
  };
}
