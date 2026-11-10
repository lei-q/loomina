import {
  castReadiness,
  shotAnchors,
  SHEET_ANGLES,
  SHEET_LABELS,
  type CastStatus,
  type Project,
  type ProjectEvent,
  type SheetView,
  type Shot,
  type Take,
} from "@loomina/ir";
import {
  buildKeyframePrompt,
  SHOT_ANGLE_CN,
  SHOT_SIZE_CN,
  shotMaterial,
} from "@loomina/pipeline";
import { requoteProject, requoteShot, type ProjectRequote, type Requote } from "./pricing";

export type SceneKind = "door" | "two" | "table" | "corridor";
export type ShotState = "open" | "pick" | "reject";

export type StageShot = {
  /** 镜号，从 1 开始；IR 里的 index 从 0 开始 */
  no: number;
  id: string;
  art: SceneKind;
  action: string;
  /** 秒 */
  dur: number;
  state: ShotState;
  /** 当前用的是第几版 take，没有 take 时为空 */
  take?: number;
  /** 锁定的镜头在审片台里只读 */
  locked: boolean;
  /** 景别与人话机位（"特写 · 仰拍"）：一句话指令改了哪个当场看得见（ADR-0039） */
  size: string;
  angle: string;
  /** 一句话指令落下的补充要求（ADR-0039） */
  notes: string[];
  /** 首尾两帧真正会送出的提示词：说了什么、改了什么，在这里对得上（ADR-0040） */
  prompts: { first: string; last: string };
  /** 这一镜带进生成的参考图（ADR-0029）；缺锚点时生成会被拒绝 */
  anchors: { labels: string[]; missing: string[] };
  /** 首帧的真图（data URI，ADR-0037）；没生成过就为空 */
  keyframeUri?: string;
  /** 首帧这张资产是否存在（有没有生成过） */
  hasKeyframe: boolean;
  /** 尾帧的真图（data URI，ADR-0038）；没生成过就为空 */
  lastKeyframeUri?: string;
  hasLastFrame: boolean;
  /** 出图之后这一镜的画面改过（ADR-0057）：时间是最后一次改动，另带改过哪几项 */
  staleFirst?: StaleMark;
  staleLast?: StaleMark;
};

export type Spend = {
  /** 已花：take 的费用 + 有价目的生成资产，元 */
  spent: number;
  /** 其中分镜 take 的钱 */
  takes: number;
  /** 其中定妆 / 场景 / 道具资产的钱 */
  assets: number;
  /** 其中已淘汰 take 的钱：钱花了，但那一版不要了（ADR-0036） */
  rejected: number;
  /** 生成过、但价目表里没有这个模型，算不进已花的图（ADR-0033） */
  unpriced: number;
};

/**
 * 一个项目已经花了多少钱。
 *
 * 只加"知道单价"的东西：没有价目的资产宁可单独数出来，也不当 0 算进去——
 * 把未知算成免费，预算就成了摆设（准则 P21）。
 */
export function spendOf(project: Project): Spend {
  const takes = project.takes.reduce((sum, take) => sum + take.costCny, 0);
  const rejected = project.takes
    .filter((take) => take.status === "rejected")
    .reduce((sum, take) => sum + take.costCny, 0);
  let assets = 0;
  let unpriced = 0;
  for (const asset of project.assets) {
    if (asset.costCny !== undefined) assets += asset.costCny;
    else if (asset.source === "generated" && asset.uri) unpriced += 1;
  }
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    spent: round(takes + assets),
    takes: round(takes),
    assets: round(assets),
    rejected: round(rejected),
    unpriced,
  };
}

export type StageView = {
  title: string;
  version: number;
  /** 已花 / 预算，元 */
  spent: number;
  /** 已花的构成（分镜 / 定妆 / 已淘汰） */
  spend: Spend;
  /** 算不进已花的生成资产张数 */
  unpriced: number;
  budget: number;
  /** 当前镜在 shots 里的下标 */
  current: number;
  /** 当前镜重做一次的报价（含首帧），价目来自 gateway 的价目表 */
  requote: Requote;
  /** 整片重做一遍的报价；镜数写在 basis 里 */
  requoteAll: ProjectRequote;
  /** 烧在画面里的字幕；当前镜没有台词时为空串 */
  subtitle: string;
  shots: StageShot[];
};

export type StageOptions = {
  budgetCny?: number;
  /** 指定看哪一格；不传则挑第一个还没定的镜头 */
  currentShotId?: string;
  /** 给了日志就算出关键帧的过期标记（ADR-0057） */
  events?: ProjectEvent[];
};

const artByTemplate: Record<string, SceneKind> = {
  corridor: "corridor",
  doorway: "door",
  door: "door",
  table: "table",
};

function shotState(shot: Shot, take: Take | undefined): ShotState {
  if (take?.status === "approved") return "pick";
  if (take?.status === "rejected") return "reject";
  if (shot.locked) return "pick";
  return "open";
}

/** 同一个镜头有多条 take 时，按生成时间取最新的一条。 */
export function latestTake(shot: Shot, takesById: Map<string, Take>): Take | undefined {
  let latest: Take | undefined;
  for (const id of shot.takeIds) {
    const take = takesById.get(id);
    if (!take) continue;
    if (!latest || take.provenance.createdAt > latest.provenance.createdAt) latest = take;
  }
  return latest;
}

/** 镜头挂的场景 → 场景所在地 → 场景模板 → 用哪张分镜剪影。 */
function artFor(
  shot: Shot,
  templateByLocation: Map<string, string | undefined>,
  locationByScene: Map<string, string>,
): SceneKind {
  if (shot.characterIds.length >= 2) return "two";
  const locationId = locationByScene.get(shot.sceneId);
  const template = locationId ? templateByLocation.get(locationId) : undefined;
  return (template && artByTemplate[template]) || "door";
}

/** 按场次顺序、场内镜序排一遍；没挂进 scene.shotIds 的镜头兜底接在后面。 */
function orderShots(project: Project): Shot[] {
  const shotsById = new Map(project.shots.map((shot) => [shot.id, shot]));
  const ordered: Shot[] = [];

  for (const scene of [...project.scenes].sort((a, b) => a.index - b.index)) {
    for (const shotId of scene.shotIds) {
      const shot = shotsById.get(shotId);
      if (shot) ordered.push(shot);
    }
  }

  const seen = new Set(ordered.map((shot) => shot.id));
  for (const shot of [...project.shots].sort((a, b) => a.index - b.index)) {
    if (!seen.has(shot.id)) ordered.push(shot);
  }

  return ordered;
}

/**
 * Project IR → 审片台读模型。
 * 组件只认 StageView，不认 IR；IR 的结构变化只改这一个文件。
 */
export function toStageView(project: Project, options: StageOptions = {}): StageView {
  const takesById = new Map(project.takes.map((take) => [take.id, take]));
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const dialogueById = new Map(project.dialogue.map((line) => [line.id, line]));
  const templateByLocation = new Map<string, string | undefined>(
    project.locations.map((location) => [location.id, location.templateId]),
  );
  const locationByScene = new Map<string, string>(
    project.scenes.map((scene) => [scene.id, scene.locationId]),
  );

  const ordered = orderShots(project);
  const stale = options.events ? staleFrames(options.events, project) : new Map<string, StaleFrame>();

  const shots: StageShot[] = ordered.map((shot, i) => {
    const take = latestTake(shot, takesById);
    const anchors = shotAnchors(project, shot);
    const keyframe = shot.keyframes.firstAssetId
      ? assetById.get(shot.keyframes.firstAssetId)
      : undefined;
    const lastFrame = shot.keyframes.lastAssetId
      ? assetById.get(shot.keyframes.lastAssetId)
      : undefined;
    const material = shotMaterial(project, shot);
    return {
      no: i + 1,
      id: shot.id,
      art: artFor(shot, templateByLocation, locationByScene),
      action: shot.description,
      dur: shot.durationMs / 1000,
      state: shotState(shot, take),
      take: take ? shot.takeIds.indexOf(take.id) + 1 : undefined,
      locked: shot.locked ?? false,
      size: SHOT_SIZE_CN[shot.shotSize],
      angle: SHOT_ANGLE_CN[shot.camera.angle],
      notes: shot.promptNotes,
      prompts: {
        first: buildKeyframePrompt(material, "first"),
        last: buildKeyframePrompt(material, "last"),
      },
      anchors: {
        labels: anchors.refs.map((ref) => ref.label),
        missing: anchors.missing,
      },
      keyframeUri: keyframe?.uri,
      hasKeyframe: Boolean(keyframe),
      lastKeyframeUri: lastFrame?.uri,
      hasLastFrame: Boolean(lastFrame),
      staleFirst: stale.get(shot.id)?.first,
      staleLast: stale.get(shot.id)?.last,
    };
  });

  const requested = options.currentShotId
    ? shots.findIndex((shot) => shot.id === options.currentShotId)
    : shots.findIndex((shot) => shot.state === "open");
  const current = requested >= 0 ? requested : 0;

  const currentShot = ordered[current];
  const subtitle = currentShot
    ? currentShot.dialogueIds
        .map((id) => dialogueById.get(id)?.text)
        .filter((text): text is string => Boolean(text))
        .join(" ")
    : "";

  const spend = spendOf(project);
  const { spent, unpriced } = spend;

  return {
    title: project.title,
    version: project.version,
    spent,
    spend,
    unpriced,
    budget: options.budgetCny ?? project.budgetCny,
    current,
    requote: currentShot ? requoteShot(currentShot.durationMs) : { basis: "没有当前镜" },
    requoteAll: requoteProject(ordered.map((shot) => shot.durationMs)),
    subtitle,
    shots,
  };
}

export function shotLabel(no: number): string {
  return `SH-${String(no).padStart(2, "0")}`;
}

// ── 关键帧页（ADR-0042）───────────────────────────────────────────

export type KeyframeCell = {
  id: string;
  no: number;
  art: SceneKind;
  action: string;
  size: string;
  angle: string;
  locked: boolean;
  firstUri?: string;
  lastUri?: string;
  hasFirst: boolean;
  hasLast: boolean;
  /** 出图之后这一镜的画面输入改过（ADR-0057）：时间是最后一次改动，另带改过哪几项 */
  staleFirst?: StaleMark;
  staleLast?: StaleMark;
};

/** 影响画面的镜头字段：改了这些，已经出的帧就不算数了（ADR-0057） */
/** 画面字段 → 人话（ADR-0057 附记：过期要能说出改了什么） */
const VISUAL_SHOT_KEYS: Array<[keyof Shot, string]> = [
  ["description", "动作"],
  ["promptNotes", "补充要求"],
  ["shotSize", "景别"],
  ["camera", "机位"],
  ["characterIds", "人物"],
  ["propIds", "道具"],
];

/** 一帧过期：最后一次改动的时间，与出图之后改过的那几项 */
export type StaleMark = { at: string; reasons: string[] };

export type StaleFrame = { first?: StaleMark; last?: StaleMark };

/**
 * 哪些帧在出图之后又改过画面输入（ADR-0057）。
 *
 * 只比时间，不比内容：快照里的帧按快照算，之后的改写按事件的 `at` 算。
 * 镜头级的画面字段（动作、景别、机位、人物、道具、补充要求）与所在场头的
 * 内 / 外景、日夜、地点算进来；台词改动不算——它不改变一张静止画面。
 */
export function staleFrames(events: ProjectEvent[], project: Project): Map<string, StaleFrame> {
  // 每一镜记下每一条画面改动的时刻与原因：哪一帧过期，取决于它出图之后发生了哪些
  const edits = new Map<string, Array<{ at: string; reason: string }>>();
  const bump = (shotId: string, at: string, reason: string) => {
    const list = edits.get(shotId);
    if (list) list.push({ at, reason });
    else edits.set(shotId, [{ at, reason }]);
  };

  const first = events[0];
  const sceneShots = new Map<string, string[]>();
  if (first?.type === "project.created") {
    for (const scene of first.project.scenes) sceneShots.set(scene.id, scene.shotIds);
  }

  for (const event of events.slice(first?.type === "project.created" ? 1 : 0)) {
    if (event.type === "shot.updated") {
      for (const [key, label] of VISUAL_SHOT_KEYS) {
        if (event.patch[key] !== undefined) bump(event.shotId, event.at, label);
      }
    } else if (event.type === "scene.updated") {
      for (const shotId of sceneShots.get(event.sceneId) ?? []) bump(shotId, event.at, "场头");
    }
  }

  const stale = new Map<string, StaleFrame>();
  for (const shot of project.shots) {
    const shotEdits = edits.get(shot.id);
    if (!shotEdits) continue;
    const out: StaleFrame = {};
    for (const [key, assetId] of [
      ["first", shot.keyframes.firstAssetId],
      ["last", shot.keyframes.lastAssetId],
    ] as const) {
      if (!assetId) continue;
      const asset = project.assets.find((item) => item.id === assetId);
      if (!asset) continue;
      const after = shotEdits.filter((edit) => Date.parse(edit.at) > Date.parse(asset.createdAt));
      if (after.length === 0) continue;
      const at = after.reduce((latest, edit) => (Date.parse(edit.at) > Date.parse(latest) ? edit.at : latest), after[0]!.at);
      out[key] = { at, reasons: [...new Set(after.map((edit) => edit.reason))] };
    }
    if (out.first || out.last) stale.set(shot.id, out);
  }
  return stale;
}

export type KeyframeView = {
  title: string;
  version: number;
  cells: KeyframeCell[];
  /** 有多少镜已经有首帧 / 尾帧 */
  firstCount: number;
  lastCount: number;
  /** 有多少镜两帧都齐了 */
  completeCount: number;
  /** 关键帧这一类资产花掉的钱（按 id 前缀认） */
  keyframeSpend: number;
  /** 生成了但价目表里没有模型的关键帧张数 */
  keyframeUnpriced: number;
  spent: number;
  spend: Spend;
  unpriced: number;
  budget: number;
};

/**
 * 关键帧页的读模型：一格一镜，只看首尾两帧够不够用。
 *
 * 关键帧的钱单独算：它们混在 `assets` 里，但这一页要回答的是
 * "为了这两帧花了多少"，不是整片花了多少。
 */
/**
 * 关键帧页的筛子：只想看还缺哪一帧的时候，十二格一起看反而看不清。
 * 只筛读模型的投影，不碰 IR。
 */
export type KeyframeFilter = "all" | "missing-first" | "missing-last" | "complete";

export function filterKeyframeCells(
  cells: KeyframeCell[],
  filter: KeyframeFilter,
): KeyframeCell[] {
  switch (filter) {
    case "missing-first":
      return cells.filter((cell) => !cell.hasFirst);
    case "missing-last":
      return cells.filter((cell) => !cell.hasLast);
    case "complete":
      return cells.filter((cell) => cell.hasFirst && cell.hasLast);
    default:
      return cells;
  }
}

/** 十二镜各自缺哪几帧：页头的筛子与计数都从这里来。 */
export function keyframeTally(cells: KeyframeCell[]): Record<KeyframeFilter, number> {
  return {
    all: cells.length,
    "missing-first": cells.filter((cell) => !cell.hasFirst).length,
    "missing-last": cells.filter((cell) => !cell.hasLast).length,
    complete: cells.filter((cell) => cell.hasFirst && cell.hasLast).length,
  };
}

export function toKeyframeView(
  project: Project,
  options: { budgetCny?: number; events?: ProjectEvent[] } = {},
): KeyframeView {
  const view = toStageView(project, {});
  const stale = options.events ? staleFrames(options.events, project) : new Map<string, StaleFrame>();
  const cells: KeyframeCell[] = view.shots.map((shot) => ({
    id: shot.id,
    no: shot.no,
    art: shot.art,
    action: shot.action,
    size: shot.size,
    angle: shot.angle,
    locked: shot.locked,
    firstUri: shot.keyframeUri,
    lastUri: shot.lastKeyframeUri,
    hasFirst: shot.hasKeyframe,
    hasLast: shot.hasLastFrame,
    staleFirst: stale.get(shot.id)?.first,
    staleLast: stale.get(shot.id)?.last,
  }));

  let keyframeSpend = 0;
  let keyframeUnpriced = 0;
  for (const asset of project.assets) {
    const isFrame = asset.id.startsWith("a-keyframe-") || asset.id.startsWith("a-lastframe-");
    if (!isFrame) continue;
    if (asset.costCny === undefined) {
      keyframeUnpriced += 1;
      continue;
    }
    keyframeSpend += asset.costCny;
  }

  return {
    title: view.title,
    version: view.version,
    cells,
    firstCount: cells.filter((cell) => cell.hasFirst).length,
    lastCount: cells.filter((cell) => cell.hasLast).length,
    completeCount: cells.filter((cell) => cell.hasFirst && cell.hasLast).length,
    keyframeSpend: Math.round(keyframeSpend * 100) / 100,
    keyframeUnpriced,
    spent: view.spent,
    spend: view.spend,
    unpriced: view.unpriced,
    budget: options.budgetCny ?? view.budget,
  };
}

// ── 剧本（只读）─────────────────────────────────────────────────

const round2 = (value: number) => Math.round(value * 100) / 100;

export type ScriptLine = {
  id: string;
  /** 说话人的角色 id，换人时用 */
  characterId: string;
  /** 说话人；角色表里找不到就写"未知" */
  character: string;
  text: string;
  /** 配音时长，秒 */
  dur: number;
};

export type ScriptShot = {
  id: string;
  no: number;
  action: string;
  dur: number;
  size: string;
  angle: string;
  /** 锁定的镜头不能改台词（ADR-0041 / 0044） */
  locked: boolean;
  /** 这一镜里有谁，加台词时默认第一个 */
  characterIds: string[];
  lines: ScriptLine[];
};

export type ScriptScene = {
  id: string;
  /** 场号，从 1 开始 */
  no: number;
  locationId: string;
  place: string;
  space: "int" | "ext";
  timeOfDay: "day" | "night" | "dawn" | "dusk";
  dur: number;
  shots: ScriptShot[];
};

/** 场头两个小签的中文写法（ADR-0050） */
export const SPACE_LABEL: Record<ScriptScene["space"], string> = {
  int: "内",
  ext: "外",
};

export const TIME_LABEL: Record<ScriptScene["timeOfDay"], string> = {
  day: "日",
  night: "夜",
  dawn: "晨",
  dusk: "昏",
};

export function sceneHead(scene: ScriptScene): string {
  return `${SPACE_LABEL[scene.space]} · ${TIME_LABEL[scene.timeOfDay]}`;
}

export type ScriptView = {
  title: string;
  version: number;
  /** 说话人候选：加台词时挑一个 */
  characters: { id: string; name: string }[];
  scenes: ScriptScene[];
  shotCount: number;
  dialogueCount: number;
  /** 全片时长，秒 */
  totalDur: number;
  spent: number;
  spend: Spend;
  unpriced: number;
  budget: number;
};

/**
 * 剧本页的读模型：按场次、场内镜序排，把每镜的动作与台词摊平。
 *
 * 只读投影：这一页回答"这条片子写了什么"。台词的改写走 store 的
 * `editDialogue`（ADR-0044），读模型只负责把改完的结果摊平。
 */
export function toScriptView(project: Project, options: { budgetCny?: number } = {}): ScriptView {
  const stage = toStageView(project, {});
  const stageById = new Map(stage.shots.map((shot) => [shot.id, shot]));
  const locationById = new Map(project.locations.map((item) => [item.id, item]));
  const characterById = new Map(project.characters.map((item) => [item.id, item]));
  const dialogueById = new Map(project.dialogue.map((item) => [item.id, item]));

  const scenes: ScriptScene[] = [...project.scenes]
    .sort((a, b) => a.index - b.index)
    .map((scene, at) => {
      const shots: ScriptShot[] = project.shots
        .filter((shot) => shot.sceneId === scene.id)
        .sort((a, b) => a.index - b.index)
        .map((shot) => {
          const view = stageById.get(shot.id);
          const lines: ScriptLine[] = [];
          for (const dialogueId of shot.dialogueIds) {
            const line = dialogueById.get(dialogueId);
            if (!line) continue;
            lines.push({
              id: line.id,
              characterId: line.characterId,
              character: characterById.get(line.characterId)?.name ?? "未知",
              text: line.text,
              dur: line.durationMs / 1000,
            });
          }
          return {
            id: shot.id,
            no: view?.no ?? shot.index + 1,
            action: shot.description,
            dur: shot.durationMs / 1000,
            size: view?.size ?? "",
            angle: view?.angle ?? "",
            locked: shot.locked,
            characterIds: shot.characterIds,
            lines,
          };
        });

      return {
        id: scene.id,
        no: at + 1,
        locationId: scene.locationId,
        place: locationById.get(scene.locationId)?.name ?? "未命名场景",
        space: scene.space,
        timeOfDay: scene.timeOfDay,
        dur: round2(shots.reduce((sum, shot) => sum + shot.dur, 0)),
        shots,
      };
    });

  return {
    title: stage.title,
    version: stage.version,
    characters: project.characters.map((item) => ({ id: item.id, name: item.name })),
    scenes,
    shotCount: scenes.reduce((sum, scene) => sum + scene.shots.length, 0),
    dialogueCount: scenes.reduce(
      (sum, scene) => sum + scene.shots.reduce((n, shot) => n + shot.lines.length, 0),
      0,
    ),
    totalDur: round2(scenes.reduce((sum, scene) => sum + scene.dur, 0)),
    spent: stage.spent,
    spend: stage.spend,
    unpriced: stage.unpriced,
    budget: options.budgetCny ?? stage.budget,
  };
}

// ── 定妆（ADR-0028）───────────────────────────────────────────────

export type CastPanel = {
  angle: SheetView;
  label: string;
  /** 没有资产时这一格还没生成 */
  assetId?: string;
  /** 生成出来的图（data URI）；示例素材为空，界面画剪影 */
  uri?: string;
};

export type CastCharacterView = {
  id: string;
  name: string;
  appearance: string;
  mustNotChange: string[];
  panels: CastPanel[];
  status: CastStatus;
  /** 有近景的角色必须四格齐全才能锁 */
  required: boolean;
  lockedAt?: string;
};

export type CastLocationView = {
  id: string;
  name: string;
  art: SceneKind;
  status: CastStatus;
  required: boolean;
  masterAssetId?: string;
  /** 主镜的真图（data URI）；示例素材为空，界面画剪影 */
  masterUri?: string;
  lockedAt?: string;
};

export type PropKind = "cup" | "lamp" | "generic";

export type CastPropView = {
  id: string;
  name: string;
  description: string;
  art: PropKind;
  status: CastStatus;
  /** 进了镜头的道具必须能锁 */
  required: boolean;
  referenceAssetId?: string;
  /** 参考图的真图（data URI）；示例素材为空，界面画剪影 */
  referenceUri?: string;
  lockedAt?: string;
};

export type CastView = {
  characters: CastCharacterView[];
  locations: CastLocationView[];
  props: CastPropView[];
  complete: boolean;
  lockedCount: number;
  totalRequired: number;
  /** 已花 / 无价目张数，顶栏用 */
  spend: Spend;
};

/** Project IR → 定妆台读模型：只给画面与状态，不给锁的规则（规则在 `@loomina/ir`）。 */
export function toCastView(project: Project): CastView {
  const readiness = castReadiness(project);
  const characterById = new Map(project.characters.map((item) => [item.id, item]));
  const locationById = new Map(project.locations.map((item) => [item.id, item]));

  const propById = new Map(project.props.map((item) => [item.id, item]));
  const assetById = new Map(project.assets.map((item) => [item.id, item]));

  const characters: CastCharacterView[] = readiness.characters.flatMap((item) => {
    const character = characterById.get(item.targetId);
    if (!character) return [];
    return [
      {
        id: character.id,
        name: character.name,
        appearance: character.appearance,
        mustNotChange: character.mustNotChange,
        panels: SHEET_ANGLES.map((angle) => ({
          angle,
          label: SHEET_LABELS[angle],
          assetId: character.sheet[angle],
          uri: assetById.get(character.sheet[angle] ?? "")?.uri,
        })),
        status: item.status,
        required: item.required,
        lockedAt:
          item.approval?.status === "approved" ? item.approval.approvedAt : undefined,
      },
    ];
  });

  const locations: CastLocationView[] = readiness.locations.flatMap((item) => {
    const location = locationById.get(item.targetId);
    if (!location) return [];
    const template = location.templateId;
    return [
      {
        id: location.id,
        name: location.name,
        art: (template && artByTemplate[template]) || "door",
        status: item.status,
        required: item.required,
        masterAssetId: location.masterShotId,
        masterUri: assetById.get(location.masterShotId ?? "")?.uri,
        lockedAt:
          item.approval?.status === "approved" ? item.approval.approvedAt : undefined,
      },
    ];
  });

  const props: CastPropView[] = readiness.props.flatMap((item) => {
    const prop = propById.get(item.targetId);
    if (!prop) return [];
    return [
      {
        id: prop.id,
        name: prop.name,
        description: prop.description,
        art: propArt(prop.id),
        status: item.status,
        required: item.required,
        referenceAssetId: prop.referenceImages[0],
        referenceUri: assetById.get(prop.referenceImages[0] ?? "")?.uri,
        lockedAt:
          item.approval?.status === "approved" ? item.approval.approvedAt : undefined,
      },
    ];
  });

  return {
    characters,
    locations,
    props,
    complete: readiness.complete,
    lockedCount: readiness.lockedCount,
    totalRequired: readiness.totalRequired,
    spend: spendOf(project),
  };
}

function propArt(id: string): PropKind {
  if (id.includes("cup")) return "cup";
  if (id.includes("lamp")) return "lamp";
  return "generic";
}

export type DialogueRevision = {
  at: string;
  text: string;
  /** 这一版估出来的配音时长，秒 */
  dur: number;
};

export type SpeakerRevision = {
  at: string;
  /** 换之前的角色 id */
  from: string;
  /** 换之后的角色 id */
  to: string;
};

export type DialogueHistory = {
  /** 引导事件里最初的那句（含当时的时长与说话人）；日志里没有就省掉 */
  original?: { text: string; dur: number; characterId: string };
  /** 从旧到新，一次改写一条 */
  edits: DialogueRevision[];
  /** 从旧到新，一次换人一条（ADR-0052） */
  speakers: SpeakerRevision[];
};

/**
 * 一句台词被改过几次（ADR-0044 附记）。
 *
 * 只看日志里的 `dialogue.updated`：每一次改写就是一条，时间和新文本都在事件里；
 * 最初那版从 `project.created` 的快照里取。不用另外存版本表。
 */
export function dialogueHistory(
  events: ProjectEvent[],
  lineId: string,
): DialogueHistory {
  let original: DialogueHistory["original"];
  const first = events[0];
  if (first?.type === "project.created") {
    const line = first.project.dialogue.find((item) => item.id === lineId);
    if (line) {
      original = { text: line.text, dur: line.durationMs / 1000, characterId: line.characterId };
    }
  }

  const edits: DialogueRevision[] = [];
  for (const event of events) {
    if (event.type !== "dialogue.updated") continue;
    if (event.lineId !== lineId) continue;
    const text = event.patch.text;
    if (text === undefined) continue;
    edits.push({
      at: event.at,
      text,
      dur: (event.patch.durationMs ?? 0) / 1000,
    });
  }

  // 换人不改文本，单独收：从快照里的说话人开始，一条一条接着换
  const speakers: SpeakerRevision[] = [];
  let speaker = original?.characterId;
  for (const event of events) {
    if (event.type !== "dialogue.speaker.updated") continue;
    if (event.lineId !== lineId) continue;
    if (speaker !== undefined && speaker !== event.characterId) {
      speakers.push({ at: event.at, from: speaker, to: event.characterId });
    }
    speaker = event.characterId;
  }

  return { original, edits, speakers };
}

/** 上一版的文本：改过一次就是最初那版，改过多次就是倒数第二版的文本。 */
export function previousDialogueText(history: DialogueHistory): string | undefined {
  if (history.edits.length === 0) return undefined;
  return history.edits[history.edits.length - 2]?.text ?? history.original?.text;
}

export type OrderRevision = { at: string; lineIds: string[] };

/**
 * 这一镜的台词顺序被改过几次（ADR-0053）。
 *
 * 只收显式换了 `dialogueIds`、且句子集合没变的 `shot.updated`：排序是一次镜头级改写；
 * 加句 / 删句走的是 `dialogue.added` / `dialogue.removed`，跨镜头挪台词改的是集合（ADR-0054），
 * 都不算在这里。
 */
export function dialogueOrderHistory(
  events: ProjectEvent[],
  shotId: string,
): OrderRevision[] {
  // 这一镜当前的台词集合：从快照起，加句 / 删句也一起跟。排序的判据是「集合没变、只换顺序」。
  let previous: Set<string> | undefined;
  const first = events[0];
  if (first?.type === "project.created") {
    const shot = first.project.shots.find((item) => item.id === shotId);
    if (shot) previous = new Set(shot.dialogueIds);
  }

  const revisions: OrderRevision[] = [];
  for (const event of events) {
    if (event.type === "dialogue.added" && event.shotId === shotId) {
      previous?.add(event.line.id);
      continue;
    }
    if (event.type === "dialogue.removed") {
      previous?.delete(event.lineId);
      continue;
    }
    if (event.type !== "shot.updated" || event.shotId !== shotId) continue;
    const lineIds = event.patch.dialogueIds;
    if (lineIds === undefined) continue;
    const next = new Set(lineIds);
    // 集合变了就不是「换顺序」，是句子进出（跨镜头挪台词，ADR-0054）。
    const reorder = previous === undefined || sameLineSet(previous, next);
    previous = next;
    if (reorder) revisions.push({ at: event.at, lineIds: [...lineIds] });
  }
  return revisions;
}

function sameLineSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

export type RemovedLine = {
  at: string;
  lineId: string;
  /** 删的时候它属于哪一镜 */
  shotId: string;
  text: string;
  characterId: string;
  durationMs: number;
};

/**
 * 被删掉的台词，带它当时的正文与所属镜头（ADR-0055）。
 *
 * `dialogue.removed` 只带 `lineId`：正文从快照与 `dialogue.added` 里按 id 找回，
 * 归属镜头从快照的 `dialogueIds`、加句事件与之后的数组改写里跟出来。
 * 返回从旧到新；同一句删了又恢复又删，会有两条记录。
 */
export function removedLines(events: ProjectEvent[], shotId?: string): RemovedLine[] {
  const first = events[0];
  if (!first || first.type !== "project.created") return [];

  const lines = new Map(first.project.dialogue.map((line) => [line.id, line]));
  const home = new Map<string, string>();
  for (const shot of first.project.shots) {
    for (const lineId of shot.dialogueIds) home.set(lineId, shot.id);
  }

  const removed: RemovedLine[] = [];
  for (const event of events.slice(1)) {
    if (event.type === "dialogue.added") {
      lines.set(event.line.id, event.line);
      home.set(event.line.id, event.shotId);
      continue;
    }
    if (event.type === "shot.updated" && event.patch.dialogueIds !== undefined) {
      for (const lineId of event.patch.dialogueIds) home.set(lineId, event.shotId);
      continue;
    }
    if (event.type !== "dialogue.removed") continue;
    const line = lines.get(event.lineId);
    const from = home.get(event.lineId);
    if (line && from !== undefined && (shotId === undefined || from === shotId)) {
      removed.push({
        at: event.at,
        lineId: event.lineId,
        shotId: from,
        text: line.text,
        characterId: line.characterId,
        durationMs: line.durationMs,
      });
    }
    lines.delete(event.lineId);
    home.delete(event.lineId);
  }
  return removed;
}

export type ActionRevision = { at: string; text: string };

export type ActionHistory = {
  /** 引导事件里最初那句动作；日志里没有就省掉 */
  original?: string;
  /** 从旧到新，一次改写一条 */
  edits: ActionRevision[];
};

/**
 * 一镜的动作被改过几次（ADR-0051）。
 *
 * 动作没有自己的事件：每次改写就是一条带 `description` 的 `shot.updated`；
 * 最初那版从 `project.created` 的快照里取。与台词的历史同一套读法。
 */
export function actionHistory(events: ProjectEvent[], shotId: string): ActionHistory {
  let original: string | undefined;
  const first = events[0];
  if (first?.type === "project.created") {
    const shot = first.project.shots.find((item) => item.id === shotId);
    if (shot) original = shot.description;
  }

  const edits: ActionRevision[] = [];
  for (const event of events) {
    if (event.type !== "shot.updated" || event.shotId !== shotId) continue;
    if (event.patch.description === undefined) continue;
    edits.push({ at: event.at, text: event.patch.description });
  }

  return { original, edits };
}

/** 上一版的动作：改过一次就是最初那版，改过多次就是倒数第二版的文本。 */
export function previousActionText(history: ActionHistory): string | undefined {
  if (history.edits.length === 0) return undefined;
  return history.edits[history.edits.length - 2]?.text ?? history.original;
}

export type SceneHead = {
  space: "int" | "ext";
  timeOfDay: "day" | "night" | "dawn" | "dusk";
  locationId: string;
};

export type SceneHeadRevision = { at: string; head: SceneHead };

export type SceneHeadHistory = {
  /** 引导事件里最初的场头；日志里没有这一场就省掉 */
  original?: SceneHead;
  /** 从旧到新，一次改动一条；每条是改完之后完整的场头 */
  edits: SceneHeadRevision[];
};

/**
 * 场头被改过几次（ADR-0058）。
 *
 * 场头三项挤在同一条 `scene.updated` 里（ADR-0050 / 0056），所以历史不是「改过哪一项」，
 * 而是「那一版长什么样」：每条事件之后把 patch 叠上去，存完整的场头。
 * 最初那版从 `project.created` 的快照里取，与动作、台词同一套读法。
 */
export function sceneHeadHistory(events: ProjectEvent[], sceneId: string): SceneHeadHistory {
  let current: SceneHead | undefined;
  const first = events[0];
  if (first?.type === "project.created") {
    const scene = first.project.scenes.find((item) => item.id === sceneId);
    if (scene) {
      current = {
        space: scene.space,
        timeOfDay: scene.timeOfDay,
        locationId: scene.locationId,
      };
    }
  }
  const original = current ? { ...current } : undefined;

  const edits: SceneHeadRevision[] = [];
  for (const event of events) {
    if (event.type !== "scene.updated" || event.sceneId !== sceneId) continue;
    const patch = event.patch;
    current = {
      space: patch.space ?? current?.space ?? "int",
      timeOfDay: patch.timeOfDay ?? current?.timeOfDay ?? "day",
      locationId: patch.locationId ?? current?.locationId ?? "",
    };
    edits.push({ at: event.at, head: { ...current } });
  }

  return { original, edits };
}

/** 上一版的场头：改过一次就是最初那版，改过多次就是倒数第二版。 */
export function previousSceneHead(history: SceneHeadHistory): SceneHead | undefined {
  if (history.edits.length === 0) return undefined;
  return history.edits[history.edits.length - 2]?.head ?? history.original;
}

/**
 * 剧本导出成纯文本（ADR-0048）：给存档、给外部工具、给人看。
 *
 * 只取屏上已有的东西：标题、页头四个数、场头、镜号、动作、台词、技术行。
 * 不做 Markdown 或 PDF——先保证"导出来的是剧本"。
 */
export function scriptToText(view: ScriptView): string {
  const lines: string[] = [];
  lines.push(`${view.title} v${view.version}`);
  lines.push(
    `${view.scenes.length} 场 · ${view.shotCount} 镜 · ${view.dialogueCount} 句台词 · ${view.totalDur.toFixed(1)}s`,
  );

  for (const scene of view.scenes) {
    lines.push("");
    lines.push(
      `第 ${scene.no} 场 · ${sceneHead(scene)} · ${scene.place}（${scene.dur.toFixed(1)}s · ${scene.shots.length} 镜）`,
    );
    for (const shot of scene.shots) {
      lines.push("");
      lines.push(`${shotLabel(shot.no)} · ${shot.size} · ${shot.angle} · ${shot.dur.toFixed(1)}s`);
      if (shot.action) lines.push(shot.action);
      for (const line of shot.lines) {
        lines.push(`　${line.character}：${line.text}`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}
