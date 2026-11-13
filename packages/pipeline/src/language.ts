/**
 * 镜头语言库（I1）。
 *
 * 一镜的摄影意图由四件事决定：景别、机位角度、运镜、焦段。这四个字段
 * 分开选，作者得先在心里把它们拼成一句话；库把它们收成一组一组的
 * 「说法」——建立镜头、过肩、反应特写、插入、主观视角……
 *
 * 这里只给组合，不改 IR 结构：应用一次就是一条 `shot.updated`，
 * 写的是四个已经存在的字段。库本身不存进项目，也不进提示词——
 * 提示词仍然由 `shotParts` 从那四个字段编译，换一套说法就是换一组值。
 */

import type { Camera, Composition, Lighting, Shot } from "@loomina/ir";

export type ShotLanguage = {
  id: string;
  name: string;
  /** 这套说法干什么用 */
  blurb: string;
  /** 分组：作者按意图找，不按参数找 */
  group: "建立" | "对话" | "反应" | "细节" | "氛围";
  shotSize: Shot["shotSize"];
  angle: Camera["angle"];
  movement: Camera["movement"];
  focalMm: number;
};

export const SHOT_LANGUAGES: ShotLanguage[] = [
  {
    id: "establish",
    name: "建立镜头",
    blurb: "先把空间与人物关系交代清楚；一场的开头常用。",
    group: "建立",
    shotSize: "wide",
    angle: "eye",
    movement: "static",
    focalMm: 24,
  },
  {
    id: "establish-push",
    name: "推进建立",
    blurb: "从空间推到人身上，一个镜头把「在哪」和「谁」都说了。",
    group: "建立",
    shotSize: "wide",
    angle: "eye",
    movement: "push",
    focalMm: 24,
  },
  {
    id: "top-down",
    name: "俯视交代",
    blurb: "顶拍看布局：谁在门口、谁在桌边，一图说清。",
    group: "建立",
    shotSize: "wide",
    angle: "top",
    movement: "static",
    focalMm: 24,
  },
  {
    id: "over-shoulder",
    name: "过肩",
    blurb: "对话的标准机位：前景一个人的肩，后景另一个人的脸。",
    group: "对话",
    shotSize: "medium",
    angle: "eye",
    movement: "static",
    focalMm: 50,
  },
  {
    id: "two-shot",
    name: "双人中景",
    blurb: "两个人在同一画面里；关系比台词重要时用它。",
    group: "对话",
    shotSize: "medium",
    angle: "eye",
    movement: "static",
    focalMm: 35,
  },
  {
    id: "pan-follow",
    name: "横移跟随",
    blurb: "镜头横着跟住一个人走；走廊、门口常用。",
    group: "对话",
    shotSize: "wide",
    angle: "eye",
    movement: "pan",
    focalMm: 24,
  },
  {
    id: "reaction-close",
    name: "反应特写",
    blurb: "听的人比说的人更重要时，把镜头给听的人。",
    group: "反应",
    shotSize: "close",
    angle: "eye",
    movement: "static",
    focalMm: 85,
  },
  {
    id: "low-pressure",
    name: "低角度压迫",
    blurb: "仰拍让人显得更强、更有压迫感；对峙时用。",
    group: "反应",
    shotSize: "medium",
    angle: "low",
    movement: "static",
    focalMm: 35,
  },
  {
    id: "high-small",
    name: "俯拍变小",
    blurb: "俯拍让人显得弱、被压住；认输、被抓时用。",
    group: "反应",
    shotSize: "medium",
    angle: "high",
    movement: "static",
    focalMm: 35,
  },
  {
    id: "insert",
    name: "插入特写",
    blurb: "手、钥匙、杯子、屏幕——一个物件替一句台词。",
    group: "细节",
    shotSize: "extreme-close",
    angle: "high",
    movement: "static",
    focalMm: 100,
  },
  {
    id: "detail-close",
    name: "细节近景",
    blurb: "比特写再近一点，只留一处：眼睛、嘴角、指节。",
    group: "细节",
    shotSize: "extreme-close",
    angle: "eye",
    movement: "static",
    focalMm: 85,
  },
  {
    id: "pov",
    name: "主观视角",
    blurb: "手持、轻微晃动，像这个人自己在看；紧张与不安时用。",
    group: "氛围",
    shotSize: "medium",
    angle: "eye",
    movement: "handheld",
    focalMm: 35,
  },
  {
    id: "pull-reveal",
    name: "拉远揭示",
    blurb: "从人拉到环境，把刚才没看见的东西露出来。",
    group: "氛围",
    shotSize: "medium",
    angle: "eye",
    movement: "pull",
    focalMm: 35,
  },
  {
    id: "tilt-up",
    name: "升降打量",
    blurb: "镜头从下往上走，像在打量一个人或一栋楼。",
    group: "氛围",
    shotSize: "medium",
    angle: "low",
    movement: "tilt",
    focalMm: 50,
  },
];

export const SHOT_LANGUAGE_GROUPS = ["建立", "对话", "反应", "细节", "氛围"] as const;

export function shotLanguageById(id: string): ShotLanguage | undefined {
  return SHOT_LANGUAGES.find((item) => item.id === id);
}

/** 这一镜现在正好是某套说法吗：四个字段全对才算 */
export function matchShotLanguage(
  shot: Pick<Shot, "shotSize" | "camera">,
): ShotLanguage | undefined {
  return SHOT_LANGUAGES.find(
    (item) =>
      item.shotSize === shot.shotSize &&
      item.angle === shot.camera.angle &&
      item.movement === shot.camera.movement &&
      item.focalMm === shot.camera.focalMm,
  );
}

/**
 * 把一套说法翻成 `shot.updated` 的补丁。
 *
 * 机位坐标（B13 的 `placement`）从 `current` 原样保留：那是几何事实，
 * 换一套说法不该把已经摆好的机位抹掉。
 */
export function shotLanguagePatch(
  language: ShotLanguage,
  current?: Pick<Shot, "camera">,
): {
  shotSize: Shot["shotSize"];
  camera: Camera;
} {
  return {
    shotSize: language.shotSize,
    camera: {
      angle: language.angle,
      movement: language.movement,
      focalMm: language.focalMm,
      ...(current?.camera.placement ? { placement: current.camera.placement } : {}),
    },
  };
}


/* ------------------------------------------------------------------ */
/* I2 光影模板 / I4 构图模板                                            */
/* ------------------------------------------------------------------ */

export type LightingTemplate = {
  id: string;
  name: string;
  blurb: string;
  value: Lighting;
};

/**
 * 光影模板（I2）：**光源是谁**，与 `Project.look` 的光比 / 色温分开。
 *
 * 风格说「这条片子偏冷、硬光」；这里说「这一镜的光从窗外来」。
 * 两个旋钮各管一件事，提示词里各写一句，不会互相覆盖。
 */
export const LIGHTING_TEMPLATES: LightingTemplate[] = [
  {
    id: "window-side",
    name: "窗光侧打",
    blurb: "侧窗自然光，脸上有明暗过渡；最常用的日常光。",
    value: { source: "window", position: "side", mood: "modeled", note: "" },
  },
  {
    id: "window-back",
    name: "窗光逆光",
    blurb: "人背对窗，只剩轮廓与发丝光；藏着事的时候用。",
    value: { source: "window", position: "back", mood: "silhouette", note: "" },
  },
  {
    id: "lamp-pool",
    name: "台灯局部光",
    blurb: "只有一盏台灯亮着，周围沉进暗处；桌面戏的默认。",
    value: { source: "lamp", position: "side", mood: "modeled", note: "只有一盏台灯亮着，周围很暗" },
  },
  {
    id: "overhead-flat",
    name: "顶灯平光",
    blurb: "办公室 / 走廊的顶灯，平、冷、没有阴影；公共空间。",
    value: { source: "overhead", position: "top", mood: "flat", note: "" },
  },
  {
    id: "practical-mix",
    name: "实用光源",
    blurb: "画面里的灯、屏、霓虹自己发光；夜景与街道。",
    value: { source: "practical", position: "side", mood: "modeled", note: "光源来自画面里的灯与屏幕" },
  },
  {
    id: "moon-cool",
    name: "月光冷调",
    blurb: "月光从窗外打进来，偏蓝、很弱；夜外景与失眠。",
    value: { source: "moon", position: "side", mood: "modeled", note: "" },
  },
  {
    id: "under-creep",
    name: "底光",
    blurb: "光从下往上打，脸变形；惊吓与失控。",
    value: { source: "practical", position: "under", mood: "modeled", note: "光从下方打上来" },
  },
];

export const LIGHTING_SOURCE_CN: Record<Lighting["source"], string> = {
  window: "窗外自然光",
  lamp: "台灯",
  overhead: "顶灯",
  practical: "画面里的实用光源",
  moon: "月光",
};

export const LIGHTING_POSITION_CN: Record<Lighting["position"], string> = {
  front: "正面光",
  side: "侧光",
  back: "逆光",
  top: "顶光",
  under: "底光",
};

export const LIGHTING_MOOD_CN: Record<Lighting["mood"], string> = {
  flat: "平光，不塑形",
  modeled: "明暗过渡清晰",
  silhouette: "剪影，只剩轮廓",
};

export function lightingTemplateById(id: string): LightingTemplate | undefined {
  return LIGHTING_TEMPLATES.find((item) => item.id === id);
}

/** 光影 → 提示词里的一句；没写就不带（沿用场景与风格给的光） */
export function compileLighting(lighting: Lighting | undefined): string {
  if (!lighting) return "";
  const bits = [
    LIGHTING_SOURCE_CN[lighting.source],
    LIGHTING_POSITION_CN[lighting.position],
    LIGHTING_MOOD_CN[lighting.mood],
  ];
  const note = lighting.note.trim();
  if (note) bits.push(note);
  return `光线：${bits.join("，")}`;
}

export type CompositionTemplate = {
  id: string;
  name: string;
  blurb: string;
  value: Composition;
};

export const COMPOSITION_TEMPLATES: CompositionTemplate[] = [
  {
    id: "thirds",
    name: "三分",
    blurb: "主体偏一侧，留出另一侧的空间；最稳的构图。",
    value: { rule: "thirds", note: "" },
  },
  {
    id: "centered",
    name: "居中对称",
    blurb: "主体正中，压住画面；对峙、宣布、仪式感。",
    value: { rule: "centered", note: "" },
  },
  {
    id: "leading",
    name: "引导线",
    blurb: "走廊、台阶、桌面边缘把视线引向主体。",
    value: { rule: "leading", note: "" },
  },
  {
    id: "frame-in-frame",
    name: "框中框",
    blurb: "门框、窗框、镜子把主体框起来；隔一层看。",
    value: { rule: "frame", note: "" },
  },
  {
    id: "diagonal",
    name: "对角线",
    blurb: "主体沿对角线摆放，画面不稳；紧张与失衡。",
    value: { rule: "diagonal", note: "" },
  },
  {
    id: "negative",
    name: "大量留白",
    blurb: "主体很小，大片空处；孤独与被环境压住。",
    value: { rule: "negative", note: "" },
  },
];

export const COMPOSITION_RULE_CN: Record<Composition["rule"], string> = {
  thirds: "三分构图，主体偏一侧",
  centered: "居中对称构图",
  leading: "引导线构图，线条指向主体",
  frame: "框中框构图，透过门框或窗框看",
  diagonal: "对角线构图，画面倾斜",
  negative: "大量留白，主体在画面中很小",
};

export function compositionTemplateById(id: string): CompositionTemplate | undefined {
  return COMPOSITION_TEMPLATES.find((item) => item.id === id);
}

/** 构图 → 提示词里的一句；没写就不带 */
export function compileComposition(composition: Composition | undefined): string {
  if (!composition) return "";
  const bits = [COMPOSITION_RULE_CN[composition.rule]];
  const note = composition.note.trim();
  if (note) bits.push(note);
  return `构图：${bits.join("，")}`;
}
