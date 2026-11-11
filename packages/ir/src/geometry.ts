import type {
  Blocking,
  CameraPlacement,
  LocationSpace,
  Project,
  Shot,
  Vec3,
} from "./schema";

/**
 * 场地几何（B13.1 / ADR-0126）。
 *
 * 坐标系：地点自己的局部坐标，原点在房间中心地面，单位米，右手系，Y 向上。
 * 所以 X 落在 ±宽/2、Z 落在 ±深/2、Y 落在 0…高。
 *
 * 这里只做纯计算，不读写事件——校验在 `applyEvent`，自动摆位在 pipeline。
 */

/** 越界容差：手拖一下差几厘米不该被拒（ADR-0126） */
export const SPACE_TOLERANCE_M = 0.1;

/** 两点重合的最小距离：机位与目标重合就没有视线方向 */
export const MIN_SIGHT_DISTANCE_M = 0.05;

export type SpaceBounds = { halfWidth: number; halfDepth: number; height: number };

export function boundsOf(space: LocationSpace): SpaceBounds {
  const [width, depth, height] = space.dimensions;
  return { halfWidth: width / 2, halfDepth: depth / 2, height };
}

/** 这个点在不在场地里（含容差）。越界要拒绝，不夹取。 */
export function insideSpace(
  space: LocationSpace,
  point: Vec3,
  tolerance = SPACE_TOLERANCE_M,
): boolean {
  const bounds = boundsOf(space);
  const [x, y, z] = point;
  return (
    Math.abs(x) <= bounds.halfWidth + tolerance &&
    Math.abs(z) <= bounds.halfDepth + tolerance &&
    y >= -tolerance &&
    y <= bounds.height + tolerance
  );
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 一镜所属地点的几何；没选模板、没有场次时返回 undefined。 */
export function spaceOfShot(project: Project, shot: Pick<Shot, "sceneId">): LocationSpace | undefined {
  const scene = project.scenes.find((item) => item.id === shot.sceneId);
  if (!scene) return undefined;
  return project.locations.find((item) => item.id === scene.locationId)?.space;
}

export type GeometryProblem = { message: string };

/**
 * 走位是否合法（ADR-0126）：
 * - 出场人物之外的人不能有走位；
 * - 道具必须在 `shot.propIds` 里；
 * - 坐标必须落在场地内。
 */
export function blockingProblem(
  space: LocationSpace | undefined,
  shot: Pick<Shot, "characterIds" | "propIds">,
  blocking: Blocking,
): GeometryProblem | null {
  const actors = new Set<string>();
  for (const actor of blocking.actors) {
    if (!shot.characterIds.includes(actor.characterId)) {
      return { message: `走位里的人不在这一镜出场：${actor.characterId}` };
    }
    if (actors.has(actor.characterId)) {
      return { message: `同一个人只能有一个走位：${actor.characterId}` };
    }
    actors.add(actor.characterId);
    if (space && !insideSpace(space, actor.position)) {
      return { message: `走位坐标超出场地：${fmt(actor.position)}` };
    }
  }
  const props = new Set<string>();
  for (const prop of blocking.props) {
    if (!shot.propIds.includes(prop.propId)) {
      return { message: `走位里的道具不在这一镜：${prop.propId}` };
    }
    if (props.has(prop.propId)) {
      return { message: `同一件道具只能有一个位置：${prop.propId}` };
    }
    props.add(prop.propId);
    if (space && !insideSpace(space, prop.position)) {
      return { message: `道具坐标超出场地：${fmt(prop.position)}` };
    }
  }
  return null;
}

/** 机位是否合法：两点不能重合，且都在场地内（没有几何就不查边界）。 */
export function placementProblem(
  space: LocationSpace | undefined,
  placement: CameraPlacement,
): GeometryProblem | null {
  if (distance(placement.position, placement.target) < MIN_SIGHT_DISTANCE_M) {
    return { message: "机位和目标是同一个点：没有视线方向" };
  }
  if (space && !insideSpace(space, placement.position)) {
    return { message: `机位坐标超出场地：${fmt(placement.position)}` };
  }
  if (space && !insideSpace(space, placement.target)) {
    return { message: `机位目标超出场地：${fmt(placement.target)}` };
  }
  return null;
}

/** 地点几何自身是否成立：尺寸为正、锚点落在场地内。 */
export function spaceProblem(space: LocationSpace): GeometryProblem | null {
  const [width, depth, height] = space.dimensions;
  if (width <= 0 || depth <= 0 || height <= 0) {
    return { message: "场地尺寸必须是正数" };
  }
  const seen = new Set<string>();
  for (const anchor of space.anchors) {
    if (seen.has(anchor.id)) return { message: `锚点 id 重复：${anchor.id}` };
    seen.add(anchor.id);
    if (!insideSpace(space, anchor.position)) {
      return { message: `锚点「${anchor.id}」超出场地：${fmt(anchor.position)}` };
    }
  }
  return null;
}

function fmt(point: Vec3): string {
  return `(${point.map((value) => value.toFixed(2)).join(", ")})`;
}
