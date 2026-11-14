import {
  missingSheetAngles,
  requiresSheet,
  shotAnchors,
  type Character,
  type Project,
  type Shot,
} from "@loomina/ir";

/**
 * 一致性体检（B14，ADR-0097）。
 *
 * 这里只查**结构化的锚点是否齐、能不能复核**：定妆三视图、角色参考图、
 * 场景主镜、道具参考、take 的模型与溯源。
 *
 * 不做人脸 embedding、不做 pHash、不做 VLM 比对——这些需要另一条推理链路，
 * 当前仓库没有，也不能用一个算术分数假装看过画面。光影 / 空间 / 表演
 * 三项同理，在报告里明确标「未测」。
 */

export type ConsistencyKey = "identity" | "wardrobe" | "scene" | "style" | "provenance";

export const CONSISTENCY_LABEL: Record<ConsistencyKey, string> = {
  identity: "身份",
  wardrobe: "服化道",
  scene: "场景",
  style: "风格",
  provenance: "溯源",
};

/** 权重只在可测维度之间重新归一；未测维度不参与。 */
export const CONSISTENCY_WEIGHT: Record<ConsistencyKey, number> = {
  identity: 35,
  wardrobe: 20,
  scene: 20,
  style: 15,
  provenance: 10,
};

/** 溯源不是画面一致性，权重最低；它回答「出了问题能不能查」。 */
export type ConsistencyIssue = {
  dimension: ConsistencyKey;
  severity: "error" | "warning";
  message: string;
  /** 能做的一步；没有可执行动作时不给假建议 */
  fix?: string;
};

export type ConsistencyDimension = {
  key: ConsistencyKey;
  label: string;
  /** 0–100；null 表示这一镜没有可测内容（例如没有人物就不评身份） */
  score: number | null;
  weight: number;
};

export type ShotConsistency = {
  shotId: string;
  no: number;
  label: string;
  sceneId: string;
  shotSize: Shot["shotSize"];
  dimensions: ConsistencyDimension[];
  /** 可测维度按权重归一后的分数；都不可测时为 null */
  overall: number | null;
  /** 按景别收紧的通过线（CONSISTENCY.md：特写严、全景松） */
  threshold: number;
  verdict: "pass" | "review" | "fail" | "unknown";
  issues: ConsistencyIssue[];
};

export type ConsistencyReport = {
  shots: ShotConsistency[];
  summary: {
    shots: number;
    pass: number;
    review: number;
    fail: number;
    unknown: number;
    /** 可测镜头的平均分；没有可测镜头时为 0，不除零 */
    average: number;
  };
  /** 需要人看一眼的镜头（review + fail），分数低的在前 */
  attention: ShotConsistency[];
  notMeasured: { key: "lighting" | "spatial" | "performance"; label: string; reason: string }[];
};

const NOT_MEASURED: ConsistencyReport["notMeasured"] = [
  {
    key: "lighting",
    label: "光影（画面比色）",
    reason:
      "主光方向与光源的跨镜一致性在走位台账里查（B4 / ADR-0215）；画面里的实际色温与亮度仍需人眼或视觉模型。",
  },
  {
    key: "spatial",
    label: "空间（轴线）",
    reason:
      "左右翻面、朝向翻转、前后景跳变在走位台账里查（B11）；机位参数与 180° 轴线的几何判定仍未做。",
  },
  {
    key: "performance",
    label: "表演 / 动作",
    reason: "没有视频动作分析，切点与情绪连续性仍需人工看片。",
  },
];

const THRESHOLD: Record<Shot["shotSize"], number> = {
  wide: 80,
  medium: 85,
  close: 90,
  "extreme-close": 90,
};

function shotLabel(no: number): string {
  return `SH-${String(no).padStart(2, "0")}`;
}

/** 场次顺序 → 场内镜序；剩下的孤儿镜头按原顺序补在后面。 */
function orderedShots(project: Project): { shot: Shot; no: number; sceneId: string }[] {
  const seen = new Set<string>();
  const out: { shot: Shot; no: number; sceneId: string }[] = [];
  const scenes = [...project.scenes].sort((a, b) => a.index - b.index);
  for (const scene of scenes) {
    for (const shotId of scene.shotIds) {
      const shot = project.shots.find((item) => item.id === shotId);
      if (!shot || seen.has(shot.id)) continue;
      seen.add(shot.id);
      out.push({ shot, no: out.length + 1, sceneId: scene.id });
    }
  }
  for (const shot of project.shots) {
    if (seen.has(shot.id)) continue;
    seen.add(shot.id);
    out.push({ shot, no: out.length + 1, sceneId: shot.sceneId });
  }
  return out;
}

function clamp(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function average(scores: number[]): number | null {
  if (!scores.length) return null;
  return clamp(scores.reduce((sum, value) => sum + value, 0) / scores.length);
}

/** 锚点里属于某个角色的参考图：`shotAnchors` 的 label 是「名字 · 角度」。 */
function characterRefCount(refs: { label: string }[], character: Character): number {
  return refs.filter((ref) => ref.label.startsWith(`${character.name} · `)).length;
}

function identityOf(
  project: Project,
  shot: Shot,
  anchors: ReturnType<typeof shotAnchors>,
): { score: number | null; issues: ConsistencyIssue[] } {
  if (!shot.characterIds.length) return { score: null, issues: [] };

  const issues: ConsistencyIssue[] = [];
  const perCharacter: number[] = [];
  const wanted = shot.characterIds.length === 1 ? 2 : 1;

  for (const characterId of shot.characterIds) {
    const character = project.characters.find((item) => item.id === characterId);
    if (!character) {
      perCharacter.push(0);
      issues.push({
        dimension: "identity",
        severity: "error",
        message: `镜头引用的角色 ${characterId} 不存在。`,
        fix: "回到定妆页把这一镜的出场角色重新点一遍。",
      });
      continue;
    }

    const refs = characterRefCount(anchors.refs, character);
    let score = 100;

    if (refs === 0) {
      score = 0;
      issues.push({
        dimension: "identity",
        severity: "error",
        message: `「${character.name}」在这一镜没有可用的身份参考：三视图与参考图都缺，或被闸门锁在门外。`,
        fix: "在定妆页补齐三视图；如果已经锁定，确认锁定的资产里包含这个角色的图。",
      });
    } else if (refs < wanted) {
      score -= 25;
      issues.push({
        dimension: "identity",
        severity: "warning",
        message:
          shot.characterIds.length === 1
            ? `「${character.name}」只有 ${refs} 张身份参考：单人镜头建议正面 + 3/4 两张。`
            : `「${character.name}」只有 ${refs} 张身份参考：多人同框每人至少一张，脸才不会混。`,
        fix: "在定妆页补齐正面与 3/4 两格。",
      });
    }

    if (requiresSheet(project, character.id)) {
      const gaps = missingSheetAngles(character);
      if (gaps.length) {
        score -= Math.min(40, gaps.length * 15);
        issues.push({
          dimension: "identity",
          severity: "warning",
          message: `「${character.name}」的三视图缺 ${gaps.length} 格：特写 / 近景时模型更容易换人。`,
          fix: "在定妆页补齐四格；近景优先补正面与 3/4。",
        });
      }
    }

    perCharacter.push(clamp(score));
  }

  return { score: average(perCharacter), issues };
}

function wardrobeOf(
  project: Project,
  shot: Shot,
  anchors: ReturnType<typeof shotAnchors>,
): { score: number | null; issues: ConsistencyIssue[] } {
  const issues: ConsistencyIssue[] = [];
  const scores: number[] = [];

  for (const characterId of shot.characterIds) {
    const character = project.characters.find((item) => item.id === characterId);
    if (!character || character.mustNotChange.length === 0) continue;
    if (character.referenceImages.length > 0) {
      scores.push(100);
      continue;
    }
    scores.push(50);
    issues.push({
      dimension: "wardrobe",
      severity: "warning",
      message: `「${character.name}」只有三视图，没有表情 / 服装参考：${character.mustNotChange.length} 条不可变特征没有可对照的图。`,
      fix: `在定妆页给「${character.name}」补一张表情或服装参考图。`,
    });
  }

  for (const propId of shot.propIds) {
    const prop = project.props.find((item) => item.id === propId);
    if (!prop) {
      scores.push(0);
      issues.push({
        dimension: "wardrobe",
        severity: "error",
        message: `镜头引用的道具 ${propId} 不存在。`,
        fix: "在定妆页重新点一次这一镜的道具。",
      });
      continue;
    }
    const lockedOut = anchors.missing.some((text) =>
      text.includes(`道具「${prop.name}」缺参考图`),
    );
    if (prop.referenceImages.length === 0 || lockedOut) {
      scores.push(0);
      issues.push({
        dimension: "wardrobe",
        severity: "error",
        message: `道具「${prop.name}」没有可用的参考图。`,
        fix: "在定妆页给这件道具补一张参考图；有闸门时确认锁定的图里包含它。",
      });
      continue;
    }
    scores.push(100);
  }

  return { score: average(scores), issues };
}

function sceneOf(
  project: Project,
  shot: Shot,
  anchors: ReturnType<typeof shotAnchors>,
): { score: number | null; issues: ConsistencyIssue[] } {
  const scene = project.scenes.find((item) => item.id === shot.sceneId);
  if (!scene) {
    return {
      score: 0,
      issues: [
        {
          dimension: "scene",
          severity: "error",
          message: "这一镜找不到所属场次。",
          fix: "回到剧本页确认它属于哪一场。",
        },
      ],
    };
  }
  const location = project.locations.find((item) => item.id === scene.locationId);
  if (!location) {
    return {
      score: 0,
      issues: [
        {
          dimension: "scene",
          severity: "error",
          message: "这一镜的场景不存在。",
          fix: "在定妆页补齐场景。",
        },
      ],
    };
  }
  if (anchors.missing.some((text) => text.includes(`场景「${location.name}」缺主镜`))) {
    return {
      score: 0,
      issues: [
        {
          dimension: "scene",
          severity: "error",
          message: `场景「${location.name}」没有可用的主镜：每一拍都会重新想象这个房间。`,
          fix: "在定妆页给这个场景补一张主镜。",
        },
      ],
    };
  }
  return { score: 100, issues: [] };
}

function styleOf(
  project: Project,
  shot: Shot,
): { score: number | null; issues: ConsistencyIssue[] } {
  const latest = project.takes.find((take) => take.id === shot.takeIds.at(-1));
  if (!latest) return { score: null, issues: [] };

  const counts = new Map<string, number>();
  for (const take of project.takes) {
    counts.set(take.provenance.modelId, (counts.get(take.provenance.modelId) ?? 0) + 1);
  }
  let dominant = "";
  let most = -1;
  for (const [model, count] of counts) {
    if (count > most) {
      dominant = model;
      most = count;
    }
  }
  if (dominant && latest.provenance.modelId !== dominant) {
    return {
      score: 60,
      issues: [
        {
          dimension: "style",
          severity: "warning",
          message: `这一拍用了「${latest.provenance.modelId}」，全片多用「${dominant}」：颗粒、锐度与镜头感可能不齐。`,
          fix: "需要统一时，用全片主用模型重拍这一拍。",
        },
      ],
    };
  }
  return { score: 100, issues: [] };
}

function provenanceOf(
  project: Project,
  shot: Shot,
): { score: number | null; issues: ConsistencyIssue[] } {
  const latest = project.takes.find((take) => take.id === shot.takeIds.at(-1));
  if (!latest) return { score: null, issues: [] };

  const issues: ConsistencyIssue[] = [];
  let score = 40; // 有 take 就一定记了 modelId（IR 不变量）

  if (latest.provenance.referenceAssetIds.length > 0) {
    score += 30;
  } else {
    issues.push({
      dimension: "provenance",
      severity: "warning",
      message: "这一拍没有记录参考图：无法复核生成时用了哪些定妆锚点。",
      fix: "重拍一拍；新的 video take 会带上首帧与参考图记录。",
    });
  }

  if (latest.provenance.prompt) {
    score += 20;
  } else {
    issues.push({
      dimension: "provenance",
      severity: "warning",
      message: "这一拍没有留下提示词，改过的参考约束无法追查。",
      fix: "重拍后会自动写入提示词。",
    });
  }

  if (latest.provenance.seed !== undefined) {
    score += 10;
  } else {
    issues.push({
      dimension: "provenance",
      severity: "warning",
      message: "这一拍没有 seed 记录：供应商接口目前不支持固定 seed，身份漂移时没法靠复现 seed 修。",
    });
  }

  return { score: clamp(score), issues };
}

function verdictFor(
  overall: number | null,
  threshold: number,
): ShotConsistency["verdict"] {
  if (overall === null) return "unknown";
  if (overall >= threshold) return "pass";
  if (overall >= 60) return "review";
  return "fail";
}

/**
 * 全片体检。纯函数，不写任何事件；分数是「锚点齐不齐、能不能复核」，
 * 不是画面相似度。
 */
export function analyzeConsistency(project: Project): ConsistencyReport {
  const shots: ShotConsistency[] = orderedShots(project).map(({ shot, no, sceneId }) => {
    const anchors = shotAnchors(project, shot);
    const identity = identityOf(project, shot, anchors);
    const wardrobe = wardrobeOf(project, shot, anchors);
    const scene = sceneOf(project, shot, anchors);
    const style = styleOf(project, shot);
    const provenance = provenanceOf(project, shot);
    const parts: [ConsistencyKey, { score: number | null; issues: ConsistencyIssue[] }][] = [
      ["identity", identity],
      ["wardrobe", wardrobe],
      ["scene", scene],
      ["style", style],
      ["provenance", provenance],
    ];

    const measured = parts.filter(
      (entry): entry is [ConsistencyKey, { score: number; issues: ConsistencyIssue[] }] =>
        entry[1].score !== null,
    );
    const weightSum = measured.reduce(
      (sum, [key]) => sum + CONSISTENCY_WEIGHT[key],
      0,
    );
    const overall =
      weightSum > 0
        ? clamp(
            measured.reduce(
              (sum, [key, value]) => sum + value.score * CONSISTENCY_WEIGHT[key],
              0,
            ) / weightSum,
          )
        : null;
    const threshold = THRESHOLD[shot.shotSize] ?? 85;
    // 还没有 take 的镜头只有「锚点准备度」，没有可判定的成片一致性。
    const hasTake = shot.takeIds.length > 0;

    return {
      shotId: shot.id,
      no,
      label: shotLabel(no),
      sceneId,
      shotSize: shot.shotSize,
      dimensions: parts.map(([key, value]) => ({
        key,
        label: CONSISTENCY_LABEL[key],
        score: value.score,
        weight: CONSISTENCY_WEIGHT[key],
      })),
      overall,
      threshold,
      verdict: hasTake ? verdictFor(overall, threshold) : "unknown",
      issues: parts.flatMap(([, value]) => value.issues),
    };
  });

  const pass = shots.filter((item) => item.verdict === "pass").length;
  const review = shots.filter((item) => item.verdict === "review").length;
  const fail = shots.filter((item) => item.verdict === "fail").length;
  const unknown = shots.filter((item) => item.verdict === "unknown").length;
  const measured = shots
    .map((item) => item.overall)
    .filter((value): value is number => value !== null);

  const attention = shots
    .filter((item) => item.verdict === "review" || item.verdict === "fail")
    .sort((a, b) => (a.overall ?? 101) - (b.overall ?? 101));

  return {
    shots,
    summary: {
      shots: shots.length,
      pass,
      review,
      fail,
      unknown,
      average: measured.length
        ? Math.round(measured.reduce((sum, value) => sum + value, 0) / measured.length)
        : 0,
    },
    attention,
    notMeasured: NOT_MEASURED,
  };
}
