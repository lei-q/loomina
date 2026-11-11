/**
 * 场景模板库（B15 / ADR-0103 / B13.1 / ADR-0126 / SCENE-TEMPLATES.md）。
 *
 * 每个模板两件事：
 * - 能进提示词的可读预设：尺寸、锚点名、机位名、光线；
 * - 能进 IR 的几何：锚点坐标、朝向、承载人数。坐标是场地局部坐标，
 *   原点在房间中心地面，单位米，右手系，Y 向上（+X 右、+Z 前）。
 *
 * 几何只描述「空间事实」，不描述镜头。没有坐标的项目照旧只用提示词。
 *
 * 模板 id 与 SCENE-TEMPLATES.md 一一对应；旧项目的 corridor / doorway /
 * table / door 仍可用，只是没有模板提示，也没有几何。
 */

import type { LocationAnchor, Vec3 } from "@loomina/ir";

export type SceneTemplateCategory = "interior" | "exterior";

export type TemplateAnchor = {
  /** 锚点 id：换模板时按它保留作者改过的位置 */
  id: string;
  /** 人话名字，进提示词（"沙发（中左）"） */
  label: string;
  kind: LocationAnchor["kind"];
  position: Vec3;
  /** 绕 Y 轴朝向，弧度；0 = 朝 +Z（前） */
  facingRad?: number;
  /** 可站 / 坐人数；0 表示不可承载 */
  capacity?: number;
};

export type SceneTemplate = {
  id: string;
  name: string;
  category: SceneTemplateCategory;
  /** 宽 × 深 × 高（米） */
  dimensions: [number, number, number];
  /** 关键锚点：带坐标；第一个通常是主光方向 */
  anchors: TemplateAnchor[];
  /** 默认机位：label 进说明，focalMm 是建议焦段 */
  cameras: { label: string; focalMm: number }[];
  /** 光线默认值：整句进提示词，避免每次重新描述 */
  lighting: string;
  tags: string[];
  /** 典型剧情，作者选模板时参考 */
  plots: string[];
};

const HALF_PI = Math.PI / 2;

export const SCENE_TEMPLATES: SceneTemplate[] = [
  {
    id: "living-room",
    name: "公寓客厅",
    category: "interior",
    dimensions: [5, 4, 2.8],
    anchors: [
      { id: "window", label: "窗（左）", kind: "window", position: [-2.5, 1.2, 0], facingRad: HALF_PI },
      { id: "sofa", label: "沙发（中左）", kind: "furniture", position: [-1.2, 0.45, 0.9], capacity: 3 },
      { id: "table", label: "茶几", kind: "furniture", position: [0, 0.4, 0.6] },
      { id: "tv-wall", label: "电视墙（前）", kind: "wall", position: [0, 1.4, 2], facingRad: Math.PI },
      { id: "door", label: "入户门（右后）", kind: "door", position: [2.5, 0, -1.6], facingRad: -HALF_PI },
      { id: "ceiling", label: "顶灯", kind: "light", position: [0, 2.7, 0] },
    ],
    cameras: [
      { label: "沙发正面", focalMm: 35 },
      { label: "沙发过肩", focalMm: 50 },
      { label: "门口反打", focalMm: 35 },
    ],
    lighting: "窗光 + 顶灯；4300K；光比 3:1",
    tags: ["家庭", "对话", "日常"],
    plots: ["家庭冲突", "情侣对话", "客人来访", "独处"],
  },
  {
    id: "bedroom",
    name: "卧室",
    category: "interior",
    dimensions: [4, 3.5, 2.8],
    anchors: [
      { id: "window", label: "窗（左）", kind: "window", position: [-2, 1.2, 0], facingRad: HALF_PI },
      { id: "bed", label: "床（中）", kind: "furniture", position: [0, 0.5, -0.4], capacity: 2 },
      { id: "nightstand", label: "床头柜", kind: "furniture", position: [-1.1, 0.55, -1.2] },
      { id: "wardrobe", label: "衣柜", kind: "furniture", position: [1.7, 1, -1.6] },
      { id: "door", label: "门（右后）", kind: "door", position: [2, 0, -1.4], facingRad: -HALF_PI },
      { id: "bedside-light", label: "床头灯", kind: "light", position: [-1.1, 0.85, -1.2] },
    ],
    cameras: [
      { label: "床侧 45°", focalMm: 35 },
      { label: "门口反打", focalMm: 35 },
      { label: "床头俯拍", focalMm: 50 },
    ],
    lighting: "床头灯 + 窗光；3200K；光比 4:1",
    tags: ["私密", "情绪", "夜景"],
    plots: ["亲密", "背叛", "独处", "争吵"],
  },
  {
    id: "office",
    name: "办公室",
    category: "interior",
    dimensions: [4, 4, 2.8],
    anchors: [
      { id: "window", label: "窗（左）", kind: "window", position: [-2, 1.2, 0], facingRad: HALF_PI },
      { id: "desk", label: "办公桌（中后）", kind: "furniture", position: [0, 0.75, -1] },
      { id: "boss-chair", label: "老板椅", kind: "furniture", position: [0, 0.5, -1.9], capacity: 1 },
      { id: "guest-chair", label: "访客椅", kind: "furniture", position: [0, 0.45, 0.4], capacity: 1 },
      { id: "bookshelf", label: "书架", kind: "furniture", position: [1.7, 1.2, -1.6] },
      { id: "door", label: "门（右前）", kind: "door", position: [2, 0, 1.6], facingRad: -HALF_PI },
    ],
    cameras: [
      { label: "桌后低机位", focalMm: 35 },
      { label: "桌前", focalMm: 50 },
      { label: "侧 45°", focalMm: 35 },
    ],
    lighting: "顶灯 + 窗光；5000K；光比 3:1",
    tags: ["职场", "权力", "谈判"],
    plots: ["职场压迫", "谈判", "解雇", "表白"],
  },
  {
    id: "elevator",
    name: "电梯",
    category: "interior",
    dimensions: [2, 2, 2.6],
    anchors: [
      { id: "door", label: "门（前）", kind: "door", position: [0, 0, 1], facingRad: Math.PI },
      { id: "panel", label: "按钮面板", kind: "prop", position: [0.9, 1.1, 0.4] },
      { id: "mirror", label: "镜面（侧）", kind: "mirror", position: [-0.9, 1.4, 0], facingRad: HALF_PI },
      { id: "handrail", label: "扶手", kind: "furniture", position: [0.9, 1, -0.4] },
      { id: "ceiling", label: "顶灯", kind: "light", position: [0, 2.5, 0] },
    ],
    cameras: [
      { label: "角落全景", focalMm: 24 },
      { label: "正面中景", focalMm: 35 },
      { label: "低机位", focalMm: 24 },
    ],
    lighting: "顶部荧光；5000K；光比 2:1；轻微绿调",
    tags: ["封闭", "压迫", "低成本"],
    plots: ["封闭对峙", "偶遇", "尴尬", "信息揭示"],
  },
  {
    id: "street",
    name: "街道 / 巷口",
    category: "exterior",
    dimensions: [8, 4, 3],
    anchors: [
      { id: "wall", label: "墙", kind: "wall", position: [0, 1.5, -2], facingRad: 0 },
      { id: "streetlight", label: "路灯", kind: "light", position: [-2, 2.6, -1.6] },
      { id: "shop-door", label: "店铺门", kind: "door", position: [2.4, 0, -2], facingRad: 0 },
      { id: "bin", label: "垃圾桶", kind: "prop", position: [3.2, 0.5, -1.4] },
      { id: "alley", label: "巷口", kind: "wall", position: [-4, 0, 1.2], facingRad: HALF_PI },
    ],
    cameras: [
      { label: "沿街跟移", focalMm: 35 },
      { label: "巷口反打", focalMm: 35 },
      { label: "低机位", focalMm: 24 },
    ],
    lighting: "日景自然光 / 夜景霓虹；3200–5600K",
    tags: ["外景", "移动", "夜戏"],
    plots: ["相遇", "追逐", "跟踪", "分别"],
  },
  {
    id: "cafe",
    name: "餐厅 / 咖啡厅",
    category: "interior",
    dimensions: [6, 5, 3],
    anchors: [
      { id: "window", label: "窗（左）", kind: "window", position: [-3, 1.3, 0], facingRad: HALF_PI },
      { id: "table", label: "桌（中）", kind: "furniture", position: [0, 0.75, 0] },
      { id: "chair-a", label: "椅", kind: "furniture", position: [0, 0.45, 0.9], capacity: 1 },
      { id: "chair-b", label: "椅", kind: "furniture", position: [0, 0.45, -0.9], capacity: 1 },
      { id: "bar", label: "吧台", kind: "furniture", position: [2.2, 1.1, -2] },
      { id: "door", label: "门（右前）", kind: "door", position: [3, 0, 1.8], facingRad: -HALF_PI },
    ],
    cameras: [
      { label: "对坐过肩", focalMm: 50 },
      { label: "侧面", focalMm: 35 },
      { label: "门口", focalMm: 35 },
    ],
    lighting: "窗光 + 吊灯；3500K；光比 3:1",
    tags: ["约会", "对话", "公共场所"],
    plots: ["约会", "摊牌", "谈判", "重逢"],
  },
  {
    id: "hospital-corridor",
    name: "医院走廊",
    category: "interior",
    dimensions: [12, 2.5, 2.8],
    anchors: [
      { id: "nurses-station", label: "护士站", kind: "furniture", position: [0, 1, -1] },
      { id: "ward-door", label: "病房门", kind: "door", position: [-3, 0, 1.2], facingRad: Math.PI },
      { id: "bench", label: "长椅", kind: "furniture", position: [2.5, 0.45, 1], capacity: 3 },
      { id: "ceiling", label: "顶灯", kind: "light", position: [0, 2.6, 0] },
    ],
    cameras: [
      { label: "纵深跟移", focalMm: 35 },
      { label: "门口反打", focalMm: 50 },
    ],
    lighting: "顶部冷白荧光；5600K；光比 2:1",
    tags: ["医院", "危机", "冷色"],
    plots: ["危机", "秘密", "生离死别"],
  },
  {
    id: "car-interior",
    name: "车内",
    category: "interior",
    dimensions: [3, 1.5, 1.4],
    anchors: [
      { id: "driver", label: "驾驶座", kind: "furniture", position: [-0.45, 0.5, 0.2], capacity: 1 },
      { id: "passenger", label: "副驾", kind: "furniture", position: [0.45, 0.5, 0.2], capacity: 1 },
      { id: "back-seat", label: "后座", kind: "furniture", position: [0, 0.5, -0.4], capacity: 2 },
      { id: "mirror", label: "后视镜", kind: "mirror", position: [0, 1.1, 0.6], facingRad: Math.PI },
    ],
    cameras: [
      { label: "侧面双人", focalMm: 24 },
      { label: "后视镜", focalMm: 50 },
      { label: "后座反打", focalMm: 35 },
    ],
    lighting: "街灯扫过 + 仪表光；3200–5600K；光比 4:1",
    tags: ["私密", "移动", "夜戏"],
    plots: ["私密对话", "逃亡", "争执"],
  },
  {
    id: "rooftop",
    name: "天台",
    category: "exterior",
    dimensions: [6, 6, 3],
    anchors: [
      { id: "railing", label: "护栏", kind: "wall", position: [0, 0.9, 3], facingRad: Math.PI },
      { id: "water-tank", label: "水箱", kind: "prop", position: [2, 1.2, -2] },
      { id: "door", label: "门", kind: "door", position: [-2.5, 0, -3], facingRad: 0 },
      { id: "sky", label: "天光", kind: "light", position: [0, 3, 0] },
    ],
    cameras: [
      { label: "边缘侧拍", focalMm: 35 },
      { label: "门口反打", focalMm: 35 },
      { label: "俯拍", focalMm: 24 },
    ],
    lighting: "城市天光 / 夜景灯海；4300–5600K",
    tags: ["外景", "高潮", "开阔"],
    plots: ["高潮", "告白", "决裂"],
  },
  {
    id: "classroom",
    name: "教室",
    category: "interior",
    dimensions: [7, 6, 3],
    anchors: [
      { id: "window", label: "窗（左）", kind: "window", position: [-3.5, 1.4, 0], facingRad: HALF_PI },
      { id: "desk", label: "课桌", kind: "furniture", position: [0, 0.75, 0.5] },
      { id: "blackboard", label: "黑板（前）", kind: "wall", position: [0, 1.5, 3], facingRad: Math.PI },
      { id: "door", label: "门（右后）", kind: "door", position: [3.5, 0, -2.4], facingRad: -HALF_PI },
      { id: "ceiling", label: "顶灯", kind: "light", position: [0, 2.8, 0] },
    ],
    cameras: [
      { label: "讲台", focalMm: 35 },
      { label: "后排", focalMm: 50 },
      { label: "走廊", focalMm: 35 },
    ],
    lighting: "窗光 + 顶灯；5000K；光比 3:1",
    tags: ["校园", "青春", "群戏"],
    plots: ["青春", "校园", "霸凌"],
  },
];

/** 旧 id → 场景模板 id：示例项目与历史数据里的名字继续可用。 */
const SCENE_TEMPLATE_ALIASES: Record<string, string> = {
  "apartment-living": "living-room",
};

const TEMPLATE_BY_ID = new Map(SCENE_TEMPLATES.map((template) => [template.id, template]));

export function sceneTemplateById(id: string | undefined): SceneTemplate | undefined {
  if (!id) return undefined;
  return TEMPLATE_BY_ID.get(SCENE_TEMPLATE_ALIASES[id] ?? id);
}

/** 模板 → IR 的场地几何（B13.1）：坐标与朝向落进 `Location.space`。 */
export function templateSpace(template: SceneTemplate): {
  dimensions: [number, number, number];
  anchors: LocationAnchor[];
} {
  return {
    dimensions: [...template.dimensions] as [number, number, number],
    anchors: template.anchors.map((anchor) => ({
      id: anchor.id,
      kind: anchor.kind,
      ...(anchor.label ? { label: anchor.label } : {}),
      position: [...anchor.position] as Vec3,
      facingRad: anchor.facingRad ?? 0,
      capacity: anchor.capacity ?? 0,
    })),
  };
}

/**
 * 换模板时的几何合并（ADR-0126）：按锚点 id 保留作者改过的位置。
 *
 * 模板没变的位置跟着模板走，作者挪过的位置留着——换模板不该把人家摆好的
 * 沙发弹回默认值。新模板没有的锚点丢掉，旧几何没有的锚点按模板补上。
 */
export function mergeTemplateSpace(
  previous: { dimensions: Vec3; anchors: LocationAnchor[] } | undefined,
  next: { dimensions: [number, number, number]; anchors: LocationAnchor[] },
): { dimensions: Vec3; anchors: LocationAnchor[] } {
  const previousById = new Map((previous?.anchors ?? []).map((anchor) => [anchor.id, anchor]));
  const anchors = next.anchors.map((anchor) => {
    const old = previousById.get(anchor.id);
    if (!old || old.kind !== anchor.kind) return anchor;
    return {
      ...anchor,
      position: old.position,
      facingRad: old.facingRad,
      capacity: old.capacity || anchor.capacity,
    };
  });
  return { dimensions: next.dimensions, anchors };
}

/** 一行模板说明：选模板、看提示词时都能复用。 */
export function describeSceneTemplate(template: SceneTemplate): string {
  const [width, depth, height] = template.dimensions;
  return `${template.name} · ${width}×${depth}×${height}m · ${template.lighting} · 机位：${template.cameras
    .map((camera) => camera.label)
    .join(" / ")}`;
}

/** 场景模板的唯一一句提示词：空间 + 主光 + 关键锚点。 */
export function sceneTemplatePrompt(template: SceneTemplate): string {
  return `${template.name}模板（${template.lighting}；关键位置：${template.anchors
    .map((anchor) => anchor.label)
    .join("、")}）`;
}
