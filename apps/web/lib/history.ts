import { rebuildStates, type Project, type ProjectEvent } from "@loomina/ir";
import { shotLabel } from "@/lib/read-model";
import { stageMetaOf } from "@/lib/stage-flow";

/**
 * 历史（F2 / ADR-0109）。
 *
 * 日志是事实，历史只是它的另一种读法：一步一步回放，给每条事件配一句人话。
 * 撤销与版本回滚都落在 `project.restored` 上——指向日志前缀，不复制项目快照，
 * 所以历史再长，本地库也只多出一条小事件。
 */

export type HistoryKind = "created" | "edit" | "removal" | "restore";

export type HistoryEntry = {
  /** 事件在日志里的下标（从 0 数） */
  index: number;
  /** 事件之后的前缀长度（从 1 数）：回滚到这一步就是它 */
  count: number;
  at: string;
  label: string;
  kind: HistoryKind;
  /** 同一次操作写出的多条事件共用一条时间戳：只有第一条标为起点 */
  stepStart: boolean;
  /** 这一组（同一毫秒）一共几条事件 */
  groupSize: number;
};

const SHOT_FIELD_CN: Record<string, string> = {
  sceneId: "所属场次",
  index: "镜序",
  durationMs: "时长",
  description: "动作描述",
  promptNotes: "补充要求",
  shotSize: "景别",
  camera: "机位",
  beat: "节拍",
  purpose: "目的",
  performance: "表演",
  staging: "调度",
  characterIds: "出场人物",
  propIds: "道具",
  dialogueIds: "台词",
  takeIds: "版本",
  keyframes: "关键帧",
  locked: "锁定",
  budgetCny: "单镜预算",
};

const SCENE_FIELD_CN: Record<string, string> = {
  space: "内外景",
  timeOfDay: "日夜",
  locationId: "地点",
  code: "场号",
};

const CHARACTER_FIELD_CN: Record<string, string> = {
  name: "名字",
  appearance: "外形",
  mustNotChange: "不许变",
  referenceImages: "参考图",
  voiceProfileId: "音色",
};

const PROP_FIELD_CN: Record<string, string> = {
  name: "名字",
  description: "描述",
  referenceImages: "参考图",
};

const LOCATION_FIELD_CN: Record<string, string> = {
  name: "名字",
  templateId: "模板",
  description: "场景描述",
};

const DIALOGUE_FIELD_CN: Record<string, string> = {
  text: "台词文本",
  durationMs: "时长",
  audioAssetId: "配音音轨",
  performance: "表演参数",
};

const TAKE_FIELD_CN: Record<string, string> = {
  status: "状态",
  costCny: "花费",
  provenance: "来源",
  assetId: "资产",
};

function fieldsCn(map: Record<string, string>, patch: object): string {
  const keys = Object.keys(patch).map((key) => map[key] ?? key);
  return keys.length > 0 ? keys.join("、") : "内容";
}

function sceneName(project: Project, sceneId: string): string {
  const scene = project.scenes.find((item) => item.id === sceneId);
  return scene ? `第 ${scene.code || scene.index + 1} 场` : "某一场";
}

function shotName(project: Project, shotId: string): string {
  const ordered = project.scenes.flatMap((scene) => scene.shotIds);
  const at = ordered.indexOf(shotId);
  return at >= 0 ? shotLabel(at + 1) : "某一镜";
}

/** 一条事件的人话。`before` 是它发生之前的项目——名字都按当时的样子叫。 */
export function describeEvent(before: Project, event: ProjectEvent): string {
  switch (event.type) {
    case "project.created":
      return `新建项目「${event.project.title}」`;
    case "project.updated": {
      const touched: string[] = [];
      if (event.budgetCny !== undefined) touched.push(`预算 ¥${event.budgetCny}`);
      if (event.maxAttemptsPerShot !== undefined) {
        touched.push(`单镜重试 ${event.maxAttemptsPerShot} 次`);
      }
      if (event.onBudgetExceed !== undefined) {
        touched.push(`超预算${event.onBudgetExceed === "block" ? "阻断" : "保留"}`);
      }
      return `项目设置：${touched.join("、")}`;
    }
    case "shot.updated":
      return `改 ${shotName(before, event.shotId)}：${fieldsCn(SHOT_FIELD_CN, event.patch)}`;
    case "scene.updated":
      return `改 ${sceneName(before, event.sceneId)}：${fieldsCn(SCENE_FIELD_CN, event.patch)}`;
    case "scene.added":
      return `加第 ${event.scene.code || event.scene.index + 1} 场`;
    case "shot.added":
      return `${sceneName(before, event.shot.sceneId)}加一镜`;
    case "scene.moved":
      return `挪场：${sceneName(before, event.sceneId)} → 第 ${event.toIndex + 1} 位`;
    case "scene.removed":
      return `删 ${sceneName(before, event.sceneId)}`;
    case "shot.removed":
      return `删 ${shotName(before, event.shotId)}`;
    case "location.added":
      return `加地点「${event.location.name}」`;
    case "location.updated":
      return `改地点「${before.locations.find((item) => item.id === event.locationId)?.name ?? event.locationId}」：${fieldsCn(LOCATION_FIELD_CN, event.patch)}`;
    case "location.removed":
      return `删地点「${before.locations.find((item) => item.id === event.locationId)?.name ?? event.locationId}」`;
    case "character.added":
      return `加人物「${event.character.name}」`;
    case "character.updated":
      return `改人物「${before.characters.find((item) => item.id === event.characterId)?.name ?? event.characterId}」：${fieldsCn(CHARACTER_FIELD_CN, event.patch)}`;
    case "character.removed":
      return `删人物「${before.characters.find((item) => item.id === event.characterId)?.name ?? event.characterId}」`;
    case "prop.added":
      return `加道具「${event.prop.name}」`;
    case "prop.updated":
      return `改道具「${before.props.find((item) => item.id === event.propId)?.name ?? event.propId}」：${fieldsCn(PROP_FIELD_CN, event.patch)}`;
    case "prop.removed":
      return `删道具「${before.props.find((item) => item.id === event.propId)?.name ?? event.propId}」`;
    case "story.updated": {
      const parts: string[] = [];
      for (const [key, label] of [
        ["logline", "logline"],
        ["synopsis", "梗概"],
        ["genre", "类型"],
        ["audience", "受众"],
        ["tone", "调性"],
        ["openingHook", "开场钩子"],
        ["endingHook", "结尾钩子"],
      ] as const) {
        if (event.patch[key] !== undefined) parts.push(label);
      }
      if (event.patch.arcs !== undefined) parts.push(`${event.patch.arcs.length} 条人物弧光`);
      if (event.patch.relationships !== undefined) {
        parts.push(`${event.patch.relationships.length} 对关系`);
      }
      return `改故事：${parts.join(" / ") || "无变化"}`;
    }
    case "dialogue.updated":
      return `改一句台词：${fieldsCn(DIALOGUE_FIELD_CN, event.patch)}`;
    case "dialogue.speaker.updated":
      return `换说话人 → ${before.characters.find((item) => item.id === event.characterId)?.name ?? event.characterId}`;
    case "dialogue.added":
      return `加一句台词（${before.characters.find((item) => item.id === event.line.characterId)?.name ?? "角色"}）`;
    case "dialogue.removed":
      return `删一句台词`;
    case "subtitle.updated": {
      const line = before.dialogue.find((item) => item.id === event.lineId);
      const preview = line ? `「${line.text.slice(0, 12)}」` : "一句台词";
      return event.cues === null
        ? `恢复自动断句：${preview}`
        : `手改断句：${preview}（${event.cues.length} 条）`;
    }
    case "subtitle.layout.updated": {
      const touched: string[] = [];
      const { layout } = event;
      if (layout.preset !== undefined) {
        touched.push(`模板「${layout.preset === "large" ? "大字" : "默认"}」`);
      }
      if (layout.fontSizeCqw !== undefined) {
        touched.push(
          layout.fontSizeCqw === null ? "字号回模板" : `字号 ${layout.fontSizeCqw}`,
        );
      }
      if (layout.bottomPct !== undefined) {
        touched.push(
          layout.bottomPct === null ? "位置回模板" : `离底边 ${layout.bottomPct}%`,
        );
      }
      if (layout.strokeCqw !== undefined) {
        touched.push(
          layout.strokeCqw === null ? "描边回模板" : `描边 ${layout.strokeCqw}`,
        );
      }
      return `字幕版式：${touched.join("、") || "没有改动"}`;
    }
    case "voice.take.added": {
      const line = before.dialogue.find((item) => item.id === event.take.lineId);
      return `加一版配音：${line ? `「${line.text.slice(0, 12)}」` : "一句台词"}`;
    }
    case "voice.take.removed":
      return `删一版配音`;
    case "take.added":
      return `加一条 ${shotName(before, event.take.shotId)} 的 take`;
    case "take.updated": {
      const take = before.takes.find((item) => item.id === event.takeId);
      const where = take ? shotName(before, take.shotId) : "某一镜";
      return `改 ${where} 的 take：${fieldsCn(TAKE_FIELD_CN, event.patch)}`;
    }
    case "take.removed": {
      const take = before.takes.find((item) => item.id === event.takeId);
      return `删 ${take ? shotName(before, take.shotId) : "某一镜"} 的一拍 take`;
    }
    case "approval.updated": {
      const target =
        event.approval.targetType === "character"
          ? before.characters.find((item) => item.id === event.approval.targetId)?.name
          : event.approval.targetType === "location"
            ? before.locations.find((item) => item.id === event.approval.targetId)?.name
            : before.props.find((item) => item.id === event.approval.targetId)?.name;
      return `${event.approval.status === "approved" ? "锁定" : "解锁"}「${target ?? event.approval.targetId}」`;
    }
    case "asset.updated": {
      const kind = event.asset.kind === "image" ? "图片" : event.asset.kind === "video" ? "视频" : "音频";
      return `落一条${kind}资产`;
    }
    case "timeline.updated":
      return `初剪：${event.items.length} 段`;
    case "timeline.music.updated":
      return `配乐：${event.music.length} 段`;
    case "motif.updated":
      return `主题动机「${event.motif.label}」`;
    case "motif.removed":
      return "删掉一个主题动机";
    case "gate.confirmed":
      return `确认「${stageMetaOf(event.stage).name}」阶段${event.override ? "（带条件）" : ""}`;
    case "gate.reopened":
      return `回退「${stageMetaOf(event.stage).name}」阶段`;
    case "publish.recorded":
      return `记录发布：${event.package.platform}`;
    case "project.restored":
      return event.label?.trim() || `回到第 ${event.toEventCount} 条事件之后`;
  }
}

function kindOf(event: ProjectEvent): HistoryKind {
  if (event.type === "project.created") return "created";
  if (event.type === "project.restored") return "restore";
  switch (event.type) {
    case "scene.removed":
    case "shot.removed":
    case "location.removed":
    case "character.removed":
    case "prop.removed":
      return "removal";
    default:
      return "edit";
  }
}

/**
 * 把整条日志读成历史：最新的在前，每条带一句人话。
 *
 * 回放一次就够了：`rebuildStates` 给出每一步的项目（结构共享），
 * 名字用「事件发生之前」的那一份算，删掉的东西也还能按当时的叫法显示。
 */
export function buildHistory(events: ProjectEvent[]): HistoryEntry[] {
  let states: Project[];
  try {
    states = rebuildStates(events);
  } catch {
    return [];
  }

  const entries: HistoryEntry[] = events.map((event, index) => {
    const before = index > 0 ? states[index - 1]! : states[0]!;
    return {
      index,
      count: index + 1,
      at: event.at,
      label: describeEvent(before, event),
      kind: kindOf(event),
      stepStart: index === 0 || events[index - 1]!.at !== event.at,
      groupSize: 1,
    };
  });

  // 同一毫秒写出的多条事件属于同一次操作：记下组大小，撤销时整组退
  for (let index = 0; index < entries.length; index += 1) {
    if (!entries[index]!.stepStart) continue;
    let size = 1;
    while (index + size < entries.length && events[index + size]!.at === events[index]!.at) {
      size += 1;
    }
    for (let offset = 0; offset < size; offset += 1) {
      entries[index + offset]!.groupSize = size;
    }
  }

  return entries;
}

/**
 * 当前落在历史的哪一步：前缀长度。
 *
 * 最后一条是回滚时，它自己指向的位置就是当前位置——否则再按撤销
 * 只会退到同一个地方，反复按像坏了。
 */
export function historyPosition(events: ProjectEvent[]): number {
  const last = events.at(-1);
  if (last?.type === "project.restored") return last.toEventCount;
  return events.length;
}

export type UndoStep = {
  /** 退回的前缀长度：撤销后项目 = 前这么多条事件回放的结果 */
  toEventCount: number;
  /** 撤销的是哪一步（整组一次操作合成一句） */
  label: string;
  /** 这一步一共几条事件 */
  eventCount: number;
};

function groupLabel(entries: HistoryEntry[], start: number, end: number): string {
  const labels = [...new Set(entries.slice(start, end + 1).map((entry) => entry.label))];
  if (labels.length <= 2) return labels.join("、");
  return `${labels[0]} 等 ${end - start + 1} 条改动`;
}

/**
 * 下一步撤销退到哪里。
 *
 * 从当前位置往回找最近一条「不是回滚」的事件，再沿同一毫秒往前扩到操作起点。
 * 回滚事件本身不是一步操作：它只是记录"我退到了这里"，撤它没有意义。
 */
export function nextUndo(
  events: ProjectEvent[],
  entries: HistoryEntry[],
): UndoStep | undefined {
  const position = historyPosition(events);
  let end = position - 1;
  while (end >= 1 && events[end]!.type === "project.restored") end -= 1;
  if (end < 1) return undefined;

  let start = end;
  while (start - 1 >= 1 && events[start - 1]!.at === events[end]!.at) start -= 1;

  return {
    toEventCount: start,
    label: groupLabel(entries, start, end),
    eventCount: end - start + 1,
  };
}
