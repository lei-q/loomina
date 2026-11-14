/**
 * 分镜检查（A11 / A12 / A13，ADR-0096）。
 *
 * 三件事共用一份读模型：
 * - A11 Beat 分析：每镜归到哪一拍；没有显式标注的旧项目按镜序推断；
 * - A12 覆盖率：每一拍有没有信息镜头与情绪 / 反应镜头；
 * - A13 分镜校验：V1 / V2 / V3 / V4 / V5 / V6 / V7 / V8 / V9 / V10 / V11 / V12。
 *
 * 推断只在读模型里发生，不写回 IR；作者在检查面板里改过的值才落 `shot.updated`。
 * V3 用 B17 的左右调度做近似：只看同一场相邻两镜，没有 3D 坐标就不声称精确；
 * V7 用每拍平均镜长与全片平均对比，查「该碎不碎」的拍；
 * V9 只查尾帧：当前网关没有尾帧字段，运镜本身只作为提示词提交。
 * V10 查表演设计（B16 / B17）；V11 查节拍顺序（A11）；
 * V12 查立面与遮挡（B13.2）：视线被谁挡住、机位高度与写下的角度档位对不上。
 * 「不拦生成」是这一轮的有意取舍（ADR-0103 / ADR-0108）。
 */

import type {
  BeatKind,
  Project,
  Shot,
  ShotPurpose,
} from "@loomina/ir";
import { SHOT_ANGLE_CN, SHOT_SIZE_CN, checkAxis, elevationOf, occlusionsOf } from "@loomina/pipeline";
import { performanceAdvice } from "./performance-grammar";

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
  /** 平均镜长（秒）；没有镜头时是 0 */
  aslSeconds: number;
  /** 每 10 秒切几次；没有时长时是 0 */
  cutsPer10s: number;
  hasInformation: boolean;
  hasEmotion: boolean;
};

/**
 * 节拍摘要（A11）：一拍一行，回答「这一拍在干什么、用了多少时间」。
 *
 * 只是把已有的 `BeatSpan` 读成一句话，不新增事实：顺序、占比、缺什么
 * 都能从 span 本身算出来。独立 Beat 实体与 Beat 级成本仍不做（见 ADR-0115）。
 */
export type BeatDigestLine = {
  id: string;
  kind: BeatKind;
  label: string;
  task: string;
  sceneLabel: string;
  shotNos: number[];
  shotCount: number;
  seconds: number;
  /** 占全片时长的百分比，四舍五入到整数 */
  sharePct: number;
  covered: boolean;
  /** 缺哪一类镜头；都齐时为 null */
  missing: "information" | "emotion" | null;
};

export type BeatDigest = {
  lines: BeatDigestLine[];
  totalSeconds: number;
  count: number;
  /** 覆盖的拍数 */
  covered: number;
  /** 用时最长的一拍；没有拍时为 undefined */
  longest?: BeatDigestLine;
  /** 按顺序连起来的节拍名，例如「钩子 → 铺垫 → 升级」 */
  arc: string;
};

export function digestBeats(beats: BeatSpan[]): BeatDigest {
  const totalMs = beats.reduce((sum, beat) => sum + beat.durationMs, 0);
  const lines: BeatDigestLine[] = beats.map((beat) => {
    const covered = beat.hasInformation && beat.hasEmotion;
    return {
      id: beat.id,
      kind: beat.kind,
      label: BEAT_LABEL[beat.kind],
      task: BEAT_TASK[beat.kind],
      sceneLabel: beat.sceneLabel,
      shotNos: beat.shotNos,
      shotCount: beat.shotIds.length,
      seconds: beat.durationMs / 1000,
      sharePct: totalMs > 0 ? Math.round((beat.durationMs / totalMs) * 100) : 0,
      covered,
      missing: covered ? null : beat.hasInformation ? "emotion" : "information",
    };
  });

  const longest = lines.reduce<BeatDigestLine | undefined>(
    (best, line) => (!best || line.seconds > best.seconds ? line : best),
    undefined,
  );

  return {
    lines,
    totalSeconds: totalMs / 1000,
    count: lines.length,
    covered: lines.filter((line) => line.covered).length,
    longest,
    arc: lines.map((line) => line.label).join(" → "),
  };
}

export type StoryboardRule =
  | "V1"
  | "V2"
  | "V3"
  | "V4"
  | "V5"
  | "V6"
  | "V7"
  | "V8"
  | "V9"
  | "V10"
  | "V11"
  | "V12"
  | "V13"
  | "V14";

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
  /**
   * 当前视频模型是否吃尾帧。不传按 false：网关目前没有尾帧字段（B12）。
   * 供应商补上之后再传 true，V9 自然不再提示。
   */
  videoAcceptsLastFrame?: boolean;
};

function sceneLabelOf(project: Project, sceneId: string): string {
  const scene = project.scenes.find((item) => item.id === sceneId);
  if (!scene) return "未知场次";
  return `第 ${scene.code || scene.index + 1} 场`;
}

/** 左右调度的简化坐标：左 -1、右 +1；中间与没标的不参与轴线比较。 */
function stagingSides(shot: Shot): Map<string, -1 | 1> {
  const sides = new Map<string, -1 | 1>();
  for (const mark of shot.staging) {
    if (!mark.characterId || mark.side === "center") continue;
    sides.set(mark.characterId, mark.side === "left" ? -1 : 1);
  }
  return sides;
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
        aslSeconds: 0,
        cutsPer10s: 0,
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
  return spans.map((span) => ({
    ...span,
    aslSeconds: span.shotIds.length > 0 ? span.durationMs / span.shotIds.length / 1000 : 0,
    cutsPer10s: span.durationMs > 0 ? span.shotIds.length / (span.durationMs / 10_000) : 0,
  }));
}

/**
 * A13 校验。只返回能在这里可靠判断的规则：
 * V1 建立镜头、V2 台词承载、V3 轴线近似、V4 镜头时长、V5 每拍信息 + 情绪、
 * V6 同景别连续、V7 切率、V8 预算、V9 尾帧能力、V10 表演设计、V11 节拍顺序。
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

  // V3：同一场相邻两镜里，两个角色的左右关系不能翻。
  // 有坐标（B13.1）时用几何判精确越轴；没有坐标时退回 B17 的 left / right 近似，
  // 文案区分「越轴」与「像越轴」。
  const precisePairs = new Set<string>();
  for (const scene of [...project.scenes].sort((a, b) => a.index - b.index)) {
    if (!project.locations.find((item) => item.id === scene.locationId)?.space) continue;
    const report = checkAxis(project, scene.id);
    if (report.checked === 0) continue;
    const byId = new Map(project.shots.map((shot) => [shot.id, shot]));
    for (let index = 1; index < scene.shotIds.length; index += 1) {
      const previous = scene.shotIds[index - 1]!;
      const current = scene.shotIds[index]!;
      if (!byId.get(previous)?.camera.placement || !byId.get(current)?.camera.placement) continue;
      precisePairs.add(`${previous}|${current}`);
    }
    for (const violation of report.violations) {
      const [previous, current] = violation.shotIds as [string, string];
      const beforeNo = plans.find((plan) => plan.shotId === previous)?.no ?? 0;
      const afterNo = plans.find((plan) => plan.shotId === current)?.no ?? 0;
      issues.push({
        rule: "V3",
        severity: "warning",
        message: `第 ${beforeNo} → ${afterNo} 镜：越轴了——机位跨到了 180° 轴线另一侧（按走位坐标判定）：插一个中性镜，或把其中一镜挪回同一侧。`,
        shotIds: violation.shotIds,
      });
    }
  }

  for (let index = 1; index < plans.length; index += 1) {
    const previous = plans[index - 1]!;
    const current = plans[index]!;
    if (previous.sceneId !== current.sceneId) continue;
    // 有坐标的那一对已经精确判过，不再用调度近似重复报
    if (precisePairs.has(`${previous.shotId}|${current.shotId}`)) continue;
    const beforeShot = shotById.get(previous.shotId);
    const afterShot = shotById.get(current.shotId);
    if (!beforeShot || !afterShot) continue;
    const before = stagingSides(beforeShot);
    const after = stagingSides(afterShot);
    const shared = [...before.keys()].filter((id) => after.has(id));
    if (shared.length < 2) continue;

    const flipped = new Set<string>();
    for (let left = 0; left < shared.length; left += 1) {
      for (let right = left + 1; right < shared.length; right += 1) {
        const beforeGap = before.get(shared[left]!)! - before.get(shared[right]!)!;
        const afterGap = after.get(shared[left]!)! - after.get(shared[right]!)!;
        if (beforeGap !== 0 && afterGap !== 0 && Math.sign(beforeGap) !== Math.sign(afterGap)) {
          flipped.add(shared[left]!);
          flipped.add(shared[right]!);
        }
      }
    }
    if (flipped.size === 0) continue;

    const names = [...flipped]
      .slice(0, 3)
      .map((id) => project.characters.find((item) => item.id === id)?.name ?? "角色")
      .join("、");
    issues.push({
      rule: "V3",
      severity: "warning",
      message: `第 ${previous.no} → ${current.no} 镜：${names}的左右位置翻了，像越过了 180° 轴线：插一个中性镜，或把其中一镜的调度改回来。`,
      shotIds: [previous.shotId, current.shotId],
    });
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

  // V7：切率曲线。该碎的拍（钩子 / 升级 / 转折 / 高潮 / 尾钩）不能比全片慢太多：
  // 平均镜长 >= 全片 1.6 倍且 >= 3.5 秒，或一拍只有一镜 4 秒以上，都提示。
  const totalMs = plans.reduce((sum, plan) => sum + plan.durationMs, 0);
  const filmAsl = plans.length > 0 ? totalMs / plans.length / 1000 : 0;
  const intenseBeats = new Set<BeatKind>(["hook", "escalation", "turn", "climax", "endHook"]);
  for (const beat of beats) {
    if (!intenseBeats.has(beat.kind) || beat.durationMs < 4000) continue;
    const singleLongShot = beat.shotIds.length === 1;
    if (!singleLongShot && beat.aslSeconds < Math.max(3.5, filmAsl * 1.6)) continue;
    if (filmAsl <= 0) continue;
    const length =
      beat.shotIds.length === 1
        ? `只有 1 个镜头`
        : `${beat.shotIds.length} 镜、平均 ${beat.aslSeconds.toFixed(1)} 秒一镜`;
    issues.push({
      rule: "V7",
      severity: "warning",
      message: `${beat.sceneLabel}「${BEAT_LABEL[beat.kind]}」这一拍 ${(beat.durationMs / 1000).toFixed(1)} 秒${length}，全片平均 ${filmAsl.toFixed(1)} 秒一镜：这一拍要更碎，补反应镜或拆镜。`,
      shotIds: beat.shotIds,
      beatId: beat.id,
    });
  }

  // V10：表演设计（B16 / B17）。不拦生成，只在检查里点名：
  // 存量项目没有 PerformanceSpec，硬拦会把已有片子锁死（ADR-0103）。
  const missingPerformance = plans.filter((plan) => {
    const shot = shotById.get(plan.shotId);
    return !shot?.performance || !shot.performance.objective.trim();
  });
  if (missingPerformance.length > 0) {
    const nos = missingPerformance.map((plan) => `第 ${plan.no} 镜`);
    const shown = nos.slice(0, 8).join("、");
    const tail = nos.length > 8 ? ` 等 ${nos.length} 镜` : "";
    issues.push({
      rule: "V10",
      severity: "warning",
      message: `${shown}${tail}还没有表演设计：补上 objective 与视线，首尾帧与视频提示词才会写到表情和看谁。`,
      shotIds: missingPerformance.map((plan) => plan.shotId),
    });
  }

  // V10 续（I11 / ADR-0220）：有了表演设计之后，再查它与表演语法对不对得上。
  // 只判两条能确定的：强度 4–5 却写了大动作、认出意图却没写 avoid。
  for (const plan of plans) {
    const shot = shotById.get(plan.shotId);
    const performance = shot?.performance;
    if (!performance || !performance.objective.trim()) continue;
    const advice = performanceAdvice({
      objective: performance.objective,
      intensity: performance.intensity,
      beats: performance.beats.map((beat) => ({
        micro: beat.micro,
        body: beat.body,
        action: beat.action,
      })),
      avoid: performance.avoid,
    });
    for (const problem of advice.problems) {
      issues.push({
        rule: "V10",
        severity: "warning",
        message: `第 ${plan.no} 镜${problem}`,
        shotIds: [plan.shotId],
      });
    }
  }

  // V12：立面与遮挡（B13.2）。只在有机位坐标时判；没坐标的项目一个字都不说，
  // 免得把「没画走位」说成「有遮挡」。两条都是提示，不拦生成。
  const occluded: { no: number; shotId: string; names: string[] }[] = [];
  const angleDrift: { no: number; shotId: string; said: string; geometry: string }[] = [];
  for (const plan of plans) {
    const shot = shotById.get(plan.shotId);
    if (!shot?.camera.placement) continue;
    const found = occlusionsOf(project, shot);
    if (found.length > 0) {
      occluded.push({
        no: plan.no,
        shotId: shot.id,
        names: found.map((item) => item.label),
      });
    }
    const elevation = elevationOf(project, shot);
    if (elevation && !elevation.agrees) {
      angleDrift.push({
        no: plan.no,
        shotId: shot.id,
        said: SHOT_ANGLE_CN[elevation.declaredAngle],
        geometry: SHOT_ANGLE_CN[elevation.angleFromGeometry],
      });
    }
  }
  if (occluded.length > 0) {
    const shown = occluded.slice(0, 5).map((item) => `第 ${item.no} 镜（${item.names.slice(0, 2).join("、")}）`);
    const tail = occluded.length > 5 ? ` 等 ${occluded.length} 镜` : "";
    issues.push({
      rule: "V12",
      severity: "warning",
      message: `${shown.join("、")}${tail}的视线被挡住了：挪开挡在前面的人或家具，或者把机位抬高、换一个机位。`,
      shotIds: occluded.map((item) => item.shotId),
    });
  }
  if (angleDrift.length > 0) {
    const shown = angleDrift
      .slice(0, 5)
      .map((item) => `第 ${item.no} 镜写的「${item.said}」、坐标算出来是「${item.geometry}」`);
    const tail = angleDrift.length > 5 ? ` 等 ${angleDrift.length} 镜` : "";
    issues.push({
      rule: "V12",
      severity: "warning",
      message: `${shown.join("；")}${tail}：机位高度与角度档位对不上，提示词会同时说两件事。改高度或改档位。`,
      shotIds: angleDrift.map((item) => item.shotId),
    });
  }

  // V9：尾帧能力。画面画了尾帧，但网关只把首帧送给视频模型时，尾帧只是参考。
  if (!(options.videoAcceptsLastFrame ?? false)) {
    const withLastFrame = plans.filter((plan) => {
      const shot = shotById.get(plan.shotId);
      return Boolean(shot?.keyframes.lastAssetId);
    });
    if (withLastFrame.length > 0) {
      const nos = withLastFrame.map((plan) => `第 ${plan.no} 镜`);
      const shown = nos.slice(0, 6).join("、");
      const tail = nos.length > 6 ? ` 等 ${nos.length} 镜` : "";
      issues.push({
        rule: "V9",
        severity: "warning",
        message: `${shown}${tail}已经画了尾帧，但当前视频模型只吃首帧（网关没有尾帧字段）：尾帧不会送进视频，落点与口型只能靠提示词。`,
        shotIds: withLastFrame.map((plan) => plan.shotId),
      });
    }
  }

  // V11：节拍顺序（A11）。开场要钩子、结尾要尾钩，同一场里不能倒退。
  if (plans.length >= 2) {
    const first = plans[0]!;
    if (first.beat !== "hook") {
      issues.push({
        rule: "V11",
        severity: "warning",
        message: `全片第一镜是「${BEAT_LABEL[first.beat]}」，不是钩子：前 3 秒先给一个能抓住人的画面。`,
        shotIds: [first.shotId],
      });
    }
    const last = plans.at(-1)!;
    if (last.beat !== "endHook") {
      issues.push({
        rule: "V11",
        severity: "warning",
        message: `最后一镜是「${BEAT_LABEL[last.beat]}」，不是尾钩：结尾留一个新悬念，观众才会追下一集。`,
        shotIds: [last.shotId],
      });
    }
    const rank = new Map(BEAT_ORDER.map((kind, index) => [kind, index]));
    for (let index = 1; index < plans.length; index += 1) {
      const previous = plans[index - 1]!;
      const current = plans[index]!;
      if (previous.sceneId !== current.sceneId) continue;
      if ((rank.get(current.beat) ?? 0) >= (rank.get(previous.beat) ?? 0)) continue;
      issues.push({
        rule: "V11",
        severity: "warning",
        message: `第 ${previous.no} → ${current.no} 镜：节拍从「${BEAT_LABEL[previous.beat]}」回到「${BEAT_LABEL[current.beat]}」，在倒退：确认这是新的一轮冲突，否则把后面的拍往前推。`,
        shotIds: [previous.shotId, current.shotId],
      });
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

  // V13：手持单场 ≤ 2（M4 / DIRECTOR-GRAMMAR.md §五）。手持过量会晕，
  // 而「晕」是整体感受——逐镜看不出问题，只有按场数才知道。
  const handheldByScene = new Map<string, { no: number; shotId: string }[]>();
  for (const plan of plans) {
    const shot = shotById.get(plan.shotId);
    if (shot?.camera.movement !== "handheld") continue;
    const list = handheldByScene.get(plan.sceneId) ?? [];
    list.push({ no: plan.no, shotId: plan.shotId });
    handheldByScene.set(plan.sceneId, list);
  }
  for (const [sceneId, list] of handheldByScene) {
    if (list.length <= 2) continue;
    const sceneLabel = plans.find((plan) => plan.sceneId === sceneId)?.sceneLabel ?? "这一场";
    const nos = list.map((item) => `第 ${item.no} 镜`).join("、");
    issues.push({
      rule: "V13",
      severity: "warning",
      message: `${sceneLabel}有 ${list.length} 个手持镜（${nos}）：手持过量会晕，一场控制在 2 镜以内。`,
      shotIds: list.map((item) => item.shotId),
    });
  }

  // V14：荷兰角单场 ≤ 1（A4 / DIRECTOR-GRAMMAR.md §四）。
  // dutch 是画面滚转，连用两次会让观众晕；单场一次是「失衡」，
  // 两次以上就只是「这个导演只会这一招」。
  const dutchByScene = new Map<string, { no: number; shotId: string }[]>();
  for (const plan of plans) {
    const shot = shotById.get(plan.shotId);
    if (shot?.camera.angle !== "dutch") continue;
    const list = dutchByScene.get(plan.sceneId) ?? [];
    list.push({ no: plan.no, shotId: plan.shotId });
    dutchByScene.set(plan.sceneId, list);
  }
  for (const [sceneId, list] of dutchByScene) {
    if (list.length <= 1) continue;
    const sceneLabel = plans.find((plan) => plan.sceneId === sceneId)?.sceneLabel ?? "这一场";
    const nos = list.map((item) => `第 ${item.no} 镜`).join("、");
    issues.push({
      rule: "V14",
      severity: "warning",
      message: `${sceneLabel}有 ${list.length} 个荷兰角（${nos}）：一场最多一个，连用会让观众晕。`,
      shotIds: list.map((item) => item.shotId),
    });
  }

  return issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    return a.rule.localeCompare(b.rule, undefined, { numeric: true });
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
