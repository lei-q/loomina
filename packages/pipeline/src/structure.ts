/**
 * 结构参考图（B13.3 / ADR-0126 / ADR-0129 §2）。
 *
 * depth 导出的产品目的不是「好看的结构图」，是给关键帧当**构图参考**：
 * 人在画面的哪个位置、离机头多远、前后景怎么叠。所以这里不做真实渲染，
 * 只把已有坐标投影到一张 9:16 的画面上，按深度着色（近暖远冷）画简笔。
 *
 * 全部是纯函数：输入场地 / 机位 / 走位，输出一串图元。
 * 没有 WebGL、没有 Three.js，也没有逐像素深度——图上没有的东西不假装有。
 */

import type { CameraPlacement, LocationSpace, Vec3 } from "@loomina/ir";
import { boundsOf } from "@loomina/ir";
import { ACTOR_HEAD_M, ACTOR_RADIUS_M } from "./elevation";

/** 参考图尺寸：9:16 竖幅，够看清构图又不用传大图 */
export const STRUCTURE_WIDTH = 360;
export const STRUCTURE_HEIGHT = 640;
/**
 * 竖幅画面的传感器短边（毫米）。
 *
 * 模板里的焦段（24 / 35 / 50）是 **35 mm 全画幅等效**，全画幅是 36×24；
 * 竖着拍时短边 24 mm 就是画面宽。所以 `focalPx = width × f / 24`。
 *
 * 第一版抄了走位板的 9.6 mm（那是手机传感器的物理宽度），结果 35 mm
 * 算出来是 15° 的视场——比长焦还窄，人物柱子糊满整张图。焦段既然写的是
 * 等效值，传感器也要用等效的 24 mm；走位板的视锥同步改过来（B13.3 落地节）。
 */
export const SENSOR_SHORT_MM = 24;
export const DEFAULT_FOCAL_MM = 35;
/** 比这更近的点不画：贴到镜头上没有意义 */
export const NEAR_PLANE_M = 0.1;
/** 深度色标的远端：更远的点按最冷处理 */
export const FAR_PLANE_M = 9;
/** 地面网格的格距（米） */
const GRID_STEP_M = 0.5;
/** 肩高与头心高度：柱子画到肩、头单独一个圆，中间留出脖子 */
const SHOULDER_M = 1.45;
const HEAD_CENTER_M = 1.575;
const HEAD_RADIUS_M = 0.105;

export type StructureSize = { width: number; height: number };

export type ProjectedPoint = { x: number; y: number; depth: number };

export type StructureActor = {
  characterId: string;
  name: string;
  position: Vec3;
};

export type StructureInput = {
  space: LocationSpace;
  placement: CameraPlacement;
  actors: StructureActor[];
  size?: StructureSize;
  /** 焦段（毫米），默认 35 */
  focalMm?: number;
};

export type StructureShape =
  | {
      kind: "quad";
      points: [number, number][];
      fill: string;
      stroke?: string;
      strokeWidth?: number;
      depth: number;
    }
  | {
      kind: "line";
      points: [number, number][];
      stroke: string;
      strokeWidth: number;
      dash?: string;
      depth: number;
    }
  | {
      kind: "disc";
      cx: number;
      cy: number;
      r: number;
      fill: string;
      stroke?: string;
      strokeWidth?: number;
      depth: number;
    }
  | { kind: "label"; x: number; y: number; text: string; fill: string; depth: number };

export type StructureFrame = {
  width: number;
  height: number;
  /** 由远到近排好序：直接按顺序画就是对的 */
  shapes: StructureShape[];
  /** 视锥外或被近平面裁掉的物件数：图上看不见它们，要如实说 */
  culled: number;
  /** 在画面外的人物数：图上标了「→ 画面外」，但人本身不在画里 */
  outside: number;
};

type Basis = {
  /** 机位 */
  eye: Vec3;
  /** 前（朝向目标） */
  forward: Vec3;
  /** 右 */
  right: Vec3;
  /** 上 */
  up: Vec3;
  /** 焦距，像素单位 */
  focalPx: number;
};

/** 一组正交基：前 = 目标 − 机位，右 = 前 × 世界上，上 = 右 × 前 */
export function basisOf(placement: CameraPlacement, size: StructureSize = DEFAULT_SIZE): Basis {
  const eye = placement.position;
  const dx = placement.target[0] - eye[0];
  const dy = placement.target[1] - eye[1];
  const dz = placement.target[2] - eye[2];
  const length = Math.hypot(dx, dy, dz) || 1;
  const forward: Vec3 = [dx / length, dy / length, dz / length];
  // 世界上向量取 (0,1,0)：机位正上 / 正下看时叉积退化，退到 Z 轴
  let right: Vec3 = normalize(cross(forward, [0, 1, 0]));
  if (Math.hypot(right[0], right[1], right[2]) < 1e-6) {
    right = normalize(cross(forward, [0, 0, 1]));
  }
  const up = normalize(cross(right, forward));
  return { eye, forward, right, up, focalPx: focalPxOf(size) };
}

export const DEFAULT_SIZE: StructureSize = {
  width: STRUCTURE_WIDTH,
  height: STRUCTURE_HEIGHT,
};

/**
 * 焦段 → 像素焦距。
 *
 * 竖幅时传感器短边（24 mm）对应画面**宽**。所以
 * `focalPx = width × f / sensorShort`——与走位板视锥的
 * `2·atan(24/2/f)` 是同一个口径，俯视图里画的扇形与这张图对得上。
 */
export function focalPxOf(size: StructureSize, focalMm = DEFAULT_FOCAL_MM): number {
  return (size.width * Math.max(8, focalMm)) / SENSOR_SHORT_MM;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * 把世界坐标投到画面。
 *
 * 返回 `undefined` 表示这个点在机位后面（或贴得太近），画不出来。
 * 没有透视除法以外的任何处理：这是一次针孔投影。
 */
export function project(basis: Basis, point: Vec3, size: StructureSize = DEFAULT_SIZE): ProjectedPoint | undefined {
  const vx = point[0] - basis.eye[0];
  const vy = point[1] - basis.eye[1];
  const vz = point[2] - basis.eye[2];
  const depth = vx * basis.forward[0] + vy * basis.forward[1] + vz * basis.forward[2];
  if (!Number.isFinite(depth) || depth < NEAR_PLANE_M) return undefined;
  const rightAmount = vx * basis.right[0] + vy * basis.right[1] + vz * basis.right[2];
  const upAmount = vx * basis.up[0] + vy * basis.up[1] + vz * basis.up[2];
  return {
    x: size.width / 2 + (rightAmount / depth) * basis.focalPx,
    y: size.height / 2 - (upAmount / depth) * basis.focalPx,
    depth,
  };
}

/**
 * 深度色标：近暖远冷。
 *
 * 用 HSL 从 28°（橙）走到 205°（蓝），亮度随距离略降。
 * 不用渐变条也不用外部资源：一张图里的颜色必须自己说清远近。
 */
export function depthColor(depthM: number): string {
  const t = Math.min(1, Math.max(0, (depthM - NEAR_PLANE_M) / (FAR_PLANE_M - NEAR_PLANE_M)));
  const hue = 28 + (205 - 28) * t;
  const lightness = 58 - 20 * t;
  return `hsl(${hue.toFixed(0)} 62% ${lightness.toFixed(0)}%)`;
}

/** 给 `hsl(...)` 或 `#rrggbb` 加透明度：画半透明的盒子与人物柱用 */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.min(1, Math.max(0, alpha));
  if (color.startsWith("hsl(")) return color.replace(/\)$/, ` / ${a})`);
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  return color;
}

/** 一条线段的深度：取近端，近的东西画在上层 */
function depthOfPoints(basis: Basis, points: Vec3[]): number {
  let near = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const vx = point[0] - basis.eye[0];
    const vy = point[1] - basis.eye[1];
    const vz = point[2] - basis.eye[2];
    const depth = vx * basis.forward[0] + vy * basis.forward[1] + vz * basis.forward[2];
    if (depth < near) near = depth;
  }
  return Number.isFinite(near) ? near : FAR_PLANE_M;
}

/** 一镜的结构参考图：地面网格 + 房间框 + 家具块 + 人物柱 + 视线 */
export function structureOf(input: StructureInput): StructureFrame {
  const size = input.size ?? DEFAULT_SIZE;
  const focalMm = input.focalMm ?? DEFAULT_FOCAL_MM;
  const basis: Basis = { ...basisOf(input.placement, size), focalPx: focalPxOf(size, focalMm) };
  const bounds = boundsOf(input.space);
  const shapes: StructureShape[] = [];
  let culled = 0;
  let outside = 0;

  const pushQuad = (corners: Vec3[], fill: string, stroke?: string) => {
    const projected = corners.map((corner) => project(basis, corner, size));
    if (projected.some((point) => !point)) {
      culled += 1;
      return;
    }
    shapes.push({
      kind: "quad",
      points: projected.map((point) => [point!.x, point!.y] as [number, number]),
      fill,
      ...(stroke ? { stroke, strokeWidth: 1 } : {}),
      depth: depthOfPoints(basis, corners),
    });
  };

  const pushLine = (a: Vec3, b: Vec3, stroke: string, width: number, dash?: string) => {
    const pa = project(basis, a, size);
    const pb = project(basis, b, size);
    if (!pa || !pb) return;
    shapes.push({
      kind: "line",
      points: [
        [pa.x, pa.y],
        [pb.x, pb.y],
      ],
      stroke,
      strokeWidth: width,
      ...(dash ? { dash } : {}),
      depth: depthOfPoints(basis, [a, b]),
    });
  };

  // 地面网格：每半米一条。网格是「地平面」的证明，没有它整张图像悬空
  const { halfWidth, halfDepth } = bounds;
  for (let x = -Math.floor(halfWidth / GRID_STEP_M) * GRID_STEP_M; x <= halfWidth; x += GRID_STEP_M) {
    pushLine([x, 0, -halfDepth], [x, 0, halfDepth], "rgba(120,132,150,.28)", 1);
  }
  for (let z = -Math.floor(halfDepth / GRID_STEP_M) * GRID_STEP_M; z <= halfDepth; z += GRID_STEP_M) {
    pushLine([-halfWidth, 0, z], [halfWidth, 0, z], "rgba(120,132,150,.28)", 1);
  }

  // 房间框：四面墙的底边 + 四根竖角。只画线框——结构参考图不填墙，免得挡住屋里
  const corners: Vec3[] = [
    [-halfWidth, 0, -halfDepth],
    [halfWidth, 0, -halfDepth],
    [halfWidth, 0, halfDepth],
    [-halfWidth, 0, halfDepth],
  ];
  for (let index = 0; index < 4; index += 1) {
    const a = corners[index]!;
    const b = corners[(index + 1) % 4]!;
    pushLine(a, b, "rgba(154,160,172,.55)", 1.5);
    pushLine([a[0], 0, a[2]], [a[0], bounds.height, a[2]], "rgba(154,160,172,.35)", 1);
  }

  // 家具 / 道具：按锚点位置画一个半透明的矮盒（占位半径 0.45 / 0.2，
  // 与遮挡判定同一口径）。只画顶面与四条竖棱：填满的立方体会把身后的人盖死，
  // 而这张图的用途正是看「谁在谁前面」。
  for (const anchor of input.space.anchors) {
    if (anchor.kind !== "furniture" && anchor.kind !== "prop") continue;
    const radius = anchor.kind === "furniture" ? 0.45 : 0.2;
    const height = Math.max(0.05, anchor.position[1]);
    const [x, , z] = anchor.position;
    const depth = depthOfPoints(basis, [anchor.position]);
    const corners: Vec3[] = [
      [x - radius, 0, z - radius],
      [x + radius, 0, z - radius],
      [x + radius, 0, z + radius],
      [x - radius, 0, z + radius],
    ];
    // 顶面：一眼看出这是一块占地的矮东西，而不是一堵墙
    pushQuad(
      corners.map((corner): Vec3 => [corner[0], height, corner[2]]),
      withAlpha(depthColor(depth), 0.5),
      "rgba(255,255,255,.28)",
    );
    // 四条竖棱 + 底边：把盒子在透视里的体积画出来
    for (let index = 0; index < 4; index += 1) {
      const a = corners[index]!;
      const b = corners[(index + 1) % 4]!;
      pushLine([a[0], height, a[2]], [b[0], height, b[2]], "rgba(255,255,255,.34)", 1);
      pushLine([a[0], 0, a[2]], [b[0], 0, b[2]], "rgba(255,255,255,.18)", 1);
      pushLine([a[0], 0, a[2]], [a[0], height, a[2]], "rgba(255,255,255,.18)", 1);
    }
  }

  // 人物：肩宽的柱子（到肩高）+ 一个头 + 名字。
  //
  // 柱子**不画到头顶**：柱宽是肩宽（0.44 m），一直画到 1.68 m 再叠一个
  // 同色的头，远看就是一块方板。柱到肩高（1.45 m）、头单独一个圆，
  // 中间留出一截脖子，剪影才读得出是人。
  for (const actor of input.actors) {
    const [x, , z] = actor.position;
    const foot = project(basis, [x, 0, z], size);
    const shoulder = project(basis, [x, SHOULDER_M, z], size);
    const headCenter = project(basis, [x, HEAD_CENTER_M, z], size);
    if (!foot || !shoulder || !headCenter) {
      culled += 1;
      continue;
    }
    const depth = depthOfPoints(basis, [actor.position]);
    const color = depthColor(depth);
    // 柱宽随距离收：近大远小，但不小于 3px（否则远的人就消失了）
    const widthPx = Math.max(3, (2 * ACTOR_RADIUS_M * basis.focalPx) / depth);

    // 人已经整个偏出画面：别画半截柱子，改在边上标一个箭头 + 名字。
    // 这是结构参考图最该说的一句话——「他不在这一镜里」。
    const headRadiusPx = Math.max(2, (HEAD_RADIUS_M * basis.focalPx) / depth);
    if (
      headCenter.x < -widthPx / 2 - headRadiusPx ||
      headCenter.x > size.width + widthPx / 2 + headRadiusPx
    ) {
      outside += 1;
      const edgeX = headCenter.x < 0 ? 10 : size.width - 10;
      shapes.push({
        kind: "label",
        x: edgeX,
        y: Math.min(size.height - 8, Math.max(14, headCenter.y)),
        text: headCenter.x < 0 ? `← ${actor.name} 画面外` : `${actor.name} 画面外 →`,
        fill: "#8a8f9a",
        depth: Number.NEGATIVE_INFINITY,
      });
      continue;
    }

    shapes.push({
      kind: "quad",
      points: [
        [foot.x - widthPx / 2, foot.y],
        [foot.x + widthPx / 2, foot.y],
        [shoulder.x + widthPx / 2, shoulder.y],
        [shoulder.x - widthPx / 2, shoulder.y],
      ],
      fill: withAlpha(color, 0.72),
      // 亮一点的描边：深色背景上，一块纯色矩形读不出「人」的剪影
      stroke: "rgba(255,255,255,.55)",
      strokeWidth: 1.5,
      depth,
    });
    shapes.push({
      kind: "disc",
      cx: headCenter.x,
      cy: headCenter.y,
      r: headRadiusPx,
      fill: color,
      stroke: "rgba(255,255,255,.55)",
      strokeWidth: 1.5,
      depth: depth - 0.001,
    });
    // 名字固定画在最上层（`depth` 记成极小值）：几何该遮就遮，但名字必须读得出来
    shapes.push({
      kind: "label",
      x: headCenter.x,
      y: headCenter.y - Math.max(8, headRadiusPx * 2 + 4),
      text: actor.name,
      fill: "#e6e8ee",
      depth: Number.NEGATIVE_INFINITY,
    });
  }

  // 视线：机位 → 目标，虚到能看见底下的人
  pushLine(
    input.placement.position,
    input.placement.target,
    "rgba(200,176,106,.85)",
    1.5,
    "5 4",
  );

  // 由远到近排：先画的在下层。名字不参与排序，绘制时最后统一画上去
  shapes.sort((a, b) => b.depth - a.depth);
  return { width: size.width, height: size.height, shapes, culled, outside };
}

/**
 * 把图元画到 2D 画布。浏览器里调用；测试只用 `structureOf` 的图元断言。
 *
 * 抽成独立函数是为了让组件只负责「什么时候画」，不负责「怎么画」。
 */
export function drawStructure(
  ctx: {
    // 只声明用得到的部分：pipeline 的 tsconfig 没有 DOM lib。
    // `string | object` 是 `string | CanvasGradient | CanvasPattern` 的父类型，
    // 浏览器里传真的 CanvasRenderingContext2D 照样成立。
    fillStyle: string | object;
    strokeStyle: string | object;
    lineWidth: number;
    setLineDash(dash: number[]): void;
    beginPath(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    closePath(): void;
    fill(): void;
    stroke(): void;
    arc(x: number, y: number, r: number, start: number, end: number): void;
    fillRect(x: number, y: number, w: number, h: number): void;
    font: string;
    textAlign: string;
    fillText(text: string, x: number, y: number): void;
  },
  frame: StructureFrame,
): void {
  ctx.fillStyle = "#0f1013";
  ctx.fillRect(0, 0, frame.width, frame.height);

  const labels = frame.shapes.filter((shape) => shape.kind === "label");

  for (const shape of frame.shapes) {
    if (shape.kind === "label") continue;
    if (shape.kind === "quad") {
      ctx.beginPath();
      shape.points.forEach(([x, y], index) => {
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = shape.fill;
      ctx.fill();
      if (shape.stroke) {
        ctx.strokeStyle = shape.stroke;
        ctx.lineWidth = shape.strokeWidth ?? 1;
        ctx.setLineDash([]);
        ctx.stroke();
      }
      continue;
    }
    if (shape.kind === "line") {
      ctx.beginPath();
      shape.points.forEach(([x, y], index) => {
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = shape.stroke;
      ctx.lineWidth = shape.strokeWidth;
      ctx.setLineDash(shape.dash ? shape.dash.split(" ").map(Number) : []);
      ctx.stroke();
      continue;
    }
    if (shape.kind === "disc") {
      ctx.beginPath();
      ctx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2);
      ctx.fillStyle = shape.fill;
      ctx.fill();
      if (shape.stroke) {
        ctx.strokeStyle = shape.stroke;
        ctx.lineWidth = shape.strokeWidth ?? 1;
        ctx.setLineDash([]);
        ctx.stroke();
      }
    }
  }

  // 名字最后画：几何照常遮挡，但名字不能被家具盖住
  ctx.setLineDash([]);
  ctx.font = "600 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  for (const label of labels) {
    if (label.kind !== "label") continue;
    ctx.fillStyle = label.fill;
    ctx.fillText(label.text, label.x, label.y);
  }
}
