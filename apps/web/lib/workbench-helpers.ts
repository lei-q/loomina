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
import type { GenerateJob, WorkbenchState } from "./workbench-types";
import {
  hasWorkspaces,
  listWorkspaces,
  saveWorkspace,
  type WorkspaceMeta,
} from "./event-log";
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

/** 新项目的第一条事件：一条 `project.created`，日期固定以便回放稳定 */
export function bootstrap(project: Project): ProjectEvent[] {
  return [
    {
      type: "project.created",
      at: "2026-11-10T00:00:00+08:00",
      project,
    },
  ];
}

/**
 * 把当前工作空间登记进本机的列表（第一次打开老日志时也走这里）。
 *
 * 收 `set` 而不是直接 import store：hydrate 与 createWorkspace 都要用，
 * 而它们分处两个文件，传进来才不会形成循环。
 */
export async function registerWorkspace(
  id: string,
  name: string,
  set: (partial: { workspaces: WorkspaceMeta[] }) => void,
): Promise<void> {
  if (!hasWorkspaces()) return;
  try {
    const now = new Date().toISOString();
    const existing = (await listWorkspaces()).find((item) => item.id === id);
    await saveWorkspace(
      existing
        ? { ...existing, name: existing.name || name, lastOpenedAt: now }
        : { id, name, createdAt: now, lastOpenedAt: now },
    );
    set({ workspaces: await listWorkspaces() });
  } catch {
    // 列表读不到不影响编辑：顶栏最多显示不出别的空间
  }
}

/** 手改过的提示词（ADR-0148）：没有就什么都不加，让服务端按默认那段生成 */
export function withPromptOverride(
  get: () => WorkbenchState,
  key: string,
): { prompt?: string } {
  const prompt = get().promptOverrides[key]?.trim();
  return prompt ? { prompt } : {};
}

/** 这次生成的提示词覆盖键（H14）：与各生成动作传给 `withPromptOverride` 的键一一对应 */
export function promptKeyOf(input: { key: string; job: GenerateJob }): string {
  if (input.job.kind === "sheet") return `sheet:${input.key}:${input.job.angle}`;
  if (input.job.kind === "master") return `master:${input.key}`;
  if (input.job.kind === "prop") return `prop:${input.key}`;
  if (input.job.kind === "keyframe") {
    // 关键帧的进度键是 `${shotId}:${frame}`，提示词键是 `keyframe:${shotId}:${frame}`
    return `keyframe:${input.key}`;
  }
  return `other:${input.key}`;
}

/**
 * 把资产 id 变成「随请求发出去的参考图」（B2 / ADR-0162）。
 *
 * 只收有地址的图；缺的、不是图的都跳过——服务端还会再按字节校验一次，
 * 这里少带一张比带一个空地址更安全。最多 4 张，与 `MAX_REFERENCES` 对齐。
 */
export function referenceImagesOf(
  project: Project,
  refs: { assetId: string; label: string }[],
): { assetId: string; uri: string; label: string }[] {
  const out: { assetId: string; uri: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (out.length >= 4) break;
    if (seen.has(ref.assetId)) continue;
    const asset = project.assets.find((item) => item.id === ref.assetId);
    if (!asset?.uri || asset.kind !== "image") continue;
    seen.add(ref.assetId);
    out.push({ assetId: ref.assetId, uri: asset.uri, label: ref.label });
  }
  return out;
}

export function clipReason(reason: string): string {
  return reason.length > 240 ? `${reason.slice(0, 240)}…` : reason;
}

/**
 * 出图之后那句「参考图到底发出去没有」（B2 / ADR-0162）。
 *
 * 三种情况分开说：真的带上了、读不到字节所以少带、供应商不收于是退回纯文生图。
 * 没说清的话，作者会以为身份一致性已经靠参考图锁住了（准则 P3 / P15）。
 */
export function referenceNotice(
  result:
    | { mode?: "edits" | "prompt-only"; sent?: number; missing?: string[]; fitted?: number }
    | undefined,
): string | undefined {
  if (!result) return undefined;
  const sent = result.sent ?? 0;
  const missing = result.missing ?? [];
  const fitted = result.fitted ?? 0;
  const fittedTail = fitted > 0 ? `；其中 ${fitted} 张太大，出图前压到长边 1536（等比，不裁剪）` : "";
  if (result.mode === "edits" && sent > 0) {
    const tail = missing.length ? `；另有 ${missing.length} 张读不到字节没发出去（${missing.join("、")}）` : "";
    return `已带 ${sent} 张参考图生成${tail}${fittedTail}。`;
  }
  if (missing.length > 0) {
    return `参考图读不到字节（${missing.join("、")}），这一张按纯文生图生成。`;
  }
  return "这一张按纯文生图生成：供应商没有接收参考图。";
}
