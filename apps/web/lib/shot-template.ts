import {
  CompositionSchema,
  LightingSchema,
  type Composition,
  type Lighting,
  type Project,
  type Shot,
} from "@loomina/ir";

/**
 * 镜头模板（F3 第二档 / ADR-0207）。
 *
 * 一套「摄影做法」：景别 + 机位 + 运镜 + 焦段，外加可选的光影与构图模板。
 * **不含**动作、台词、时长、出场人物与道具——那些是这一镜的内容，
 * 模板换的是拍法，不是内容。
 *
 * 与班底模板共用 `templates` 仓，靠 `format` 区分；不进事件日志。
 */

type ShotSize = Shot["shotSize"];
type Angle = Shot["camera"]["angle"];
type Movement = Shot["camera"]["movement"];

export type ShotTemplate = {
  format: "loomina.shot-template";
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  /** 从哪一镜存下来的：界面上写「来自「夜班」第 2 场 · 第 3 镜」 */
  from: { projectId: string; title: string; shotId: string; shotLabel: string };
  shotSize: ShotSize;
  angle: Angle;
  movement: Movement;
  focalMm: number;
  lighting?: Lighting;
  composition?: Composition;
};

/** 读回来的数据像不像一份镜头模板：坏数据宁可跳过，也别把界面弄崩 */
export function looksLikeShotTemplate(value: unknown): value is ShotTemplate {
  if (!value || typeof value !== "object") return false;
  const template = value as Partial<ShotTemplate>;
  return (
    template.format === "loomina.shot-template" &&
    typeof template.id === "string" &&
    typeof template.name === "string" &&
    typeof template.focalMm === "number" &&
    typeof template.shotSize === "string" &&
    typeof template.angle === "string" &&
    typeof template.movement === "string"
  );
}

/** 从某一镜取出摄影做法 */
export function shotTemplateOf(
  project: Project,
  shot: Shot,
  input: { id: string; name: string; at: string; shotLabel: string },
): ShotTemplate {
  return {
    format: "loomina.shot-template",
    version: 1,
    id: input.id,
    name: input.name.trim().slice(0, 40) || "镜头模板",
    createdAt: input.at,
    from: {
      projectId: project.id,
      title: project.title,
      shotId: shot.id,
      shotLabel: input.shotLabel,
    },
    shotSize: shot.shotSize,
    angle: shot.camera.angle,
    movement: shot.camera.movement,
    focalMm: shot.camera.focalMm,
    ...(shot.lighting ? { lighting: structuredClone(shot.lighting) } : {}),
    ...(shot.composition ? { composition: structuredClone(shot.composition) } : {}),
  };
}

/**
 * 把模板变成一条 `shot.updated` 的 patch。
 *
 * 只写摄影相关的四项 + 可选两块模板；不碰动作、台词、时长、出场人物与道具。
 * 模板里没有的光影 / 构图**不回传 undefined**：那等于把这一镜原来的模板清掉，
 * 而作者套模板多半只是想换景别与机位（schema 也没有「清空」的写法）。
 */
export function shotTemplatePatch(template: ShotTemplate): Partial<Shot> {
  return {
    shotSize: template.shotSize,
    camera: {
      angle: template.angle,
      movement: template.movement,
      focalMm: template.focalMm,
    },
    ...(template.lighting ? { lighting: structuredClone(template.lighting) } : {}),
    ...(template.composition ? { composition: structuredClone(template.composition) } : {}),
  };
}

/** 校验读回来的两块可选模板：不合法就不带，不让坏数据进 `shot.updated` */
export function sanitizeShotTemplate(template: ShotTemplate): ShotTemplate {
  const lighting = template.lighting ? LightingSchema.safeParse(template.lighting) : undefined;
  const composition = template.composition
    ? CompositionSchema.safeParse(template.composition)
    : undefined;
  const { lighting: _lighting, composition: _composition, ...rest } = template;
  return {
    ...rest,
    name: template.name.trim().slice(0, 40) || "镜头模板",
    focalMm: Number.isFinite(template.focalMm) && template.focalMm > 0 ? template.focalMm : 35,
    ...(lighting?.success ? { lighting: lighting.data } : {}),
    ...(composition?.success ? { composition: composition.data } : {}),
  };
}