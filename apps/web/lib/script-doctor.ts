/**
 * 剧本医生（A18 / ADR-0123）——第一档：本地报告。
 *
 * 报告是当前剧本的函数，**不进 IR**：改一句台词，重开抽屉就变。12 个维度里
 * 10 个本地可算，`emotionalPayoff` 要模型判断、`originality` 等 A8，
 * 两者如实写「未测」，不填 0 分——0 分是「很差」，未测是「不知道」。
 *
 * 分数是词法与结构的估计，不是审美判断。界面每维都要写清它读的是什么。
 * 第一档只给方向，不改字；模型改写（第二档）与「采用」都还没接。
 */

import type { Project } from "@loomina/ir";
import { scoreLogline, type LoglineScore } from "@loomina/pipeline";
import { BEAT_LABEL, groupBeats, planShots } from "./storyboard";

export type DoctorSource = "local" | "model" | "unmeasured";

export type DoctorDimensionKey =
  | "hook"
  | "premiseClarity"
  | "desireObstacleStakes"
  | "beatDensity"
  | "reversal"
  | "characterAgency"
  | "relationshipTension"
  | "dialogueEfficiency"
  | "emotionalPayoff"
  | "endHook"
  | "feasibility"
  | "originality";

export type DoctorDimension = {
  key: DoctorDimensionKey;
  label: string;
  /** 1–5；null 表示这一项没算（未测，或没有可算的内容） */
  score: number | null;
  source: DoctorSource;
  reason: string;
};

export type DoctorFinding = {
  /** 对应 STORY.md 第七节的触发条件 */
  key: string;
  severity: "warn" | "info";
  dimension: DoctorDimensionKey;
  message: string;
  shotIds: string[];
};

export type DoctorMode =
  | "strengthenHook"
  | "addReversal"
  | "trimExposition"
  | "sharpenConflict"
  | "reduceCast"
  | "rewriteEnding";

export const DOCTOR_MODE_LABEL: Record<DoctorMode, string> = {
  strengthenHook: "强化钩子",
  addReversal: "加反转",
  trimExposition: "删解释",
  sharpenConflict: "锐化冲突",
  reduceCast: "减人物 / 减场景",
  rewriteEnding: "重写结尾",
};

export type DoctorSuggestion = {
  mode: DoctorMode;
  label: string;
  /** 改哪里：镜号、关系或结构 */
  target: string;
  /** 第一档的改写方向：指出问题与方向，不替作者写字 */
  direction: string;
  /** 这一条现在是否用得上 */
  applicable: boolean;
  shotIds: string[];
};

export type ScriptDoctorReport = {
  dims: DoctorDimension[];
  /** 已测维度的均值（1–5，一位小数）；一维都没测时为 null */
  overall: number | null;
  measured: number;
  total: number;
  findings: DoctorFinding[];
  suggestions: DoctorSuggestion[];
  summary: {
    warn: number;
    info: number;
    /** 总分落在哪一档，只用于一句话结论 */
    verdict: "偏低" | "及格" | "不错" | "未测";
  };
  /** 全片时长（秒），按镜头时长累加 */
  seconds: number;
  /** 镜 id → 全片镜号；抽屉点「去这一镜」用 */
  shotNos: Record<string, number>;
};

export type DoctorOptions = {
  /** 已经有 logline 分数时传进来，省一次重复计算 */
  loglineScore?: LoglineScore;
};

/** 可拍性的范围（STORY.md：60–180 秒、≤3 场、≤5 人、≤14 镜） */
export const FEASIBILITY_LIMITS = {
  scenes: 3,
  characters: 5,
  shots: 14,
  minSeconds: 60,
  maxSeconds: 180,
} as const;

const DIMENSION_LABEL: Record<DoctorDimensionKey, string> = {
  hook: "Hook 强度",
  premiseClarity: "前提清晰度",
  desireObstacleStakes: "欲望 / 障碍 / 代价",
  beatDensity: "Beat 密度",
  reversal: "反转质量",
  characterAgency: "人物主动性",
  relationshipTension: "关系张力",
  dialogueEfficiency: "台词效率",
  emotionalPayoff: "情绪兑现",
  endHook: "结尾钩子",
  feasibility: "可拍性",
  originality: "原创性",
};

function clampScore(value: number): number {
  return Math.max(1, Math.min(5, Math.round(value)));
}

function shotLabel(no: number): string {
  return `SH-${String(no).padStart(2, "0")}`;
}

function rate(filled: number, total: number): number {
  return total > 0 ? filled / total : 0;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * 本地 12 维报告。纯函数：不写事件、不改项目、不调模型。
 */
export function analyzeScript(
  project: Project,
  options: DoctorOptions = {},
): ScriptDoctorReport {
  const plans = planShots(project);
  const beats = groupBeats(plans);
  const shots = plans.length;
  const seconds = plans.reduce((sum, plan) => sum + plan.durationMs, 0) / 1000;
  const story = project.story;
  const dims: DoctorDimension[] = [];
  const findings: DoctorFinding[] = [];

  const push = (
    key: DoctorDimensionKey,
    score: number | null,
    source: DoctorSource,
    reason: string,
  ) => {
    dims.push({ key, label: DIMENSION_LABEL[key], score, source, reason });
  };

  // 1. Hook：首镜是不是钩子、够不够短，前 15 秒有没有升级 / 转折。
  //    这是结构代理，不是审美判断——回答不了「这个钩子抓不抓人」。
  if (shots === 0) {
    push("hook", 1, "local", "还没有镜头，谈不上开场。");
  } else {
    const first = plans[0]!;
    const firstBeat = first.beat;
    const shortEnough = first.durationMs <= 3000;
    const earlyShift = plans.some(
      (plan) =>
        plan.startMs < 15_000 && (plan.beat === "turn" || plan.beat === "escalation"),
    );
    let score = 2;
    if (firstBeat === "hook") score += 1;
    if (shortEnough) score += 1;
    if (earlyShift) score += 1;
    push(
      "hook",
      clampScore(score),
      "local",
      [
        `首镜 ${shotLabel(first.no)} 是「${BEAT_LABEL[firstBeat]}」、${(first.durationMs / 1000).toFixed(1)}s`,
        earlyShift ? "前 15 秒内出现升级或转折" : "前 15 秒没有升级或转折",
        "这里只查结构，不判断钩子抓不抓人",
      ].join("；"),
    );
    if (score < 3) {
      findings.push({
        key: "hook",
        severity: "warn",
        dimension: "hook",
        message: `首镜 ${shotLabel(first.no)} 不像钩子：${
          firstBeat !== "hook" ? "它不是钩子拍" : "它太长"
        }${earlyShift ? "" : "，前 15 秒也没有升级或转折"}。`,
        shotIds: [first.shotId],
      });
    }
  }

  // 2. 前提清晰度：复用 logline 六维里的冲突与代价两维。
  const loglineScore =
    options.loglineScore ?? scoreLogline(story.logline, undefined);
  const loglineText = story.logline.trim();
  if (!loglineText) {
    push("premiseClarity", 1, "local", "还没有 logline：一句话说不清这条片讲什么。");
    findings.push({
      key: "premise",
      severity: "warn",
      dimension: "premiseClarity",
      message: "还没有 logline：先用一句话写清谁想要什么、谁挡着。",
      shotIds: [],
    });
  } else {
    const conflict = loglineScore.dims.find((dim) => dim.key === "conflict")?.score ?? 1;
    const stake = loglineScore.dims.find((dim) => dim.key === "stake")?.score ?? 1;
    const score = clampScore((conflict + stake) / 2);
    push(
      "premiseClarity",
      score,
      "local",
      `logline 的冲突 ${conflict}/5、代价 ${stake}/5（logline 六维里取这两项）。`,
    );
  }

  // 3. 欲望 / 障碍 / 代价：弧光的 want / need / flaw 填写率 + 有没有张力关系。
  const arcs = story.arcs;
  if (arcs.length === 0) {
    push(
      "desireObstacleStakes",
      1,
      "local",
      "还没有人物弧光：先写主角想要什么、缺什么、哪里会做错。",
    );
    findings.push({
      key: "desire",
      severity: "warn",
      dimension: "desireObstacleStakes",
      message: "没有人物弧光：欲望 / 障碍 / 代价都还空着。",
      shotIds: [],
    });
  } else {
    const fields = arcs.flatMap((arc) => [arc.want, arc.need, arc.flaw]);
    const filled = fields.filter((field) => field.trim()).length;
    const tension = story.relationships.filter((item) => item.tension.trim()).length;
    const score = clampScore(1 + rate(filled, fields.length) * 3 + (tension > 0 ? 1 : 0));
    push(
      "desireObstacleStakes",
      score,
      "local",
      `弧光三格填了 ${filled}/${fields.length}（想要 / 需要 / 缺陷）；${
        tension > 0 ? `有 ${tension} 对关系写了张力` : "还没有一对关系写了张力"
      }。`,
    );
    if (score < 3) {
      findings.push({
        key: "desire",
        severity: "warn",
        dimension: "desireObstacleStakes",
        message: `欲望 / 障碍 / 代价不成立：弧光只填了 ${filled}/${fields.length} 格，${
          tension > 0 ? "" : "关系里也没有张力。"
        }`,
        shotIds: [],
      });
    }
  }

  // 4. Beat 密度：每 20 秒有几拍。少于 1 拍触发（STORY.md）。
  const beatCount = beats.length;
  const per20 = seconds > 0 ? beatCount / (seconds / 20) : 0;
  if (seconds === 0) {
    push("beatDensity", 1, "local", "还没有时长，算不出密度。");
  } else {
    const score = clampScore(1 + per20);
    push(
      "beatDensity",
      score,
      "local",
      `${beatCount} 拍 / ${seconds.toFixed(1)}s ≈ 每 20 秒 ${per20.toFixed(1)} 拍（STORY.md 要求 ≥ 1）。`,
    );
    if (per20 < 1) {
      findings.push({
        key: "beatDensity",
        severity: "warn",
        dimension: "beatDensity",
        message: `Beat 密度偏低：每 20 秒只有 ${per20.toFixed(1)} 拍，该碎的段落没有增量。`,
        shotIds: [],
      });
    }
  }

  // 5. 反转：有没有 turn / climax 拍。
  const hasTurn = beats.some((beat) => beat.kind === "turn");
  const hasClimax = beats.some((beat) => beat.kind === "climax");
  const reversalScore = clampScore(2 + (hasTurn ? 2 : 0) + (hasClimax ? 1 : 0));
  push(
    "reversal",
    reversalScore,
    "local",
    hasTurn
      ? `有转折拍${hasClimax ? "，也有高潮拍" : "，但没有高潮拍"}。`
      : `没有转折拍${hasClimax ? "（有高潮拍）" : "，也没有高潮拍"}。`,
  );
  if (!hasTurn) {
    findings.push({
      key: "reversal",
      severity: "info",
      dimension: "reversal",
      message: "全片没有转折拍：25–40 秒处可以放一次认知变化。",
      shotIds: [],
    });
  }

  // 6. 人物主动性：弧光的 agency 填写率 + 主角有没有出场。
  const protagonist = protagonistOf(project);
  const protagonistShots = protagonist
    ? plans.filter((plan) =>
        project.shots
          .find((shot) => shot.id === plan.shotId)
          ?.characterIds.includes(protagonist.id),
      )
    : [];
  if (arcs.length === 0) {
    push("characterAgency", 1, "local", "还没有人物弧光，主动性无从谈起。");
  } else {
    const filled = arcs.filter((arc) => arc.agency.trim()).length;
    let score = clampScore(1 + rate(filled, arcs.length) * 4);
    if (protagonist && protagonistShots.length === 0) score = Math.min(score, 2);
    push(
      "characterAgency",
      score,
      "local",
      `${filled}/${arcs.length} 条弧光写了主动性；${
        protagonist
          ? `主角「${protagonist.name}」出现在 ${protagonistShots.length} 镜`
          : "还没有角色"
      }。`,
    );
  }

  // 7. 关系张力：关系数与张力填写率。
  const relationships = story.relationships;
  if (relationships.length === 0) {
    push("relationshipTension", 1, "local", "还没有写人物关系：对手是谁还不清楚。");
    findings.push({
      key: "relationship",
      severity: "info",
      dimension: "relationshipTension",
      message: "还没有人物关系：补一对「谁想要谁、谁怕谁、谁瞒谁」。",
      shotIds: [],
    });
  } else {
    const filled = relationships.filter((item) => item.tension.trim()).length;
    push(
      "relationshipTension",
      clampScore(1 + rate(filled, relationships.length) * 4),
      "local",
      `${relationships.length} 对关系，${filled} 对写了张力。`,
    );
  }

  // 8. 台词效率：平均字数 > 15 触发；单镜超过 2 句也扣分。
  const lines = project.dialogue;
  if (lines.length === 0) {
    push(
      "dialogueEfficiency",
      null,
      "local",
      "还没有台词：这一项没有可算的内容（默片不算差）。",
    );
  } else {
    const chars = lines.reduce((sum, line) => sum + [...line.text].length, 0);
    const average = chars / lines.length;
    const crowded = plans.filter((plan) => {
      const shot = project.shots.find((item) => item.id === plan.shotId);
      return (shot?.dialogueIds.length ?? 0) > 2;
    });
    let score = average > 15 ? 2 : average > 10 ? 3 : average > 7 ? 4 : 5;
    if (crowded.length > 0) score -= 1;
    const longest = [...lines]
      .sort((a, b) => [...b.text].length - [...a.text].length)
      .slice(0, 3);
    push(
      "dialogueEfficiency",
      clampScore(score),
      "local",
      `${lines.length} 句，平均 ${average.toFixed(1)} 字（> 15 触发）；${
        crowded.length > 0
          ? `${crowded.length} 镜塞了 2 句以上`
          : "没有一镜塞 2 句以上"
      }。最长三句：${longest.map((line) => `「${line.text}」`).join("、")}。`,
    );
    if (average > 15) {
      findings.push({
        key: "dialogueLength",
        severity: "warn",
        dimension: "dialogueEfficiency",
        message: `平均台词 ${average.toFixed(1)} 字，超过 15：先删解释，把说明改成行动。`,
        shotIds: crowded.map((plan) => plan.shotId),
      });
    } else if (crowded.length > 0) {
      findings.push({
        key: "dialogueCrowded",
        severity: "info",
        dimension: "dialogueEfficiency",
        message: `${crowded.length} 镜塞了 2 句以上台词：一句台词通常只需要一个镜头。`,
        shotIds: crowded.map((plan) => plan.shotId),
      });
    }
  }

  // 9. 情绪兑现：需要模型判断，第一版标未测。
  push(
    "emotionalPayoff",
    null,
    "model",
    "要模型判断爽点 / 泪点是否到位，第一版不调模型：未测。",
  );

  // 10. 结尾钩子：story.hooks.ending 非空 + 末拍是 endHook。
  const endingHook = story.hooks.ending.trim();
  const lastBeat = plans.at(-1)?.beat;
  let endScore = 1;
  if (endingHook) endScore += 2;
  if (lastBeat === "endHook") endScore += 2;
  push(
    "endHook",
    clampScore(endScore),
    "local",
    `${endingHook ? "写了结尾钩子" : "没有写结尾钩子"}；${
      lastBeat ? `末镜是「${BEAT_LABEL[lastBeat]}」` : "没有末镜"
    }。`,
  );
  if (!endingHook || lastBeat !== "endHook") {
    findings.push({
      key: "endHook",
      severity: "warn",
      dimension: "endHook",
      message: !endingHook
        ? "没有结尾钩子：最后一句要留一个没解决的问题。"
        : "末镜不是尾钩拍：把结尾的悬念放进最后一镜。",
      shotIds: plans.length > 0 ? [plans.at(-1)!.shotId] : [],
    });
  }

  // 11. 可拍性：场、人、镜、时长。
  const cast = project.characters.length;
  const scenes = project.scenes.length;
  const overScenes = scenes > FEASIBILITY_LIMITS.scenes;
  const overCast = cast > FEASIBILITY_LIMITS.characters;
  const overShots = shots > FEASIBILITY_LIMITS.shots;
  const overTime =
    seconds > FEASIBILITY_LIMITS.maxSeconds || (shots > 0 && seconds < FEASIBILITY_LIMITS.minSeconds);
  const violations = [overScenes, overCast, overShots, overTime].filter(Boolean).length;
  push(
    "feasibility",
    clampScore(5 - violations),
    "local",
    `${scenes} 场（≤ ${FEASIBILITY_LIMITS.scenes}）· ${cast} 人（≤ ${FEASIBILITY_LIMITS.characters}）· ${shots} 镜（≤ ${FEASIBILITY_LIMITS.shots}）· ${seconds.toFixed(1)}s（${FEASIBILITY_LIMITS.minSeconds}–${FEASIBILITY_LIMITS.maxSeconds}s）。`,
  );
  if (overScenes) {
    findings.push({
      key: "tooManyScenes",
      severity: "warn",
      dimension: "feasibility",
      message: `${scenes} 场超过 ${FEASIBILITY_LIMITS.scenes} 场：合并同地点的场，降成本也提清晰度。`,
      shotIds: [],
    });
  }
  if (overCast) {
    findings.push({
      key: "tooManyCharacters",
      severity: "warn",
      dimension: "feasibility",
      message: `${cast} 个角色超过 ${FEASIBILITY_LIMITS.characters} 人：合并次要人物。`,
      shotIds: [],
    });
  }
  if (overTime) {
    findings.push({
      key: "duration",
      severity: "warn",
      dimension: "feasibility",
      message:
        seconds > FEASIBILITY_LIMITS.maxSeconds
          ? `时长 ${seconds.toFixed(1)}s 超过 ${FEASIBILITY_LIMITS.maxSeconds}s：拆成两集，或砍拍。`
          : `时长 ${seconds.toFixed(1)}s 不到 ${FEASIBILITY_LIMITS.minSeconds}s：短剧单集太短，补拍或加时长。`,
      shotIds: [],
    });
  }
  if (overShots) {
    findings.push({
      key: "tooManyShots",
      severity: "info",
      dimension: "feasibility",
      message: `${shots} 镜超过 ${FEASIBILITY_LIMITS.shots} 镜：先看有没有重复信息镜。`,
      shotIds: [],
    });
  }

  // 12. 原创性：等 A8 的相似度检查。
  push(
    "originality",
    null,
    "unmeasured",
    "原创性要等 A8 的相似度检查（n-gram / embedding），现在没有数据：未测。",
  );

  const measured = dims.filter((dim) => dim.score !== null);
  const overall =
    measured.length > 0
      ? Math.round(
          (measured.reduce((sum, dim) => sum + (dim.score ?? 0), 0) / measured.length) * 10,
        ) / 10
      : null;
  const warn = findings.filter((item) => item.severity === "warn").length;
  const info = findings.length - warn;

  return {
    dims,
    overall,
    measured: measured.length,
    total: dims.length,
    findings: findings.sort((a, b) =>
      a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1,
    ),
    suggestions: suggestionsOf(project, plans, beats, seconds),
    summary: {
      warn,
      info,
      verdict:
        overall === null ? "未测" : overall >= 4 ? "不错" : overall >= 3 ? "及格" : "偏低",
    },
    seconds,
    shotNos: Object.fromEntries(plans.map((plan) => [plan.shotId, plan.no])),
  };
}

/** 出场最多的角色当作主角；平手取角色表里靠前的那个。 */
function protagonistOf(project: Project): Project["characters"][number] | undefined {
  if (project.characters.length === 0) return undefined;
  const count = new Map<string, number>();
  for (const shot of project.shots) {
    for (const id of shot.characterIds) count.set(id, (count.get(id) ?? 0) + 1);
  }
  let best = project.characters[0]!;
  for (const character of project.characters) {
    if ((count.get(character.id) ?? 0) > (count.get(best.id) ?? 0)) best = character;
  }
  return best;
}

/**
 * 六种改写模式的第一档建议：指出改哪里、往哪个方向改。
 *
 * 不替作者写字：改写是创作决定（ADR-0123 决策 4）。第二档的模型改写还没接，
 * 界面里写清「只给方向」。
 */
function suggestionsOf(
  project: Project,
  plans: ReturnType<typeof planShots>,
  beats: ReturnType<typeof groupBeats>,
  seconds: number,
): DoctorSuggestion[] {
  const first = plans[0];
  const last = plans.at(-1);
  const lines = [...project.dialogue].sort(
    (a, b) => [...b.text].length - [...a.text].length,
  );
  const weakest = project.story.relationships.find((item) => !item.tension.trim());
  const hasTurn = beats.some((beat) => beat.kind === "turn");
  const middle = plans.filter((plan) => plan.startMs >= 25_000 && plan.startMs <= 40_000);
  const crowded = plans.filter((plan) => {
    const shot = project.shots.find((item) => item.id === plan.shotId);
    return (shot?.dialogueIds.length ?? 0) > 2;
  });

  return [
    {
      mode: "strengthenHook",
      label: DOCTOR_MODE_LABEL.strengthenHook,
      target: first ? `首镜 ${shotLabel(first.no)}（${BEAT_LABEL[first.beat]}）` : "还没有镜头",
      direction: first
        ? first.durationMs > 3000
          ? `首镜 ${(first.durationMs / 1000).toFixed(1)}s，太长：压到 3 秒内，先给冲突或悬念，别先交代环境。`
          : first.beat === "hook"
            ? "首镜已经是钩子拍、也够短：看它有没有一个具体的动作或一句刺人的台词。"
            : `首镜是「${BEAT_LABEL[first.beat]}」：把它改成钩子拍，或把后面更抓人的一镜提到最前。`
        : "先有镜头再谈钩子。",
      applicable: first !== undefined,
      shotIds: first ? [first.shotId] : [],
    },
    {
      mode: "addReversal",
      label: DOCTOR_MODE_LABEL.addReversal,
      target:
        middle.length > 0
          ? `25–40 秒：${middle.map((plan) => shotLabel(plan.no)).join("、")}`
          : "25–40 秒（当前没有镜头落在这一段）",
      direction: hasTurn
        ? "已经有转折拍：看它是不是「意外且合理」，不合理就换成前面埋过的东西。"
        : middle.length > 0
          ? "这里没有转折：让其中一个角色知道一件观众也不知道的事，或把已知信息反过来。"
          : `全片只有 ${seconds.toFixed(1)}s，25–40 秒是空的：先按时长找位置，再放认知变化。`,
      applicable: !hasTurn && middle.length > 0,
      shotIds: middle.map((plan) => plan.shotId),
    },
    {
      mode: "trimExposition",
      label: DOCTOR_MODE_LABEL.trimExposition,
      target:
        lines.length > 0
          ? `最长的三句：${lines
              .slice(0, 3)
              .map((line) => `「${line.text}」`)
              .join("、")}`
          : "还没有台词",
      direction:
        lines.length === 0
          ? "没有台词，不用删。"
          : `把「我早就知道」这类解释改成动作或沉默；${crowded.length > 0 ? `另外 ${crowded.length} 镜塞了 2 句以上，拆开或删一句。` : "每镜保持一句台词。"}`,
      applicable: lines.length > 0,
      shotIds: crowded.map((plan) => plan.shotId),
    },
    {
      mode: "sharpenConflict",
      label: DOCTOR_MODE_LABEL.sharpenConflict,
      target: weakest
        ? `张力最弱的一对：${nameOf(project, weakest.fromCharacterId)} → ${nameOf(project, weakest.toCharacterId)}`
        : project.story.relationships.length > 0
          ? "关系都写了张力：看谁更主动"
          : "还没有人物关系",
      direction: weakest
        ? "给这一对补上「想要 / 害怕 / 隐瞒」里的至少一件，并让对手先出手。"
        : project.story.relationships.length > 0
          ? "让对手主动做一件事，而不是只回应主角。"
          : "先写一对关系，再谈冲突。",
      applicable: weakest !== undefined || project.story.relationships.length > 0,
      shotIds: [],
    },
    {
      mode: "reduceCast",
      label: DOCTOR_MODE_LABEL.reduceCast,
      target: `${project.scenes.length} 场 · ${project.characters.length} 人 · ${plans.length} 镜`,
      direction:
        project.scenes.length > FEASIBILITY_LIMITS.scenes ||
        project.characters.length > FEASIBILITY_LIMITS.characters
          ? "超出可拍范围：先合并同地点的场，再把只有一两句台词的次要人物并进主角的对话。工具不会替你删——删角色会牵动镜头、台词与 take。"
          : "场次与人物在范围内，不需要减。",
      applicable:
        project.scenes.length > FEASIBILITY_LIMITS.scenes ||
        project.characters.length > FEASIBILITY_LIMITS.characters,
      shotIds: [],
    },
    {
      mode: "rewriteEnding",
      label: DOCTOR_MODE_LABEL.rewriteEnding,
      target: last ? `末镜 ${shotLabel(last.no)}（${BEAT_LABEL[last.beat]}）` : "还没有镜头",
      direction: last
        ? project.story.hooks.ending.trim()
          ? "结尾钩子已经写了：让最后一镜停在一个没解决的问题上，别把话说满。"
          : "没有结尾钩子：最后一镜留一个新问题，或让某个信息只露出一半。"
        : "先有镜头再谈结尾。",
      applicable: last !== undefined,
      shotIds: last ? [last.shotId] : [],
    },
  ];
}

function nameOf(project: Project, characterId: string): string {
  return project.characters.find((item) => item.id === characterId)?.name ?? characterId;
}
