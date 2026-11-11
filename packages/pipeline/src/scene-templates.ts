/**
 * 场景模板库（B15 / ADR-0103 / SCENE-TEMPLATES.md）。
 *
 * 3D 灰盒（B13）暂缓，这一版先落"能进提示词的场景预设"：
 * 空间尺寸、关键锚点、默认机位、光线默认值。它们不做几何摆位，
 * 只回答两件事——主镜提示词里这地方长什么样，换模板时作者该期待什么。
 *
 * 模板 id 与 SCENE-TEMPLATES.md 一一对应；旧项目的 corridor / doorway /
 * table / door 仍可用，只是没有模板提示。
 */

export type SceneTemplateCategory = "interior" | "exterior";

export type SceneTemplate = {
  id: string;
  name: string;
  category: SceneTemplateCategory;
  /** 宽 × 深 × 高（米）；只作为提示词与说明，不做几何计算 */
  dimensions: [number, number, number];
  /** 关键锚点：门、窗、沙发、桌……第一个通常是主光方向 */
  anchors: string[];
  /** 默认机位：label 进说明，focalMm 是建议焦段 */
  cameras: { label: string; focalMm: number }[];
  /** 光线默认值：整句进提示词，避免每次重新描述 */
  lighting: string;
  tags: string[];
  /** 典型剧情，作者选模板时参考 */
  plots: string[];
};

export const SCENE_TEMPLATES: SceneTemplate[] = [
  {
    id: "living-room",
    name: "公寓客厅",
    category: "interior",
    dimensions: [5, 4, 2.8],
    anchors: ["窗（左）", "沙发（中左）", "茶几", "电视墙（前）", "入户门（右后）"],
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
    anchors: ["窗（左）", "床（中）", "床头柜", "衣柜", "门（右后）"],
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
    anchors: ["窗（左）", "办公桌（中后）", "老板椅", "访客椅", "书架", "门（右前）"],
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
    anchors: ["门（前）", "按钮面板", "镜面（侧）", "扶手"],
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
    anchors: ["墙", "路灯", "店铺门", "垃圾桶", "巷口"],
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
    anchors: ["窗（左）", "桌（中）", "椅", "吧台", "门（右前）"],
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
    anchors: ["护士站", "病房门", "长椅"],
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
    anchors: ["驾驶座", "副驾", "后座", "后视镜"],
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
    anchors: ["护栏", "水箱", "门"],
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
    anchors: ["窗（左）", "课桌", "黑板（前）", "门（右后）"],
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

/** 一行模板说明：选模板、看提示词时都能复用。 */
export function describeSceneTemplate(template: SceneTemplate): string {
  const [width, depth, height] = template.dimensions;
  return `${template.name} · ${width}×${depth}×${height}m · ${template.lighting} · 机位：${template.cameras
    .map((camera) => camera.label)
    .join(" / ")}`;
}

/** 场景模板的唯一一句提示词：空间 + 主光 + 关键锚点。 */
export function sceneTemplatePrompt(template: SceneTemplate): string {
  return `${template.name}模板（${template.lighting}；关键位置：${template.anchors.join("、")}）`;
}
