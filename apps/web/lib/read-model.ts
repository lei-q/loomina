import {
  castReadiness,
  rebuild,
  rebuildStates,
  shotAnchors,
  SHEET_ANGLES,
  SHEET_LABELS,
  type Asset,
  type CastStatus,
  type Id,
  type LocationSpace,
  type Project,
  type ProjectEvent,
  type SheetView,
  type Shot,
  type Take,
  type VoicePerformance,
} from "@loomina/ir";
import {
  buildKeyframePrompt,
  buildVideoPrompt,
  SHOT_ANGLE_CN,
  SHOT_SIZE_CN,
  shotMaterial,
} from "@loomina/pipeline";
import { requoteProject, requoteShot, type ProjectRequote, type Requote } from "./pricing";

export type SceneKind = "door" | "two" | "table" | "corridor";
export type ShotState = "open" | "pick" | "reject";

export type StageTake = {
  id: string;
  /** 第几版，从 1 开始（按拍摄顺序，不按状态） */
  no: number;
  status: Take["status"];
  /** 视频地址（data URI 或 http(s)）；资产缺失或还没有 uri 时为空 */
  uri?: string;
  createdAt: string;
  costCny: number;
  /** 出片时的提示词里没有当前台词（A5 / ADR-0107）：这一拍的口型可能与现在这句对不上 */
  stalePrompt?: boolean;
};

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
  /** 这一镜的全部 take，按拍摄顺序（ADR-0083） */
  takes: StageTake[];
  /** 当前 take 的视频地址；没有能播的视频时为空 */
  videoUri?: string;
  /** 当前 take 有没有能播的视频：轨道条与关键帧页据此计数 */
  hasVideo: boolean;
  /** 锁定的镜头在审片台里只读 */
  locked: boolean;
  /** 这一镜里谁出场：分镜页据此点亮人物签（ADR-0065） */
  characterIds: string[];
  /** 这一镜里有哪些道具：分镜页据此点亮道具签（ADR-0066） */
  propIds: string[];
  /** 所在的场次：道具签按场筛选要用（ADR-0078） */
  sceneId: string;
  /** 景别与人话机位（"特写 · 仰拍"）：一句话指令改了哪个当场看得见（ADR-0039） */
  size: string;
  angle: string;
  /** 一句话指令落下的补充要求（ADR-0039） */
  notes: string[];
  /** 首尾两帧与视频真正会送出的提示词：说了什么、改了什么，在这里对得上（ADR-0040 / ADR-0083） */
  prompts: { first: string; last: string; video: string };
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
  /** 这一镜台词拼成的字幕（预演与审片共用，ADR-0084） */
  subtitle: string;
  /** 出片提示词里没有当前台词的 take 数（A5 / ADR-0107） */
  staleTakes: number;
  /** 配音与当前台词对不上的句数（A5 / ADR-0107） */
  staleVoices: number;
  /** 这一镜的金额上限（H10）；不设就是只受项目预算约束 */
  budgetCny?: number;
  /** 这一镜已经花掉多少（H10） */
  spentCny: number;
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
  /**
   * 其中文本调用（故事生成）的钱（H4）。
   * 文本按 token 计价，单价由作者在设置页填；没填就不进 `spent`，只进 `unpricedCalls`。
   */
  text: number;
  /**
   * 其中配音的钱（H4）：按字计价，单价同样由作者填。
   * 已算在 `assets` 里（音轨是资产），这里单独拆出来是为了让账单说得清。
   */
  voice: number;
  /**
   * 有多少次生成调用没有单价（H4）：文本 / 配音 / 图 / 视频。
   *
   * 与 `unpriced`（张数）分开：一次文本调用生成的不是「一张图」，
   * 混在一个数里，作者会以为漏算的是几张定妆图。
   */
  unpricedCalls: number;
};

/**
 * 一个项目已经花了多少钱。
 *
 * 只加"知道单价"的东西：没有价目的资产宁可单独数出来，也不当 0 算进去——
 * 把未知算成免费，预算就成了摆设（准则 P21）。
 *
 * 文本（H4）：故事生成的费用记在 `story.provenance.costCny` 上。
 * 草稿本身不写 IR，只有「用它开工」那一刻才带着这笔钱落成项目，
 * 所以这里读的是那个溯源，不是某条事件。
 */
export function spendOf(project: Project): Spend {
  const takes = project.takes.reduce((sum, take) => sum + take.costCny, 0);
  const rejected = project.takes
    .filter((take) => take.status === "rejected")
    .reduce((sum, take) => sum + take.costCny, 0);
  let assets = 0;
  let voice = 0;
  let unpriced = 0;
  let unpricedCalls = 0;
  // take 的视频资产不单独计费：钱记在 take 上，资产再记一次就重复了
  const takeAssetIds = new Set(project.takes.map((take) => take.assetId));
  for (const asset of project.assets) {
    if (takeAssetIds.has(asset.id)) continue;
    if (asset.costCny !== undefined) {
      assets += asset.costCny;
      // 音轨的钱是配音阶段花出去的（H4），单独拆一份给账单用
      if (asset.kind === "audio" && asset.source === "generated") voice += asset.costCny;
    } else if (asset.source === "generated" && asset.uri) {
      unpriced += 1;
      // 生成过却有地址却没有钱：这一笔就是「未定价的调用」，与张数一起数
      unpricedCalls += 1;
    }
  }
  const text = project.story.provenance?.costCny ?? 0;
  // 故事生成过但没记账：算一次未定价调用
  const storyUnpriced =
    project.story.provenance && project.story.provenance.costCny === undefined ? 1 : 0;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    spent: round(takes + assets + text),
    takes: round(takes),
    assets: round(assets),
    rejected: round(rejected),
    unpriced,
    text: round(text),
    voice: round(voice),
    unpricedCalls: unpricedCalls + storyUnpriced,
  };
}

export type StageSpend = {
  id: "story" | "cast" | "storyboard" | "voice" | "edit";
  label: string;
  /** 这一阶段已经花掉的钱（元） */
  spent: number;
  /** 这一阶段没有价目、算不进已花的生成资产张数 */
  unpriced: number;
  /** 这一阶段没有单价的生成调用次数（H4）：文本 / 配音没有「张」这个单位 */
  unpricedCalls: number;
  /** 钱花在哪里：给界面一句人话 */
  detail: string;
};

/**
 * 按阶段拆账（H4）。
 *
 * 分类只按引用关系走，不按资产类型猜：
 * - 故事生成的文本调用 → 故事（钱记在 `story.provenance.costCny` 上）；
 * - take 的视频资产不单独计费，钱记在 take 上 → 分镜；
 * - 首尾帧资产 → 分镜；
 * - 台词音轨 → 配音；其余音频 → 配音；
 * - 配乐资产 → 成片；
 * - 剩下没人引用的图 / 视频 → 定妆（角色三视图、场景主镜、道具参考）。
 *
 * 本机 ffmpeg 渲染不按文件收费，但占机器时间：`edit` 阶段显示最近一次渲染耗时
 * （来自 `publish.recorded.renderMs`），不折成钱——没有单价的时间不是成本。
 */
export function spendByStage(project: Project): StageSpend[] {
  const takeAssetIds = new Set(project.takes.map((take) => take.assetId));
  const keyframeIds = new Set<string>();
  for (const shot of project.shots) {
    if (shot.keyframes.firstAssetId) keyframeIds.add(shot.keyframes.firstAssetId);
    if (shot.keyframes.lastAssetId) keyframeIds.add(shot.keyframes.lastAssetId);
  }
  const dialogueAudioIds = new Set(
    project.dialogue.map((line) => line.audioAssetId).filter((id): id is Id => Boolean(id)),
  );
  const musicAssetIds = new Set(project.timeline.music.map((cue) => cue.assetId));

  const buckets: Record<
    Exclude<StageSpend["id"], "story">,
    { spent: number; unpriced: number; unpricedCalls: number; assets: number }
  > = {
    cast: { spent: 0, unpriced: 0, unpricedCalls: 0, assets: 0 },
    storyboard: { spent: 0, unpriced: 0, unpricedCalls: 0, assets: 0 },
    voice: { spent: 0, unpriced: 0, unpricedCalls: 0, assets: 0 },
    edit: { spent: 0, unpriced: 0, unpricedCalls: 0, assets: 0 },
  };
  const add = (
    id: Exclude<StageSpend["id"], "story">,
    asset: (typeof project.assets)[number],
  ) => {
    buckets[id].assets += 1;
    if (asset.costCny !== undefined) buckets[id].spent += asset.costCny;
    else if (asset.source === "generated" && asset.uri) {
      buckets[id].unpriced += 1;
      buckets[id].unpricedCalls += 1;
    }
  };

  for (const asset of project.assets) {
    // take 的视频已经由 take.costCny 记过，资产再记一次会重复
    if (takeAssetIds.has(asset.id)) continue;
    if (keyframeIds.has(asset.id)) add("storyboard", asset);
    else if (dialogueAudioIds.has(asset.id)) add("voice", asset);
    else if (musicAssetIds.has(asset.id)) add("edit", asset);
    else if (asset.kind === "audio") add("voice", asset);
    else add("cast", asset);
  }

  const takeCost = project.takes.reduce((sum, take) => sum + take.costCny, 0);
  buckets.storyboard.spent += takeCost;

  const round = (value: number) => Math.round(value * 100) / 100;
  const storyCost = project.story.provenance?.costCny;
  const storyUsage = project.story.provenance?.usage;
  const storyUnpriced = project.story.provenance && storyCost === undefined ? 1 : 0;
  const voiceLines = project.dialogue.filter((line) => line.audioAssetId).length;
  // 最近一次渲染的机器时间（H4）：只说时间，不折成钱
  const lastRenderMs = project.publishPackages
    .filter((pack) => pack.renderMs !== undefined)
    .at(-1)?.renderMs;

  return [
    {
      id: "story",
      label: "故事",
      spent: round(storyCost ?? 0),
      unpriced: 0,
      unpricedCalls: storyUnpriced,
      detail:
        storyUsage !== undefined
          ? `文本模型 ${project.story.provenance?.modelId ?? "未知"} · ${
              storyUsage.unit === "chars"
                ? `${Math.round(storyUsage.units)} 字`
                : `${(storyUsage.units / 1000).toFixed(1)}k token`
            }`
          : project.story.provenance
            ? "文本模型没有报用量，算不出钱"
            : "还没有用文本模型生成过故事",
    },
    {
      id: "cast",
      label: "定妆",
      spent: round(buckets.cast.spent),
      unpriced: buckets.cast.unpriced,
      unpricedCalls: buckets.cast.unpricedCalls,
      detail: `${buckets.cast.assets} 个资产 · 角色 / 场景 / 道具参考`,
    },
    {
      id: "storyboard",
      label: "分镜",
      spent: round(buckets.storyboard.spent),
      unpriced: buckets.storyboard.unpriced,
      unpricedCalls: buckets.storyboard.unpricedCalls,
      detail: `${project.takes.length} 条 take · ${buckets.storyboard.assets} 个关键帧资产`,
    },
    {
      id: "voice",
      label: "配音",
      spent: round(buckets.voice.spent),
      unpriced: buckets.voice.unpriced,
      unpricedCalls: buckets.voice.unpricedCalls,
      detail: `${voiceLines} 句有声台词 · ${buckets.voice.assets} 段音频`,
    },
    {
      id: "edit",
      label: "成片",
      spent: round(buckets.edit.spent),
      unpriced: buckets.edit.unpriced,
      unpricedCalls: buckets.edit.unpricedCalls,
      detail: [
        project.timeline.music.length > 0
          ? `${project.timeline.music.length} 段配乐`
          : "没有配乐",
        lastRenderMs !== undefined
          ? `最近一次渲染 ${(lastRenderMs / 1000).toFixed(1)}s 机器时间`
          : "还没记过渲染耗时",
        "本机渲染不按文件计费",
      ].join(" · "),
    },
  ];
}

export type ShotLedgerRow = {
  shotId: string;
  label: string;
  scene: string;
  durationMs: number;
  /** 这一镜的 take 与首尾帧 */
  spent: number;
  unpriced: number;
  takes: number;
  /** 其中已淘汰 take 的钱 */
  rejected: number;
};

/** 按镜拆账（H4）：每一镜花了多少，定妆等项目级成本不摊进来。 */
export function shotLedger(project: Project): ShotLedgerRow[] {
  const sceneName = (sceneId: string) => {
    const scene = project.scenes.find((item) => item.id === sceneId);
    if (!scene) return "未知场景";
    return scene.code || `第 ${scene.index + 1} 场`;
  };
  const locationName = (sceneId: string) => {
    const scene = project.scenes.find((item) => item.id === sceneId);
    return project.locations.find((item) => item.id === scene?.locationId)?.name ?? "";
  };

  return project.shots.map((shot, index) => {
    const takes = project.takes.filter((take) => take.shotId === shot.id);
    const takeAssetIds = new Set(takes.map((take) => take.assetId));
    const frameIds = new Set(
      [shot.keyframes.firstAssetId, shot.keyframes.lastAssetId].filter(
        (id): id is Id => Boolean(id),
      ),
    );
    let spent = takes.reduce((sum, take) => sum + take.costCny, 0);
    let unpriced = 0;
    for (const asset of project.assets) {
      if (!frameIds.has(asset.id) || takeAssetIds.has(asset.id)) continue;
      if (asset.costCny !== undefined) spent += asset.costCny;
      else if (asset.source === "generated" && asset.uri) unpriced += 1;
    }
    return {
      shotId: shot.id,
      label: shotLabel(index + 1),
      scene: locationName(shot.sceneId) || sceneName(shot.sceneId),
      durationMs: shot.durationMs,
      spent: Math.round(spent * 100) / 100,
      unpriced,
      takes: takes.length,
      rejected: Math.round(
        takes
          .filter((take) => take.status === "rejected")
          .reduce((sum, take) => sum + take.costCny, 0) * 100,
      ) / 100,
    };
  });
}

export type ShotSpend = {
  /** 这一镜已经花掉的钱：take 的费用 + 首尾帧资产 */
  spent: number;
  /** 生成过、但价目表里没有单价的图与视频 */
  unpriced: number;
};

/**
 * 单镜已经花了多少（H10）。
 *
 * 只数这一镜自己的东西：属于它的 take，以及挂在它首尾帧上的资产。
 * 定妆、场景主镜、道具参考图是项目级成本，不摊到某一镜上——
 * 摊了之后「单镜上限」就说不清是限制重拍还是限制定妆。
 */
export function shotSpendOf(project: Project, shotId: string): ShotSpend {
  const shot = project.shots.find((item) => item.id === shotId);
  if (!shot) return { spent: 0, unpriced: 0 };
  const takes = project.takes.filter((take) => take.shotId === shotId);
  // take 的费用记在 take 上；它的视频资产再记一次就重复了，所以跳过
  const takeAssetIds = new Set(takes.map((take) => take.assetId));
  const assetIds = new Set<string>();
  if (shot.keyframes.firstAssetId) assetIds.add(shot.keyframes.firstAssetId);
  if (shot.keyframes.lastAssetId) assetIds.add(shot.keyframes.lastAssetId);

  let spent = takes.reduce((sum, take) => sum + take.costCny, 0);
  let unpriced = 0;
  for (const asset of project.assets) {
    if (!assetIds.has(asset.id) || takeAssetIds.has(asset.id)) continue;
    if (asset.costCny !== undefined) spent += asset.costCny;
    else if (asset.source === "generated" && asset.uri) unpriced += 1;
  }
  return { spent: Math.round(spent * 100) / 100, unpriced };
}

export type DownstreamGap = {
  /** 这一镜的台词句数；没有台词时不谈同步 */
  lines: number;
  /** 出片提示词里不含当前台词的 take 数 */
  takes: number;
  /** 音轨是按旧台词念的句数 */
  voices: number;
};

/**
 * 改台词之后下游有没有跟上（A5 / ADR-0107）。
 *
 * 两条判断都只看已有的溯源，不猜：
 * - take：出片时存下的 `provenance.prompt` 里缺任何一句当前台词，就说明这一拍不是按现在这句出的；
 * - 配音：音轨资产的 `provenance.prompt` 与当前台词不同，就说明念的是旧词。
 *
 * 导入的视频没有提示词，无从判断，不计入；没有台词的镜头也不计入。
 */
export function downstreamGap(project: Project, shotId: string): DownstreamGap {
  const shot = project.shots.find((item) => item.id === shotId);
  if (!shot) return { lines: 0, takes: 0, voices: 0 };
  const lineById = new Map(project.dialogue.map((line) => [line.id, line]));
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const lines = shot.dialogueIds.flatMap((id) => {
    const line = lineById.get(id);
    return line ? [line] : [];
  });

  let voices = 0;
  for (const line of lines) {
    if (!line.audioAssetId) continue;
    const asset = assetById.get(line.audioAssetId);
    const spoken = asset?.provenance?.prompt;
    // 没有溯源就无从判断，不冒充「旧台词」
    if (spoken !== undefined && spoken !== line.text) voices += 1;
  }

  let takes = 0;
  for (const take of project.takes) {
    if (take.shotId !== shot.id) continue;
    const prompt = take.provenance.prompt;
    if (!prompt) continue;
    if (lines.some((line) => !prompt.includes(line.text))) takes += 1;
  }

  return { lines: lines.length, takes, voices };
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
  /** 全部人物：分镜页给这一镜点名用（ADR-0065） */
  characters: { id: string; name: string }[];
  /** 全部道具：分镜页给这一镜点名用（ADR-0066） */
  props: { id: string; name: string }[];
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
  // 场景模板（B15 / ADR-0103）：剪影只求一眼能认出空间类型
  "living-room": "table",
  bedroom: "table",
  office: "table",
  elevator: "door",
  street: "corridor",
  cafe: "table",
  "hospital-corridor": "corridor",
  "car-interior": "two",
  rooftop: "corridor",
  classroom: "table",
  "apartment-living": "table",
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
    // 首尾帧各对表演设计的起点与落点（B16 / ADR-0103）
    const firstMaterial = shotMaterial(project, shot, { frame: "first" });
    const lastMaterial = shotMaterial(project, shot, { frame: "last" });
    const lineTexts = shot.dialogueIds.flatMap((id) => {
      const line = dialogueById.get(id);
      return line ? [line.text] : [];
    });
    const stalePromptOf = (prompt: string | undefined) =>
      Boolean(prompt) && lineTexts.some((text) => !prompt!.includes(text));
    const staleVoices = shot.dialogueIds.filter((id) => {
      const line = dialogueById.get(id);
      if (!line?.audioAssetId) return false;
      const asset = assetById.get(line.audioAssetId);
      const spoken = asset?.provenance?.prompt;
      return spoken !== undefined && spoken !== line.text;
    }).length;
    const takes: StageTake[] = shot.takeIds.flatMap((id, i) => {
      const item = takesById.get(id);
      if (!item) return [];
      return [
        {
          id: item.id,
          no: i + 1,
          status: item.status,
          uri: assetById.get(item.assetId)?.uri,
          createdAt: item.provenance.createdAt,
          costCny: item.costCny,
          ...(stalePromptOf(item.provenance.prompt) ? { stalePrompt: true } : {}),
        },
      ];
    });
    const videoUri = take ? assetById.get(take.assetId)?.uri : undefined;
    return {
      no: i + 1,
      id: shot.id,
      art: artFor(shot, templateByLocation, locationByScene),
      action: shot.description,
      dur: shot.durationMs / 1000,
      state: shotState(shot, take),
      take: take ? shot.takeIds.indexOf(take.id) + 1 : undefined,
      takes,
      videoUri,
      hasVideo: Boolean(videoUri),
      locked: shot.locked ?? false,
      characterIds: shot.characterIds,
      propIds: shot.propIds,
      sceneId: shot.sceneId,
      size: SHOT_SIZE_CN[shot.shotSize],
      angle: SHOT_ANGLE_CN[shot.camera.angle],
      notes: shot.promptNotes,
      prompts: {
        first: buildKeyframePrompt(firstMaterial, "first"),
        last: buildKeyframePrompt(lastMaterial, "last"),
        video: buildVideoPrompt(material),
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
      subtitle: shot.dialogueIds
        .map((id) => dialogueById.get(id)?.text)
        .filter((text): text is string => Boolean(text))
        .join(" "),
      staleTakes: takes.filter((item) => item.stalePrompt).length,
      staleVoices,
      budgetCny: shot.budgetCny,
      spentCny: shotSpendOf(project, shot.id).spent,
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
    /** 可选的人物：分镜页用它给这一镜点名（ADR-0065） */
    characters: project.characters.map((item) => ({ id: item.id, name: item.name })),
    /** 可选的道具：同一排签（ADR-0066） */
    props: project.props.map((item) => ({ id: item.id, name: item.name })),
    shots,
  };
}

export function shotLabel(no: number): string {
  return `SH-${String(no).padStart(2, "0")}`;
}

// ── 预演（ADR-0084）─────────────────────────────────────────────

export type AnimaticClip = {
  id: string;
  text: string;
  /** 这一句的音轨（data URI 或 http(s)） */
  uri: string;
};

export type AnimaticSegment = {
  id: string;
  no: number;
  /** 这一镜显示多少秒 */
  dur: number;
  art: SceneKind;
  /** 先看有片子的，再看首帧，再看尾帧；都没有就用占位画 */
  imageUri?: string;
  videoUri?: string;
  /** 字幕：这一镜所有台词拼起来 */
  subtitle: string;
  /** 这一镜已配好的音轨，按台词顺序播（ADR-0085） */
  clips: AnimaticClip[];
  /** 有没有画可看：没有的话预演里只出占位色块 */
  hasPicture: boolean;
};

/** 预演里的配乐（E10 / C4）：跟着整条片子循环，按 cue 的增益压低 */
export type AnimaticMusic = {
  id: string;
  title: string;
  mood: string;
  uri?: string;
  /** 线性音量，已从 dB 换算；没有文件时是 0 */
  volume: number;
  loop: boolean;
};

export type AnimaticView = {
  title: string;
  segments: AnimaticSegment[];
  /** 配乐床；目前一条，没有就是空数组 */
  music: AnimaticMusic[];
  /** 全长，秒 */
  totalSec: number;
  /** 一帧画面都没有的镜头数 */
  missing: number;
  /** 有片子的镜头数 */
  withVideo: number;
  /** 已经配了音的镜头数 */
  withVoice: number;
};

/**
 * 预演用的读模型：按顺序铺满整条片子（ADR-0084）。
 *
 * 只读现成的帧与片子，不触发生成、不写事件——预演是看节奏的地方，
 * 不是又一个烧钱的入口。
 */
export function toAnimaticView(project: Project): AnimaticView {
  const view = toStageView(project);
  const dialogueById = new Map(project.dialogue.map((line) => [line.id, line]));
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const irShotById = new Map(project.shots.map((shot) => [shot.id, shot]));

  const segments: AnimaticSegment[] = view.shots.map((shot) => {
    const imageUri = shot.keyframeUri ?? shot.lastKeyframeUri;
    const clips: AnimaticClip[] = [];
    for (const lineId of irShotById.get(shot.id)?.dialogueIds ?? []) {
      const line = dialogueById.get(lineId);
      const asset = line?.audioAssetId ? assetById.get(line.audioAssetId) : undefined;
      if (line && asset?.uri) {
        clips.push({ id: line.id, text: line.text, uri: asset.uri });
      }
    }
    return {
      id: shot.id,
      no: shot.no,
      dur: shot.dur,
      art: shot.art,
      imageUri,
      videoUri: shot.videoUri,
      subtitle: shot.subtitle,
      clips,
      hasPicture: Boolean(shot.videoUri ?? imageUri),
    };
  });
  const totalSec = segments.reduce((sum, item) => sum + item.dur, 0);
  const music: AnimaticMusic[] = project.timeline.music.flatMap((cue) => {
    const asset = assetById.get(cue.assetId);
    if (!asset?.uri) return [];
    return [
      {
        id: cue.id,
        title: cue.title,
        mood: cue.mood,
        uri: asset.uri,
        // 与成片同一口径：dB 转线性，0 dB 就是 1
        volume: Math.min(1, Math.max(0, 10 ** (cue.gainDb / 20))),
        loop: cue.loop,
      },
    ];
  });
  return {
    title: view.title,
    segments,
    music,
    totalSec: Math.round(totalSec * 10) / 10,
    missing: segments.filter((item) => !item.hasPicture).length,
    withVideo: segments.filter((item) => Boolean(item.videoUri)).length,
    withVoice: segments.filter((item) => item.clips.length > 0).length,
  };
}

// ── 配音页（ADR-0085）──────────────────────────────────────────

export type VoiceLine = {
  id: string;
  /** 所属镜号 */
  no: number;
  sceneNo: number;
  characterId: string;
  characterName: string;
  text: string;
  /** 这一句在 IR 里占的时长，秒 */
  dur: number;
  /** 量出来的音轨时长，秒；还没量过就是空 */
  audioDur?: number;
  audioUri?: string;
  state: "missing" | "voiced";
  /** 音轨是按旧台词念的（A5 / ADR-0107）：重配才会对上 */
  stale?: boolean;
  /** 表演参数（C2 / ADR-0124）；没写过就是 undefined，界面按默认值显示 */
  performance?: VoicePerformance;
  /** 试听台里有几版（C9）；0 表示还没存过版本 */
  takes: number;
  /** 当前音轨是不是试听台里的某一版（C9） */
  adoptedTakeId?: string;
};

export type VoiceRole = {
  id: string;
  name: string;
  /** 音色标识；空表示用默认音色 */
  voice?: string;
  lines: number;
  voiced: number;
};

export type VoiceView = {
  title: string;
  version: number;
  lines: VoiceLine[];
  roles: VoiceRole[];
  total: number;
  voiced: number;
  /** 台词总长，秒 */
  totalSec: number;
  /** 已配好的音轨总长，秒；没量过的按 IR 时长算 */
  voicedSec: number;
  spent: number;
  budget: number;
  spend: Spend;
  unpriced: number;
  /** 试听台总版本数（C9）；界面上写「共 N 版」 */
  takes: number;
};

/**
 * 配音页的读模型：按镜头顺序铺开每一句台词。
 *
 * 时长以 IR 为准（P5）：字幕、预演、时间线都读同一个数；
 * 音轨量出来之后由 `fitLineToAudio` 把 IR 改成真实时长，而不是各读各的。
 */
export function toVoiceView(project: Project): VoiceView {
  const view = toStageView(project);
  const dialogueById = new Map(project.dialogue.map((line) => [line.id, line]));
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const characterById = new Map(project.characters.map((item) => [item.id, item]));
  const shotById = new Map(project.shots.map((shot) => [shot.id, shot]));
  const sceneById = new Map(project.scenes.map((scene) => [scene.id, scene]));

  const lines: VoiceLine[] = [];
  for (const stageShot of view.shots) {
    const shot = shotById.get(stageShot.id);
    if (!shot) continue;
    const sceneNo = (sceneById.get(shot.sceneId)?.index ?? 0) + 1;
    for (const lineId of shot.dialogueIds) {
      const line = dialogueById.get(lineId);
      if (!line) continue;
      const asset = line.audioAssetId ? assetById.get(line.audioAssetId) : undefined;
      const character = characterById.get(line.characterId);
      const takes = project.voiceTakes.filter((take) => take.lineId === line.id);
      const adopted = takes.find((take) => take.assetId === line.audioAssetId);
      lines.push({
        id: line.id,
        no: stageShot.no,
        sceneNo,
        characterId: line.characterId,
        characterName: character?.name ?? line.characterId,
        text: line.text,
        dur: Math.round((line.durationMs / 1000) * 10) / 10,
        ...(asset?.durationMs
          ? { audioDur: Math.round((asset.durationMs / 1000) * 10) / 10 }
          : {}),
        ...(asset?.uri ? { audioUri: asset.uri } : {}),
        state: asset?.uri ? "voiced" : "missing",
        ...(asset?.uri && asset.provenance?.prompt !== undefined && asset.provenance.prompt !== line.text
          ? { stale: true }
          : {}),
        ...(line.performance ? { performance: line.performance } : {}),
        takes: takes.length,
        ...(adopted ? { adoptedTakeId: adopted.id } : {}),
      });
    }
  }

  const roles: VoiceRole[] = project.characters.map((character) => {
    const own = lines.filter((line) => line.characterId === character.id);
    return {
      id: character.id,
      name: character.name,
      ...(character.voiceProfileId ? { voice: character.voiceProfileId } : {}),
      lines: own.length,
      voiced: own.filter((line) => line.state === "voiced").length,
    };
  });

  const totalSec = lines.reduce((sum, line) => sum + line.dur, 0);
  const voicedSec = lines
    .filter((line) => line.state === "voiced")
    .reduce((sum, line) => sum + (line.audioDur ?? line.dur), 0);
  const spend = spendOf(project);

  return {
    title: view.title,
    version: view.version,
    lines,
    roles,
    total: lines.length,
    voiced: lines.filter((line) => line.state === "voiced").length,
    totalSec: Math.round(totalSec * 10) / 10,
    voicedSec: Math.round(voicedSec * 10) / 10,
    spent: spend.spent,
    budget: project.budgetCny,
    spend,
    unpriced: spend.unpriced,
    takes: project.voiceTakes.length,
  };
}

// ── 撤销删除（ADR-0076）─────────────────────────────────────────

export type RemovalKind = "character" | "prop" | "location" | "shot" | "scene";

export type UndoableRemoval = {
  /** 删除事件在日志里的位置：前缀重放用它取回被删对象的快照 */
  index: number;
  kind: RemovalKind;
  id: string;
  /** 界面上怎么称呼它：人物 / 道具 / 地点用名字，镜头用 SH-xx，场次用第 N 场 */
  label: string;
  at: string;
};

export function removalTargetOf(
  event: ProjectEvent,
): { kind: RemovalKind; id: string } | undefined {
  switch (event.type) {
    case "character.removed":
      return { kind: "character", id: event.characterId };
    case "prop.removed":
      return { kind: "prop", id: event.propId };
    case "location.removed":
      return { kind: "location", id: event.locationId };
    case "shot.removed":
      return { kind: "shot", id: event.shotId };
    case "scene.removed":
      return { kind: "scene", id: event.sceneId };
    default:
      return undefined;
  }
}

export function removalAlive(
  project: Project,
  kind: RemovalKind,
  id: string,
): boolean {
  switch (kind) {
    case "character":
      return project.characters.some((item) => item.id === id);
    case "prop":
      return project.props.some((item) => item.id === id);
    case "location":
      return project.locations.some((item) => item.id === id);
    case "shot":
      return project.shots.some((item) => item.id === id);
    case "scene":
      return project.scenes.some((item) => item.id === id);
  }
}

/** 界面上怎么称呼它：人物 / 道具 / 地点用名字，镜头用 SH-xx，场次用第 N 场 */
function removalLabel(
  project: Project,
  target: { kind: RemovalKind; id: string },
): string {
  switch (target.kind) {
    case "character":
      return project.characters.find((item) => item.id === target.id)?.name ?? target.id;
    case "prop":
      return project.props.find((item) => item.id === target.id)?.name ?? target.id;
    case "location":
      return project.locations.find((item) => item.id === target.id)?.name ?? target.id;
    case "shot": {
      const no = toStageView(project).shots.findIndex((item) => item.id === target.id);
      return no >= 0 ? shotLabel(no + 1) : target.id;
    }
    case "scene": {
      const scene = project.scenes.find((item) => item.id === target.id);
      return scene ? `第 ${scene.code || scene.index + 1} 场` : target.id;
    }
  }
}

/**
 * 下一次「撤销删除」会撤销哪一条（ADR-0076）。
 *
 * 从日志末尾往回找第一条"删掉之后还没回来"的记录：同一个对象删了又删，
 * 撤的永远是最新那一次；撤销过的那条因为对象已经回来，会被跳过。
 */
export function undoableRemoval(
  events: ProjectEvent[],
  project: Project,
): UndoableRemoval | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const target = removalTargetOf(events[index]!);
    if (!target || removalAlive(project, target.kind, target.id)) continue;

    // 被删时它叫什么：用删除之前的那份项目算
    const before = rebuild(events.slice(0, index));
    return {
      index,
      kind: target.kind,
      id: target.id,
      label: removalLabel(before, target),
      at: events[index]!.at,
    };
  }
  return undefined;
}

/**
 * 回收站（F2 / ADR-0109）：日志里所有「删掉了、现在还没回来」的对象，最新在前。
 *
 * 一次回放拿到每一步的项目，逐条登记时用「删除之前」的那一份取名字——
 * 这样早先删掉的东西也还能按当时的叫法显示，不会变成一串 id。
 */
export function recycleBin(
  events: ProjectEvent[],
  project: Project,
): UndoableRemoval[] {
  const states = rebuildStates(events);
  const seen = new Set<string>();
  const bin: UndoableRemoval[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const target = removalTargetOf(events[index]!);
    if (!target || removalAlive(project, target.kind, target.id)) continue;
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const before = states[index - 1] ?? project;
    bin.push({
      index,
      kind: target.kind,
      id: target.id,
      label: removalLabel(before, target),
      at: events[index]!.at,
    });
  }
  return bin;
}

// ── 关键帧页（ADR-0042）───────────────────────────────────────────

export type KeyframeCell = {
  id: string;
  no: number;
  art: SceneKind;
  action: string;
  size: string;
  angle: string;
  /** 秒：出视频的报价按它算 */
  dur: number;
  locked: boolean;
  firstUri?: string;
  lastUri?: string;
  hasFirst: boolean;
  hasLast: boolean;
  /** 这一镜已经有能播的 take 视频（ADR-0083） */
  videoUri?: string;
  hasVideo: boolean;
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

/**
 * 主镜过期（ADR-0075）：场景描述改了之后，已经出的主镜对不上新描述。
 *
 * 只认 `location.updated { description }`：主镜提示词里只有名字与描述
 * （模板只决定界面剪影，不改提示词）。与关键帧同一套判定——比时间，不比内容。
 */
export function staleMasters(
  events: ProjectEvent[],
  project: Project,
): Map<string, StaleMark> {
  const edits = new Map<string, Array<{ at: string; reason: string }>>();
  for (const event of events) {
    if (event.type !== "location.updated") continue;
    if (event.patch.description === undefined) continue;
    const list = edits.get(event.locationId);
    if (list) list.push({ at: event.at, reason: "场景描述" });
    else edits.set(event.locationId, [{ at: event.at, reason: "场景描述" }]);
  }

  const stale = new Map<string, StaleMark>();
  for (const location of project.locations) {
    const locationEdits = edits.get(location.id);
    if (!locationEdits || !location.masterShotId) continue;
    const asset = project.assets.find((item) => item.id === location.masterShotId);
    if (!asset) continue;
    const after = locationEdits.filter(
      (edit) => Date.parse(edit.at) > Date.parse(asset.createdAt),
    );
    if (after.length === 0) continue;
    const at = after.reduce(
      (latest, edit) => (Date.parse(edit.at) > Date.parse(latest) ? edit.at : latest),
      after[0]!.at,
    );
    stale.set(location.id, {
      at,
      reasons: [...new Set(after.map((edit) => edit.reason))],
    });
  }
  return stale;
}

/**
 * 四格过期（B1）：人物名字 / 外形 / 「不许变」改了之后，已经出的三视图对不上新设定。
 *
 * 与主镜、关键帧同一套判定：只比时间，不比内容。四格之间还比一次生成模型——
 * 单格重出时换了模型，四张脸会不是一个画风，这里标出来。
 */
export function staleSheetCells(
  events: ProjectEvent[],
  project: Project,
): Map<string, StaleMark> {
  const edits = new Map<string, Array<{ at: string; reason: string }>>();
  for (const event of events) {
    if (event.type !== "character.updated") continue;
    const reasons: string[] = [];
    if (event.patch.name !== undefined) reasons.push("名字");
    if (event.patch.appearance !== undefined) reasons.push("外形描述");
    if (event.patch.mustNotChange !== undefined) reasons.push("不许变");
    if (reasons.length === 0) continue;
    const list = edits.get(event.characterId);
    const next = reasons.map((reason) => ({ at: event.at, reason }));
    if (list) list.push(...next);
    else edits.set(event.characterId, next);
  }

  const stale = new Map<string, StaleMark>();
  for (const character of project.characters) {
    const cells = SHEET_ANGLES.flatMap((angle) => {
      const assetId = character.sheet[angle];
      if (!assetId) return [];
      const asset = project.assets.find((item) => item.id === assetId);
      return asset ? [{ assetId, asset }] : [];
    });
    if (cells.length === 0) continue;

    // 四格不是一个模型出的：标出少数派；两种各半时四格都标
    const byModel = new Map<string, number>();
    for (const { asset } of cells) {
      const modelId = asset.provenance?.modelId;
      if (modelId) byModel.set(modelId, (byModel.get(modelId) ?? 0) + 1);
    }
    let majority: string | undefined;
    let tied = false;
    if (byModel.size > 1) {
      const ranked = [...byModel.entries()].sort((a, b) => b[1] - a[1]);
      majority = ranked[0]![0];
      tied = ranked[0]![1] === ranked[1]![1];
    }

    const characterEdits = edits.get(character.id) ?? [];
    for (const { assetId, asset } of cells) {
      const after = characterEdits.filter(
        (edit) => Date.parse(edit.at) > Date.parse(asset.createdAt),
      );
      const reasons = [...new Set(after.map((edit) => edit.reason))];
      const modelId = asset.provenance?.modelId;
      if (byModel.size > 1 && (tied || modelId !== majority)) {
        reasons.push("四格生成模型不一致");
      }
      if (reasons.length === 0) continue;
      const at = after.reduce(
        (latest, edit) => (Date.parse(edit.at) > Date.parse(latest) ? edit.at : latest),
        asset.createdAt,
      );
      stale.set(assetId, { at, reasons });
    }
  }
  return stale;
}

export type SheetCellVersion = {
  /** 这一格以前出过的资产（带 uri 才有得看、有得换） */
  asset: Asset;
  /** 写进日志的时刻 */
  at: string;
  modelId?: string;
};

/**
 * 三视图每一格的旧版（B1）：按 `asset.updated` 回放，同一个资产 id 出过哪几张。
 *
 * 只留带 uri 的版本，按 uri 去重；当前这一版不算「旧版」。
 * 换版本不花钱——它只是把某一张旧图重新指成当前资产（`asset.updated`）。
 */
export function sheetAssetHistory(
  events: ProjectEvent[],
): Map<string, SheetCellVersion[]> {
  const versions = new Map<string, SheetCellVersion[]>();
  const push = (asset: Asset, at: string) => {
    if (!asset.uri) return;
    const list = versions.get(asset.id);
    const entry: SheetCellVersion = {
      asset,
      at,
      ...(asset.provenance?.modelId ? { modelId: asset.provenance.modelId } : {}),
    };
    if (list) list.push(entry);
    else versions.set(asset.id, [entry]);
  };

  for (const event of events) {
    if (event.type === "project.created") {
      for (const asset of event.project.assets) push(asset, asset.createdAt);
    } else if (event.type === "asset.updated") {
      push(event.asset, event.at);
    }
  }

  const out = new Map<string, SheetCellVersion[]>();
  for (const [assetId, list] of versions) {
    const current = list.at(-1)?.asset.uri;
    const seen = new Set<string>([current ?? ""]);
    const older: SheetCellVersion[] = [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i]!;
      const uri = entry.asset.uri ?? "";
      if (seen.has(uri)) continue;
      seen.add(uri);
      older.push(entry);
    }
    if (older.length > 0) out.set(assetId, older);
  }
  return out;
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
  /** 有多少镜已经有能播的视频（ADR-0083） */
  videoCount: number;
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
    dur: shot.dur,
    locked: shot.locked,
    firstUri: shot.keyframeUri,
    lastUri: shot.lastKeyframeUri,
    hasFirst: shot.hasKeyframe,
    hasLast: shot.hasLastFrame,
    videoUri: shot.videoUri,
    hasVideo: shot.hasVideo,
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
    videoCount: cells.filter((cell) => cell.hasVideo).length,
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
  /** 已经出过首帧或尾帧：换人之后这两帧会挂「过期」（ADR-0081） */
  hasFrames: boolean;
  lines: ScriptLine[];
};

export type ScriptScene = {
  id: string;
  /** 场号，从 1 开始 */
  no: number;
  /** 显式场号（ADR-0080）：`2A`；空串表示按顺序 */
  code: string;
  /** 界面上写的场号：有显式场号用它，否则用顺序号 */
  label: string;
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
            hasFrames: Boolean(shot.keyframes.firstAssetId || shot.keyframes.lastAssetId),
            lines,
          };
        });

      return {
        id: scene.id,
        no: at + 1,
        code: scene.code,
        label: scene.code || String(at + 1),
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
  /** 出图之后改过名字 / 外形 / 不许变，或四格不是同一个模型（B1） */
  stale?: StaleMark;
};

/** 一张参考图：资产 id 与真图；示例素材没有 uri，界面画剪影（ADR-0079） */
export type CastReference = { assetId: string; uri?: string };

export type CastCharacterView = {
  id: string;
  name: string;
  appearance: string;
  mustNotChange: string[];
  panels: CastPanel[];
  /** 三视图之外的参考图：表情表、服装变体、手动挂进来的图（ADR-0079） */
  references: CastReference[];
  status: CastStatus;
  /** 有近景的角色必须四格齐全才能锁 */
  required: boolean;
  lockedAt?: string;
};

export type CastLocationView = {
  id: string;
  name: string;
  /** 模板：决定主镜画哪种剪影，也决定改名表单里选中哪一项（ADR-0059） */
  templateId?: string;
  /** 场景描述：这地方长什么样；空串表示还没写，主镜提示词里只有名字（ADR-0063） */
  description: string;
  art: SceneKind;
  status: CastStatus;
  required: boolean;
  masterAssetId?: string;
  /** 主镜的真图（data URI）；示例素材为空，界面画剪影 */
  masterUri?: string;
  /** 出图之后改过场景描述（ADR-0075），界面挂「过期」小签 */
  masterStale?: StaleMark;
  /** 场地几何（B13.1 / ADR-0126）：有它才能画俯视走位图、判精确越轴 */
  space?: LocationSpace;
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
  /** 全部参考图，第一张同时是 referenceAssetId（ADR-0079） */
  references: CastReference[];
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

/**
 * Project IR → 定妆台读模型：只给画面与状态，不给锁的规则（规则在 `@loomina/ir`）。
 * 给了日志就算出主镜的过期标记（ADR-0075）。
 */
export function toCastView(project: Project, events?: ProjectEvent[]): CastView {
  const readiness = castReadiness(project);
  const staleMaster = events ? staleMasters(events, project) : new Map<string, StaleMark>();
  const staleSheet = events ? staleSheetCells(events, project) : new Map<string, StaleMark>();
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
        panels: SHEET_ANGLES.map((angle) => {
          const assetId = character.sheet[angle];
          return {
            angle,
            label: SHEET_LABELS[angle],
            assetId,
            uri: assetById.get(assetId ?? "")?.uri,
            ...(assetId && staleSheet.has(assetId)
              ? { stale: staleSheet.get(assetId)! }
              : {}),
          };
        }),
        references: character.referenceImages.map((id) => ({
          assetId: id,
          uri: assetById.get(id)?.uri,
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
        templateId: template,
        description: location.description,
        art: (template && artByTemplate[template]) || "door",
        status: item.status,
        required: item.required,
        masterAssetId: location.masterShotId,
        masterUri: assetById.get(location.masterShotId ?? "")?.uri,
        masterStale: staleMaster.get(location.id),
        space: location.space,
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
        references: prop.referenceImages.map((id) => ({
          assetId: id,
          uri: assetById.get(id)?.uri,
        })),
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

/** 人物 / 道具 / 地点：文字类的「那一版长什么样」（ADR-0082） */
export type CastTextKind = "character" | "prop" | "location";

export type CastTextVersion = {
  at: string;
  name: string;
  /** 人物是外形描述，道具 / 地点是描述 */
  body: string;
};

export type CastTextHistory = {
  /** 建出来那一版；引导事件或 `*.added` 里取 */
  original: CastTextVersion;
  /** 从旧到新，一次改动一条；每条是改完之后完整的名字 + 描述 */
  edits: CastTextVersion[];
};

/**
 * 名字与描述被改过几次（ADR-0082）。
 *
 * 两类字段挤在同一条 `*.updated` 里，所以历史记的是「那一版长什么样」：
 * 逐条把 patch 叠到名字 / 描述上，存完整的两个值。最初那版从引导事件
 * 或 `*.added` 里取，与动作、场头同一套读法。模板、参考图这类改动不算一版。
 */
export function castTextHistory(
  events: ProjectEvent[],
  kind: CastTextKind,
  id: string,
): CastTextHistory | undefined {
  let original: CastTextVersion | undefined;
  const edits: CastTextVersion[] = [];

  for (const event of events) {
    const last = edits[edits.length - 1] ?? original;
    if (event.type === "project.created") {
      if (kind === "character") {
        const item = event.project.characters.find((entry) => entry.id === id);
        if (item) original = { at: event.at, name: item.name, body: item.appearance };
      } else if (kind === "prop") {
        const item = event.project.props.find((entry) => entry.id === id);
        if (item) original = { at: event.at, name: item.name, body: item.description };
      } else {
        const item = event.project.locations.find((entry) => entry.id === id);
        if (item) original = { at: event.at, name: item.name, body: item.description ?? "" };
      }
    } else if (event.type === "character.added" && kind === "character" && event.character.id === id) {
      original = { at: event.at, name: event.character.name, body: event.character.appearance };
    } else if (event.type === "prop.added" && kind === "prop" && event.prop.id === id) {
      original = { at: event.at, name: event.prop.name, body: event.prop.description };
    } else if (event.type === "location.added" && kind === "location" && event.location.id === id) {
      original = { at: event.at, name: event.location.name, body: event.location.description ?? "" };
    } else if (event.type === "character.updated" && kind === "character" && event.characterId === id) {
      const patch = event.patch;
      if (patch.name === undefined && patch.appearance === undefined) continue;
      edits.push({
        at: event.at,
        name: patch.name ?? last?.name ?? "",
        body: patch.appearance ?? last?.body ?? "",
      });
    } else if (event.type === "prop.updated" && kind === "prop" && event.propId === id) {
      const patch = event.patch;
      if (patch.name === undefined && patch.description === undefined) continue;
      edits.push({
        at: event.at,
        name: patch.name ?? last?.name ?? "",
        body: patch.description ?? last?.body ?? "",
      });
    } else if (event.type === "location.updated" && kind === "location" && event.locationId === id) {
      const patch = event.patch;
      if (patch.name === undefined && patch.description === undefined) continue;
      edits.push({
        at: event.at,
        name: patch.name ?? last?.name ?? "",
        body: patch.description ?? last?.body ?? "",
      });
    }
  }

  if (!original) return undefined;
  return { original, edits };
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
      `第 ${scene.label} 场 · ${sceneHead(scene)} · ${scene.place}（${scene.dur.toFixed(1)}s · ${scene.shots.length} 镜）`,
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
