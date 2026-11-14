/**
 * 模板的改名、说明与去重（F3 第二档）。
 *
 * 模板存下来之后最常见的两件事：
 * 1. **名字打错了 / 想改得更清楚**——原来只能删了重存，重存会把 `createdAt`
 *    和「从哪来」一起重置，等于丢掉这份模板的来历；
 * 2. **同一套又存了一遍**——作者忘了存过，列表里出现两份一模一样的班底。
 *
 * 这里只做纯函数：改名与加说明都是**返回新对象**，不原地改；
 * 去重是结构比较，忽略 `id` / `name` / `note` / `createdAt` / `from`
 * ——那些是「这份模板是谁」，不是「这套参数是什么」。
 */

import type { ProjectTemplate } from "./project-template";
import type { ShotTemplate } from "./shot-template";

export const TEMPLATE_NAME_MAX = 40;
export const TEMPLATE_NOTE_MAX = 200;

/** 名字的校验：空名字会让列表里出现一行认不出的东西 */
export function templateNameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "模板要有名字。";
  if (trimmed.length > TEMPLATE_NAME_MAX) return `名字最多 ${TEMPLATE_NAME_MAX} 个字。`;
  return undefined;
}

/** 说明的校验：可以空着（空就是「没有说明」），但不能超长 */
export function templateNoteProblem(note: string): string | undefined {
  if (note.trim().length > TEMPLATE_NOTE_MAX) return `说明最多 ${TEMPLATE_NOTE_MAX} 个字。`;
  return undefined;
}

/** 改班底模板的名字：只动 `name`，`createdAt` 与 `from` 保留 */
export function renameProjectTemplate(
  template: ProjectTemplate,
  name: string,
): ProjectTemplate {
  return { ...template, name: name.trim().slice(0, TEMPLATE_NAME_MAX) };
}

/** 给班底模板写说明；空串等于删掉说明字段 */
export function withProjectTemplateNote(
  template: ProjectTemplate,
  note: string,
): ProjectTemplate {
  const trimmed = note.trim().slice(0, TEMPLATE_NOTE_MAX);
  const { note: _drop, ...rest } = template;
  return trimmed ? { ...rest, note: trimmed } : rest;
}

/** 改镜头模板的名字 */
export function renameShotTemplate(template: ShotTemplate, name: string): ShotTemplate {
  return { ...template, name: name.trim().slice(0, TEMPLATE_NAME_MAX) };
}

/** 给镜头模板写说明 */
export function withShotTemplateNote(template: ShotTemplate, note: string): ShotTemplate {
  const trimmed = note.trim().slice(0, TEMPLATE_NOTE_MAX);
  const { note: _drop, ...rest } = template;
  return trimmed ? { ...rest, note: trimmed } : rest;
}

/**
 * 两份班底模板是不是同一套参数。
 *
 * 比的是「带走的东西」：人物、地点、道具、资产、风格、调色、画幅、品牌。
 * 不比 `id`（每份都不同）、`name` / `note`（那是标签）、`createdAt` / `from`
 * （那是来历）。JSON 比较对这几份结构是安全的：它们都是纯数据，没有函数与循环引用。
 */
export function sameProjectParams(a: ProjectTemplate, b: ProjectTemplate): boolean {
  return (
    JSON.stringify(a.cast) === JSON.stringify(b.cast) &&
    JSON.stringify(a.locations) === JSON.stringify(b.locations) &&
    JSON.stringify(a.props) === JSON.stringify(b.props) &&
    JSON.stringify(a.assets) === JSON.stringify(b.assets) &&
    JSON.stringify(a.look) === JSON.stringify(b.look) &&
    JSON.stringify(a.grade) === JSON.stringify(b.grade) &&
    JSON.stringify(a.frame) === JSON.stringify(b.frame) &&
    JSON.stringify(a.brand) === JSON.stringify(b.brand)
  );
}

/** 两份镜头模板是不是同一套拍法 */
export function sameShotParams(a: ShotTemplate, b: ShotTemplate): boolean {
  return (
    a.shotSize === b.shotSize &&
    a.angle === b.angle &&
    a.movement === b.movement &&
    a.focalMm === b.focalMm &&
    JSON.stringify(a.lighting ?? null) === JSON.stringify(b.lighting ?? null) &&
    JSON.stringify(a.composition ?? null) === JSON.stringify(b.composition ?? null)
  );
}

/** 在已有列表里找同一套班底；找不到返回 undefined */
export function findSameProjectTemplate(
  list: ProjectTemplate[],
  candidate: ProjectTemplate,
  excludeId?: string,
): ProjectTemplate | undefined {
  return list.find(
    (item) => item.id !== excludeId && sameProjectParams(item, candidate),
  );
}

/** 在已有列表里找同一套拍法 */
export function findSameShotTemplate(
  list: ShotTemplate[],
  candidate: ShotTemplate,
  excludeId?: string,
): ShotTemplate | undefined {
  return list.find((item) => item.id !== excludeId && sameShotParams(item, candidate));
}
