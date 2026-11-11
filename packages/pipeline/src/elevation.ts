/**
 * 立面与遮挡（B13.2 / ADR-0126 §1）。
 *
 * 两件纯函数，都只读已有的坐标，不新增字段、不写事件：
 * - `elevationOf()` 把机位与目标的坐标换成一张立面：高度、距离、俯仰角，
 *   并从几何推出一个 `angle` 档位，与作者写的比一比；
 * - `occlusionsOf()` 在 XZ 平面上算视线被谁挡住。
 *
 * 都是启发式：锚点高度取模板给的 `position[1]`（家具是估的高度），
 * 人物按 1.68 m 身高、0.22 m 半径。结论是提示，不是事实。
 */

import type { Camera, LocationSpace, Project, Shot, Vec3 } from "@loomina/ir";
import { boundsOf } from "@loomina/ir";

/** 人物头顶高度（米）；模板与走位都不记身高，这里用一个成人均值 */
export const ACTOR_HEAD_M = 1.68;
/** 人物占位半径（米） */
export const ACTOR_RADIUS_M = 0.22;
/** 判定「机位就在目标身上」的距离：这么近就不谈视线 */
const SAME_SPOT_M = 0.5;
/** 视线两端各留一段不计遮挡：贴脸的东西不算挡 */
const SIGHT_MARGIN = 0.15;
/** 高度差在 2 cm 以内算「刚好擦过」，不算挡 */
const HEIGHT_EPSILON = 0.02;

export type ElevationReport = {
  shotId: string;
  camera: Vec3;
  target: Vec3;
  /** 视线长度（三维） */
  distanceM: number;
  /** 地面距离（只算 XZ） */
  groundDistanceM: number;
  cameraHeightM: number;
  targetHeightM: number;
  /** 俯仰角，度：正数 = 俯拍，负数 = 仰拍 */
  pitchDeg: number;
  /** 按几何推出的角度档位 */
  angleFromGeometry: Camera["angle"];
  /** 作者写的档位；没有坐标时两者都为空 */
  declaredAngle: Camera["angle"];
  /** 作者写的档位与几何是否一致（差一档以上就算不一致） */
  agrees: boolean;
  /** 一句人话，界面直接用 */
  summary: string;
};

const ANGLE_ORDER: Camera["angle"][] = ["low", "eye", "high", "top"];

/** 俯仰角 → 档位：≥60° 是俯拍，≥10° 是稍高，≤−10° 是仰拍，其余平视 */
export function angleFromPitch(pitchDeg: number): Camera["angle"] {
  if (pitchDeg >= 60) return "top";
  if (pitchDeg >= 10) return "high";
  if (pitchDeg <= -10) return "low";
  return "eye";
}

export const ANGLE_LABEL: Record<Camera["angle"], string> = {
  eye: "平视",
  low: "仰拍",
  high: "俯拍（稍高）",
  top: "顶拍",
};

/**
 * 一镜的立面读数。没有机位坐标时返回 `undefined`——没坐标就谈不上高度与俯仰。
 */
export function elevationOf(project: Project, shot: Shot): ElevationReport | undefined {
  const placement = shot.camera.placement;
  if (!placement) return undefined;
  const camera = placement.position;
  const target = placement.target;
  const dx = target[0] - camera[0];
  const dz = target[2] - camera[2];
  const groundDistanceM = Math.hypot(dx, dz);
  const distanceM = Math.hypot(dx, camera[1] - target[1], dz);
  const pitchDeg = (Math.atan2(camera[1] - target[1], groundDistanceM) * 180) / Math.PI;
  const angleFromGeometry = angleFromPitch(pitchDeg);
  const declaredAngle = shot.camera.angle;
  const delta = Math.abs(
    ANGLE_ORDER.indexOf(angleFromGeometry) - ANGLE_ORDER.indexOf(declaredAngle),
  );
  const agrees = delta === 0;
  return {
    shotId: shot.id,
    camera,
    target,
    distanceM,
    groundDistanceM,
    cameraHeightM: camera[1],
    targetHeightM: target[1],
    pitchDeg,
    angleFromGeometry,
    declaredAngle,
    agrees,
    summary: `${camera[1].toFixed(2)} m 高 · 距目标 ${groundDistanceM.toFixed(1)} m · 俯仰 ${pitchDeg >= 0 ? "下" : "上"} ${Math.abs(pitchDeg).toFixed(0)}° · ${ANGLE_LABEL[angleFromGeometry]}`,
  };
}

export type OcclusionKind = "anchor" | "actor";

export type Occlusion = {
  kind: OcclusionKind;
  /** 锚点 id 或人物 id */
  id: string;
  label: string;
  /** 遮挡物在视线上的位置：0 = 机位，1 = 目标 */
  at: number;
  /** 遮挡物高度（米） */
  heightM: number;
  /** 该处视线高度（米） */
  sightHeightM: number;
};

/** 按锚点类型给的占位半径（米）：家具是一大块，道具是一小块 */
const ANCHOR_RADIUS: Record<string, number> = {
  furniture: 0.45,
  prop: 0.2,
};

/** 只有这些挡得住视线：门窗是开口，顶灯与镜面不在视线上 */
const BLOCKING_KINDS = new Set(["furniture", "prop"]);

/** 贴到墙面多少米以内算「长在墙上」：模板里的墙都是房间边界 */
const ON_BOUNDARY_M = 0.2;

/** 点到线段最近处的参数 t 与距离 */
function closestOnSegment(a: Vec3, b: Vec3, point: Vec3): { t: number; distance: number } {
  const ax = b[0] - a[0];
  const az = b[2] - a[2];
  const lengthSq = ax * ax + az * az;
  if (lengthSq < 1e-9) return { t: 0, distance: Math.hypot(point[0] - a[0], point[2] - a[2]) };
  const t = ((point[0] - a[0]) * ax + (point[2] - a[2]) * az) / lengthSq;
  const clamped = Math.min(1, Math.max(0, t));
  const dx = point[0] - (a[0] + ax * clamped);
  const dz = point[2] - (a[2] + az * clamped);
  return { t: clamped, distance: Math.hypot(dx, dz) };
}

/**
 * 视线被谁挡住（B13.2）。
 *
 * 只在 XZ 平面上判：遮挡物投影到视线上的位置落在两端之间、横向半径够得着，
 * 且它的高度达到该处的视线高度，就算挡住。
 *
 * 目标本人不算遮挡；离机位或目标太近（`SIGHT_MARGIN`）的也不算——
 * 贴脸的灯架不该报「挡住脸」。
 */
export function occlusionsOf(
  project: Project,
  shot: Shot,
  space?: LocationSpace,
): Occlusion[] {
  const placement = shot.camera.placement;
  if (!placement) return [];
  const camera = placement.position;
  const target = placement.target;
  const span = Math.hypot(target[0] - camera[0], target[2] - camera[2]);
  if (span < SAME_SPOT_M) return [];

  const room =
    space ??
    project.locations.find(
      (item) =>
        item.id ===
        project.scenes.find((scene) => scene.id === shot.sceneId)?.locationId,
    )?.space;

  const sightHeightAt = (t: number) => camera[1] + (target[1] - camera[1]) * t;
  const found: Occlusion[] = [];

  for (const anchor of room?.anchors ?? []) {
    if (!BLOCKING_KINDS.has(anchor.kind)) continue;
    const { t, distance: lateral } = closestOnSegment(camera, target, anchor.position);
    const margin = SIGHT_MARGIN / span;
    if (t <= margin || t >= 1 - margin) continue;
    const radius = ANCHOR_RADIUS[anchor.kind] ?? 0.3;
    if (lateral > radius) continue;
    const heightM = anchor.position[1];
    const sightHeightM = sightHeightAt(t);
    if (heightM < sightHeightM - HEIGHT_EPSILON) continue;
    found.push({
      kind: "anchor",
      id: anchor.id,
      label: anchor.label ?? anchor.id,
      at: t,
      heightM,
      sightHeightM,
    });
  }

  // 墙：模板里的墙是房间边界，两个屋里的人之间不可能被边界墙挡住。
  // 只有立在屋里的隔断才算遮挡——按高度算整面墙（`position[1]` 是它的代表高度，不是墙高）。
  const bounds = room ? boundsOf(room) : undefined;
  for (const anchor of room?.anchors ?? []) {
    if (anchor.kind !== "wall") continue;
    const onBoundary =
      !bounds ||
      Math.abs(Math.abs(anchor.position[0]) - bounds.halfWidth) < ON_BOUNDARY_M ||
      Math.abs(Math.abs(anchor.position[2]) - bounds.halfDepth) < ON_BOUNDARY_M;
    if (onBoundary) continue;
    const { t, distance: lateral } = closestOnSegment(camera, target, anchor.position);
    const margin = SIGHT_MARGIN / span;
    if (t <= margin || t >= 1 - margin) continue;
    if (lateral > 0.8) continue;
    const heightM = bounds ? bounds.height : anchor.position[1];
    const sightHeightM = sightHeightAt(t);
    if (heightM < sightHeightM - HEIGHT_EPSILON) continue;
    found.push({
      kind: "anchor",
      id: anchor.id,
      label: anchor.label ?? anchor.id,
      at: t,
      heightM,
      sightHeightM,
    });
  }

  // 目标点站在谁身上，就把谁当被摄者：他不挡自己
  const subject = shot.blocking?.actors.find(
    (actor) => Math.hypot(actor.position[0] - target[0], actor.position[2] - target[2]) < SAME_SPOT_M,
  );
  for (const actor of shot.blocking?.actors ?? []) {
    if (subject && actor.characterId === subject.characterId) continue;
    const { t, distance: lateral } = closestOnSegment(camera, target, actor.position);
    const margin = SIGHT_MARGIN / span;
    if (t <= margin || t >= 1 - margin) continue;
    if (lateral > ACTOR_RADIUS_M) continue;
    const sightHeightM = sightHeightAt(t);
    if (ACTOR_HEAD_M < sightHeightM - HEIGHT_EPSILON) continue;
    found.push({
      kind: "actor",
      id: actor.characterId,
      label:
        project.characters.find((item) => item.id === actor.characterId)?.name ??
        actor.characterId,
      at: t,
      heightM: ACTOR_HEAD_M,
      sightHeightM,
    });
  }

  return found.sort((a, b) => a.at - b.at);
}

/** 立面图的水平跨度：地面距离加上目标身后的一点余量 */
export function elevationExtent(report: ElevationReport, space?: LocationSpace): number {
  const bounds = space ? boundsOf(space) : undefined;
  const roomReach = bounds ? Math.max(bounds.halfWidth, bounds.halfDepth) * 2 : 0;
  return Math.max(report.groundDistanceM, 1, Math.min(roomReach, report.groundDistanceM + 2));
}
