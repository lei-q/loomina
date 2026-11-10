import { clone } from "./clone";
import type {
  Approval,
  Asset,
  DialogueLine,
  Id,
  Location,
  Project,
  Scene,
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
       * 场头改写（ADR-0050）：目前只允许内 / 外景与日夜。
       * 地点、场号属于结构，不在这里改。
       */
      type: "scene.updated";
      at: string;
      sceneId: Id;
      patch: Partial<Pick<Scene, "space" | "timeOfDay" | "locationId">>;
    }
  | {
      /**
       * 调整场序（ADR-0060）：一场一位。镜号跟着场序重排；
       * 台词、take、关键帧都按 id 引用，不跟着动。
       */
      type: "scene.moved";
      at: string;
      sceneId: Id;
      /** 挪到第几位（从 0 数），必须落在现有场次范围内 */
      toIndex: number;
    }
  | {
      /** 加一个地点（ADR-0059）：先有地点，场次才挂得上去 */
      type: "location.added";
      at: string;
      location: Location;
    }  | {
      /** 改地点（ADR-0059）：名字与模板；主镜与参考图走资产那条路 */
      type: "location.updated";
      at: string;
      locationId: Id;
      patch: Partial<Pick<Location, "name" | "templateId">>;
    }
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
  | {
      /** 换说话人（ADR-0046）：同一句台词换个角色说，文本与时长不动 */
      type: "dialogue.speaker.updated";
      at: string;
      lineId: Id;
      characterId: Id;
    }
  | {
      /** 加一句台词（ADR-0045）：同时挂到镜头的 dialogueIds 上 */
      type: "dialogue.added";
      at: string;
      shotId: Id;
      line: DialogueLine;
    }
  | {
      /** 删一句台词（ADR-0045）：整句从项目与所属镜头上摘掉 */
      type: "dialogue.removed";
      at: string;
      lineId: Id;
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

    case "scene.updated": {
      if (!current) throw new Error("scene.updated 之前必须有 project.created");
      if (!current.scenes.some((scene) => scene.id === event.sceneId)) {
        throw new Error(`scene.updated 指向不存在的场次: ${event.sceneId}`);
      }
      if (Object.keys(event.patch).length === 0) {
        throw new Error("scene.updated 的 patch 是空的");
      }
      if (
        event.patch.locationId !== undefined &&
        !current.locations.some((location) => location.id === event.patch.locationId)
      ) {
        throw new Error(`scene.updated 指向不存在的地点: ${event.patch.locationId}`);
      }
      const scenes = current.scenes.map((scene) =>
        scene.id === event.sceneId ? { ...scene, ...event.patch } : scene,
      );
      return { ...current, scenes };
    }

    case "scene.moved": {
      if (!current) throw new Error("scene.moved 之前必须有 project.created");
      const ordered = [...current.scenes].sort((a, b) => a.index - b.index);
      const from = ordered.findIndex((scene) => scene.id === event.sceneId);
      if (from < 0) {
        throw new Error(`scene.moved 指向不存在的场次: ${event.sceneId}`);
      }
      if (
        !Number.isInteger(event.toIndex) ||
        event.toIndex < 0 ||
        event.toIndex >= ordered.length
      ) {
        throw new Error(`scene.moved 的目标位置越界: ${event.toIndex}`);
      }
      if (event.toIndex === from) {
        throw new Error(`场次 ${event.sceneId} 已经在这个位置`);
      }
      const [moved] = ordered.splice(from, 1);
      ordered.splice(event.toIndex, 0, moved!);
      const scenes = ordered.map((scene, index) => ({ ...scene, index }));
      return { ...current, scenes };
    }

    case "location.added": {
      if (!current) throw new Error("location.added 之前必须有 project.created");
      if (event.location.name.trim().length === 0) throw new Error("地点总得有个名字");
      if (current.locations.some((location) => location.id === event.location.id)) {
        throw new Error(`location.added 重复的地点: ${event.location.id}`);
      }
      return { ...current, locations: [...current.locations, event.location] };
    }

    case "location.updated": {
      if (!current) throw new Error("location.updated 之前必须有 project.created");
      if (!current.locations.some((location) => location.id === event.locationId)) {
        throw new Error(`location.updated 指向不存在的地点: ${event.locationId}`);
      }
      if (Object.keys(event.patch).length === 0) {
        throw new Error("location.updated 的 patch 是空的");
      }
      if (event.patch.name !== undefined && event.patch.name.trim().length === 0) {
        throw new Error("地点总得有个名字");
      }
      const locations = current.locations.map((location) =>
        location.id === event.locationId ? { ...location, ...event.patch } : location,
      );
      return { ...current, locations };
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

    case "dialogue.speaker.updated": {
      if (!current) throw new Error("dialogue.speaker.updated 之前必须有 project.created");
      const line = current.dialogue.find((item) => item.id === event.lineId);
      if (!line) {
        throw new Error(`dialogue.speaker.updated 指向不存在的台词: ${event.lineId}`);
      }
      if (!current.characters.some((item) => item.id === event.characterId)) {
        throw new Error(`dialogue.speaker.updated 指向不存在的角色: ${event.characterId}`);
      }
      if (line.characterId === event.characterId) {
        throw new Error(`台词 ${event.lineId} 已经是 ${event.characterId} 说的`);
      }
      return {
        ...current,
        dialogue: current.dialogue.map((item) =>
          item.id === event.lineId ? { ...item, characterId: event.characterId } : item,
        ),
      };
    }

    case "dialogue.added": {
      if (!current) throw new Error("dialogue.added 之前必须有 project.created");
      if (current.dialogue.some((item) => item.id === event.line.id)) {
        throw new Error(`dialogue.added 的台词 id 已存在: ${event.line.id}`);
      }
      const shot = current.shots.find((item) => item.id === event.shotId);
      if (!shot) {
        throw new Error(`dialogue.added 指向不存在的镜头: ${event.shotId}`);
      }
      if (event.line.text.trim().length === 0 || !(event.line.durationMs > 0)) {
        throw new Error("dialogue.added 的台词必须是正时长且非空");
      }
      return {
        ...current,
        dialogue: [...current.dialogue, event.line],
        shots: current.shots.map((item) =>
          item.id === event.shotId
            ? { ...item, dialogueIds: [...item.dialogueIds, event.line.id] }
            : item,
        ),
      };
    }

    case "dialogue.removed": {
      if (!current) throw new Error("dialogue.removed 之前必须有 project.created");
      if (!current.dialogue.some((item) => item.id === event.lineId)) {
        throw new Error(`dialogue.removed 指向不存在的台词: ${event.lineId}`);
      }
      return {
        ...current,
        dialogue: current.dialogue.filter((item) => item.id !== event.lineId),
        shots: current.shots.map((item) =>
          item.dialogueIds.includes(event.lineId)
            ? { ...item, dialogueIds: item.dialogueIds.filter((id) => id !== event.lineId) }
            : item,
        ),
      };
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
