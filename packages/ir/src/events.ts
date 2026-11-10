import { clone } from "./clone";
import type { Id, Project, Shot, Take } from "./schema";

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
  | { type: "shot.updated"; at: string; shotId: Id; patch: Partial<Shot> }
  | { type: "take.added"; at: string; take: Take }
  | {
      type: "take.updated";
      at: string;
      takeId: Id;
      /** 只允许改生成结果的状态与元数据，id 与 shotId 不可改 */
      patch: Partial<Omit<Take, "id" | "shotId">>;
    };

export function applyEvent(
  current: Project | null,
  event: ProjectEvent,
): Project {
  switch (event.type) {
    case "project.created":
      return clone(event.project);

    case "shot.updated": {
      if (!current) throw new Error("shot.updated 之前必须有 project.created");
      const shots = current.shots.map((shot) =>
        shot.id === event.shotId ? { ...shot, ...event.patch } : shot,
      );
      return { ...current, shots };
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
