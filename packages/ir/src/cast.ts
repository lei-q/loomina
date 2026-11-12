import type { Approval, Asset, Character, Id, Project, SheetView } from "./schema";

/**
 * 定妆闸门（ADR-0028）。
 *
 * 规则只有一条：**有近景的角色，四格三视图必须齐全，才能锁定。**
 * 全景/远景里的角色可以先不做，等他真的需要一张脸时再补。
 *
 * 这里只做判断，不做生成：生成接通前，示例项目用占位素材走通同一条路径。
 */

export const SHEET_ANGLES = ["front", "threeQuarter", "side", "back"] as const;

export const SHEET_LABELS: Record<SheetView, string> = {
  front: "正面",
  threeQuarter: "3/4",
  side: "侧面",
  back: "背面",
};

/** 需要一张脸的景别：近景与特写。 */
const NEAR_SHOT_SIZES = new Set(["close", "extreme-close"]);

export type CastStatus = "locked" | "ready" | "incomplete";

export type CastItem = {
  targetType: "character" | "location" | "prop";
  targetId: Id;
  name: string;
  /** 这个角色是否有近景，决定三视图是否必须 */
  required: boolean;
  /** 已挂上的资产（锁定时写进 Approval.lockedAssetIds） */
  assetIds: Id[];
  /** 缺哪几格，只对角色有意义 */
  missingAngles: SheetView[];
  status: CastStatus;
  approval?: Approval;
};

export type CastReadiness = {
  characters: CastItem[];
  locations: CastItem[];
  props: CastItem[];
  /** 必须的锚点是否全部锁定 */
  complete: boolean;
  lockedCount: number;
  totalRequired: number;
};

export function requiresSheet(project: Project, characterId: Id): boolean {
  return project.shots.some(
    (shot) =>
      shot.characterIds.includes(characterId) && NEAR_SHOT_SIZES.has(shot.shotSize),
  );
}

export function missingSheetAngles(character: Character): SheetView[] {
  return SHEET_ANGLES.filter((angle) => !character.sheet[angle]);
}

/**
 * 四格的资产位（B1 / ADR-0144）：新建人物时先把四个格子占上。
 *
 * 格子只是一个稳定的资产 id，没有图也合法（界面画「待生成」）；
 * 出图时仍由 `asset.updated` 把图写进这个 id。旧项目没有格子时，
 * 「生成三视图」会先补一条 `character.updated { sheet }` 再出图。
 */
export function sheetSlotsOf(characterId: Id): Character["sheet"] {
  return Object.fromEntries(
    SHEET_ANGLES.map((angle) => [angle, `a-sheet-${characterId}-${angle}`]),
  ) as Character["sheet"];
}

/**
 * 四个资产位的占位资产：没有 uri，界面画剪影 / 「待生成」。
 * `Project` 的不变量要求 `sheet` 里的 id 都指向真实资产，所以占格子要连资产一起建。
 */
export function sheetSlotAssets(characterId: Id, at: string): Asset[] {
  const sheet = sheetSlotsOf(characterId);
  return SHEET_ANGLES.map((angle) => ({
    id: sheet[angle]!,
    kind: "image" as const,
    source: "generated" as const,
    placeholder: true,
    createdAt: at,
  }));
}

/** 一个目标在锁定时应当锁住的全部资产。 */
export function targetAssetIds(
  project: Project,
  targetType: CastItem["targetType"],
  targetId: Id,
): Id[] {
  if (targetType === "character") {
    const character = project.characters.find((item) => item.id === targetId);
    if (!character) return [];
    return [
      ...SHEET_ANGLES.map((angle) => character.sheet[angle]).filter(
        (id): id is Id => Boolean(id),
      ),
      ...character.referenceImages,
    ];
  }

  if (targetType === "location") {
    const location = project.locations.find((item) => item.id === targetId);
    if (!location) return [];
    return [
      ...(location.masterShotId ? [location.masterShotId] : []),
      ...location.referenceImages,
    ];
  }

  const prop = project.props.find((item) => item.id === targetId);
  return prop ? [...prop.referenceImages] : [];
}

function approvalFor(
  project: Project,
  targetType: CastItem["targetType"],
  targetId: Id,
): Approval | undefined {
  return project.approvals.find(
    (item) => item.targetType === targetType && item.targetId === targetId,
  );
}

function statusOf(
  approval: Approval | undefined,
  required: boolean,
  missingAngles: SheetView[],
  assetIds: Id[],
): CastStatus {
  if (approval?.status === "approved") return "locked";
  if (required && missingAngles.length > 0) return "incomplete";
  if (assetIds.length === 0) return "incomplete";
  return "ready";
}

export function castReadiness(project: Project): CastReadiness {
  // 只有盘上真的存在的资产才算数：新建人物会先占四个格子（ADR-0144），
  // 格子没有图时不能让闸门误以为「已经齐了」。
  const existingAssetIds = new Set(
    project.assets.filter((asset) => asset.placeholder !== true).map((asset) => asset.id),
  );
  const realAssetIds = (ids: Id[]) => ids.filter((id) => existingAssetIds.has(id));

  const characters: CastItem[] = project.characters.map((character) => {
    const required = requiresSheet(project, character.id);
    const missingAngles = missingSheetAngles(character);
    const assetIds = realAssetIds(targetAssetIds(project, "character", character.id));
    const approval = approvalFor(project, "character", character.id);
    return {
      targetType: "character",
      targetId: character.id,
      name: character.name,
      required,
      assetIds,
      missingAngles,
      status: statusOf(approval, required, missingAngles, assetIds),
      approval,
    };
  });

  const locations: CastItem[] = project.locations.map((location) => {
    const assetIds = realAssetIds(targetAssetIds(project, "location", location.id));
    const approval = approvalFor(project, "location", location.id);
    return {
      targetType: "location",
      targetId: location.id,
      name: location.name,
      // 有镜头的场景必须有主镜
      required: project.scenes.some((scene) => scene.locationId === location.id),
      assetIds,
      missingAngles: [],
      status: statusOf(approval, true, [], assetIds),
      approval,
    };
  });

  const props: CastItem[] = project.props.map((prop) => {
    const assetIds = realAssetIds(targetAssetIds(project, "prop", prop.id));
    const approval = approvalFor(project, "prop", prop.id);
    return {
      targetType: "prop",
      targetId: prop.id,
      name: prop.name,
      // 进了镜头的道具必须有参考图：它在画面里要被认得出来
      required: project.shots.some((shot) => shot.propIds.includes(prop.id)),
      assetIds,
      missingAngles: [],
      status: statusOf(approval, true, [], assetIds),
      approval,
    };
  });

  const requiredItems = [...characters, ...locations, ...props].filter(
    (item) => item.required,
  );
  const lockedRequired = requiredItems.filter((item) => item.status === "locked");

  return {
    characters,
    locations,
    props,
    complete:
      requiredItems.length > 0 && lockedRequired.length === requiredItems.length,
    lockedCount: lockedRequired.length,
    totalRequired: requiredItems.length,
  };
}
