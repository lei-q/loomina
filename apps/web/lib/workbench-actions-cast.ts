/**
 * 定妆台的 action 切片（B2 / B13 / B17 / F8）。
 *
 * 从 `workbench-store.ts` 拆出的第二批 action（2026-11-15）：
 * 锁定 / 解锁、出定妆照、出场景主镜。
 *
 * 与 workspace 组不同，这几个**会花钱**（调出图接口），所以都要先过
 * `lockedStage` 的第二道闸；生成本身走 `generateOne`，与主 store 同一份实现。
 */

import {
  applyEvent,
  castReadiness,
  SHEET_ANGLES,
  SHEET_LABELS,
  sheetSlotsOf,
  type Character,
  type Location,
  type ProjectEvent,
} from "@loomina/ir";
import { imagePlanOf } from "@/lib/image-plan";
import { persistAsset } from "@/lib/asset-client";
import type { WorkbenchState } from "@/lib/workbench-types";
import { generateOne, lockedStage } from "@/lib/workbench-generate";
import { isLocked, referenceImagesOf, withPromptOverride } from "@/lib/workbench-helpers";

type Store = {
  get: () => WorkbenchState;
  set: (partial: Partial<WorkbenchState>) => void;
};

type Stamp = () => string;

/** 这一片负责的动作：签名从主接口挑出来，少写多写都会在类型层报错 */
export type CastActions = Pick<
  WorkbenchState,
  "lockCast" | "unlockCast" | "generateSheet" | "generateMaster"
>;

export function castActions({ get, set }: Store, stamp: Stamp): CastActions {
  return {
  lockCast: (targetType, targetId) => {
    if (get().readOnly) return;
    const { project, events } = get();
    const readiness = castReadiness(project);
    const item = [
      ...readiness.characters,
      ...readiness.locations,
      ...readiness.props,
    ].find(
      (entry) => entry.targetType === targetType && entry.targetId === targetId,
    );
    // 缺资产、缺角度的不许锁：闸门的意义就在这里
    if (!item || item.status === "incomplete") return;

    const at = stamp();
    const event: ProjectEvent = {
      type: "approval.updated",
      at,
      approval: {
        id: `ap-${targetType}-${targetId}`,
        targetType,
        targetId,
        status: "approved",
        approvedAt: at,
        lockedAssetIds: item.assetIds,
      },
    };
    set({ project: applyEvent(project, event), events: [...events, event] });
  },

  unlockCast: (targetType, targetId) => {
    if (get().readOnly) return;
    const { project, events } = get();
    const existing = project.approvals.find(
      (item) => item.targetType === targetType && item.targetId === targetId,
    );
    if (!existing) return;

    const event: ProjectEvent = {
      type: "approval.updated",
      at: stamp(),
      approval: {
        id: existing.id,
        targetType,
        targetId,
        status: "pending",
        lockedAssetIds: [],
        note: existing.note,
      },
    };
    set({ project: applyEvent(project, event), events: [...events, event] });
  },

  generateSheet: async (characterId) => {
    if (get().readOnly) return;
    if (lockedStage({ get, set }, "cast")) return;
    const { project } = get();
    const character = project.characters.find((item) => item.id === characterId);
    if (!character) return;
    // 锁定的定妆不能被覆盖：要重做先解锁（准则 P14）
    if (isLocked(project, "character", characterId)) return;
    // 旧项目 / 还没补格子的角色（ADR-0144）：点「生成三视图」先补一条
    // `character.updated { sheet }` 把四个资产位占上，再一格一格出图。
    // 已有的格子（可能是作者换过的 id）原样保留。
    let active = character;
    if (SHEET_ANGLES.some((angle) => !character.sheet[angle])) {
      const sheet: Character["sheet"] = sheetSlotsOf(character.id);
      for (const angle of SHEET_ANGLES) {
        const assetId = character.sheet[angle];
        if (assetId) sheet[angle] = assetId;
      }
      const at = stamp();
      // 新占的格子也要有资产记录：不变量要求 sheet 的 id 指得到资产
      const slotEvents: ProjectEvent[] = SHEET_ANGLES.filter(
        (angle) => !character.sheet[angle],
      ).map((angle) => ({
        type: "asset.updated",
        at,
        asset: {
          id: sheet[angle]!,
          kind: "image",
          source: "generated",
          placeholder: true,
          createdAt: at,
        },
      }));
      const event: ProjectEvent = {
        type: "character.updated",
        at,
        characterId: character.id,
        patch: { sheet },
      };
      let nextProject = project;
      for (const item of [...slotEvents, event]) nextProject = applyEvent(nextProject, item);
      set({
        project: nextProject,
        events: [...get().events, ...slotEvents, event],
        castError: undefined,
      });
      active = nextProject.characters.find((item) => item.id === character.id) ?? character;
    } else {
      set({ castError: undefined });
    }

    for (const angle of SHEET_ANGLES) {
      const assetId = active.sheet[angle];
      if (!assetId) continue;
      // 参考图（B2 / ADR-0162）：已经出过的正面 / 3/4 当作这一格的身份锚。
      // 正面是锚点本身，不拿自己当参考；其余角度按「先正后侧」的顺序取前两张。
      const sheetRefs = SHEET_ANGLES.slice(0, SHEET_ANGLES.indexOf(angle))
        .map((other) => ({ assetId: active.sheet[other], label: `${active.name} · ${SHEET_LABELS[other]}` }))
        .filter((ref): ref is { assetId: string; label: string } => Boolean(ref.assetId))
        .slice(0, 2);
      const ok = await generateOne(
        { get, set },
        stamp,
        {
          key: characterId,
          label: active.name,
          assetId,
          job: { kind: "sheet", angle },
          body: {
            kind: "sheet",
            character: {
              name: active.name,
              appearance: active.appearance,
              mustNotChange: active.mustNotChange,
            },
            angle,
            look: get().project.look,
            skills: get().project.skills,
            ...withPromptOverride(get, `sheet:${characterId}:${angle}`),
          },
          references: referenceImagesOf(get().project, sheetRefs),
          referenceAssetIds: sheetRefs.map((ref) => ref.assetId),
        },
      );
      if (!ok) return; // 一格没成，后面的也多半不成；别继续烧钱
    }
  },



  generateMaster: async (locationId) => {
    if (get().readOnly) return;
    if (lockedStage({ get, set }, "cast")) return;
    const { project } = get();
    const location = project.locations.find((item) => item.id === locationId);
    if (!location) return;
    if (isLocked(project, "location", locationId)) return;
    if (!location.masterShotId) {
      set({ castError: `「${location.name}」还没有主镜的资产位` });
      return;
    }

    set({ castError: undefined });
    // 参考图（B2 / ADR-0162）：地点自己的参考图（B8）就是这张主镜要延续的角度与细节。
    // 参考图本身不占主镜的资产位，重生成也不会把它覆盖掉。
    const refs = referenceImagesOf(
      project,
      location.referenceImages.map((assetId) => ({ assetId, label: `${location.name} · 参考图` })),
    );
    await generateOne(
      { get, set },
      stamp,
      {
        key: locationId,
        label: location.name,
        assetId: location.masterShotId,
        job: { kind: "master" },
        body: {
          kind: "master",
          location: { name: location.name, description: location.description },
          look: get().project.look,
          skills: get().project.skills,
          ...withPromptOverride(get, `master:${locationId}`),
        },
        references: refs,
        referenceAssetIds: refs.map((ref) => ref.assetId),
      },
    );
  },
  };
}
