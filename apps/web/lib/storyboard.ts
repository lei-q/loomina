/**
 * 分镜检查（A11 / A12 / A13，ADR-0096）。
 *
 * 三件事共用一份读模型：
 * - A11 Beat 分析：每镜归到哪一拍；没有显式标注的旧项目按镜序推断；
 * - A12 覆盖率：每一拍有没有信息镜头与情绪 / 反应镜头；
 * - A13 分镜校验：V1 / V2 / V4 / V5 / V6 / V8。
 *
 * 推断只在读模型里发生，不写回 IR；作者在检查面板里改过的值才落 `shot.updated`。
 * V3（180° 轴线）、V7（切率曲线）、V9（模型能力）需要 3D 走位与能力矩阵，这一轮不做。
 */

import type {
  BeatKind,
  Project,
  Shot,
  ShotPurpose,
} from "@loomina/ir";
import { SHOT_SIZE_CN } from "@loomina/pipeline";

export const BEAT_ORDER: BeatKind[] = [
  "hook",
  "setup",
  "escalation",
  "turn",
  "climax",
  "resolution",
  "endHook",
];

export const BEAT_LABEL: Record<BeatKind, string> = {
  hook: "钩子",
  setup: "铺垫",
  escalation: "升级",
  turn: "转折",
  climax: "高潮",
  resolution: "收束",
  endHook: "尾钩",
};

export const BEAT_TASK: Record<BeatKind, string> = {
  hook: "3 秒内抓住注意力",
  setup: "交代人物、关系、目标",
  escalation: "障碍出现，压力上升",
  turn: "反转或认知变化",
  climax: "情绪 / 爽点兑现",
  resolution: "收束这一集的小闭环",
  endHook: "留一个新悬念",
};

export const PURPOSE_LABEL: Record<ShotPurpose, string> = {
  establish: "建立",
  information: "信息",
  emotion: "情绪",
  reaction: "反应",
  transition: "过渡",
  hook: "钩子",
};

export const PURPOSE_TASK: Record<ShotPurpose, string> = {
  establish: "先让观众看清空间",
  information: "交代一个事实或细节",
  emotion: "把情绪推上去",
  reaction: "看另一个人怎么反应",
  transition: "换场或留呼吸",
  hook: "抓住注意力",
};

export type ShotPlan = {
  shotId: string;
  /** 全片镜号，从 1 开始 */
  no: number;
  sceneId: string;
  sceneLabel: string;
  beat: BeatKind;
  purpose: ShotPurpose;
  /** 值是自己标的还是按镜序推断的 */
  beatFrom: "shot" | "inferred";
  purposeFrom: "shot" | "inferred";
  startMs: number;
  durationMs: number;
};

export type BeatSpan = {
  id: string;
  sceneId: string;
  sceneLabel: string;
  kind: BeatKind;
  shotIds: string[];
  shotNos: number[];
  /** 这一拍起点与时长（按剧本顺序累加，不是时间线） */
  startMs: number;
  durationMs: number;
  hasInformation: boolean;
  hasEmotion: boolean;
};

export type StoryboardRule = "V1" | "V2" | "V4" | "V5" | "V6" | "V8";

export type StoryboardIssue = {
  rule: StoryboardRule;
  severity: "error" | "warning";
  message: string;
  shotIds: string[];
  beatId?: string;
};

export type StoryboardReport = {
  plans: ShotPlan[];
  beats: BeatSpan[];
  issues: StoryboardIssue[];
  summary: {
    shots: number;
    beats: number;
    coveredBeats: number;
    /** 同时有信息与情绪镜头的拍占比，0–100 */
    coveragePct: number;
    errors: number;
    warnings: number;
  };
};

export type StoryboardOptions = {
  /** 整片重做一遍的报价；给了才查 V8 */
  requoteCny?: number;
  budgetCny?: number;
};

function sceneLabelOf(project: Project, sceneId: string): string {
  const scene = project.scenes.find((item) => item.id === sceneId);
  if (!scene) return "未知场次";
  return `第 ${scene.code || scene.index + 1} 场`;
}

/** 按场次顺序、场内镜序排出全片镜头，并写全片镜号。 */
function orderedShots(project: Project): { shot: Shot; no: number; sceneLabel: string }[] {
  const scenes = [...project.scenes].sort((a, b) => a.index - b.index);
  const byId = new Map(project.shots.map((shot) => [shot.id, shot]));
  const out: { shot: Shot; no: number; sceneLabel: string }[] = [];
  const seen = new Set<string>();

  for (const scene of scenes) {
    for (const shotId of scene.shotIds) {
      const shot = byId.get(shotId);
      if (!shot || seen.has(shotId)) continue;
      seen.add(shotId);
      out.push({
        shot,
        no: out.length + 1,
        sceneLabel: `第 ${scene.code || scene.index + 1} 场`,
      });
    }
  }
  for (const shot of project.shots) {
    if (seen.has(shot.id)) continue;
    out.push({ shot, no: out.length + 1, sceneLabel: sceneLabelOf(project, shot.sceneId) });
  }
  return out;
}

/**
 * 没标 beat 时按全片位置推断。
 *
 * 这是兜底，不是创作：生成时提示词会要求模型直接给 beat；旧项目与手工项目
 * 才走这条。作者可以随时在检查面板里改，改过的值才算数。
 */
export function inferBeat(index: number, total: number): BeatKind {
  if (index <= 0) return "hook";
  if (index >= total - 1) return "endHook";
  const at = index / Math.max(1, total - 1);
  if (at < 0.34) return "setup";
  if (at < 0.6) return "escalation";
  if (at < 0.8) return "turn";
  return "climax";
}

export function inferPurpose(
  shot: Pick<Shot, "shotSize" | "characterIds" | "dialogueIds">,
  context: { index: number; firstInScene: boolean; previousHadDialogue: boolean },
): ShotPurpose {
  if (context.index === 0) return "hook";
  if (shot.dialogueIds.length > 0) {
    return shot.shotSize === "close" || shot.shotSize === "extreme-close"
      ? "emotion"
      : "information";
  }
  if (shot.shotSize === "wide") return "establish";
  if (shot.characterIds.length === 0) return "transition";
  if (!context.firstInScene && context.previousHadDialogue) return "reaction";
  return "information";
}

export function planShots(project: Project): ShotPlan[] {
  const ordered = orderedShots(project);
  const plans: ShotPlan[] = [];
  let cursor = 0;
  let previousDialogue = false;

  for (const [index, item] of ordered.entries()) {
    const { shot, no, sceneLabel } = item;
    const firstInScene = index === 0 || ordered[index - 1]!.shot.sceneId !== shot.sceneId;
    const beat = shot.beat ?? inferBeat(index, ordered.length);
    const purpose =
      shot.purpose ??
      inferPurpose(shot, { index, firstInScene, previousHadDialogue: previousDialogue });
    plans.push({
      shotId: shot.id,
      no,
      sceneId: shot.sceneId,
      sceneLabel,
      beat,
      purpose,
      beatFrom: shot.beat ? "shot" : "inferred",
      purposeFrom: shot.purpose ? "shot" : "inferred",
      startMs: cursor,
      durationMs: shot.durationMs,
    });
    cursor += shot.durationMs;
    previousDialogue = shot.dialogueIds.length > 0;
  }
  return plans;
}

export function groupBeats(plans: ShotPlan[]): BeatSpan[] {
  const spans: BeatSpan[] = [];
  for (const plan of plans) {
    const last = spans.at(-1);
    if (last && last.sceneId === plan.sceneId && last.kind === plan.beat) {
      last.shotIds.push(plan.shotId);
      last.shotNos.push(plan.no);
      last.durationMs += plan.durationMs;
    } else {
      spans.push({
        id: `${plan.sceneId}-${plan.beat}-${spans.length + 1}`,
        sceneId: plan.sceneId,
        sceneLabel: plan.sceneLabel,
        kind: plan.beat,
        shotIds: [plan.shotId],
        shotNos: [plan.no],
        startMs: plan.startMs,
        durationMs: plan.durationMs,
        hasInformation: false,
        hasEmotion: false,
      });
    }
    const span = spans.at(-1)!;
    if (plan.purpose === "information" || plan.purpose === "establish") {
      span.hasInformation = true;
    }
    if (plan.purpose === "emotion" || plan.purpose === "reaction") {
      span.hasEmotion = true;
    }
  }
  return spans;
}

/**
 * A13 校验。只返回能在这里可靠判断的规则：
 * V1 建立镜头、V2 台词承载、V4 镜头时长、V5 每拍信息 + 情绪、V6 同景别连续、V8 预算。
 */
export function validateStoryboard(
  project: Project,
  plans: ShotPlan[],
  beats: BeatSpan[],
  options: StoryboardOptions = {},
): StoryboardIssue[] {
  const issues: StoryboardIssue[] = [];
  const shotById = new Map(project.shots.map((shot) => [shot.id, shot]));
  const dialogueById = new Map(project.dialogue.map((line) => [line.id, line]));

  // V1：每场至少一个建立镜头
  for (const scene of [...project.scenes].sort((a, b) => a.index - b.index)) {
    const inScene = plans.filter((plan) => plan.sceneId === scene.id);
    const hasEstablish = inScene.some((plan) => {
      if (plan.purpose === "establish") return true;
      return shotById.get(plan.shotId)?.shotSize === "wide";
    });
    if (!hasEstablish) {
      issues.push({
        rule: "V1",
        severity: "warning",
        message: `${scene.code ? `第 ${scene.code} 场` : `第 ${scene.index + 1} 场`}没有建立镜头：补一个全景，先让观众看清空间。`,
        shotIds: inScene.map((plan) => plan.shotId),
      });
    }
  }

  // V2：有台词时，说话人必须在场
  for (const plan of plans) {
    const shot = shotById.get(plan.shotId);
    if (!shot) continue;
    for (const lineId of shot.dialogueIds) {
      const line = dialogueById.get(lineId);
      if (!line) continue;
      if (shot.characterIds.includes(line.characterId)) continue;
      const name = project.characters.find((item) => item.id === line.characterId)?.name ?? "说话人";
      issues.push({
        rule: "V2",
        severity: "warning",
        message: `第 ${plan.no} 镜有${name}的台词，但他不在场：把他加进出场，或换一个说话人。`,
        shotIds: [shot.id],
      });
    }
  }

  // V4：单镜时长在模型安全区间（1–8 秒）
  for (const plan of plans) {
    if (plan.durationMs >= 1000 && plan.durationMs <= 8000) continue;
    issues.push({
      rule: "V4",
      severity: "error",
      message: `第 ${plan.no} 镜 ${(plan.durationMs / 1000).toFixed(1)} 秒，超出模型 1–8 秒的安全区间：拆成两镜或改时长。`,
      shotIds: [plan.shotId],
    });
  }

  // V5：每拍至少一个信息镜头 + 一个情绪 / 反应镜头
  for (const beat of beats) {
    if (!beat.hasInformation) {
      issues.push({
        rule: "V5",
        severity: "warning",
        message: `${beat.sceneLabel}「${BEAT_LABEL[beat.kind]}」没有信息镜头：补一个交代事实、道具或关系的镜头。`,
        shotIds: beat.shotIds,
        beatId: beat.id,
      });
    }
    if (!beat.hasEmotion) {
      issues.push({
        rule: "V5",
        severity: "warning",
        message: `${beat.sceneLabel}「${BEAT_LABEL[beat.kind]}」没有情绪或反应镜头：补一个近景，让观众看到谁被影响了。`,
        shotIds: beat.shotIds,
        beatId: beat.id,
      });
    }
  }

  // V6：同一场里不要连续三个同景别
  let runSize = 1;
  let runStart = 0;
  for (let index = 1; index <= plans.length; index += 1) {
    const current = plans[index];
    const previous = plans[index - 1];
    const sameScene = current && previous && current.sceneId === previous.sceneId;
    const sameSize =
      sameScene &&
      shotById.get(current.shotId)?.shotSize === shotById.get(previous.shotId)?.shotSize;
    if (sameSize) {
      runSize += 1;
      if (runSize === 3) {
        const run = plans.slice(runStart, index + 1);
        const size = shotById.get(run[0]!.shotId)?.shotSize ?? "medium";
        issues.push({
          rule: "V6",
          severity: "warning",
          message: `连续 ${runSize} 个${SHOT_SIZE_CN[size]}：换一个景别，画面才有节奏。`,
          shotIds: run.map((plan) => plan.shotId),
        });
      }
    } else {
      runSize = 1;
      runStart = index;
    }
  }

  // V8：整片重做一遍的报价超过预算
  const { requoteCny, budgetCny } = options;
  if (
    requoteCny !== undefined &&
    budgetCny !== undefined &&
    requoteCny > budgetCny &&
    plans.length > 0
  ) {
    issues.push({
      rule: "V8",
      severity: "warning",
      message: `整片重做一遍约 ¥${requoteCny.toFixed(2)}，超过预算 ¥${budgetCny.toFixed(2)}：先删减镜头或降低规格。`,
      shotIds: plans.map((plan) => plan.shotId),
    });
  }

  return issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    return a.rule.localeCompare(b.rule);
  });
}

export function analyzeStoryboard(
  project: Project,
  options: StoryboardOptions = {},
): StoryboardReport {
  const plans = planShots(project);
  const beats = groupBeats(plans);
  const issues = validateStoryboard(project, plans, beats, options);
  const coveredBeats = beats.filter((beat) => beat.hasInformation && beat.hasEmotion).length;

  return {
    plans,
    beats,
    issues,
    summary: {
      shots: plans.length,
      beats: beats.length,
      coveredBeats,
      coveragePct: beats.length === 0 ? 0 : Math.round((coveredBeats / beats.length) * 100),
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
    },
  };
}
