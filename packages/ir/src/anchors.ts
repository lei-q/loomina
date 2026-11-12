import { SHEET_ANGLES, SHEET_LABELS, missingSheetAngles, requiresSheet } from "./cast";
import type { ApprovalTargetType, Character, Id, Project, Shot, SheetView } from "./schema";

/**
 * 资产锚点装配（ADR-0029）。
 *
 * 镜头的参考图不来自 `characterIds`——那是"人"，不是图。
 * 从定妆资产里挑：人物三视图里跟这个景别有关的几格，加一张场景主镜。
 *
 * 挑几张有上限：参考图不是越多越好（CONSISTENCY.md 第一层，2–4 张）。
 * 单人的近景取正面 + 3/4；多人同框每人只取正面，把名额留给场景。
 */
export const MAX_ANCHORS = 4;

export interface AnchorRef {
  assetId: Id;
  /** 给人看的名字，例如「林 · 正面」「走廊 · 主镜」 */
  label: string;
}

export interface ShotAnchors {
  shotId: Id;
  refs: AnchorRef[];
  /** 去重后的最终参考图；顺序即提示词里的顺序 */
  assetIds: Id[];
  /** 缺什么，人话；非空时生成链路必须拒绝这一镜 */
  missing: string[];
}

type LockedMap = Map<string, Set<Id>>;

const key = (type: ApprovalTargetType, id: Id): string => `${type}:${id}`;

/** 已通过的闸门 → 它锁住的那批资产。 */
function lockedByTarget(project: Project): LockedMap {
  const map: LockedMap = new Map();
  for (const approval of project.approvals) {
    if (approval.status !== "approved") continue;
    map.set(key(approval.targetType, approval.targetId), new Set(approval.lockedAssetIds));
  }
  return map;
}

/**
 * 有闸门时只认锁住的那批资产；没有闸门时用声明的资产。
 * 锁定后新增的图不在锁内，不能悄悄进生成。
 */
function usable(id: Id | undefined, locked: Set<Id> | undefined): Id | undefined {
  if (!id) return undefined;
  return !locked || locked.has(id) ? id : undefined;
}

function characterAnchors(
  project: Project,
  shot: Shot,
  character: Character,
  locked: Set<Id> | undefined,
): { refs: AnchorRef[]; missing: string[] } {
  const panels = SHEET_ANGLES.map(
    (angle) => [angle, usable(character.sheet[angle], locked)] as const,
  ).filter((entry): entry is readonly [SheetView, Id] => Boolean(entry[1]));

  const missing: string[] = [];
  if (requiresSheet(project, character.id)) {
    const gaps = missingSheetAngles({
      ...character,
      sheet: {
        front: usable(character.sheet.front, locked),
        threeQuarter: usable(character.sheet.threeQuarter, locked),
        side: usable(character.sheet.side, locked),
        back: usable(character.sheet.back, locked),
      },
    });
    if (gaps.length) {
      missing.push(
        `角色「${character.name}」缺${gaps.map((angle) => SHEET_LABELS[angle]).join("、")}`,
      );
    }
  }

  // 单人镜头多给一格角度，多人同框每人只给一张，免得参考图互相打架。
  const perCharacter = shot.characterIds.length === 1 ? 2 : 1;

  if (panels.length) {
    return {
      refs: panels.slice(0, perCharacter).map(([angle, id]) => ({
        assetId: id,
        label: `${character.name} · ${SHEET_LABELS[angle]}`,
      })),
      missing,
    };
  }

  // 没有三视图（不强制近景的角色）时退回普通参考图。
  const fallback = character.referenceImages.slice(0, perCharacter);
  return {
    refs: fallback.map((id, i) => ({
      assetId: id,
      label: `${character.name} · 参考${fallback.length > 1 ? ` ${i + 1}` : "图"}`,
    })),
    missing,
  };
}

/**
 * 一镜的锚点：人物（按景别取格）+ 场景主镜 + 道具参考。
 *
 * 顺序就是优先级：人物与空间先把名额占住，道具最后补；
 * 一镜里参考图挤不下时，先舍弃道具而不是脸或房间。
 */
export function shotAnchors(project: Project, shot: Shot): ShotAnchors {
  const locked = lockedByTarget(project);
  const missing: string[] = [];
  const refs: AnchorRef[] = [];

  for (const characterId of shot.characterIds) {
    const character = project.characters.find((item) => item.id === characterId);
    if (!character) {
      missing.push(`角色 ${characterId} 不存在`);
      continue;
    }
    const anchors = characterAnchors(
      project,
      shot,
      character,
      locked.get(key("character", character.id)),
    );
    refs.push(...anchors.refs);
    missing.push(...anchors.missing);
  }

  const scene = project.scenes.find((item) => item.id === shot.sceneId);
  const location = scene
    ? project.locations.find((item) => item.id === scene.locationId)
    : undefined;

  let sceneRef: AnchorRef | undefined;
  if (!location) {
    missing.push("镜头没有可用的场景");
  } else {
    const master = usable(location.masterShotId, locked.get(key("location", location.id)));
    if (!master) {
      missing.push(`场景「${location.name}」缺主镜`);
    } else {
      sceneRef = { assetId: master, label: `${location.name} · 主镜` };
    }
  }

  // 道具排在场景之后：有人在的近景里，脸比杯子重要。
  const propRefs: AnchorRef[] = [];
  for (const propId of shot.propIds) {
    const prop = project.props.find((item) => item.id === propId);
    if (!prop) {
      missing.push(`道具 ${propId} 不存在`);
      continue;
    }
    const lockedProp = locked.get(key("prop", prop.id));
    const usableRefs = prop.referenceImages.filter(
      (id) => !lockedProp || lockedProp.has(id),
    );
    if (!usableRefs.length) {
      missing.push(`道具「${prop.name}」缺参考图`);
      continue;
    }
    propRefs.push({ assetId: usableRefs[0]!, label: `${prop.name} · 参考图` });
  }

  // 地点自己的参考图（B8）：房间里别的角度 / 细节。排在道具之后拿剩下的名额，
  // 不改变「脸与房间优先」的既有顺序。
  const locationRefs: AnchorRef[] = [];
  if (location) {
    const lockedLocation = locked.get(key("location", location.id));
    for (const assetId of location.referenceImages) {
      if (lockedLocation && !lockedLocation.has(assetId)) continue;
      locationRefs.push({ assetId, label: `${location.name} · 参考图` });
    }
  }

  // 场景先占一个名额，人物再排；道具与地点参考图用剩下的名额。
  const identity = sceneRef ? refs.slice(0, MAX_ANCHORS - 1) : refs.slice(0, MAX_ANCHORS);
  const ordered = [
    ...identity,
    ...(sceneRef ? [sceneRef] : []),
    ...propRefs,
    ...locationRefs,
  ].slice(0, MAX_ANCHORS);

  const seen = new Set<Id>();
  const unique = ordered.filter((ref) => {
    if (seen.has(ref.assetId)) return false;
    seen.add(ref.assetId);
    return true;
  });

  return {
    shotId: shot.id,
    refs: unique,
    assetIds: unique.map((ref) => ref.assetId),
    missing,
  };
}
