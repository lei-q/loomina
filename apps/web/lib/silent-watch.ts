/**
 * 静音可懂度检查（C13 / ADR-0164）。
 *
 * 短剧大量是在地铁、办公室、宿舍里被静音刷到的：观众先看字幕，
 * 声音是加分项。这一份报告只回答一件事——**关掉声音，这条片子还讲得通吗**。
 *
 * 能测的只有字幕这一侧：
 *
 * 1. 读不读得完：一条字幕的字数 ÷ 它停留的秒数（中文竖屏 9 字/秒以上就吃力）；
 * 2. 停得太短：一闪而过，观众来不及看；
 * 3. 信息断点：连续一段没有字幕，静音时这一段只剩画面；
 * 4. 指代不清：一句以「他 / 这 / 那个」开头，前几句里没出现过任何人物名；
 * 5. 说话人不清：一镜里两个人先后说话，中间没有镜头切换，字幕也没标是谁。
 *
 * 画面里藏了什么信息、观众能不能从表演读懂——这些测不了，报告里如实写「未测」，
 * 不给假分数。
 */

import type { EditView } from "./edit";

/** 中文竖屏字幕的舒适阅读上限（字 / 秒） */
export const READ_CPS_COMFORT = 7;
/** 超过这条线基本读不完 */
export const READ_CPS_HARD = 10;
/** 一条字幕停留短于这个时间就是一闪而过 */
export const MIN_CUE_MS = 800;
/** 连续多久没有字幕算信息断点 */
export const GAP_MS = 6000;
/** 台词覆盖低于这个比例，静音时信息量偏少（只在成片够长时才判） */
export const COVERAGE_FLOOR = 0.2;
/** 判覆盖率的成片最短时长：太短的片子比例没有意义 */
export const COVERAGE_MIN_TOTAL_MS = 30_000;

/** 指代类开头：静音时观众不知道该往哪个人 / 哪件东西上对 */
const PRONOUN_LEADS = [
  "他们",
  "她们",
  "它们",
  "他",
  "她",
  "它",
  "这个",
  "那个",
  "这些",
  "那些",
  "这里",
  "那里",
  "这样",
  "那样",
  "这件事",
  "那件事",
  "这人",
  "那人",
  "这玩意儿",
];

export type SilentCueInput = {
  cueId: string;
  lineId: string;
  shotId: string;
  shotNo: number;
  /** 说话人名；旁白留空 */
  speaker: string;
  characterId?: string;
  text: string;
  /** 绝对时间 */
  startMs: number;
  durationMs: number;
};

export type SilentShotInput = {
  shotId: string;
  shotNo: number;
  startMs: number;
  durationMs: number;
  /** 这一镜出场的人名 */
  characters: string[];
};

export type SilentIssueKind =
  | "unreadable"
  | "flash"
  | "gap"
  | "pronoun"
  | "speaker"
  | "coverage";

export const SILENT_ISSUE_LABEL: Record<SilentIssueKind, string> = {
  unreadable: "读不完",
  flash: "一闪而过",
  gap: "信息断点",
  pronoun: "指代不清",
  speaker: "说话人不清",
  coverage: "台词偏少",
};

export type CueReading = {
  cueId: string;
  lineId: string;
  shotId: string;
  shotNo: number;
  speaker: string;
  text: string;
  startMs: number;
  durationMs: number;
  /** 可见字数（不含标点与空白） */
  chars: number;
  /** 字 / 秒 */
  cps: number;
  /** 读不完时的建议字数上限；读得完就没有 */
  suggestedChars?: number;
  /** unreadable / flash / undefined */
  issue?: "unreadable" | "flash";
};

export type SilentGap = {
  startMs: number;
  durationMs: number;
  /** 断点开始时正在放的那一镜 */
  shotNo?: number;
  /** 这一段里有几镜 */
  shots: number;
  /** 这一段里有几个人说过话（静音时观众看到的只有画面） */
  lines: number;
};

export type SilentPronoun = {
  cueId: string;
  lineId: string;
  shotId: string;
  shotNo: number;
  text: string;
  /** 开头的指代词 */
  lead: string;
  /** 前几句里出现过的人名（用于解释为什么判不清） */
  known: string[];
};

export type SilentSpeaker = {
  cueId: string;
  shotId: string;
  shotNo: number;
  /** 这一镜里先后说话的人 */
  speakers: string[];
  text: string;
};

export type SilentWatchReport = {
  /** 0–100；只按字幕这一侧的可测项扣分 */
  score: number;
  grade: "good" | "fair" | "weak" | "poor";
  gradeLabel: string;
  /** 一句话结论 */
  verdict: string;
  cues: CueReading[];
  gaps: SilentGap[];
  pronouns: SilentPronoun[];
  speakers: SilentSpeaker[];
  /** 有字幕的时间 / 成片总长 */
  coverage: { ratio: number; subtitleMs: number; totalMs: number; low: boolean };
  summary: Record<SilentIssueKind, number>;
  /** 一句话说明哪些测不了 */
  untested: string;
};

const GRADE_LABEL: Record<SilentWatchReport["grade"], string> = {
  good: "静音也能看懂",
  fair: "大体能懂",
  weak: "静音时容易断",
  poor: "静音时看不懂",
};

/** 可见字数：标点与空白不占阅读时间 */
function visibleLength(text: string): number {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").length;
}

/**
 * 从成片读模型直接算：成片页与顶栏徽标用同一份，不各拼一套输入。
 */
export function silentWatchOfEdit(view: EditView): SilentWatchReport {
  const shotNoById = new Map<string, number>();
  for (const clip of view.clips) shotNoById.set(clip.shotId, clip.shotNo);
  const cues: SilentCueInput[] = view.cues.map((cue) => ({
    cueId: cue.id,
    lineId: cue.lineId,
    shotId: cue.shotId,
    shotNo: shotNoById.get(cue.shotId) ?? 0,
    speaker: cue.characterName,
    ...(cue.characterId ? { characterId: cue.characterId } : {}),
    text: cue.text,
    startMs: cue.startMs,
    durationMs: cue.durationMs,
  }));
  const shots: SilentShotInput[] = view.clips.map((clip) => ({
    shotId: clip.shotId,
    shotNo: clip.shotNo,
    startMs: clip.startMs,
    durationMs: clip.durationMs,
    characters: [...new Set(clip.lines.map((line) => line.characterName))],
  }));
  return silentWatch({
    cues,
    shots,
    totalMs: view.totalMs,
    speakerColors: view.subtitleStyle.speakerColors,
  });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 这一句是不是以指代词开头（跳过开头的引号 / 标点） */
function pronounLead(text: string): string | undefined {
  const trimmed = text.trim().replace(/^[\s\p{P}]+/u, "");
  return PRONOUN_LEADS.find((lead) => trimmed.startsWith(lead));
}

/**
 * 静音可懂度检查。
 *
 * 输入是已经排好时间的字幕与镜头（`toEditView` 的输出），所以结果与成片一致：
 * 作者改过断句、挪过字幕，这里跟着变。
 */export function silentWatch(input: {
  cues: SilentCueInput[];
  shots: SilentShotInput[];
  totalMs: number;
  /** 字幕是否按角色着色（D3）：开着时说话人不清只算提示 */
  speakerColors?: boolean;
}): SilentWatchReport {
  const cues = [...input.cues]
    .filter((cue) => visibleLength(cue.text) > 0)
    .sort((a, b) => a.startMs - b.startMs);
  const totalMs = Math.max(0, Math.round(input.totalMs));

  const readings: CueReading[] = cues.map((cue) => {
    const chars = visibleLength(cue.text);
    const seconds = Math.max(0.001, cue.durationMs / 1000);
    const cps = round1(chars / seconds);
    const reading: CueReading = {
      cueId: cue.cueId,
      lineId: cue.lineId,
      shotId: cue.shotId,
      shotNo: cue.shotNo,
      speaker: cue.speaker,
      text: cue.text,
      startMs: cue.startMs,
      durationMs: cue.durationMs,
      chars,
      cps,
    };
    if (cps > READ_CPS_HARD) {
      reading.issue = "unreadable";
      reading.suggestedChars = Math.max(1, Math.floor(READ_CPS_COMFORT * seconds));
    } else if (cue.durationMs < MIN_CUE_MS && chars >= 2) {
      reading.issue = "flash";
    }
    return reading;
  });

  // ── 信息断点 ────────────────────────────────────────────────
  const gaps: SilentGap[] = [];
  let cursor = 0;
  for (const cue of cues) {
    if (cue.startMs - cursor >= GAP_MS) {
      const from = cursor;
      const to = cue.startMs;
      const covered = input.shots.filter(
        (shot) => shot.startMs < to && shot.startMs + shot.durationMs > from,
      );
      gaps.push({
        startMs: from,
        durationMs: to - from,
        ...(covered[0] ? { shotNo: covered[0].shotNo } : {}),
        shots: covered.length,
        lines: cues.filter((line) => line.startMs >= from && line.startMs < to).length,
      });
    }
    cursor = Math.max(cursor, cue.startMs + cue.durationMs);
  }
  if (totalMs - cursor >= GAP_MS) {
    const covered = input.shots.filter(
      (shot) => shot.startMs < totalMs && shot.startMs + shot.durationMs > cursor,
    );
    gaps.push({
      startMs: cursor,
      durationMs: totalMs - cursor,
      ...(covered[0] ? { shotNo: covered[0].shotNo } : {}),
      shots: covered.length,
      lines: 0,
    });
  }

  // ── 指代不清 ────────────────────────────────────────────────
  // 指代能落到谁身上：说话人与这一片子里出场过的人。
  // 只认字幕文本里出现过的人名——说话人标签不在画面上，静音时观众看不到。
  const knownNames = [
    ...new Set([
      ...cues.map((cue) => cue.speaker).filter(Boolean),
      ...input.shots.flatMap((shot) => shot.characters),
    ]),
  ];
  const pronouns: SilentPronoun[] = [];
  cues.forEach((cue, index) => {
    const lead = pronounLead(cue.text);
    if (!lead) return;
    // 只认字幕文本里出现过的人名：说话人标签本身不在画面上，
    // 静音时观众看不到「这句是林说的」，也就没法从它推出「他」是谁。
    const window = cues.slice(Math.max(0, index - 3), index);
    const known = knownNames.filter((name) => window.some((prev) => prev.text.includes(name)));
    if (known.length > 0) return;
    pronouns.push({
      cueId: cue.cueId,
      lineId: cue.lineId,
      shotId: cue.shotId,
      shotNo: cue.shotNo,
      text: cue.text,
      lead,
      known,
    });
  });

  // ── 说话人不清 ──────────────────────────────────────────────
  // 一镜里两个人先后说话、中间没有镜头切换：静音时只能靠字幕颜色分辨。
  const speakers: SilentSpeaker[] = [];
  const byShot = new Map<string, SilentCueInput[]>();
  for (const cue of cues) {
    const list = byShot.get(cue.shotId) ?? [];
    list.push(cue);
    byShot.set(cue.shotId, list);
  }
  for (const [, list] of byShot) {
    const names = [...new Set(list.map((cue) => cue.speaker).filter(Boolean))];
    if (names.length < 2) continue;
    // 只标「换了人、但没换镜」的那几句
    let previous: string | undefined;
    for (const cue of list) {
      if (cue.speaker && previous && cue.speaker !== previous) {
        speakers.push({
          cueId: cue.cueId,
          shotId: cue.shotId,
          shotNo: cue.shotNo,
          speakers: [previous, cue.speaker],
          text: cue.text,
        });
      }
      if (cue.speaker) previous = cue.speaker;
    }
  }

  // ── 覆盖率 ──────────────────────────────────────────────────
  const subtitleMs = cues.reduce((sum, cue) => sum + cue.durationMs, 0);
  const ratio = totalMs > 0 ? Math.min(1, subtitleMs / totalMs) : 0;
  const low = totalMs >= COVERAGE_MIN_TOTAL_MS && ratio < COVERAGE_FLOOR;

  // ── 分数 ────────────────────────────────────────────────────
  const unreadable = readings.filter((cue) => cue.issue === "unreadable");
  const flashes = readings.filter((cue) => cue.issue === "flash");
  let score = 100;
  score -= Math.min(32, unreadable.length * 8);
  score -= Math.min(12, flashes.length * 3);
  score -= Math.min(20, gaps.length * 5);
  score -= Math.min(16, pronouns.length * 4);
  // 字幕按角色着色时，颜色能帮一点，扣分减半
  score -= Math.min(16, speakers.length * (input.speakerColors ? 2 : 4));
  if (low) score -= 10;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const grade: SilentWatchReport["grade"] =
    score >= 85 ? "good" : score >= 70 ? "fair" : score >= 50 ? "weak" : "poor";

  const parts: string[] = [];
  if (unreadable.length > 0) parts.push(`${unreadable.length} 条字幕读不完`);
  if (flashes.length > 0) parts.push(`${flashes.length} 条一闪而过`);
  if (gaps.length > 0) parts.push(`${gaps.length} 段没有字幕`);
  if (pronouns.length > 0) parts.push(`${pronouns.length} 句指代不清`);
  if (speakers.length > 0) parts.push(`${speakers.length} 处分不清谁在说`);
  if (low) parts.push(`台词只占 ${Math.round(ratio * 100)}%`);
  const verdict =
    parts.length === 0
      ? `字幕这一侧没有明显问题：${cues.length} 条字幕都读得完，也没有长时间的空档，静音也跟得上。`
      : `${parts.join("、")}。`;

  return {
    score,
    grade,
    gradeLabel: GRADE_LABEL[grade],
    verdict,
    cues: readings,
    gaps,
    pronouns,
    speakers,
    coverage: { ratio: round1(ratio * 100) / 100, subtitleMs, totalMs, low },
    summary: {
      unreadable: unreadable.length,
      flash: flashes.length,
      gap: gaps.length,
      pronoun: pronouns.length,
      speaker: speakers.length,
      coverage: low ? 1 : 0,
    },
    untested: "画面里藏了什么、表演能不能读懂，这一份测不了：它只查字幕。",
  };
}
