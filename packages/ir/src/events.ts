import { clone } from "./clone";
import type {
  Approval,
  Asset,
  DialogueLine,
  Id,
  Project,
  Shot,
  Take,
} from "./schema";

/**
 * 事件日志（ADR-0011）。
 *
 * 第一版只做“可回放”：
 * - `project.created` 是引导事件，携带初始快照；
 * - 其后的增量事件在快照上应用。
 *
 * 不做 CRDT、不做 OTIO、不做多人协作。
 */
export type ProjectEvent =
  | { type: "project.created"; at: string; project: Project }
  | {
      /** 项目级设置：目前只有预算。预算改了要留痕，否则"超没超"说不清 */
      type: "project.updated";
      at: string;
      budgetCny: number;
    }
  | { type: "shot.updated"; at: string; shotId: Id; patch: Partial<Shot> }
  | {
      /**
       * 台词改写（ADR-0044）：只允许改文本与时长。
       * 说话人不在这里改——换人等于换一句台词，应该新增而不是覆盖。
       */
      type: "dialogue.updated";
      at: string;
      lineId: Id;
      patch: Partial<Omit<DialogueLine, "id" | "characterId">>;
    }
  | { type: "take.added"; at: string; take: Take }
  | {
      /** 闸门：定妆锁定 / 解锁。同一目标只保留一条，按 (targetType, targetId) 覆盖。 */
      type: "approval.updated";
      at: string;
      approval: Approval;
    }
  | {
      type: "take.updated";
      at: string;
      takeId: Id;
      /** 只允许改生成结果的状态与元数据，id 与 shotId 不可改 */
      patch: Partial<Omit<Take, "id" | "shotId">>;
    }
  | {
      /** 资产回写：生成结果落成一张图，按 id upsert。 */
      type: "asset.updated";
      at: string;
      asset: Asset;
    };

export function applyEvent(
  current: Project | null,
  event: ProjectEvent,
): Project {
  switch (event.type) {
    case "project.created":
      return clone(event.project);

    case "project.updated": {
      if (!current) throw new Error("project.updated 之前必须有 project.created");
      if (!(event.budgetCny > 0)) {
        throw new Error(`预算必须大于 0：${event.budgetCny}`);
      }
      return { ...current, budgetCny: event.budgetCny };
    }

    case "shot.updated": {
      if (!current) throw new Error("shot.updated 之前必须有 project.created");
      const shots = current.shots.map((shot) =>
        shot.id === event.shotId ? { ...shot, ...event.patch } : shot,
      );
      return { ...current, shots };
    }

    case "dialogue.updated": {
      if (!current) throw new Error("dialogue.updated 之前必须有 project.created");
      const line = current.dialogue.find((item) => item.id === event.lineId);
      if (!line) {
        throw new Error(`dialogue.updated 指向不存在的台词: ${event.lineId}`);
      }
      if (event.patch.text !== undefined && event.patch.text.trim().length === 0) {
        throw new Error("台词不能改成空");
      }
      if (event.patch.durationMs !== undefined && !(event.patch.durationMs > 0)) {
        throw new Error(`台词时长必须大于 0：${event.patch.durationMs}`);
      }
      const dialogue = current.dialogue.map((item) =>
        item.id === event.lineId ? { ...item, ...event.patch } : item,
      );
      return { ...current, dialogue };
    }

    case "take.updated": {
      if (!current) throw new Error("take.updated 之前必须有 project.created");
      if (!current.takes.some((take) => take.id === event.takeId)) {
        throw new Error(`take.updated 指向不存在的 take: ${event.takeId}`);
      }
      const takes = current.takes.map((take) =>
        take.id === event.takeId ? { ...take, ...event.patch } : take,
      );
      return { ...current, takes };
    }

    case "approval.updated": {
      if (!current) throw new Error("approval.updated 之前必须有 project.created");
      const exists = current.approvals.some(
        (item) =>
          item.id === event.approval.id ||
          (item.targetType === event.approval.targetType &&
            item.targetId === event.approval.targetId),
      );
      const approvals = exists
        ? current.approvals.map((item) =>
            item.id === event.approval.id ||
            (item.targetType === event.approval.targetType &&
              item.targetId === event.approval.targetId)
              ? event.approval
              : item,
          )
        : [...current.approvals, event.approval];
      return { ...current, approvals };
    }

    case "asset.updated": {
      if (!current) throw new Error("asset.updated 之前必须有 project.created");
      const exists = current.assets.some((item) => item.id === event.asset.id);
      const assets = exists
        ? current.assets.map((item) =>
            item.id === event.asset.id ? { ...item, ...event.asset } : item,
          )
        : [...current.assets, event.asset];
      return { ...current, assets };
    }

    case "take.added": {
      if (!current) throw new Error("take.added 之前必须有 project.created");
      const shots = current.shots.map((shot) =>
        shot.id === event.take.shotId
          ? { ...shot, takeIds: [...shot.takeIds, event.take.id] }
          : shot,
      );
      return {
        ...current,
        shots,
        takes: [...current.takes, event.take],
      };
    }
  }
}

export function rebuild(events: ProjectEvent[]): Project {
  if (events.length === 0) throw new Error("事件日志为空");
  return events.reduce<Project | null>(
    (project, event) => applyEvent(project, event),
    null,
  ) as Project;
}
