/**
 * 工作台 store 的纯辅助函数。
 *
 * 这些函数只吃参数、只吐结果，不碰 store 的 `get` / `set`，也不读盘。
 * 放在这里而不是留在 `workbench-store.ts` 里，是因为那个文件已经近八千行：
 * 纯逻辑与「状态 + 副作用」混在一起，改一个纯函数也要翻过几百行 action。
 *
 * 从 `workbench-store.ts` 抽出来的第一批（2026-11-14）。
 */

import type { ApprovalTargetType, Project, ProjectEvent, TimelineItem } from "@loomina/ir";
import { toStageView, type RemovalKind } from "./read-model";

/**
 * 按顺序重排起点，保持首尾相接（E1）。
 *
 * 渲染清单要求「片段累计时长 = 全长」，留空隙会让导出直接失败；
 * 所以时间线上的一切改动都走这里，起点永远由顺序推出来，不由用户拖。
 */
export function restack(items: TimelineItem[]): TimelineItem[] {
  let cursor = 0;
  return items.map((item) => {
    const next = { ...item, startMs: cursor };
    cursor += item.durationMs;
    return next;
  });
}

/**
 * 角色配色的规范形状（D3 / ADR-0146）：大写十六进制、按角色 id 排序。
 *
 * 排序只为了让「和当前值一样」的比较稳定——对象键序不该决定写不写事件。
 */
export function canonicalSpeakerColors(
  value?: Record<string, string> | null,
): Record<string, string> | undefined {
  if (!value) return undefined;
  const ids = Object.keys(value).filter((id) => id.trim().length > 0).sort();
  if (ids.length === 0) return undefined;
  return Object.fromEntries(ids.map((id) => [id, value[id]!.toUpperCase()]));
}

/** 当前镜之后第一格还没定的；到末尾就回到开头找；全定完了就原地不动。 */
export function nextOpenShotId(project: Project, fromId: string): string {
  const { shots } = toStageView(project);
  const from = shots.findIndex((shot) => shot.id === fromId);
  if (from < 0) return fromId;

  const ordered = [...shots.slice(from + 1), ...shots.slice(0, from + 1)];
  return ordered.find((shot) => shot.state === "open")?.id ?? fromId;
}

/** 这个对象是否已经过了定妆闸门（锁定后下游只能引用、不能悄悄替换） */
export function isLocked(
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

/** 这次写入是「在日志末尾接一段」吗？加载 / 重来会整体换掉日志，不算编辑 */
export function appendOnly(before: ProjectEvent[], after: ProjectEvent[]): boolean {
  if (after.length <= before.length) return false;
  for (let index = 0; index < before.length; index += 1) {
    if (after[index] !== before[index]) return false;
  }
  return true;
}

/**
 * 把一次删除补回来：用「删除之前」的那一份项目写补偿事件（ADR-0076）。
 *
 * 撤销最近一次删除（页头那个按钮）与回收站里恢复早先的删除，
 * 走的是同一条逻辑——区别只在挑哪一条删除事件。
 */
export function removalUndoEvents(
  before: Project,
  project: Project,
  target: { kind: RemovalKind; id: string },
  at: string,
): { written: ProjectEvent[]; focusShotId?: string } {
  const written: ProjectEvent[] = [];
  let focusShotId: string | undefined;

  switch (target.kind) {
    case "character": {
      const character = before.characters.find((item) => item.id === target.id);
      if (!character) throw new Error("找不到被删的人物。");
      written.push({ type: "character.added", at, character });
      break;
    }
    case "prop": {
      const prop = before.props.find((item) => item.id === target.id);
      if (!prop) throw new Error("找不到被删的道具。");
      written.push({ type: "prop.added", at, prop });
      break;
    }
    case "location": {
      const location = before.locations.find((item) => item.id === target.id);
      if (!location) throw new Error("找不到被删的地点。");
      written.push({ type: "location.added", at, location });
      break;
    }
    case "scene": {
      const scene = before.scenes.find((item) => item.id === target.id);
      if (!scene) throw new Error("找不到被删的场次。");
      // 场次先回来，镜头随后一次一步地撤（ADR-0067 是逐镜删、再删场）
      written.push({
        type: "scene.added",
        at,
        scene: { ...scene, index: Math.min(scene.index, project.scenes.length), shotIds: [] },
      });
      break;
    }
    case "shot": {
      const shot = before.shots.find((item) => item.id === target.id);
      if (!shot) throw new Error("找不到被删的镜头。");
      const scene = project.scenes.find((item) => item.id === shot.sceneId);
      if (!scene) {
        const sceneBefore = before.scenes.find((item) => item.id === shot.sceneId);
        throw new Error(
          `这一镜原来在${sceneBefore ? `第 ${sceneBefore.index + 1} 场` : "已删的场次"}，那一场也删了：先撤销那一场。`,
        );
      }
      const lines = shot.dialogueIds.flatMap((id) => {
        const line = before.dialogue.find((item) => item.id === id);
        return line ? [line] : [];
      });
      const takes = shot.takeIds.flatMap((id) => {
        const take = before.takes.find((item) => item.id === id);
        return take ? [take] : [];
      });
      // 镜头先回来（台词、take 各自再补：shot.added 不收这两样）
      written.push({
        type: "shot.added",
        at,
        shot: {
          ...shot,
          index: Math.min(shot.index, scene.shotIds.length),
          dialogueIds: [],
          takeIds: [],
        },
      });
      for (const line of lines) {
        // 这一句可能已经被「恢复」回别的镜头：不重复添加
        if (!project.dialogue.some((item) => item.id === line.id)) {
          written.push({ type: "dialogue.added", at, shotId: shot.id, line });
        }
      }
      for (const take of takes) {
        if (!project.takes.some((item) => item.id === take.id)) {
          written.push({ type: "take.added", at, take });
        }
      }
      // 台词顺序按删之前的样子写一遍（已有同 id 的句子也排进来）
      const order = shot.dialogueIds.filter(
        (id) =>
          project.dialogue.some((item) => item.id === id) ||
          lines.some((item) => item.id === id),
      );
      if (order.length > 0) {
        written.push({ type: "shot.updated", at, shotId: shot.id, patch: { dialogueIds: order } });
      }
      focusShotId = shot.id;
      break;
    }
  }

  return focusShotId ? { written, focusShotId } : { written };
}
