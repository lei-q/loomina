import {
  SHEET_ANGLES,
  sheetSlotAssets,
  sheetSlotsOf,
  type Asset,
  type Character,
  type Location,
  type LocationSpace,
  type Project,
  type ProjectEvent,
  type Prop,
  type Vec3,
} from "@loomina/ir";
import type { WorkspaceProject } from "@/lib/workspace-assets";

/**
 * 跨空间复用「实体」：演员、场景、道具（C1 / ADR-0190）。
 *
 * C16 只搬一张参考图；做第二集时真正缺的是「这个人连同他的定妆三视图一起
 * 搬过来」「这个场景连同主镜一起搬过来」。这里给出跨空间清单，以及一个
 * **纯函数**：把源实体与它引用的资产映射成当前项目里的一条条事件。
 *
 * 口径：
 * - 资产只搬地址，不搬字节、不搬花费（`costCny` 属于花过钱的那个空间）；
 * - 当前项目里已有同一地址的资产就复用，不重复登记；
 * - 生成过的图记 `source: "library"`——本空间没为它付过钱，也不该算「未定价调用」；
 * - 上传 / 导入的图保留原 `source`，肖像与素材授权照旧要作者自己记。
 */

export type SharedEntityKind = "character" | "location" | "prop";

export type SharedEntity = {
  /** `${workspaceId}:${kind}:${id}`，列表里的稳定 key */
  key: string;
  kind: SharedEntityKind;
  id: string;
  name: string;
  /** 外形 / 场景描述 / 道具描述，列表里截断显示 */
  detail: string;
  workspaceId: string;
  workspaceName: string;
  /** 一张能认人的缩略图（定妆正面 → 主镜 → 第一张参考图） */
  thumbnail?: string;
  /** 复用时要读的实体本体 */
  entity: Character | Location | Prop;
  /** 它引用到的、有地址的资产（按源 id） */
  assets: Asset[];
};

const KIND_PREFIX: Record<SharedEntityKind, string> = {
  character: "c",
  location: "l",
  prop: "p",
};

const KIND_CN: Record<SharedEntityKind, string> = {
  character: "演员",
  location: "场景",
  prop: "道具",
};

export function sharedEntityKindLabel(kind: SharedEntityKind): string {
  return KIND_CN[kind];
}

function referencedIdsOf(kind: SharedEntityKind, entity: Character | Location | Prop): string[] {
  if (kind === "character") {
    const character = entity as Character;
    return [
      ...SHEET_ANGLES.map((angle) => character.sheet[angle]).filter(
        (id): id is string => Boolean(id),
      ),
      ...character.referenceImages,
    ];
  }
  if (kind === "location") {
    const location = entity as Location;
    return [
      ...(location.masterShotId ? [location.masterShotId] : []),
      ...location.referenceImages,
    ];
  }
  return [...(entity as Prop).referenceImages];
}

function entitiesOf(
  kind: SharedEntityKind,
  project: Project,
): Array<Character | Location | Prop> {
  if (kind === "character") return project.characters;
  if (kind === "location") return project.locations;
  return project.props;
}

/**
 * 各空间里可以复用的实体（纯函数）。按空间顺序列出，不做去重——
 * 同一个演员在两个空间各有一份，本来就可以各取各的。
 */
export function sharedEntitiesOf(
  spaces: WorkspaceProject[],
  kind: SharedEntityKind,
): SharedEntity[] {
  const list: SharedEntity[] = [];
  for (const space of spaces) {
    const byId = new Map(space.project.assets.map((asset) => [asset.id, asset]));
    for (const entity of entitiesOf(kind, space.project)) {
      const referenced = referencedIdsOf(kind, entity)
        .map((id) => byId.get(id))
        .filter((asset): asset is Asset => Boolean(asset?.uri));
      const thumbnail = referenced[0]?.uri;
      const detail =
        kind === "character"
          ? (entity as Character).appearance
          : (entity as Location | Prop).description;
      list.push({
        key: `${space.id}:${kind}:${entity.id}`,
        kind,
        id: entity.id,
        name: entity.name,
        detail,
        workspaceId: space.id,
        workspaceName: space.name,
        ...(thumbnail ? { thumbnail } : {}),
        entity,
        assets: referenced,
      });
    }
  }
  return list;
}

/** 列表里那行小字：搬过来会带上多少东西 */
export function sharedEntitySummary(entity: SharedEntity): string {
  const assets = entity.assets.length;
  if (entity.kind === "character") {
    const sheet = SHEET_ANGLES.filter((angle) => {
      const id = (entity.entity as Character).sheet[angle];
      return id && entity.assets.some((asset) => asset.id === id);
    }).length;
    return `${sheet} 格定妆 · ${assets - sheet} 张参考图`;
  }
  if (entity.kind === "location") {
    const location = entity.entity as Location;
    return `${location.masterShotId ? "主镜 1 张" : "没有主镜"} · ${assets - (location.masterShotId ? 1 : 0)} 张参考图`;
  }
  return `${assets} 张参考图`;
}

export type SharedEntityImport = {
  events: ProjectEvent[];
  entityId: string;
  name: string;
  /** 当前项目里已有同一地址、直接复用的资产数 */
  reused: number;
  /** 新登记进当前项目的资产数 */
  added: number;
  /** 源实体引用了、但没有地址（占位 / 没生成）而没搬的资产数 */
  skipped: number;
};

function base36(at: string): string {
  const ms = Date.parse(at);
  return (Number.isFinite(ms) ? ms : 0).toString(36);
}

function uniqueId(prefix: string, base: string, taken: Set<string>): string {
  let id = `${prefix}-share-${base}`;
  while (taken.has(id)) id += "x";
  return id;
}

function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  let next = `${name}（复用）`;
  let n = 2;
  while (taken.has(next)) next = `${name}（复用 ${n++}）`;
  return next;
}

/** 源资产的复制件：地址、尺寸、来源模型都留着，钱与复核不跟过来 */
function copiedAsset(source: Asset, id: string, at: string): Asset {
  if (!source.uri) throw new Error("copiedAsset 只收有地址的资产");
  const provenance = source.provenance
    ? {
        modelId: source.provenance.modelId,
        ...(source.provenance.prompt ? { prompt: source.provenance.prompt } : {}),
        ...(source.provenance.seed !== undefined ? { seed: source.provenance.seed } : {}),
        // 源项目里的引用 id 在这里不成立，宁可清空也不留悬空引用
        referenceAssetIds: [],
        createdAt: source.provenance.createdAt,
      }
    : undefined;
  return {
    id,
    kind: source.kind,
    uri: source.uri,
    // 生成过的图取过来记素材库：本空间没花过钱，也不该被当成未定价调用
    source: source.source === "generated" ? "library" : source.source,
    ...(source.mime ? { mime: source.mime } : {}),
    ...(source.width ? { width: source.width } : {}),
    ...(source.height ? { height: source.height } : {}),
    ...(source.durationMs ? { durationMs: source.durationMs } : {}),
    ...(provenance ? { provenance } : {}),
    createdAt: at,
  };
}

/**
 * 把一个源实体搬进当前项目（纯函数，不写 store）。
 *
 * 返回的事件要按顺序喂给 `applyEvent`：先资产、后实体——不变量要求实体
 * 引用的资产已经在项目里。
 */
export function sharedEntityImport(
  shared: SharedEntity,
  project: Project,
  at: string,
): SharedEntityImport {
  const base = base36(at);
  const takenEntityIds = new Set(
    entitiesOf(shared.kind, project).map((entity) => entity.id),
  );
  const entityId = uniqueId(KIND_PREFIX[shared.kind], base, takenEntityIds);
  const takenNames = new Set(entitiesOf(shared.kind, project).map((entity) => entity.name));
  const name = uniqueName(shared.name, takenNames);

  // 1) 资产：同地址复用，否则登记复制件
  const mapped = new Map<string, string>();
  const copied: Asset[] = [];
  let placeholders = 0;
  let reused = 0;
  const known = new Set(shared.assets.map((asset) => asset.id));
  // 源实体引用到、但清单里没有的资产（占位 / 没生成 / 没地址）
  let skipped = referencedIdsOf(shared.kind, shared.entity).filter((id) => !known.has(id)).length;
  const takenAssetIds = new Set(project.assets.map((asset) => asset.id));
  for (const source of shared.assets) {
    if (!source.uri) {
      skipped += 1;
      continue;
    }
    // 也查这一轮刚登记进来的复制件：同一个源里两张图指向同一地址时只存一份
    const same = [...project.assets, ...copied].find(
      (asset) => asset.uri === source.uri && asset.kind === source.kind,
    );
    if (same) {
      mapped.set(source.id, same.id);
      reused += 1;
      continue;
    }
    const id = uniqueId("a", base, takenAssetIds);
    takenAssetIds.add(id);
    copied.push(copiedAsset(source, id, at));
    mapped.set(source.id, id);
  }

  const events: ProjectEvent[] = copied.map((asset) => ({
    type: "asset.updated" as const,
    at,
    asset,
  }));

  if (shared.kind === "character") {
    const source = shared.entity as Character;
    const slots = sheetSlotsOf(entityId);
    const slotAssets = sheetSlotAssets(entityId, at);
    const sheet: Character["sheet"] = {};
    for (const angle of SHEET_ANGLES) {
      const from = source.sheet[angle];
      const to = from ? mapped.get(from) : undefined;
      if (to) {
        sheet[angle] = to;
        continue;
      }
      const slot = slots[angle];
      if (!slot) continue;
      const placeholder = slotAssets.find((asset) => asset.id === slot);
      if (placeholder) {
        events.push({ type: "asset.updated", at, asset: placeholder });
        placeholders += 1;
      }
      sheet[angle] = slot;
    }
    const character: Character = {
      id: entityId,
      name,
      appearance: source.appearance,
      ...(source.voiceProfileId ? { voiceProfileId: source.voiceProfileId } : {}),
      sheet,
      referenceImages: source.referenceImages
        .map((id) => mapped.get(id))
        .filter((id): id is string => Boolean(id)),
      mustNotChange: [...source.mustNotChange],
    };
    events.push({ type: "character.added", at, character });
  } else if (shared.kind === "location") {
    const source = shared.entity as Location;
    const location: Location = {
      id: entityId,
      name,
      ...(source.templateId ? { templateId: source.templateId } : {}),
      description: source.description,
      ...(source.masterShotId && mapped.get(source.masterShotId)
        ? { masterShotId: mapped.get(source.masterShotId) }
        : {}),
      referenceImages: source.referenceImages
        .map((id) => mapped.get(id))
        .filter((id): id is string => Boolean(id)),
      ...(source.space ? { space: cloneSpace(source.space) } : {}),
    };
    events.push({ type: "location.added", at, location });
  } else {
    const source = shared.entity as Prop;
    const prop: Prop = {
      id: entityId,
      name,
      description: source.description,
      referenceImages: source.referenceImages
        .map((id) => mapped.get(id))
        .filter((id): id is string => Boolean(id)),
    };
    events.push({ type: "prop.added", at, prop });
  }

  return {
    events,
    entityId,
    name,
    reused,
    added: copied.length + placeholders,
    skipped,
  };
}

function cloneSpace(space: LocationSpace): LocationSpace {
  return {
    dimensions: [...space.dimensions] as Vec3,
    anchors: space.anchors.map((anchor) => ({
      ...anchor,
      position: [...anchor.position] as Vec3,
    })),
  };
}
