// 中文字幕断句（D2，ADR-0087）
//
// 字幕不是把一句台词原样铺在屏幕上：竖屏一行放不下太多字，
// 断在词中间比不断句还难读。这里做两件事：
//   1. 整理标点（全角化、去多余空格、折叠重复标点）；
//   2. 按语义停顿断句，再按可见字数分配这一段的时间。
//
// 断句是确定性的、离线的：不需要模型，预览、SRT 与导出用同一份结果。

/** 一个显示单元：文字 + 这一句在整条片子里的绝对时间 */
export type SubtitleCue = {
  text: string;
  startMs: number;
  durationMs: number;
};

const TERMINAL = "。！？!?";
const SOFT = "，,、；;：:";
const OPEN = "《“「『（【〈(";
const CLOSE = "》”」』）】〉)";

/** 字幕里不计入时长的字符：标点与空白不占阅读时间 */
function visibleLength(text: string): number {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").length;
}

/**
 * 标点整理：中文台词里常见的半角标点、字间空格、重复标点。
 * 只做确定能做的；不替用户改词。
 */
export function normalizeSubtitleText(text: string): string {
  let next = text.replace(/　/g, " ").replace(/[ \t]+/g, " ").trim();
  const hasCjk = /[㐀-鿿]/.test(next);
  if (hasCjk) {
    next = next
      .replace(/(?<=[㐀-鿿])\s+(?=[㐀-鿿])/g, "")
      .replace(/,/g, "，")
      .replace(/\?/g, "？")
      .replace(/!/g, "！")
      .replace(/;/g, "；")
      .replace(/:/g, "：")
      .replace(/\.{3,}/g, "……");
    // 空格不该停在实义标点两边
    next = next
      .replace(/\s+([，。！？；：、])/g, "$1")
      .replace(/([，。！？；：、])\s+/g, "$1");
  }
  // 重复的实义标点折叠成一个（…… 保留为两个省略号字符）
  next = next.replace(/([，。！？；：])\1+/g, "$1");
  return next.trim();
}

/** 按标点切出小句；引号 / 括号里面不切 */
function clausesOf(text: string): string[] {
  const clauses: string[] = [];
  let buffer = "";
  let depth = 0;

  const takeClosing = (index: number) => {
    while (index + 1 < text.length && CLOSE.includes(text[index + 1]!)) {
      buffer += text[index + 1]!;
      index += 1;
    }
    return index;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (OPEN.includes(char)) depth += 1;
    buffer += char;
    if (CLOSE.includes(char)) depth = Math.max(0, depth - 1);

    const isEllipsis = char === "…";
    if (isEllipsis) {
      while (index + 1 < text.length && text[index + 1] === "…") {
        buffer += text[index + 1]!;
        index += 1;
      }
    }

    const boundary = TERMINAL.includes(char) || SOFT.includes(char) || isEllipsis;
    if (boundary && depth === 0) {
      index = takeClosing(index);
      clauses.push(buffer);
      buffer = "";
    }
  }
  if (buffer.trim()) clauses.push(buffer);
  return clauses.map((clause) => clause.trim()).filter(Boolean);
}

/** 这一截文字里还有几层没闭合的引号 / 括号 */
function openDepth(text: string): number {
  let depth = 0;
  for (const char of text) {
    if (OPEN.includes(char)) depth += 1;
    else if (CLOSE.includes(char)) depth = Math.max(0, depth - 1);
  }
  return depth;
}

/** 超长小句按字数硬切；优先在空格处切 */
function hardSplit(clause: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = clause;
  while (visibleLength(rest) > maxChars) {
    let cut = 0;
    let visible = 0;
    for (const char of rest) {
      visible += /[\s\p{P}\p{S}]/u.test(char) ? 0 : 1;
      cut += char.length;
      if (visible >= maxChars) break;
    }
    // 不把切点留在空格 / 标点前
    while (cut > 0 && /[\s\p{P}]/u.test(rest[cut - 1]!)) cut -= 1;
    // 硬切也先找找有没有停顿：切在「，」后面比切在词中间好读
    const head = rest.slice(0, cut);
    const lastBreak = Math.max(
      head.lastIndexOf("，"),
      head.lastIndexOf("、"),
      head.lastIndexOf("；"),
      head.lastIndexOf("："),
      head.lastIndexOf("。"),
      head.lastIndexOf("！"),
      head.lastIndexOf("？"),
      head.lastIndexOf("…"),
    );
    if (lastBreak > 0 && visibleLength(head.slice(0, lastBreak + 1)) >= 3) {
      cut = lastBreak + 1;
    }
    if (cut <= 0) cut = Math.max(1, Math.min(maxChars, rest.length));

    // 别把一句引语劈成两半：还在引号里就跟着走到收尾
    if (openDepth(rest.slice(0, cut)) > 0) {
      for (let index = cut; index < rest.length; index += 1) {
        if (CLOSE.includes(rest[index]!)) {
          cut = index + 1;
          break;
        }
      }
    }

    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

/**
 * 断句：先按标点切小句，再贪心合并到每行不超过 `maxChars` 个可见字。
 * 太小的尾句并回上一句，避免屏幕上闪一下就没了。
 */
export function splitSubtitleText(text: string, maxChars = 16): string[] {
  const limit = Math.max(6, Math.round(maxChars));
  const clauses = clausesOf(normalizeSubtitleText(text)).flatMap((clause) =>
    visibleLength(clause) > limit ? hardSplit(clause, limit) : [clause],
  );

  const chunks: string[] = [];
  for (const clause of clauses) {
    const last = chunks.at(-1);
    if (last && visibleLength(last + clause) <= limit) {
      chunks[chunks.length - 1] = last + clause;
    } else {
      chunks.push(clause);
    }
  }

  // 收尾的小碎片（"好。"）并回上一句，前提是上一句还装得下
  for (let index = chunks.length - 1; index > 0; index -= 1) {
    if (visibleLength(chunks[index]!) >= 3) continue;
    if (visibleLength(chunks[index - 1]! + chunks[index]!) <= limit) {
      chunks[index - 1] = chunks[index - 1]! + chunks[index]!;
      chunks.splice(index, 1);
    }
  }

  return chunks.filter((chunk) => visibleLength(chunk) > 0);
}

/**
 * 按可见字数把这一句的时长分给每个显示单元。
 *
 * 每段至少 `minCueMs`；分配不下就合并（一行总比一闪而过好）。
 * 总和严格等于 `durationMs`，不会让后面的字幕整体漂移。
 */
export function subtitleCues(
  text: string,
  durationMs: number,
  options: { maxChars?: number; minCueMs?: number } = {},
): SubtitleCue[] {
  const minCueMs = Math.max(200, options.minCueMs ?? 600);
  let chunks = splitSubtitleText(text, options.maxChars ?? 16);
  if (chunks.length === 0) return [];

  const total = Math.max(1, Math.round(durationMs));
  while (chunks.length > 1 && total / chunks.length < minCueMs) {
    const tail = chunks.pop()!;
    chunks[chunks.length - 1] = chunks.at(-1)! + tail;
  }

  const weights = chunks.map((chunk) => Math.max(1, visibleLength(chunk)));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const cues: SubtitleCue[] = [];
  let remaining = total;
  let remainingWeight = weightTotal;

  for (let index = 0; index < chunks.length; index += 1) {
    const left = chunks.length - index;
    if (left === 1) {
      cues.push({ text: chunks[index]!, startMs: total - remaining, durationMs: remaining });
      break;
    }
    const maxForThis = remaining - minCueMs * (left - 1);
    const target = Math.round((remaining * weights[index]!) / remainingWeight);
    const duration = Math.max(minCueMs, Math.min(maxForThis, target));
    cues.push({ text: chunks[index]!, startMs: total - remaining, durationMs: duration });
    remaining -= duration;
    remainingWeight -= weights[index]!;
  }

  return cues;
}
