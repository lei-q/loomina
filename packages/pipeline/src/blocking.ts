/**
 * 自动摆位与轴线（B13.1 / ADR-0126 / SCENE-TEMPLATES.md §五）。
 *
 * 两件纯函数：
 * - `suggestBlocking()` 按模板几何与人物关系给一份摆位 + 三个机位建议；
 * - `checkAxis()` 用真实坐标判越轴。
 *
 * 建议**不写事件**：作者点「用这个摆位」才落 `shot.updated`。推断结果不能
 * 悄悄变成事实（ADR-0123 / ADR-0125 同一条原则）。
 */

import type {
  Blocking,
  CameraPlacement,
  LocationSpace,
  Project,
  Scene,
  Shot,
  Vec3,
} from "@loomina/ir";
import { boundsOf, distance } from "@loomina/ir";
import { sceneTemplateById } from "./scene-templates";

const EYE_HEIGHT = 1.5;
const TARGET_HEIGHT = 1.2;
/** 建议机位离被摄体的距离；屋里放不下时按比例收 */
const MASTER_DISTANCE = 2.6;
const OTS_SIDE = 0.9;
const OTS_BACK = 0.5;
/** 建议坐标离墙留的余量 */
const WALL_MARGIN = 0.3;

export type SuggestedActor = { characterId: string; position: Vec3; facingRad: number };
export type SuggestedCamera = {
  shotId: string;
  label: string;
  placement: CameraPlacement;
  focalMm: number;
};

export type BlockingSuggestion = {
  space: LocationSpace;
  actors: SuggestedActor[];
  cameras: SuggestedCamera[];
  /** 本场最主要的一对角色；只有一个人时为空 */
  axis: { aId: string; bId: string } | null;
  /** 一句话说明这次建议依据了哪条规则 */
  note: string;
};

export type BlockingRefusal = { reason: string };

const INTIMATE = /亲密|爱|情侣|暧昧|恋|亲昵/;
const POWER = /权力|压|上司|老板|掌控|上位|下属|命令/;

function sceneOf(project: Project, sceneId: string): Scene | undefined {
  return project.scenes.find((scene) => scene.id === sceneId);
}

function spaceOfScene(project: Project, scene: Scene): LocationSpace | undefined {
  return project.locations.find((location) => location.id === scene.locationId)?.space;
}

/** 本场镜头，按场内镜序 */
function shotsOf(project: Project, scene: Scene): Shot[] {
  const byId = new Map(project.shots.map((shot) => [shot.id, shot]));
  return scene.shotIds
    .map((id) => byId.get(id))
    .filter((shot): shot is Shot => Boolean(shot));
}

/** 出场次数最多的一对；平手时按首次出场顺序。 */
function mainPair(shots: Shot[]): { aId: string; bId: string } | null {
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const shot of shots) {
    for (const id of shot.characterIds) {
      if (!firstSeen.has(id)) firstSeen.set(id, order++);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const ranked = [...counts.keys()].sort(
    (a, b) => counts.get(b)! - counts.get(a)! || firstSeen.get(a)! - firstSeen.get(b)!,
  );
  if (ranked.length < 2) return null;
  return { aId: ranked[0]!, bId: ranked[1]! };
}

function tensionBetween(project: Project, aId: string, bId: string): string {
  const hit = project.story.relationships.find(
    (item) =>
      (item.fromCharacterId === aId && item.toCharacterId === bId) ||
      (item.fromCharacterId === bId && item.toCharacterId === aId),
  );
  return hit?.tension ?? "";
}

function facingToward(from: Vec3, to: Vec3): number {
  return Math.atan2(to[0] - from[0], to[2] - from[2]);
}

/** 建议坐标收进屋里：这是建议，不是作者写的事实，夹取可以接受 */
function fitInside(space: LocationSpace, point: Vec3): Vec3 {
  const bounds = boundsOf(space);
  const limitX = Math.max(0, bounds.halfWidth - WALL_MARGIN);
  const limitZ = Math.max(0, bounds.halfDepth - WALL_MARGIN);
  const limitY = Math.max(0.1, bounds.height - 0.1);
  return [
    Math.min(limitX, Math.max(-limitX, point[0])),
    Math.min(limitY, Math.max(0.1, point[1])),
    Math.min(limitZ, Math.max(-limitZ, point[2])),
  ];
}

/**
 * 摆位建议（SCENE-TEMPLATES §五）。
 *
 * 规则按优先级：
 * 1. 双人对白 → 对面；
 * 2. 关系里有权力词 → 桌后 / 桌前；
 * 3. 关系里有亲密词 → 同侧；
 * 4. 只有一个人 → 偏一侧留负空间；
 * 5. 三个以上 → 沿弧线排开。
 *
 * 主光方向不单独摆位：相机一律放在 `+n` 一侧，`note` 里写清依据。
 */
export function suggestBlocking(
  project: Project,
  sceneId: string,
): BlockingSuggestion | BlockingRefusal {
  const scene = sceneOf(project, sceneId);
  if (!scene) return { reason: "找不到这一场" };
  const space = spaceOfScene(project, scene);
  if (!space) {
    return { reason: "这个地点还没有几何：先在定妆页给地点选一个场景模板" };
  }
  const shots = shotsOf(project, scene);
  if (shots.length === 0) return { reason: "这一场还没有镜头" };

  const bounds = boundsOf(space);
  const table = space.anchors.find(
    (anchor) => anchor.kind === "furniture" && /桌|台|table|desk/i.test(anchor.id),
  );
  const tableZ = table?.position[2] ?? 0;
  const tableX = table?.position[0] ?? 0;

  const pair = mainPair(shots);
  const actors: SuggestedActor[] = [];
  let note = "按出场人物与模板锚点摆放";

  if (!pair) {
    const solo = [...new Set(shots.flatMap((shot) => shot.characterIds))][0];
    if (solo) {
      // 独处：偏一侧，画面另一边留负空间
      const position: Vec3 = [-bounds.halfWidth * 0.35, 0, tableZ];
      actors.push({ characterId: solo, position, facingRad: 0 });
      note = "一个人：偏左侧摆，右侧留负空间";
    }
  } else {
    const tension = tensionBetween(project, pair.aId, pair.bId);
    const power = POWER.test(tension);
    const intimate = INTIMATE.test(tension);
    const aPos: Vec3 = [tableX, 0, tableZ + 0.8];
    const bPos: Vec3 = [tableX, 0, tableZ - 0.8];

    if (power && table) {
      // 权力关系：一个人坐在桌后（更靠里），一个人站在桌前
      actors.push({
        characterId: pair.aId,
        position: [tableX, 0, tableZ - 0.9],
        facingRad: 0,
      });
      actors.push({
        characterId: pair.bId,
        position: [tableX, 0, tableZ + 0.9],
        facingRad: Math.PI,
      });
      note = "关系里有权力词：一个人坐桌后、一个人站桌前";
    } else if (intimate) {
      // 亲密：同侧相邻
      actors.push({
        characterId: pair.aId,
        position: [tableX - 0.55, 0, tableZ + 0.7],
        facingRad: 0,
      });
      actors.push({
        characterId: pair.bId,
        position: [tableX + 0.55, 0, tableZ + 0.7],
        facingRad: 0,
      });
      note = "关系里有亲密词：同侧相邻";
    } else {
      // 对白：隔桌对面
      actors.push({
        characterId: pair.aId,
        position: aPos,
        facingRad: facingToward(aPos, bPos),
      });
      actors.push({
        characterId: pair.bId,
        position: bPos,
        facingRad: facingToward(bPos, aPos),
      });
      note = table ? "双人对白：隔桌对面" : "双人对白：面对面";
    }

    // 第三个及以后的人沿弧线排开，不挡主要一对
    const rest = [...new Set(shots.flatMap((shot) => shot.characterIds))].filter(
      (id) => id !== pair.aId && id !== pair.bId,
    );
    rest.forEach((id, index) => {
      const angle = ((index + 1) / (rest.length + 1)) * Math.PI;
      const radius = Math.min(bounds.halfWidth, bounds.halfDepth) * 0.6;
      actors.push({
        characterId: id,
        position: [tableX + Math.cos(angle) * radius, 0, tableZ - Math.sin(angle) * radius],
        facingRad: angle + Math.PI,
      });
    });
  }

  const fitted = actors.map((actor) => ({
    ...actor,
    position: fitInside(space, actor.position),
  }));

  const cameras = fitted.length >= 2
    ? camerasForPair(project, space, shots, fitted[0]!, fitted[1]!)
    : camerasForSolo(space, shots, fitted[0]);

  return {
    space,
    actors: fitted,
    cameras,
    axis: pair,
    note,
  };
}

function normalized(d: Vec3): Vec3 {
  const length = Math.hypot(d[0], d[2]) || 1;
  return [d[0] / length, 0, d[2] / length];
}

/**
 * 三个机位：master / OTS A / OTS B，全部放在轴线同一侧（`+n`）。
 * 镜头多于三个时循环使用。
 */
function camerasForPair(
  project: Project,
  space: LocationSpace,
  shots: Shot[],
  a: SuggestedActor,
  b: SuggestedActor,
): SuggestedCamera[] {
  const dHat = normalized([b.position[0] - a.position[0], 0, b.position[2] - a.position[2]]);
  // 轴线法线：两个过肩机位与主机位都在这一侧，默认不越轴
  const n: Vec3 = [-dHat[2], 0, dHat[0]];
  const mid: Vec3 = [
    (a.position[0] + b.position[0]) / 2,
    0,
    (a.position[2] + b.position[2]) / 2,
  ];
  const focal = sceneFocal(project, shots);

  const masterPos: Vec3 = [mid[0] + n[0] * MASTER_DISTANCE, EYE_HEIGHT, mid[2] + n[2] * MASTER_DISTANCE];
  const otsA: Vec3 = [
    a.position[0] + n[0] * OTS_SIDE - dHat[0] * OTS_BACK,
    EYE_HEIGHT + 0.05,
    a.position[2] + n[2] * OTS_SIDE - dHat[2] * OTS_BACK,
  ];
  const otsB: Vec3 = [
    b.position[0] + n[0] * OTS_SIDE + dHat[0] * OTS_BACK,
    EYE_HEIGHT + 0.05,
    b.position[2] + n[2] * OTS_SIDE + dHat[2] * OTS_BACK,
  ];

  const masterTarget: Vec3 = [mid[0], TARGET_HEIGHT, mid[2]];
  const targetA: Vec3 = [a.position[0], TARGET_HEIGHT + 0.2, a.position[2]];
  const targetB: Vec3 = [b.position[0], TARGET_HEIGHT + 0.2, b.position[2]];

  const slots: { label: string; position: Vec3; target: Vec3; focalMm: number }[] = [
    { label: "主机位", position: masterPos, target: masterTarget, focalMm: focal[0] },
    { label: "过肩 A", position: otsA, target: targetB, focalMm: focal[1] },
    { label: "过肩 B", position: otsB, target: targetA, focalMm: focal[2] },
  ];

  return shots.map((shot, index) => {
    const slot = slots[index % slots.length]!;
    const position = fitInside(space, slot.position);
    const target = fitInside(space, slot.target);
    return {
      shotId: shot.id,
      label: slot.label,
      focalMm: slot.focalMm,
      placement: { position, target: distinct(space, position, target) },
    };
  });
}

/** 一个人：正面 + 左右两个侧机位 */
function camerasForSolo(
  space: LocationSpace,
  shots: Shot[],
  actor: SuggestedActor | undefined,
): SuggestedCamera[] {
  const bounds = boundsOf(space);
  const focus: Vec3 = actor ? [actor.position[0], TARGET_HEIGHT, actor.position[2]] : [0, TARGET_HEIGHT, 0];
  const distanceOut = Math.min(MASTER_DISTANCE, bounds.halfDepth + bounds.halfWidth);
  const slots: { label: string; offset: [number, number]; focalMm: number }[] = [
    { label: "正面", offset: [0, distanceOut], focalMm: 35 },
    { label: "左侧", offset: [-distanceOut * 0.75, distanceOut * 0.6], focalMm: 35 },
    { label: "右侧", offset: [distanceOut * 0.75, distanceOut * 0.6], focalMm: 35 },
  ];
  return shots.map((shot, index) => {
    const slot = slots[index % slots.length]!;
    const position = fitInside(space, [focus[0] + slot.offset[0], EYE_HEIGHT, focus[2] + slot.offset[1]]);
    return {
      shotId: shot.id,
      label: slot.label,
      focalMm: slot.focalMm,
      placement: { position, target: distinct(space, position, focus) },
    };
  });
}

/** 机位与目标重合时往屋里挪一点：重合就没有视线方向 */
function distinct(space: LocationSpace, position: Vec3, target: Vec3): Vec3 {
  if (distance(position, target) >= 0.2) return target;
  const bounds = boundsOf(space);
  const shifted: Vec3 = [
    Math.max(-bounds.halfWidth + WALL_MARGIN, Math.min(bounds.halfWidth - WALL_MARGIN, target[0] + 0.4)),
    target[1],
    target[2],
  ];
  return distance(position, shifted) >= 0.2 ? shifted : [target[0], target[1], target[2] + 0.4];
}

/** 焦段优先取模板给的三个默认机位，没有就用 35 / 50 / 35 */
function sceneFocal(project: Project, shots: Shot[]): [number, number, number] {
  const first = shots[0]!;
  const scene = project.scenes.find((item) => item.id === first.sceneId);
  const location = project.locations.find((item) => item.id === scene?.locationId);
  const template = sceneTemplateById(location?.templateId);
  const focals = template?.cameras.map((camera) => camera.focalMm) ?? [];
  return [focals[0] ?? 35, focals[1] ?? 50, focals[2] ?? 35];
}

/** 建议里的走位 → IR 形状 */
export function blockingOf(actors: SuggestedActor[]): Blocking {
  return {
    actors: actors.map((actor) => ({
      characterId: actor.characterId,
      position: actor.position,
      facingRad: actor.facingRad,
    })),
    props: [],
  };
}

export type AxisViolation = {
  shotIds: string[];
  axisId: string;
  message: string;
};

export type AxisReport = {
  violations: AxisViolation[];
  /** 查了几对相邻镜；0 表示这一场没有可用坐标 */
  checked: number;
  axis: { aId: string; bId: string } | null;
};

/**
 * 越轴（ADR-0126 §4）：用真实坐标算机位在轴线哪一侧。
 *
 * 轴线是本场最主要一对角色的连线；相邻两镜机位分居两侧就是越轴。
 * 机位没有坐标、或这一场没有几何时不判——退回 ADR-0108 的调度近似版。
 */
export function checkAxis(project: Project, sceneId: string): AxisReport {
  const scene = sceneOf(project, sceneId);
  if (!scene) return { violations: [], checked: 0, axis: null };
  const shots = shotsOf(project, scene);
  const pair = mainPair(shots);
  if (!pair) return { violations: [], checked: 0, axis: null };

  // 每镜优先用自己那份走位定轴线；没有就退回本场第一个有坐标的镜头
  const lineFor = (shot: Shot): { a: Vec3; b: Vec3 } | null => {
    const own = positionsOf(shot, pair);
    if (own) return own;
    for (const other of shots) {
      const fallback = positionsOf(other, pair);
      if (fallback) return fallback;
    }
    return null;
  };

  let checked = 0;
  const violations: AxisViolation[] = [];
  for (let index = 1; index < shots.length; index += 1) {
    const previous = shots[index - 1]!;
    const current = shots[index]!;
    const previousPlacement = previous.camera.placement;
    const currentPlacement = current.camera.placement;
    if (!previousPlacement || !currentPlacement) continue;
    const line = lineFor(previous) ?? lineFor(current);
    if (!line) continue;
    checked += 1;
    const before = sideOf(line, previousPlacement.position);
    const after = sideOf(line, currentPlacement.position);
    if (before === 0 || after === 0 || before === after) continue;
    violations.push({
      shotIds: [previous.id, current.id],
      axisId: `${pair.aId}:${pair.bId}`,
      message: "相邻两镜的机位在轴线两侧：插一个中性镜，或把其中一镜挪回同一侧。",
    });
  }
  return { violations, checked, axis: pair };
}

function positionsOf(shot: Shot, pair: { aId: string; bId: string }): { a: Vec3; b: Vec3 } | null {
  const a = shot.blocking?.actors.find((actor) => actor.characterId === pair.aId);
  const b = shot.blocking?.actors.find((actor) => actor.characterId === pair.bId);
  if (!a || !b) return null;
  return { a: a.position, b: b.position };
}

/** 点在轴线哪一侧：叉积符号；正好在线上返回 0 */
function sideOf(line: { a: Vec3; b: Vec3 }, point: Vec3): -1 | 0 | 1 {
  const dx = line.b[0] - line.a[0];
  const dz = line.b[2] - line.a[2];
  const px = point[0] - line.a[0];
  const pz = point[2] - line.a[2];
  const cross = dx * pz - dz * px;
  if (Math.abs(cross) < 1e-6) return 0;
  return cross > 0 ? 1 : -1;
}

/** 界面用：这一场有没有几何、能不能做精确越轴 */
export function hasGeometry(project: Project, sceneId: string): boolean {
  const scene = sceneOf(project, sceneId);
  if (!scene) return false;
  return Boolean(spaceOfScene(project, scene));
}
