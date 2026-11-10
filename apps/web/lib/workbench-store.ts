"use client";

import {
  applyEvent,
  castReadiness,
  SHEET_ANGLES,
  type ApprovalTargetType,
  type Project,
  type ProjectEvent,
  type SheetView,
} from "@loomina/ir";
import { create } from "zustand";
import { latestTake, toStageView } from "@/lib/read-model";
import { sampleProject } from "@/lib/sample-project";

export type Decision = "approved" | "rejected";

/** 正在生成哪一张：定妆台的三类资产共用一条进度记录。 */
export type GenerateJob =
  | { kind: "sheet"; angle: SheetView }
  | { kind: "master" }
  | { kind: "prop" };

/**
 * 审片台的本地状态（ADR-0027）。
 *
 * - `events` 是事实，`project` 是它跑出来的结果，两者一起持有只是为了少算；
 * - 选格子不发事件，只有留用 / 淘汰才写一条 `take.updated`；
 * - 还没有服务端，刷新即回到示例项目。
 */
type WorkbenchState = {
  project: Project;
  events: ProjectEvent[];
  currentShotId: string;
  /** 正在生成哪一张：人物 / 场景 / 道具的 id → 任务。出图是分钟级，界面要如实显示进度 */
  jobs: Record<string, GenerateJob | undefined>;
  castError?: string;
  select: (shotId: string) => void;
  decide: (status: Decision) => void;
  /** 定妆闸门：锁定 / 解锁一个角色、场景或道具 */
  lockCast: (targetType: ApprovalTargetType, targetId: string) => void;
  unlockCast: (targetType: ApprovalTargetType, targetId: string) => void;
  /** 逐格生成三视图；每落一张写一条 `asset.updated` */
  generateSheet: (characterId: string) => Promise<void>;
  /** 生成场景主镜 */
  generateMaster: (locationId: string) => Promise<void>;
  /** 生成道具参考图 */
  generateProp: (propId: string) => Promise<void>;
  reset: () => void;
};

function bootstrap(project: Project): ProjectEvent[] {
  return [
    {
      type: "project.created",
      at: "2026-11-10T00:00:00+08:00",
      project,
    },
  ];
}

const initialEvents = bootstrap(sampleProject);
const initialView = toStageView(sampleProject);
const initialShotId =
  initialView.shots[initialView.current]?.id ?? sampleProject.shots[0]?.id ?? "";

/** 当前镜之后第一格还没定的；到末尾就回到开头找；全定完了就原地不动。 */
function nextOpenShotId(project: Project, fromId: string): string {
  const { shots } = toStageView(project);
  const from = shots.findIndex((shot) => shot.id === fromId);
  if (from < 0) return fromId;

  const ordered = [...shots.slice(from + 1), ...shots.slice(0, from + 1)];
  return ordered.find((shot) => shot.state === "open")?.id ?? fromId;
}

function isLocked(
  project: Project,
  targetType: ApprovalTargetType,
  targetId: string,
): boolean {
  return project.approvals.some(
    (item) =>
      item.targetType === targetType &&
      item.targetId === targetId &&
      item.status === "approved",
  );
}

type Store = {
  get: () => WorkbenchState;
  set: (partial: Partial<WorkbenchState>) => void;
};

/**
 * 出一张图，落一条 `asset.updated`。
 *
 * 失败写一句人话并返回 false：批量生成据此停下，不把后面的也浪费掉。
 */
async function generateOne(
  { get, set }: Store,
  input: {
    /** 进度记在谁头上：角色 / 场景 / 道具的 id */
    key: string;
    /** 出错时点名的对象 */
    label: string;
    assetId: string;
    job: GenerateJob;
    body: Record<string, unknown>;
  },
): Promise<boolean> {
  const setJob = (value: GenerateJob | undefined) =>
    set({ jobs: { ...get().jobs, [input.key]: value } });

  setJob(input.job);
  try {
    const response = await fetch("/api/asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.body),
    });
    const payload = (await response.json()) as {
      uri?: string;
      model?: string;
      prompt?: string;
      error?: string;
    };
    if (!response.ok || !payload.uri) {
      throw new Error(payload.error ?? `生成失败（${response.status}）`);
    }

    const at = new Date().toISOString();
    const event: ProjectEvent = {
      type: "asset.updated",
      at,
      asset: {
        id: input.assetId,
        kind: "image",
        source: "generated",
        uri: payload.uri,
        mime: "image/png",
        provenance: {
          modelId: payload.model ?? "unknown",
          prompt: payload.prompt,
          referenceAssetIds: [],
          createdAt: at,
        },
        createdAt: at,
      },
    };
    set({
      project: applyEvent(get().project, event),
      events: [...get().events, event],
    });
    setJob(undefined);
    return true;
  } catch (error) {
    setJob(undefined);
    set({
      castError:
        error instanceof Error ? `「${input.label}」${error.message}` : "生成失败",
    });
    return false;
  }
}

export const useWorkbench = create<WorkbenchState>()((set, get) => ({
  project: sampleProject,
  events: initialEvents,
  currentShotId: initialShotId,
  jobs: {},

  select: (shotId) => {
    if (shotId === get().currentShotId) return;
    set({ currentShotId: shotId });
  },

  decide: (status) => {
    const { project, events, currentShotId } = get();
    const shot = project.shots.find((item) => item.id === currentShotId);
    if (!shot || shot.locked) return; // 锁定的镜头不在这里改

    const take = latestTake(shot, new Map(project.takes.map((item) => [item.id, item])));
    if (!take || take.status === status) return; // 没有可改的版本，或状态没变

    const event: ProjectEvent = {
      type: "take.updated",
      at: new Date().toISOString(),
      takeId: take.id,
      patch: { status },
    };
    const next = applyEvent(project, event);

    set({
      project: next,
      events: [...events, event],
      currentShotId: nextOpenShotId(next, currentShotId),
    });
  },

  lockCast: (targetType, targetId) => {
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

    const at = new Date().toISOString();
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
    const { project, events } = get();
    const existing = project.approvals.find(
      (item) => item.targetType === targetType && item.targetId === targetId,
    );
    if (!existing) return;

    const event: ProjectEvent = {
      type: "approval.updated",
      at: new Date().toISOString(),
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
    const { project } = get();
    const character = project.characters.find((item) => item.id === characterId);
    if (!character) return;
    // 锁定的定妆不能被覆盖：要重做先解锁（准则 P14）
    if (isLocked(project, "character", characterId)) return;

    const angles = SHEET_ANGLES.filter((angle) => character.sheet[angle]);
    if (angles.length === 0) {
      set({ castError: "这个角色还没有三视图的资产位，先建四个格子" });
      return;
    }

    set({ castError: undefined });
    for (const angle of angles) {
      const ok = await generateOne(
        { get, set },
        {
          key: characterId,
          label: character.name,
          assetId: character.sheet[angle]!,
          job: { kind: "sheet", angle },
          body: {
            kind: "sheet",
            character: {
              name: character.name,
              appearance: character.appearance,
              mustNotChange: character.mustNotChange,
            },
            angle,
          },
        },
      );
      if (!ok) return; // 一格没成，后面的也多半不成；别继续烧钱
    }
  },

  generateMaster: async (locationId) => {
    const { project } = get();
    const location = project.locations.find((item) => item.id === locationId);
    if (!location) return;
    if (isLocked(project, "location", locationId)) return;
    if (!location.masterShotId) {
      set({ castError: `「${location.name}」还没有主镜的资产位` });
      return;
    }

    set({ castError: undefined });
    await generateOne(
      { get, set },
      {
        key: locationId,
        label: location.name,
        assetId: location.masterShotId,
        job: { kind: "master" },
        body: { kind: "master", location: { name: location.name } },
      },
    );
  },

  generateProp: async (propId) => {
    const { project } = get();
    const prop = project.props.find((item) => item.id === propId);
    if (!prop) return;
    if (isLocked(project, "prop", propId)) return;
    const assetId = prop.referenceImages[0];
    if (!assetId) {
      set({ castError: `「${prop.name}」还没有参考图的资产位` });
      return;
    }

    set({ castError: undefined });
    await generateOne(
      { get, set },
      {
        key: propId,
        label: prop.name,
        assetId,
        job: { kind: "prop" },
        body: {
          kind: "prop",
          prop: { name: prop.name, description: prop.description },
        },
      },
    );
  },

  reset: () => {
    const project = applyEvent(null, initialEvents[0]!);
    set({
      project,
      events: bootstrap(project),
      currentShotId: initialShotId,
      jobs: {},
      castError: undefined,
    });
  },
}));
