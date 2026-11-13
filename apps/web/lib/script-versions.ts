import {
  applyEvent,
  rebuildStates,
  type DialogueLine,
  type Project,
  type ProjectEvent,
  type Scene,
  type Shot,
} from "@loomina/ir";
import { describeEvent } from "@/lib/history";
import { scriptToText, toScriptView } from "@/lib/read-model";

/**
 * 剧本 / 分镜整份版本快照（C14 第五档 / ADR-0204）。
 *
 * 与故事版本库同一口径：日志就是版本库，不另存快照。用 `rebuildStates`
 * 拿到每一步的 Project，从里面挑出「改了剧本」的事件，再把那一版的整份
 * 剧本摊平成纯文本。同一毫秒的一组事件算一版（F2 撤销的同口径）。
 *
 * 纯函数：不写 IR、不调模型、不花钱。
 */

/** `shot.updated` 里算「改了剧本」的字段（白名单：将来加成片字段不会误判） */
const SCRIPT_SHOT_FIELDS = [
  "description",
  "promptNotes",
  "shotSize",
  "camera",
  "durationMs",
  "beat",
  "purpose",
  "lighting",
  "composition",
  "continuation",
] as const;

/** 轻恢复要写回的镜头字段：只取目标里真有值的可选模板，避免把 undefined 塞进 patch */
const OPTIONAL_SHOT_FIELDS = ["beat", "purpose", "lighting", "composition", "continuation"] as const;

export type ScriptVersion = {
  /** 这一组最后一条事件的下标：整份回滚时 restoreTo(index + 1) */
  eventIndex: number;
  at: string;
  /** 这一组的人话标签（去重后最多 3 条） */
  labels: string[];
  /** 整份剧本纯文本 */
  text: string;
  scenes: number;
  shots: number;
  lines: number;
  /** 这一组之后的项目（用于写回 / 对比） */
  project: Project;
};

/** 这条事件算不算改了剧本 */
function isScriptEvent(event: ProjectEvent): boolean {
  switch (event.type) {
    case "project.created":
    case "scene.added":
    case "scene.removed":
    case "scene.moved":
    case "scene.updated":
    case "shot.added":
    case "shot.removed":
    case "dialogue.added":
    case "dialogue.removed":
    case "dialogue.speaker.updated":
      return true;
    case "dialogue.updated":
      // 配音 / 字幕偏移 / 表演参数 / 译文都不算剧本；只认文字与时长
      return event.patch.text !== undefined || event.patch.durationMs !== undefined;
    case "shot.updated":
      return SCRIPT_SHOT_FIELDS.some((field) => event.patch[field] !== undefined);
    default:
      return false;
  }
}

/** 整份快照：与剧本页「当前剧本纯文本」同一个读模型，去掉标题里的版本号 */
function snapshot(project: Project): { text: string; scenes: number; shots: number; lines: number } {
  const view = toScriptView(project);
  return {
    text: scriptToText({ ...view, version: 0 }),
    scenes: view.scenes.length,
    shots: view.shotCount,
    lines: view.dialogueCount,
  };
}

/**
 * 每一版剧本：初版在最前，之后按日志顺序。
 *
 * 若日志最后是别的事件（全局回滚等）导致剧本内容又变了，补一条
 * 「现在这一版」的合成版本，保证列表里总有当前状态。
 */
export function scriptVersionsOf(events: ProjectEvent[]): ScriptVersion[] {
  if (events.length === 0) return [];
  let states: Project[];
  try {
    states = rebuildStates(events);
  } catch {
    return [];
  }

  const versions: ScriptVersion[] = [];
  const push = (eventIndex: number, at: string, labels: string[]) => {
    const project = states[eventIndex];
    if (!project) return;
    const last = versions.at(-1);
    const data = snapshot(project);
    // 连续两版文本相同（例如只改了审核字段）不另占一版
    if (last && last.text === data.text) return;
    versions.push({
      eventIndex,
      at,
      labels: [...new Set(labels)].slice(0, 3),
      ...data,
      project,
    });
  };

  let groupAt: string | undefined;
  let groupLabels: string[] = [];
  events.forEach((event, index) => {
    if (isScriptEvent(event)) {
      if (groupAt === undefined) groupAt = event.at;
      // 同毫秒的一组：接着上一个 at 收；中间夹了非剧本事件也仍算同一批操作
      if (event.at === groupAt) {
        const before = index > 0 ? states[index - 1]! : states[0]!;
        groupLabels.push(describeEvent(before, event));
        return;
      }
      push(index - 1, groupAt, groupLabels);
      groupAt = event.at;
      groupLabels = [describeEvent(index > 0 ? states[index - 1]! : states[0]!, event)];
    }
  });
  if (groupAt !== undefined) {
    // 组里最后一条剧本事件之后可能还跟着非剧本事件，版本点落在组末尾
    let end = events.length - 1;
    while (end > 0 && events[end]!.at !== groupAt) end -= 1;
    push(end, groupAt, groupLabels);
  }

  const current = states.at(-1)!;
  const data = snapshot(current);
  const last = versions.at(-1);
  if (!last || last.text !== data.text) {
    versions.push({
      eventIndex: events.length - 1,
      at: events.at(-1)!.at,
      labels: ["现在这一版"],
      ...data,
      project: current,
    });
  }
  return versions;
}

/** 行差异：按行多重集比，不追求逐行 diff（改一个字会同时出现在多 / 少两栏） */
export function textDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const count = (text: string) => {
    const map = new Map<string, number>();
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      map.set(line, (map.get(line) ?? 0) + 1);
    }
    return map;
  };
  const a = count(before);
  const b = count(after);
  const diff = (from: Map<string, number>, to: Map<string, number>) => {
    const out: string[] = [];
    for (const [line, n] of from) {
      const rest = n - (to.get(line) ?? 0);
      for (let i = 0; i < rest; i += 1) out.push(line);
    }
    return out;
  };
  return { added: diff(b, a), removed: diff(a, b) };
}

/** 轻恢复时能从目标版写回的镜头字段（都是剧本字段，不带 id 引用与成片状态） */
function scriptShotPatch(wanted: Shot, current: Shot): Partial<Shot> {
  // 只写「变了」的字段：标签不会把没改过的景别 / 时长也报成改动
  const candidate: Partial<Shot> = {
    description: wanted.description,
    promptNotes: [...wanted.promptNotes],
    shotSize: wanted.shotSize,
    // 机位只写角度 / 运动 / 焦段：坐标带几何约束，不跟着剧本版本走
    camera: {
      angle: wanted.camera.angle,
      movement: wanted.camera.movement,
      focalMm: wanted.camera.focalMm,
    },
    durationMs: wanted.durationMs,
  };
  const cameraOf = (shot: Shot) => ({
    angle: shot.camera.angle,
    movement: shot.camera.movement,
    focalMm: shot.camera.focalMm,
  });
  const cameraChanged =
    JSON.stringify(cameraOf(wanted)) !== JSON.stringify(cameraOf(current));
  const patch: Partial<Shot> = {
    ...(candidate.description !== current.description
      ? { description: candidate.description }
      : {}),
    ...(JSON.stringify(candidate.promptNotes) !== JSON.stringify(current.promptNotes)
      ? { promptNotes: candidate.promptNotes }
      : {}),
    ...(candidate.shotSize !== current.shotSize ? { shotSize: candidate.shotSize } : {}),
    ...(cameraChanged ? { camera: candidate.camera } : {}),
    ...(candidate.durationMs !== current.durationMs
      ? { durationMs: candidate.durationMs }
      : {}),
  };
  // 可选模板只补不撤：schema 没有「清空」的写法，目标没写的就不进 patch
  for (const field of OPTIONAL_SHOT_FIELDS) {
    const value = wanted[field];
    if (value === undefined) continue;
    if (JSON.stringify(value) !== JSON.stringify(current[field])) {
      Object.assign(patch, { [field]: structuredClone(value) });
    }
  }
  return patch;
}

export type ScriptRestore = {
  events: ProjectEvent[];
  /** 目标版里有、当前已经删掉的结构条数（不重建） */
  missingScenes: number;
  missingShots: number;
  missingLines: number;
  /** 锁定而整条跳过的镜头数 */
  lockedShots: number;
  /** 当前地点列表里找不到而跳过的场次字段数 */
  droppedLocations: number;
};

/**
 * 「用这版写回」的事件序列（C14 / ADR-0204）。
 *
 * 只改当前仍存在的场 / 镜 / 句：旧版删掉的结构不重建、现在多出来的不删。
 * 带上 id 引用的字段（出场人物 / 道具 / 台词顺序 / 走位 / 调度 / 表演）不恢复，
 * take / 关键帧 / 配音 / 时间线一律不动；`audioAssetId` 等台词非剧本文字也不动。
 *
 * 全部事件共用一个 `at`，一次撤销即可整批退回。没有要改的字段时返回空数组。
 */
export function scriptRestoreEvents(
  current: Project,
  target: Project,
  at: string,
): ScriptRestore {
  const events: ProjectEvent[] = [];
  let lockedShots = 0;
  let droppedLocations = 0;

  const targetScenes = new Map(target.scenes.map((scene) => [scene.id, scene]));
  const targetShots = new Map(target.shots.map((shot) => [shot.id, shot]));
  const targetLines = new Map(target.dialogue.map((line) => [line.id, line]));
  const currentScenes = new Set(current.scenes.map((scene) => scene.id));
  const currentShotIds = new Set(current.shots.map((shot) => shot.id));
  const currentLineIds = new Set(current.dialogue.map((line) => line.id));
  const currentShots = new Map(current.shots.map((shot) => [shot.id, shot]));
  const locations = new Set(current.locations.map((location) => location.id));

  // 目标版有、当前已经删掉的：不重建，只如实计数
  const missingScenes = [...targetScenes.keys()].filter((id) => !currentScenes.has(id)).length;
  const missingShots = [...targetShots.keys()].filter((id) => !currentShotIds.has(id)).length;
  const missingLines = [...targetLines.keys()].filter((id) => !currentLineIds.has(id)).length;

  for (const scene of current.scenes) {
    const wanted = targetScenes.get(scene.id);
    if (!wanted) continue;
    const patch: Partial<Pick<Scene, "space" | "timeOfDay" | "locationId">> = {};
    if (wanted.space !== scene.space) patch.space = wanted.space;
    if (wanted.timeOfDay !== scene.timeOfDay) patch.timeOfDay = wanted.timeOfDay;
    if (wanted.locationId !== scene.locationId) {
      if (locations.has(wanted.locationId)) patch.locationId = wanted.locationId;
      else droppedLocations += 1;
    }
    if (Object.keys(patch).length > 0) {
      events.push({ type: "scene.updated", at, sceneId: scene.id, patch });
    }
  }

  for (const shot of current.shots) {
    const wanted = targetShots.get(shot.id);
    if (!wanted) continue;
    if (shot.locked) {
      lockedShots += 1;
      continue;
    }
    const patch = scriptShotPatch(wanted, shot);
    if (Object.keys(patch).length > 0) {
      events.push({ type: "shot.updated", at, shotId: shot.id, patch });
    }
  }

  for (const line of current.dialogue) {
    const wanted: DialogueLine | undefined = targetLines.get(line.id);
    if (!wanted) continue;
    const owner = currentShots.get(
      [...currentShots.values()].find((shot) => shot.dialogueIds.includes(line.id))?.id ?? "",
    );
    if (owner?.locked) continue;
    if (wanted.text !== line.text || wanted.durationMs !== line.durationMs) {
      events.push({
        type: "dialogue.updated",
        at,
        lineId: line.id,
        patch: { text: wanted.text, durationMs: wanted.durationMs },
      });
    }
    if (wanted.characterId !== line.characterId) {
      events.push({
        type: "dialogue.speaker.updated",
        at,
        lineId: line.id,
        characterId: wanted.characterId,
      });
    }
  }

  return { events, missingScenes, missingShots, missingLines, lockedShots, droppedLocations };
}

/** 在草稿上整批回放：任何一条不合法都不该落状态 */
export function replayRestore(project: Project, events: ProjectEvent[]): Project {
  return events.reduce((state, event) => applyEvent(state, event), project);
}
