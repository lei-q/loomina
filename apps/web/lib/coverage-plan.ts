/**
 * 覆盖率收口（A10 / ADR-0155）。
 *
 * 模板来自 STORYBOARD.md §四，缺口来自 ADR-0096 的 `StoryboardReport`。
 * 这一层全是纯函数：不进 IR、不自动补镜；作者点「标成 X」时才走既有
 * `setShotPlan` 写一条 `shot.updated`。
 */

import type { ShotPurpose } from "@loomina/ir";
import { requoteShot } from "./pricing";
import {
  BEAT_LABEL,
  BEAT_TASK,
  PURPOSE_LABEL,
  type BeatSpan,
  type StoryboardReport,
} from "./storyboard";

/** 补镜估价的名义镜长：作者还没决定补哪一镜，统一按 3 秒草稿档算 */
export const COVERAGE_SHOT_MS = 3000;

export type CoverageGap = "information" | "emotion" | "both";

/** STORYBOARD.md 的六种序列；`info` / `emotion` 是一键标目的候选 */
export type CoverageTemplate = {
  id: string;
  name: string;
  note: string;
  sequence: string[];
  info: ShotPurpose;
  emotion: ShotPurpose;
  shots: number;
};

export const COVERAGE_TEMPLATES: CoverageTemplate[] = [
  {
    id: "dialogue",
    name: "双人对话",
    note: "先交代空间，再交替给两个人特写，最后留反应。",
    sequence: ["master", "OTS A", "OTS B", "CU A", "CU B", "reaction", "insert"],
    info: "information",
    emotion: "reaction",
    shots: 2,
  },
  {
    id: "conflict",
    name: "对峙 / 冲突",
    note: "两个特写来回切，时长逐镜递减。",
    sequence: ["CU A", "CU B", "CU A", "CU B"],
    info: "information",
    emotion: "emotion",
    shots: 2,
  },
  {
    id: "reveal",
    name: "信息揭示",
    note: "全景立空间，细节交代事实，再用反应镜头把信息变成情绪。",
    sequence: ["wide", "detail insert", "reaction CU", "push-in"],
    info: "information",
    emotion: "reaction",
    shots: 2,
  },
  {
    id: "solitude",
    name: "单人情绪",
    note: "由中景逐步逼近细节，最后拉远收尾。",
    sequence: ["medium", "CU", "ECU detail", "wide"],
    info: "information",
    emotion: "emotion",
    shots: 2,
  },
  {
    id: "action",
    name: "动作",
    note: "先看清动作发生的空间，再给冲击特写和反应。",
    sequence: ["wide", "tracking", "impact CU", "reaction"],
    info: "establish",
    emotion: "reaction",
    shots: 2,
  },
  {
    id: "montage",
    name: "蒙太奇",
    note: "四到八个信息碎片按节奏切，适合时间流逝。",
    sequence: ["insert × 4–8", "按音乐节拍切"],
    info: "information",
    emotion: "emotion",
    shots: 1,
  },
];

export function gapOfBeat(beat: BeatSpan): CoverageGap | undefined {
  if (beat.hasInformation && beat.hasEmotion) return undefined;
  if (!beat.hasInformation && !beat.hasEmotion) return "both";
  return beat.hasInformation ? "emotion" : "information";
}

export type CoverageGapLine = {
  beatId: string;
  kind: BeatSpan["kind"];
  label: string;
  task: string;
  sceneLabel: string;
  shotNos: number[];
  seconds: number;
  gap: CoverageGap;
  gapLabel: string;
  suggested: ShotPurpose;
};

export const GAP_LABEL: Record<CoverageGap, string> = {
  information: "缺信息",
  emotion: "缺情绪",
  both: "信息 + 情绪都缺",
};

/** 一份覆盖率缺口清单：已齐的拍不出现，不硬推荐补镜 */
export function coverageGaps(report: StoryboardReport): CoverageGapLine[] {
  return report.beats.flatMap((beat) => {
    const gap = gapOfBeat(beat);
    if (!gap) return [];
    return [
      {
        beatId: beat.id,
        kind: beat.kind,
        label: BEAT_LABEL[beat.kind],
        task: BEAT_TASK[beat.kind],
        sceneLabel: beat.sceneLabel,
        shotNos: beat.shotNos,
        seconds: beat.durationMs / 1000,
        gap,
        gapLabel: GAP_LABEL[gap],
        suggested: gap === "emotion" ? "emotion" : "information",
      },
    ];
  });
}

/** 按缺口筛模板：缺情绪时给情绪类，缺信息时给信息类，都缺就全给 */
export function coverageTemplatesFor(gap: CoverageGap | undefined): CoverageTemplate[] {
  if (!gap) return [];
  return COVERAGE_TEMPLATES.filter((template) => {
    if (gap === "information") return template.info !== "emotion" && template.info !== "reaction";
    if (gap === "emotion") return template.emotion === "emotion" || template.emotion === "reaction";
    return true;
  });
}

export type CoverageEstimate = {
  shots: number;
  perShotCny?: number;
  totalCny?: number;
  basis: string;
};

/**
 * 补镜估价：每个缺口按模板建议补几镜，统一 3 秒草稿档。
 *
 * 与 V8 整片重做共用 `requoteShot`：价目表没有模型 / 首帧就不给金额，
 * 界面写「报不出价」，绝不把未知当 ¥0。
 */
export function coverageEstimate(
  report: StoryboardReport,
  templates: CoverageTemplate[],
): CoverageEstimate {
  const gaps = coverageGaps(report);
  const shots = gaps.reduce(
    (sum) => sum + (templates[0]?.shots ?? 1),
    0,
  );
  const quote = requoteShot(COVERAGE_SHOT_MS);
  if (quote.totalCny === undefined || shots === 0) {
    return {
      shots,
      basis:
        shots === 0
          ? "每一拍都有信息 + 情绪镜头：暂时不需要补镜。"
          : `补镜按 3 秒草稿档估，但 ${quote.basis}：报不出价。`,
    };
  }
  const perShotCny = quote.totalCny;
  return {
    shots,
    perShotCny,
    totalCny: Math.round(perShotCny * shots * 100) / 100,
    basis: `${shots} 镜 × 3 秒草稿档 × ¥${perShotCny.toFixed(2)}/镜（${quote.basis}）`,
  };
}

/** 报告里不写「通过率」「审美评分」：覆盖率只回答功能齐不齐 */
export function coverageReportText(input: {
  title: string;
  report: StoryboardReport;
  estimate: CoverageEstimate;
  templates: CoverageTemplate[];
}): string {
  const { report, estimate, templates } = input;
  const gaps = coverageGaps(report);
  const lines = [
    `${input.title} · 覆盖率报告`,
    `覆盖率 ${report.summary.coveragePct}%：${report.summary.coveredBeats} / ${report.summary.beats} 拍齐备，共 ${report.summary.shots} 镜。`,
    `校验：${report.summary.errors} 错 · ${report.summary.warnings} 提示。`,
    "",
    "口径：每一拍至少有一个信息镜头（information / establish）与一个情绪镜头（emotion / reaction）；不评价故事好坏。",
    "模板来自 STORYBOARD.md §四，未经授权样片 A/B 标定；以下是建议，不是自动改写。",
    "",
    "逐拍：",
  ];
  for (const beat of report.beats) {
    const gap = gapOfBeat(beat);
    const shots = beat.shotNos.length > 0
      ? `SH-${String(beat.shotNos[0]).padStart(2, "0")}–SH-${String(beat.shotNos.at(-1)).padStart(2, "0")}`
      : "无镜";
    lines.push(
      `- ${BEAT_LABEL[beat.kind]} · ${beat.sceneLabel} · ${shots} · ${(beat.durationMs / 1000).toFixed(1)}s · ${gap ? GAP_LABEL[gap] : "信息 + 情绪齐"}`,
    );
  }
  lines.push("", "缺口与建议：");
  if (gaps.length === 0) lines.push("- 没有缺口。");
  for (const line of gaps) {
    lines.push(
      `- ${line.label} · ${line.sceneLabel} · ${line.gapLabel}：建议补 ${PURPOSE_LABEL[line.suggested]} 镜（${BEAT_TASK[line.kind]}）。`,
    );
  }
  lines.push("", "候选模板：");
  if (templates.length === 0) lines.push("- 当前缺口没有候选模板。");
  for (const template of templates) {
    lines.push(`- ${template.name}：${template.sequence.join(" → ")}；${template.note}`);
  }
  lines.push("", "补镜估价：");
  lines.push(
    estimate.totalCny === undefined
      ? `- ${estimate.basis}`
      : `- 约补 ${estimate.shots} 镜，合计 ¥${estimate.totalCny.toFixed(2)}；${estimate.basis}。`,
  );
  lines.push("- 3 秒是名义镜长，真实镜长与供应商回执以作者实际生成后的账为准。", "");
  lines.push("校验清单：");
  if (report.issues.length === 0) lines.push("- 当前规则都过了。");
  for (const issue of report.issues) {
    lines.push(`- ${issue.rule} · ${issue.severity === "error" ? "错误" : "提示"}：${issue.message}`);
  }
  lines.push("");
  return lines.join("\n");
}
