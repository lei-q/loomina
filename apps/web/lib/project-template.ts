import {
  ProjectSchema,
  type Asset,
  type Brand,
  type Character,
  type Frame,
  type Grade,
  type Location,
  type Look,
  type Project,
  type Prop,
} from "@loomina/ir";

/**
 * 项目模板（F3 / ADR-0180）。
 *
 * 「班底」是可以跨集复用的那一份：人物（含定妆图与参考图）、地点、道具、
 * 画面风格、调色、画幅、品牌包。**不包含**故事、场景、镜头、台词、take——
 * 那些是这一集自己的东西，模板给的是同一个人、同一个地方、同一种质感。
 *
 * 模板只存地址（`loomina://` / `s3://` / `data:`），不存字节：
 * 从模板开工的新项目引用同一批文件，内容寻址天然去重。
 *
 * 纯函数：模板的生成与还原都不碰 IndexedDB，持久化在 `template-store.ts`。
 */

export type ProjectTemplate = {
  format: "loomina.template";
  version: 1;
  id: string;
  /** 作者起的名字，例如「夜班 · 班底」 */
  name: string;
  createdAt: string;
  /** 从哪个项目存下来的：界面上说明「这套人从哪儿来」 */
  from: { projectId: string; title: string };
  cast: Character[];
  locations: Location[];
  props: Prop[];
  /** 班底用到的资产记录（只有地址） */
  assets: Asset[];
  look: Look;
  grade: Grade;
  frame: Frame;
  brand: Brand;
};

/** 模板里带了多少东西：界面上给人看的那个摘要 */
export type TemplateCounts = { cast: number; locations: number; props: number; assets: number };

export function templateCounts(template: ProjectTemplate): TemplateCounts {
  return {
    cast: template.cast.length,
    locations: template.locations.length,
    props: template.props.length,
    assets: template.assets.length,
  };
}

/** 班底引用的资产 id（与 `referencedAssetIds` 同一套引用点，只取这三类） */
function castAssetIdsOf(input: {
  cast: Character[];
  locations: Location[];
  props: Prop[];
}): Set<string> {
  const ids = new Set<string>();
  for (const character of input.cast) {
    for (const id of Object.values(character.sheet)) if (id) ids.add(id);
    for (const id of character.referenceImages) ids.add(id);
  }
  for (const location of input.locations) {
    if (location.masterShotId) ids.add(location.masterShotId);
    for (const id of location.referenceImages) ids.add(id);
  }
  for (const prop of input.props) for (const id of prop.referenceImages) ids.add(id);
  return ids;
}

/** 从项目里取出「班底」：人物、地点、道具与它们用到的资产记录 */
export function templateOf(
  project: Project,
  input: { id: string; name: string; at: string },
): ProjectTemplate {
  const cast = project.characters;
  const locations = project.locations;
  const props = project.props;
  const assetIds = castAssetIdsOf({ cast, locations, props });
  return {
    format: "loomina.template",
    version: 1,
    id: input.id,
    name: input.name,
    createdAt: input.at,
    from: { projectId: project.id, title: project.title },
    cast,
    locations,
    props,
    assets: project.assets.filter((asset) => assetIds.has(asset.id)),
    look: project.look,
    grade: project.grade,
    frame: project.frame,
    brand: project.brand,
  };
}

/**
 * 用模板开一个新项目：班底照搬，故事与分镜从零开始。
 *
 * 走 `ProjectSchema.parse` 而不是手拼对象：模板可能是几个月前存的，
 * 缺省字段要靠 schema 补齐（与旧日志回放同一个规矩）。
 */
export function projectFromTemplate(
  template: ProjectTemplate,
  input: { id: string; at: string; title: string; budgetCny: number },
): Project {
  return ProjectSchema.parse({
    id: input.id,
    title: input.title.trim() || template.name,
    version: 0,
    budgetCny: input.budgetCny,
    look: template.look,
    grade: template.grade,
    frame: template.frame,
    brand: template.brand,
    characters: template.cast,
    locations: template.locations,
    props: template.props,
    assets: template.assets,
  });
}

/** 模板名字的默认值：片名 + 日期，去掉不能进界面的空白 */
export function templateNameOf(title: string, at: string): string {
  const clean = title.trim().replace(/\s+/g, " ");
  const day = at.slice(0, 10);
  return clean ? `${clean} · ${day}` : `班底 · ${day}`;
}
