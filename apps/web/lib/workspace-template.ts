import type { Asset, Project } from "@loomina/ir";

/**
 * 照一个工作空间的「设定」开新一集（C.1 / ADR-0197）。
 *
 * 跨集真正要复用的一次性内容：故事圣经、演员 / 场景 / 道具的定妆与参考图、
 * 技能、风格与调色。成片相关的东西（场次、分镜、台词、take、时间线、审批）
 * 不跟过来——新的一集要从空白故事板重新开始。
 *
 * id 原样保留：新项目是一条独立的日志，不会和来源项目撞 id；
 * 保留 id 才能让故事的弧光 / 关系、场景的主镜引用继续有效。
 */

/** 新项目要带过来的资产：定妆与参考图、场景主镜、调色表 */
function referencedAssetIds(source: Project): Set<string> {
  const ids = new Set<string>();
  for (const character of source.characters) {
    for (const id of Object.values(character.sheet)) if (id) ids.add(id);
    for (const id of character.referenceImages) ids.add(id);
  }
  for (const location of source.locations) {
    if (location.masterShotId) ids.add(location.masterShotId);
    for (const id of location.referenceImages) ids.add(id);
  }
  for (const prop of source.props) {
    for (const id of prop.referenceImages) ids.add(id);
  }
  if (source.grade.lutAssetId) ids.add(source.grade.lutAssetId);
  return ids;
}

/**
 * 复用的资产记 `library`：字节不是这次花的钱，也不是这次上传的（C16 / C17 同一口径）。
 * 上传 / 导入的保留原来源：授权仍是当初那一次；花费与复核不跟过来。
 */
function reusedAsset(asset: Asset): Asset {
  const { costCny: _cost, review: _review, ...rest } = asset;
  return {
    ...rest,
    source: asset.source === "generated" ? "library" : asset.source,
  };
}

export function projectFromSetup(
  source: Project,
  options: { id: string; title: string },
): Project {
  const keep = referencedAssetIds(source);
  const assets = source.assets.filter((asset) => keep.has(asset.id)).map(reusedAsset);

  return {
    ...structuredClone(source),
    id: options.id,
    title: options.title,
    version: 1,
    // 设定跟着走
    story: structuredClone(source.story),
    skills: structuredClone(source.skills),
    characters: structuredClone(source.characters),
    locations: structuredClone(source.locations),
    props: structuredClone(source.props),
    look: structuredClone(source.look),
    grade: structuredClone(source.grade),
    frame: structuredClone(source.frame),
    brand: structuredClone(source.brand),
    subtitleLayout: structuredClone(source.subtitleLayout),
    subtitleTranslation: structuredClone(source.subtitleTranslation),
    assets,
    // 成片不跟：新的一集从空白故事板开始
    scenes: [],
    shots: [],
    dialogue: [],
    voiceTakes: [],
    takes: [],
    timeline: {
      items: [],
      music: [],
      sfx: [],
      mix: structuredClone(source.timeline.mix),
    },
    subtitleOverrides: [],
    approvals: [],
    gates: [],
    publishPackages: [],
    authorizations: [],
  };
}
