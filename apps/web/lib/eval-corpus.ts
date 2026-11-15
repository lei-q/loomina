/**
 * 规则评测素材库（I9 / DIRECTOR-GRAMMAR.md §十一）。
 *
 * 正反例回归（`rule-eval.ts`）验的是「判定方向没写反」；这里验的是
 * 「规则碰到真实短剧片段还灵不灵」——素材库要的是 30 个真实片段，
 * 每段带一份人工标注：人看过这段，认为哪些规则确实该报。
 *
 * 这一档先把**格式与跑分**定下来：
 *
 * 1. 一段素材 = 一个文件：`meta`（出处 / 授权 / 题材）+ `project`（IR 快照）+ `expected`（人工标注）；
 * 2. 跑一遍 `analyzeStoryboard`，和人工标注比对，给出精确率 / 召回率；
 * 3. 汇总违规率（每 100 镜）、景别熵与还差几段素材。
 *
 * 为什么不存「规则输出」而存「人工标注」：规则改了以后要能重跑。
 * 存输出等于把旧规则结论焊死在素材里，改一次规则就得重标一遍。
 *
 * 纯计算：不读盘、不调模型、不碰 store。
 */

import { ProjectSchema, type Project } from "@loomina/ir";
import { analyzeStoryboard, type StoryboardRule } from "./storyboard";
import { shotSizeEntropy } from "./rule-eval";

export const CORPUS_VERSION = "2026-11";

/** DIRECTOR-GRAMMAR.md §十一 要求的素材量 */
export const CORPUS_TARGET = 30;

const RULES: StoryboardRule[] = [
  "V1",
  "V2",
  "V3",
  "V4",
  "V5",
  "V6",
  "V7",
  "V8",
  "V9",
  "V10",
  "V11",
  "V12",
  "V13",
  "V14",
];

export type CorpusClipMeta = {
  /** 片段 id，文件名去掉 `.json` 后应与它一致 */
  id: string;
  /** 出处：片名 / 自制编号 */
  source: string;
  /** 授权：`self-made` / `licensed` / 说明文字。没有授权的素材不许进库 */
  license: string;
  genre?: string;
  platform?: string;
  note?: string;
};

export type CorpusClip = {
  meta: CorpusClipMeta;
  /** 这一段对应的项目快照（导出的 IR） */
  project: Project;
  /** 人工标注：人看过这段，认为这些规则确实该报 */
  expected: StoryboardRule[];
};

export type CorpusClipResult = {
  id: string;
  shots: number;
  /** 规则实际报出来的编号（去重） */
  actual: StoryboardRule[];
  /** 人工标注 */
  expected: StoryboardRule[];
  /** 报了但人认为不该报 */
  falsePositives: StoryboardRule[];
  /** 人认为该报但规则没报 */
  missed: StoryboardRule[];
};

export type CorpusReport = {
  version: string;
  results: CorpusClipResult[];
  summary: {
    clips: number;
    /** 还差几段才到 30 */
    short: number;
    shots: number;
    /** 每 100 镜命中规则的次数（与 rule-eval 同一口径） */
    violationRatePer100: number;
    /** 景别分布熵 */
    shotSizeEntropy: number;
    /** 人工标注与规则输出的精确率 / 召回率（0–1；没有标注时为空） */
    precision?: number;
    recall?: number;
    falsePositives: number;
    missed: number;
  };
  /** 每条规则被报了几次（14 条全列，0 也列） */
  byRule: Record<StoryboardRule, number>;
};

/** 读取并校验一段素材；错误信息要能直接告诉作者改哪个字段 */
export function parseCorpusClip(raw: unknown): CorpusClip {
  if (!raw || typeof raw !== "object") {
    throw new Error("素材文件必须是一个对象：{ meta, project, expected }");
  }
  const value = raw as Record<string, unknown>;
  const meta = readMeta(value.meta);
  const project = ProjectSchema.parse(value.project);
  const expected = readRules(value.expected, "expected");
  return { meta, project, expected };
}

function readMeta(raw: unknown): CorpusClipMeta {
  if (!raw || typeof raw !== "object") throw new Error("缺少 meta");
  const value = raw as Record<string, unknown>;
  const text = (key: string): string => {
    const item = value[key];
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`meta.${key} 必须是非空字符串`);
    }
    return item.trim();
  };
  return {
    id: text("id"),
    source: text("source"),
    license: text("license"),
    genre: optionalText(value.genre),
    platform: optionalText(value.platform),
    note: optionalText(value.note),
  };
}

function optionalText(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

function readRules(raw: unknown, field: string): StoryboardRule[] {
  if (!Array.isArray(raw)) throw new Error(`${field} 必须是数组`);
  const out: StoryboardRule[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !RULES.includes(item as StoryboardRule)) {
      throw new Error(`${field} 里的 ${String(item)} 不是 V1–V14 之一`);
    }
    if (!out.includes(item as StoryboardRule)) out.push(item as StoryboardRule);
  }
  return out;
}

/** 同一段素材里同一条规则报多次只算一次：这一段「命中了这条」是一个二值事实 */
export function actualRulesOf(project: Project): StoryboardRule[] {
  const report = analyzeStoryboard(project);
  const out: StoryboardRule[] = [];
  for (const issue of report.issues) {
    if (!out.includes(issue.rule)) out.push(issue.rule);
  }
  return out;
}

export function runCorpus(clips: CorpusClip[]): CorpusReport {
  const results: CorpusClipResult[] = clips.map((clip) => {
    const actual = actualRulesOf(clip.project);
    return {
      id: clip.meta.id,
      shots: clip.project.shots.length,
      actual,
      expected: [...clip.expected],
      falsePositives: actual.filter((rule) => !clip.expected.includes(rule)),
      missed: clip.expected.filter((rule) => !actual.includes(rule)),
    };
  });

  const issues = clips.reduce(
    (sum, clip) => sum + analyzeStoryboard(clip.project).issues.length,
    0,
  );
  const shots = results.reduce((sum, item) => sum + item.shots, 0);
  const falsePositives = results.reduce((sum, item) => sum + item.falsePositives.length, 0);
  const missed = results.reduce((sum, item) => sum + item.missed.length, 0);
  const labelled = results.reduce((sum, item) => sum + item.expected.length, 0);
  const reported = results.reduce((sum, item) => sum + item.actual.length, 0);
  const matched = results.reduce(
    (sum, item) => sum + item.actual.filter((rule) => item.expected.includes(rule)).length,
    0,
  );

  const byRule = Object.fromEntries(RULES.map((rule) => [rule, 0])) as Record<
    StoryboardRule,
    number
  >;
  for (const item of results) for (const rule of item.actual) byRule[rule] += 1;

  return {
    version: CORPUS_VERSION,
    results,
    summary: {
      clips: results.length,
      short: Math.max(0, CORPUS_TARGET - results.length),
      shots,
      violationRatePer100: shots === 0 ? 0 : round2((issues / shots) * 100),
      shotSizeEntropy: shotSizeEntropy(clips.map((clip) => clip.project)),
      precision: reported === 0 ? undefined : round2(matched / reported),
      recall: labelled === 0 ? undefined : round2(matched / labelled),
      falsePositives,
      missed,
    },
    byRule,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function corpusText(report: CorpusReport): string {
  const { summary } = report;
  const lines: string[] = [
    `评测素材库 ${report.version}：${summary.clips} / ${CORPUS_TARGET} 段，${summary.shots} 镜`,
  ];
  if (summary.clips === 0) {
    lines.push(
      "还没有素材。加一段：把导出的项目 JSON 放进 apps/web/scripts/evals/corpus/，",
    );
    lines.push("按 README 的格式补 meta（出处 / 授权）与 expected（人工标注）。");
    return lines.join("\n");
  }

  lines.push(`违规率 ${summary.violationRatePer100.toFixed(2)} / 100 镜，景别熵 ${summary.shotSizeEntropy.toFixed(3)} bit`);
  if (summary.precision === undefined || summary.recall === undefined) {
    lines.push("人工标注是空的：只报了指标，没算精确率 / 召回率。");
  } else {
    lines.push(
      `与人工标注：精确率 ${(summary.precision * 100).toFixed(0)}%，召回率 ${(summary.recall * 100).toFixed(0)}%（误报 ${summary.falsePositives}，漏报 ${summary.missed}）`,
    );
  }

  const hits = RULES.filter((rule) => report.byRule[rule] > 0);
  lines.push(hits.length ? `有命中的规则：${hits.map((r) => `${r}×${report.byRule[r]}`).join("　")}` : "没有任何规则命中。");

  for (const item of report.results) {
    if (item.falsePositives.length === 0 && item.missed.length === 0) continue;
    const parts: string[] = [];
    if (item.falsePositives.length) parts.push(`误报 ${item.falsePositives.join(" / ")}`);
    if (item.missed.length) parts.push(`漏报 ${item.missed.join(" / ")}`);
    lines.push(`  · ${item.id}：${parts.join("；")}`);
  }

  if (summary.short > 0) lines.push(`还差 ${summary.short} 段才到 ${CORPUS_TARGET} 段的标定档。`);
  return lines.join("\n");
}
