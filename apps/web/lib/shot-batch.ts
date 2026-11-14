/**
 * 按场批量套用摄影参数（I7 第三档）。
 *
 * 摄影单（ADR-0222）让作者看见全片；这一档让他**改一整场**。
 * 但批量改参数比单镜改危险得多：一整场十几镜，改错一次要撤十几步。
 *
 * 所以这里只做**计划**，不做执行：
 * - `batchPlanOf(project, sceneId, patch)` 算出「哪几镜会变、哪几镜跳过、为什么跳过」；
 * - 界面把计划摊给作者看，确认之后才逐镜写事件；
 * - 锁定的镜一律跳过（与单镜改同一口径）；参数没变的镜不写事件。
 *
 * 纯函数：不读盘、不写 IR。
 */

import type { Camera, Project, Shot } from "@loomina/ir";
import { MOVE_CN, SHOT_ANGLE_CN, SHOT_SIZE_CN } from "@loomina/pipeline";

export type BatchPatch = {
  shotSize?: Shot["shotSize"];
  angle?: Camera["angle"];
  movement?: Camera["movement"];
  focalMm?: number;
};

export type BatchChange = {
  shotId: string;
  /** 场内镜号 */
  no: number;
  label: string;
  /** 会变成什么 */
  next: Partial<Shot>;
  /** 人话：哪几项变了 */
  changes: string[];
};

export type BatchSkip = {
  shotId: string;
  no: number;
  label: string;
  reason: string;
};

export type BatchPlan = {
  sceneId: string;
  sceneLabel: string;
  changes: BatchChange[];
  skipped: BatchSkip[];
  summary: {
    /** 这一场一共几镜 */
    shots: number;
    /** 会变几镜 */
    changing: number;
    /** 跳过几镜 */
    skipped: number;
    /** 要写几条事件（= changing） */
    events: number;
  };
};

// 中文名直接用 pipeline 的常量：这几个概念归 shot_vocab（M6），不再本地重写一份

/** 焦段合法区间，与 `setShotCamera` 同一口径 */
export const FOCAL_MIN = 8;
export const FOCAL_MAX = 300;

/** 补丁本身是否合法；不合法时返回原因，合法时返回 undefined */
export function batchPatchProblem(patch: BatchPatch): string | undefined {
  if (
    patch.focalMm !== undefined &&
    (!Number.isFinite(patch.focalMm) || patch.focalMm < FOCAL_MIN || patch.focalMm > FOCAL_MAX)
  ) {
    return `焦段要在 ${FOCAL_MIN}–${FOCAL_MAX}mm 之间。`;
  }
  if (Object.keys(patch).length === 0) return "没有要改的参数。";
  return undefined;
}

/**
 * 算出一场批量套用会改什么。
 *
 * 只处理**这一场自己的镜**：跨场批量是另一回事（不同地点、不同时间，
 * 统一参数通常没有意义）。
 */
export function batchPlanOf(
  project: Project,
  sceneId: string,
  patch: BatchPatch,
): BatchPlan | { error: string } {
  const problem = batchPatchProblem(patch);
  if (problem) return { error: problem };

  const scene = project.scenes.find((item) => item.id === sceneId);
  if (!scene) return { error: "找不到这一场。" };

  const byId = new Map(project.shots.map((shot) => [shot.id, shot]));
  const changes: BatchChange[] = [];
  const skipped: BatchSkip[] = [];
  const sceneLabel = scene.code ? `第 ${scene.code} 场` : `第 ${scene.index + 1} 场`;

  scene.shotIds.forEach((shotId, index) => {
    const shot = byId.get(shotId);
    if (!shot) return;
    const no = index + 1;
    const label = `SH-${String(no).padStart(2, "0")}`;

    if (shot.locked) {
      skipped.push({ shotId, no, label, reason: "这一镜已锁定" });
      return;
    }

    const next: Partial<Shot> = {};
    const list: string[] = [];

    if (patch.shotSize !== undefined && patch.shotSize !== shot.shotSize) {
      next.shotSize = patch.shotSize;
      list.push(`景别 ${SHOT_SIZE_CN[shot.shotSize]} → ${SHOT_SIZE_CN[patch.shotSize]}`);
    }

    // 机位是整份写回的：只换点了的那几项，走位坐标不能让批量洗掉
    const camera = { ...shot.camera };
    let cameraChanged = false;
    if (patch.angle !== undefined && patch.angle !== shot.camera.angle) {
      camera.angle = patch.angle;
      cameraChanged = true;
      list.push(`机位 ${SHOT_ANGLE_CN[shot.camera.angle]} → ${SHOT_ANGLE_CN[patch.angle]}`);
    }
    if (patch.movement !== undefined && patch.movement !== shot.camera.movement) {
      camera.movement = patch.movement;
      cameraChanged = true;
      list.push(`运镜 ${MOVE_CN[shot.camera.movement]} → ${MOVE_CN[patch.movement]}`);
    }
    if (patch.focalMm !== undefined) {
      const focalMm = Math.round(patch.focalMm);
      if (focalMm !== shot.camera.focalMm) {
        camera.focalMm = focalMm;
        cameraChanged = true;
        list.push(`焦段 ${shot.camera.focalMm} → ${focalMm}mm`);
      }
    }
    if (cameraChanged) next.camera = camera;

    if (list.length === 0) {
      skipped.push({ shotId, no, label, reason: "已经是这样了" });
      return;
    }
    changes.push({ shotId, no, label, next, changes: list });
  });

  return {
    sceneId,
    sceneLabel,
    changes,
    skipped,
    summary: {
      shots: scene.shotIds.length,
      changing: changes.length,
      skipped: skipped.length,
      events: changes.length,
    },
  };
}

/** 一句话说清这次批量会动几镜、跳过几镜 */
export function batchText(plan: BatchPlan): string {
  const { summary } = plan;
  if (summary.shots === 0) return "这一场还没有镜头。";
  if (summary.changing === 0) {
    return `这一场 ${summary.shots} 镜都不用改${summary.skipped > 0 ? `（${summary.skipped} 镜跳过）` : ""}。`;
  }
  const skip = summary.skipped > 0 ? `，${summary.skipped} 镜跳过` : "";
  return `会改 ${summary.changing} 镜、写 ${summary.events} 条事件${skip}。锁定与已经是这样的镜不写。`;
}
