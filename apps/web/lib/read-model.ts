import {
  castReadiness,
  shotAnchors,
  SHEET_ANGLES,
  SHEET_LABELS,
  type CastStatus,
  type Project,
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
