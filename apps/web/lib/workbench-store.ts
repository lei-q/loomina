"use client";

import {
  applyEvent,
  castReadiness,
  BlockingSchema,
  blockingProblem,
  PerformanceSpecSchema,
  placementProblem,
  rebuild,
  REFERENCE_IMAGES_MAX,
  SHEET_ANGLES,
  shotAnchors,
  StagingMarkSchema,
  VOICE_PROFILE_MAX,
  type ApprovalTargetType,
  type Asset,
  type BeatKind,
  type Character,
  type GateStage,
  type Location,
  type MusicCue,
  type Blocking,
  type CameraPlacement,
  type PerformanceSpec,
  type Project,
  type Prop,
  type ProjectEvent,
  type PublishPackage,
  type Scene,
  type SheetView,
  type Shot,
  type ShotPurpose,
  type StagingMark,
  type StoryArc,
  type StoryRelationship,
  type TimelineItem,
} from "@loomina/ir";
import {
  parseInstruction,
  projectFromStoryDraft,
  mergeTemplateSpace,
  sceneTemplateById,
  shotMaterial,
  templateSpace,
  type Frame,
  type StoryDraft,
} from "@loomina/pipeline";
import { create } from "zustand";
import { diffEvents, getEventLog, migrateLog } from "@/lib/event-log";
import { estimateDialogueMs } from "@/lib/dialogue";
import { autoCut, timelineEquals } from "@/lib/edit";
import { buildHistory, historyPosition, nextUndo } from "@/lib/history";
import { claimWriter } from "@/lib/writer-lock";
import {
  latestTake,
  removalAlive,
  removalTargetOf,
  removedLines,
  shotLabel,
  shotSpendOf,
  spendOf,
  toStageView,
  undoableRemoval,
  type RemovalKind,
} from "@/lib/read-model";
import { persistAsset } from "@/lib/asset-client";
import { inlineBytesOf, inventoryOf, type AssetInventory } from "@/lib/asset-inventory";
import { isStoredAssetUri } from "@/lib/asset-uri";
import { getModelChoice } from "@/lib/model-choice";
import { sampleProject } from "@/lib/sample-project";
import { stageMetaOf, stageSignature } from "@/lib/stage-flow";
import {
  stageLockOf,
  stageLockViolation,
  type StageLock,
  type WorkbenchMode,
} from "@/lib/stage-lock";

/** 工作台模式存在这里：跨页面、跨刷新都记得（F8） */
const MODE_KEY = "loomina.mode";

function storedMode(): WorkbenchMode {
  if (typeof window === "undefined") return "guided";
  try {
    return window.localStorage.getItem(MODE_KEY) === "free" ? "free" : "guided";
  } catch {
    return "guided";
  }
}

function persistMode(mode: WorkbenchMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // 隐私模式写不进就不记：这次切换照常生效
  }
}

export type Decision = "approved" | "rejected";

/** 故事层可改的字段（A16）；与 `story.updated` 的 patch 同一形状 */
export type StoryPatch = Extract<ProjectEvent, { type: "story.updated" }>["patch"];

/**
 * B6: 视频失败重试。只重试服务端明确说「没在跑、重交安全」的失败；
 * 路由决定 retryable，客户端不做更聪明的猜测。
 * 重试上限由项目设置（H10 的 maxAttemptsPerShot），这里只放每次之间的等待。
 */
const VIDEO_RETRY_DELAYS_MS = [1200, 3000];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clipReason(reason: string): string {
  return reason.length > 240 ? `${reason.slice(0, 240)}…` : reason;
}

/**
 * 每次操作一个时间戳，并且严格递增。
 *
 * 历史按「同一时间戳」把一次操作的几条事件归成一组，撤销时整组退：
 * 删一场会写「逐镜删除 + 删场」，只退最后一条会留下半场空镜头。
 * 同一毫秒里连点两次（测试里尤其常见）会被误认成一组，所以这里往后挪 1ms。
 */
let lastStamp = 0;
function stamp(): string {
  const now = Date.now();
  const next = now > lastStamp ? now : lastStamp + 1;
  lastStamp = next;
  return new Date(next).toISOString();
}

/** 正在生成哪一张：定妆台的三类资产共用一条进度记录（视频按 `${shotId}:video` 记）。 */
export type GenerateJob =
  | { kind: "sheet"; angle: SheetView }
  | { kind: "master" }
  | { kind: "prop" }
  | { kind: "keyframe"; frame: Frame }
  | { kind: "video"; attempt?: number }
  | { kind: "voice" }
  | { kind: "asr" };

/**
 * 审片台的本地状态（ADR-0027）。
 *
 * - `events` 是事实，`project` 是它跑出来的结果，两者一起持有只是为了少算；
 * - 选格子不发事件，只有留用 / 淘汰才写一条 `take.updated`；
 * - 日志落在浏览器本地（IndexedDB，ADR-0034），刷新不会把花过钱的图丢掉。
 */
type WorkbenchState = {
  project: Project;
  events: ProjectEvent[];
  currentShotId: string;
  /** 正在生成哪一张：人物 / 场景 / 道具的 id → 任务。出图是分钟级，界面要如实显示进度 */
  jobs: Record<string, GenerateJob | undefined>;
  castError?: string;
  /** 历史抽屉的一句话：刚撤销了什么 / 回滚到了哪一步（F2 / ADR-0109） */
  historyNotice?: string;
  /** 阶段式 / 自由工作台（F8）：存在 localStorage，跨页面生效 */
  mode: WorkbenchMode;
  /** 刚刚被阶段硬锁拦下的那句话（F8）：写一次就弹一次 */
  lockedNotice?: string;
  /** 本地写入失败（配额、隐私模式）：不能让用户以为已经存住了 */
  storageError?: string;
  /** 另一个标签页在编辑：这里只读，改了也存不下 */
  readOnly?: boolean;
  /**
   * 刚做完的一次换人（ADR-0081）：只留最近一条，供「撤销」写回交换之前的样子。
   * 只在内存里，刷新就没了——撤销是"刚点错了"，不是历史功能。
   */
  lastSwap?: {
    shotId: string;
    fromId: string;
    toId: string;
    /** 交换之前的出场顺序，撤销时整组写回 */
    prevCharacterIds: string[];
    /** 这次换人顺手改过说话人的台词（仍以 toId 说话才撤得回） */
    lineIds: string[];
  };
  /** 当前出图模型的单价（元 / 张）。由服务端价目接口给，不知道就不拦（ADR-0035） */
  imageCny?: number;
  /** 当前出视频模型的单价（元 / 秒）。同上：不知道就不拦（ADR-0083） */
  videoCnyPerSecond?: number;
  /**
   * 配音模型（ADR-0085）：服务端配了 TTS_MODEL 才给 model；
   * 没配时这里就是空对象，界面如实说「还没配配音模型」。
   */
  voiceInfo?: { model?: string; voice?: string };
  /**
   * 识别模型（ADR-0087）：服务端配了 ASR_MODEL 才给 model；
   * 没配时这里是空对象，声音页如实说「还没配识别模型」。
   */
  asrInfo?: { model?: string };
  /** 刚识别出来的一句：只留最近一条，等用户决定用不用 */
  asrResult?: {
    lineId: string;
    text: string;
    model: string;
    segments: { text: string; startMs: number; endMs: number }[];
    createdAt: string;
  };
  /** 成片页的错误：初剪没得剪、换 take 不合规，都写在这里（ADR-0086） */
  editError?: string;
  /** 登记配音模型：声音页进页面时问一次服务端 */
  setVoiceInfo: (info: { model?: string; voice?: string }) => void;
  /** 登记识别模型：声音页进页面时问一次服务端 */
  setAsrInfo: (info: { model?: string }) => void;
  /** 登记价目：定妆台进页面时问一次服务端 */
  setImagePrice: (price: { model: string; cny?: number }) => void;
  setVideoPrice: (price: { model: string; cnyPerSecond?: number }) => void;
  /** 改预算上限：写一条 `project.updated`，预算改了要留痕 */
  setBudget: (cny: number) => void;
  /** 改这一镜的金额上限（H10）：写一条 `shot.updated`；空值表示取消单镜上限 */
  setShotBudget: (shotId: string, cny: number | undefined) => boolean;
  /** 改单镜自动重试上限（H10）：含第一次，1–5；写一条 `project.updated` */
  setRetryLimit: (attempts: number) => void;
  /** 改超预算后的处置（H10）：block 阻断，keep 保留现有结果不再调用生成 */
  setOnBudgetExceed: (mode: "block" | "keep") => void;
  /**
   * 记一条发布记录（G1）：把平台、档位与成片文件信息追加进 `publishPackages`。
   * 只记元数据，不存视频二进制。
   */
  recordPublish: (input: {
    platform: string;
    quality?: "draft" | "final";
    fileName?: string;
    bytes?: number;
    videoAssetId?: string;
  }) => boolean;
  /**
   * 确认一个阶段（F8 / F9）：按当前内容算签名，写一条 `gate.confirmed`。
   * 已确认的阶段再确认一次就是更新签名，不新增第二条记录。
   */
  /** 确认阶段闸门；`override` 用于带条件确认（A12：明知覆盖率不满仍然确认） */
  confirmGate: (stage: GateStage, note?: string, override?: boolean) => boolean;
  /** 回退阶段确认：写一条 `gate.reopened`，删除这一阶段的记录 */
  reopenGate: (stage: GateStage) => boolean;
  /** 切工作台模式（F8）：阶段式会锁住已确认阶段，自由工作台全部展开 */
  setMode: (mode: WorkbenchMode) => void;
  /** 收起「已确认，先回退再改」那条提示 */
  dismissLockNotice: () => void;
  /** 从本地日志恢复；已经恢复过就什么都不做 */
  hydrate: () => Promise<void>;
  select: (shotId: string) => void;
  /** 锁 / 解锁一镜：留用过的镜头才能锁；读写都留痕（ADR-0041） */
  setShotLock: (shotId: string, locked: boolean) => void;
  /** 标这一镜的节拍与镜头目的（A11 / A12）：一条 `shot.updated`（ADR-0096） */
  setShotPlan: (
    shotId: string,
    patch: { beat?: BeatKind; purpose?: ShotPurpose },
  ) => boolean;
  /**
   * 写这一镜的表演设计（B16 / B17）：一条 `shot.updated { performance }`。
   * 传 `undefined` 表示清空；结构不合法或视线指向不存在的对象时不写。
   */
  setShotPerformance: (shotId: string, performance: PerformanceSpec | undefined) => boolean;
  /** 写这一镜的镜头内调度（B17）：一条 `shot.updated { staging }` */
  setShotStaging: (shotId: string, staging: StagingMark[]) => boolean;
  setShotBlocking: (
    shotId: string,
    blocking: Blocking,
    placement?: CameraPlacement,
  ) => boolean;
  /** 这一镜里谁出场：一条 `shot.updated { characterIds }`（ADR-0065） */
  toggleShotCharacter: (shotId: string, characterId: string) => boolean;
  /** 道具出场：点一下把这件道具加进或移出这一镜（ADR-0066） */
  toggleShotProp: (shotId: string, propId: string) => boolean;
  /** 挪出场顺序：-1 往前、1 往后；顺序就是提示词里的顺序（ADR-0077） */
  moveShotCharacter: (shotId: string, characterId: string, delta: -1 | 1) => boolean;
  moveShotProp: (shotId: string, propId: string, delta: -1 | 1) => boolean;
  /**
   * 这一镜里换人：同一条动作里把他从出场里换成另一个人，
   * 这一镜里他说的台词一起换过去（ADR-0070）
   */
  swapShotCharacter: (shotId: string, fromId: string, toId: string) => boolean;
  /** 撤销刚做完的那次换人：出场顺序与说话人一起写回（ADR-0081） */
  undoSwap: () => boolean;
  /** 一步留用并锁定：写一条 take.updated + 一条 shot.updated（ADR-0041 附记） */
  approveAndLock: (shotId: string) => void;
  decide: (status: Decision) => void;
  /**
   * 删一拍 take（B5）：写一条 `take.removed`，连带摘掉它在时间线上的片段。
   * 资产不动——资产可能还被别处引用；回滚能把这一拍找回来。
   */
  removeTake: (takeId: string) => boolean;
  /** 定妆闸门：锁定 / 解锁一个角色、场景或道具 */
  lockCast: (targetType: ApprovalTargetType, targetId: string) => void;
  unlockCast: (targetType: ApprovalTargetType, targetId: string) => void;
  /** 逐格生成三视图；每落一张写一条 `asset.updated` */
  generateSheet: (characterId: string) => Promise<void>;
  /** 生成场景主镜 */
  generateMaster: (locationId: string) => Promise<void>;
  /** 生成道具参考图 */
  generateProp: (propId: string) => Promise<void>;
  /** 给当前镜生成首帧或尾帧；落一张图 + 一条 shot.updated（ADR-0037 / 0038） */
  generateKeyframe: (shotId: string, frame?: Frame) => Promise<boolean>;
  /**
   * 首帧 → 视频：提交、等出片，落一条 `asset.updated` + 一条 `take.added`（ADR-0083）。
   * 失败如实写进 `castError`，界面还有「贴视频地址导入」兜底。
   */
  generateVideo: (shotId: string) => Promise<boolean>;
  /**
   * 贴一条视频地址当 take（ADR-0083）：供应商配额不通时的兜底，
   * 也让已经有片子的人能把 take 流程走完。收 http(s):// 或 data:video/。
   */
  attachVideo: (shotId: string, uri: string) => boolean;
  /**
   * 给一句台词出声（ADR-0085）：落一条 `asset.updated` + 一条 `dialogue.updated`。
   * 没配配音模型时服务端会明说；界面还有「贴一条音轨」兜底。
   */
  generateVoice: (lineId: string) => Promise<boolean>;
  /**
   * 贴一条音轨当这一句的配音（ADR-0085）：收 http(s):// 或 data:audio/。
   * 供应商配额不通、或已经用自己的录音时，都走这条路。
   */
  attachVoice: (lineId: string, uri: string) => boolean;
  /**
   * 量出音轨真实时长后校正台词与镜头（准则 P5）：一条 `dialogue.updated`
   * + 一条 `shot.updated`，音轨资产上补记 `durationMs`。
   */
  fitLineToAudio: (lineId: string, durationMs: number) => boolean;
  /**
   * 识别这一句的音轨（ADR-0087）：结果先放进 `asrResult` 让人确认，
   * 不直接改台词。没配识别模型时服务端会明说。
   */
  transcribeLine: (lineId: string) => Promise<boolean>;
  /**
   * 用识别结果替换台词（ADR-0087）：一条 `dialogue.updated { text }`，
   * 时长不动——音轨才是时长的准，文字只是把它写下来。
   */
  applyAsrText: (lineId: string, text: string) => boolean;
  /** 不要这条识别结果：直接收起（ADR-0087） */
  dismissAsrResult: () => void;
  /** 给一个角色指定音色：一条 `character.updated`；空串表示用回默认音色（ADR-0085） */
  setCharacterVoice: (characterId: string, voice: string) => boolean;
  /**
   * 自动初剪（ADR-0086）：按剧本顺序、优先留用 take 生成整条时间线，
   * 写一条 `timeline.updated`。没有可用 take 的镜头跳过并报出来。
   */
  autoCutTimeline: () => boolean;
  /** 换某一镜用的 take：一条 `timeline.updated` 整条替换（ADR-0086） */
  setTimelineTake: (itemId: string, takeId: string) => boolean;
  /**
   * 从时间线删掉一段（E1）：后面的片段整体前移，保持首尾相接。
   * 只动时间线，不删 take——镜头还在，重新初剪能再排回来。
   */
  removeTimelineItem: (itemId: string) => boolean;
  /** 把一段往前 / 往后挪一位（E1）：与相邻段交换位置，起点重新排，不留空隙 */
  moveTimelineItem: (itemId: string, delta: -1 | 1) => boolean;
  /**
   * 加一条配乐床（C4）：音频文件先落成资产，再写一条 `timeline.music.updated`。
   * 必须给授权备注；没有备注的音乐不进项目。
   */
  addMusic: (input: {
    uri: string;
    mime: string;
    title: string;
    mood: string;
    durationMs: number;
    licenseRef: string;
  }) => boolean;
  /** 调配乐：增益 / ducking 深度 / 开关 / 情绪；写一条 `timeline.music.updated` */
  updateMusic: (
    patch: Partial<Pick<MusicCue, "gainDb" | "duckDb" | "ducking" | "mood">>,
  ) => boolean;
  /** 移掉配乐床：写一条空的 `timeline.music.updated`，资产留在项目里 */
  removeMusic: () => boolean;
  /** 批量补缺：按镜号顺序一帧一帧生成，跳过锁定，失败即停（ADR-0042 附记） */
  /**
   * 批量补帧（H21）：按镜号顺序补缺的帧，跳过锁定，失败即停。
   * 传 `only` 就只补这些镜头——分镜筛选到某一档时，「挑张补」补的是眼前这几格。
   */
  generateMissingFrames: (frame?: Frame, only?: string[]) => Promise<void>;
  /** 批量补帧的进度；`stop` 置上后当前这一张结束就停 */
  batch?: { frame: Frame; done: number; total: number; stop?: boolean };
  stopBatch: () => void;
  /** 一句话指令：查表翻成镜头补丁，写一条 shot.updated；没听懂返回 false（ADR-0039） */
  instruct: (text: string) => boolean;
  /**
   * 改写一条台词：写一条 `dialogue.updated`，时长按字数重估；
   * 所属镜头跟着挪，保持"镜头时长 ≈ 台词 + 余量"（ADR-0044）
   */
  editDialogue: (lineId: string, text: string) => boolean;
  /** 用回某一版：文本与该版当时的时长一起写回，仍是一次改写（ADR-0044 附记） */
  restoreDialogue: (lineId: string, text: string, durationMs: number) => boolean;
  /** 加一句台词：写一条 `dialogue.added`，镜头时长加这一句（ADR-0045） */
  addDialogue: (shotId: string, characterId: string, text: string) => boolean;
  /** 删一句台词：写一条 `dialogue.removed`，镜头时长减这一句（ADR-0045） */
  removeDialogue: (lineId: string) => boolean;
  /** 换说话人：写一条 `dialogue.speaker.updated`，文本与时长不动（ADR-0046） */
  changeSpeaker: (lineId: string, characterId: string) => boolean;
  /**
   * 手改一句的断句（D2）：`cues` 为 null 恢复自动断句。
   * 按整句覆盖——自动断句是派生的，只改一条会让其余边界漂。
   */
  editSubtitles: (lineId: string, cues: { text: string; durationMs: number }[] | null) => boolean;
  /** 调整台词顺序：写一条 `shot.updated` 换 dialogueIds 的顺序（ADR-0047） */
  moveDialogue: (lineId: string, direction: "up" | "down") => boolean;
  /** 改这一镜的动作：写一条 `shot.updated { description }`，时长与台词不动（ADR-0049） */
  editAction: (shotId: string, text: string) => boolean;
  /** 改场头：写一条 `scene.updated`，只收内 / 外景、日夜与地点（ADR-0050 / ADR-0056） */
  editScene: (
    sceneId: string,
    patch: Partial<Pick<Scene, "space" | "timeOfDay" | "locationId">>,
  ) => boolean;
  /**
   * 改场号：写一条 `scene.updated { code }`，1–4 位字母数字，
   * 空串表示回到按顺序编号；重复的场号拒绝（ADR-0080）
   */
  editSceneCode: (sceneId: string, rawCode: string) => boolean;
  /** 把台词顺序整组写回：一条 `shot.updated { dialogueIds }`（ADR-0053） */
  setDialogueOrder: (shotId: string, lineIds: string[]) => boolean;  /** 把一句台词挪到另一镜：两条 `shot.updated`，两镜时长各加减这一句（ADR-0054） */
  moveDialogueTo: (lineId: string, targetShotId: string) => boolean;
  /** 把一句删掉的台词放回它原来的镜头：`dialogue.added` + 镜头时长加回（ADR-0055） */
  restoreLine: (lineId: string) => boolean;
  /** 新建地点：一条 `location.added`（ADR-0059）；描述进主镜提示词（ADR-0063） */
  addLocation: (
    name: string,
    templateId?: string,
    description?: string,
  ) => string | undefined;
  /** 改地点名字 / 模板 / 描述 / 几何：一条 `location.updated`（ADR-0059 / ADR-0063 / ADR-0126） */
  editLocation: (
    locationId: string,
    patch: Partial<Pick<Location, "name" | "templateId" | "description" | "space">>,
  ) => boolean;
  /** 加一个人物：一条 `character.added`（ADR-0071） */
  addCharacter: (name: string, appearance?: string) => string | undefined;
  /** 改人物名字 / 外形描述：一条 `character.updated`（ADR-0071） */
  editCharacter: (
    characterId: string,
    patch: Partial<Pick<Character, "name" | "appearance">>,
  ) => boolean;
  /** 加一条「不许变」：一条 `character.updated`，清单整份写回（ADR-0074） */
  addMustNotChange: (characterId: string, text: string) => boolean;
  /** 划掉一条「不许变」：同上（ADR-0074） */
  removeMustNotChange: (characterId: string, text: string) => boolean;
  /** 挂一张参考图：贴地址，建资产，写进 referenceImages（ADR-0079） */
  addCharacterReference: (characterId: string, uri: string) => boolean;
  removeCharacterReference: (characterId: string, assetId: string) => boolean;
  addPropReference: (propId: string, uri: string) => boolean;
  removePropReference: (propId: string, assetId: string) => boolean;
  /** 加一件道具：一条 `prop.added`（ADR-0072） */
  addProp: (name: string, description?: string) => string | undefined;
  /** 改道具名字 / 描述：一条 `prop.updated`（ADR-0072） */
  editProp: (
    propId: string,
    patch: Partial<Pick<Prop, "name" | "description">>,
  ) => boolean;
  /** 删一个人物：还有镜头点着 / 台词属于他时拒绝（ADR-0073） */
  removeCharacter: (characterId: string) => boolean;
  /** 删一件道具：还有镜头用着它时拒绝（ADR-0073） */
  removeProp: (propId: string) => boolean;
  /** 从故事草稿开一个新项目：写一条新的 `project.created`，旧日志仍在本地（ADR-0088） */
  startProjectFromStory: (
    draft: StoryDraft,
    meta: { modelId: string; idea: string },
  ) => boolean;
  /**
   * 改故事层文字（A16）：一条 `story.updated`。
   * 只改传进来的字段；没改的字段与 `provenance` 都不动。
   */
  editStory: (patch: StoryPatch) => boolean;
  /** 改某个角色的一条弧光字段（A16）：整组弧光替换，只动这一条 */
  editArc: (characterId: string, patch: Partial<Omit<StoryArc, "characterId">>) => boolean;
  /** 改一对关系张力（A16）；`tension` 为空表示删掉这条关系 */
  editRelationship: (
    fromCharacterId: string,
    toCharacterId: string,
    tension: string,
  ) => boolean;
  /** 新建场次：一条 `scene.added`，加在末尾或指定场之后，沿用前一场的地点与日夜（ADR-0064 / 0068 / 0069） */
  addScene: (locationId?: string, afterSceneId?: string) => string | undefined;  /** 新建镜头：一条 `shot.added`，加在这一场末尾或指定镜之后（ADR-0064 / ADR-0068） */
  addShot: (sceneId: string, afterShotId?: string) => string | undefined;
  /** 删一镜：一条 `shot.removed`，台词 / take / 时间线项一并摘掉（ADR-0067） */
  removeShot: (shotId: string) => boolean;
  /** 删一场：先逐条删掉它的镜头，再一条 `scene.removed`（ADR-0067） */
  removeScene: (sceneId: string) => boolean;
  /** 调整场序：写一条 `scene.moved`，场号与镜号跟着重排（ADR-0060） */
  moveScene: (sceneId: string, direction: "up" | "down") => boolean;
  /** 把一场直接挪到第 N 位（从 0 数）：长距离换位不用连点（ADR-0060 附记） */
  moveSceneTo: (sceneId: string, toIndex: number) => boolean;
  /** 删一个地点；还有场次占着就先把它们搬到 `moveToId` 再删（ADR-0061 / ADR-0062） */
  removeLocation: (locationId: string, moveToId?: string) => boolean;
  /** 撤销最近一次删除：按前缀重放取回快照，再写补偿事件（ADR-0076） */
  undoLastRemoval: () => boolean;
  /** 回收站里恢复某一条删除：与撤销删除走同一条补偿逻辑（F2 / ADR-0109） */
  restoreRemovalAt: (index: number) => boolean;
  /** 多步撤销：退回上一步操作之前（F2 / ADR-0109），一次退一整组同毫秒事件 */
  undo: () => boolean;
  /** 版本回滚：把项目恢复到日志第 `toEventCount` 条之后的样子（F2 / ADR-0109） */
  restoreTo: (toEventCount: number, label?: string) => boolean;
  /** 划掉一条补充要求：同样写一条 shot.updated（ADR-0039 附记） */
  removeNote: (shotId: string, note: string) => void;
  /**
   * 把还在日志里的素材搬进本机资产库（H3 / ADR-0128）。
   *
   * 显式动作：一次几十兆的读写 + 几十条事件，自动跑会在作者没准备时卡住页面。
   * 每搬一个写一条 `asset.updated { uri }`；旧事件里的 data URI 不动。
   * 返回搬了几个、失败几个。
   */
  migrateAssets: () => Promise<{ moved: number; failed: number; bytes: number }>;
  /** 素材清点（H3）：几个在日志里、几个已进资产库、哪些没人引用 */
  assetInventory: () => AssetInventory;
  reset: () => void;
};

function bootstrap(project: Project): ProjectEvent[] {
  return [
    {
      type: "project.created",
      at: "2026-11-10T00:00:00+08:00",
      project,
    },
  ];
}

/** 新镜头的默认时长：没有台词时先给 3 秒，随后在分镜页改（ADR-0064） */
const NEW_SHOT_DURATION_MS = 3000;

/** 场景描述的上限：这句会整句进主镜提示词，长了会把画面指令挤掉（ADR-0063） */
const LOCATION_DESCRIPTION_MAX = 200;

/** 外形描述的上限：同样会整句进提示词（ADR-0071） */
const CHARACTER_APPEARANCE_MAX = 200;

/** 道具描述的上限：同样会整句进提示词（ADR-0072） */
const PROP_DESCRIPTION_MAX = 200;

/** 「不许变」单条上限：整句进提示词，太长会把镜头指令挤掉（ADR-0074） */
const MUST_NOT_CHANGE_MAX = 60;

/** 「不许变」条数上限：同上（ADR-0074） */
const MUST_NOT_CHANGE_COUNT_MAX = 20;

/** 手挂参考图的地址上限：data URI 可能很长，留到 400 KB（ADR-0079） */
const REFERENCE_URI_MAX = 400_000;

/** 手贴视频地址的上限：data:video 可能很长，留到 12 MB（ADR-0083） */
const VIDEO_URI_MAX = 12_000_000;

/** 手贴音轨的上限：一句台词撑不到这么大，8 MB 已经很多（ADR-0085） */
const VOICE_URI_MAX = 8_000_000;

/**
 * 手挂的参考图：现在没有上传通道，先收一个图床 / data URI 地址（ADR-0079）。
 * 返回 Asset 或一句人话；id 在本项目里生成。
 */
function makeReferenceAsset(
  rawUri: string,
  assets: Asset[],
  at: string,
): { asset?: Asset; error?: string } {
  const uri = rawUri.trim();
  if (!uri) return { error: "先贴一张图的地址。" };
  if (!/^(https?:\/\/|data:image\/)/i.test(uri)) {
    return { error: "参考图要先有地址：http(s):// 或 data:image/ 开头。" };
  }
  if (uri.length > REFERENCE_URI_MAX) return { error: "地址太长了：400 KB 以内。" };
  let id = `a-ref-${Date.now().toString(36)}`;
  while (assets.some((asset) => asset.id === id)) id += "x";
  const mime = /^data:(image\/[a-z0-9.+-]+)[;,]/i.exec(uri)?.[1];
  return {
    asset: {
      id,
      kind: "image",
      source: "upload",
      uri,
      ...(mime ? { mime } : {}),
      createdAt: at,
    },
  };
}

const initialEvents = bootstrap(sampleProject);
const initialView = toStageView(sampleProject);
const initialShotId =
  initialView.shots[initialView.current]?.id ?? sampleProject.shots[0]?.id ?? "";

/**
 * 按顺序重排起点，保持首尾相接（E1）。
 *
 * 渲染清单要求「片段累计时长 = 全长」，留空隙会让导出直接失败；
 * 所以时间线上的一切改动都走这里，起点永远由顺序推出来，不由用户拖。
 */
function restack(items: TimelineItem[]): TimelineItem[] {
  let cursor = 0;
  return items.map((item) => {
    const next = { ...item, startMs: cursor };
    cursor += item.durationMs;
    return next;
  });
}

/** 当前镜之后第一格还没定的；到末尾就回到开头找；全定完了就原地不动。 */
function nextOpenShotId(project: Project, fromId: string): string {  const { shots } = toStageView(project);
  const from = shots.findIndex((shot) => shot.id === fromId);
  if (from < 0) return fromId;

  const ordered = [...shots.slice(from + 1), ...shots.slice(0, from + 1)];
  return ordered.find((shot) => shot.state === "open")?.id ?? fromId;
}

function isLocked(
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

type Store = {
  get: () => WorkbenchState;
  set: (partial: Partial<WorkbenchState>) => void;
};

/**
 * 阶段硬锁（F8）的第二道闸：花钱 / 调接口之前先问一句。
 *
 * 写状态的闸口能拦住「改了没生效」，但生成是先请求、后落事件——
 * 等快照写回才拦就白花了钱。所以每个会花钱的动作开头先过这里。
 */
function lockedStage(
  { get, set }: Store,
  stage: GateStage,
): boolean {
  const { project, mode } = get();
  const lock = stageLockOf(project, stage, mode);
  if (!lock) return false;
  set({ lockedNotice: lock.message });
  return true;
}

/**
 * 出一张图，落一条 `asset.updated`。
 *
 * 失败写一句人话并返回 false：批量生成据此停下，不把后面的也浪费掉。
 */
async function generateOne(
  { get, set }: Store,
  input: {
    /** 进度记在谁头上：角色 / 场景 / 道具的 id */
    key: string;
    /** 出错时点名的对象 */
    label: string;
    assetId: string;
    job: GenerateJob;
    body: Record<string, unknown>;
    /** 这一张属于哪一镜：单镜上限按它算（H10） */
    shotId?: string;
    /** 这张图还要改项目结构时，在这里追加事件（例如首帧挂回镜头） */
    after?: (assetId: string, at: string) => ProjectEvent | undefined;
    /** 溯源里记下这一张引用了哪些已锁定的锚点 */
    referenceAssetIds?: string[];
  },
): Promise<boolean> {
  const setJob = (value: GenerateJob | undefined) =>
    set({ jobs: { ...get().jobs, [input.key]: value } });

  // 提交前拦：知道单价、且这一张会超预算，就不发请求（准则 P14 / H10）。
  // 不知道单价时不拦——报不出价的时候宁可如实说，也不假拦。
  const unit = get().imageCny;
  if (unit !== undefined) {
    const project = get().project;
    const { spent } = spendOf(project);
    const budget = project.budgetCny;
    const keep = project.onBudgetExceed === "keep";
    if (spent + unit > budget) {
      set({
        castError: keep
          ? `「${input.label}」超出预算：这一笔 ¥${unit.toFixed(2)}，已花 ¥${spent.toFixed(2)} / 预算 ¥${budget.toFixed(2)}。按「超预算保留现有结果」，这次不重新生成，这一镜沿用手上已有的画面。`
          : `「${input.label}」超出预算：这一笔 ¥${unit.toFixed(2)}，已花 ¥${spent.toFixed(2)} / 预算 ¥${budget.toFixed(2)}。先提高预算再生成。`,
      });
      return false;
    }
    // 单镜上限（H10）：先到的那条拦
    const shot = input.shotId
      ? project.shots.find((item) => item.id === input.shotId)
      : undefined;
    if (shot?.budgetCny !== undefined) {
      const shotSpend = shotSpendOf(project, shot.id);
      if (shotSpend.spent + unit > shot.budgetCny) {
        set({
          castError: keep
            ? `「${input.label}」超出这一镜的上限：这一笔 ¥${unit.toFixed(2)}，这一镜已花 ¥${shotSpend.spent.toFixed(2)} / 上限 ¥${shot.budgetCny.toFixed(2)}。按「超预算保留现有结果」，这次不重新生成，这一镜沿用手上已有的画面。`
            : `「${input.label}」超出这一镜的上限：这一笔 ¥${unit.toFixed(2)}，这一镜已花 ¥${shotSpend.spent.toFixed(2)} / 上限 ¥${shot.budgetCny.toFixed(2)}。先在分镜页提高单镜上限，或改项目预算。`,
        });
        return false;
      }
    }
  }

  setJob(input.job);
  try {
    const response = await fetch("/api/asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input.body,
        modelId: getModelChoice("image"),
      }),
    });
    const payload = (await response.json()) as {
      uri?: string;
      model?: string;
      prompt?: string;
      cny?: number;
      error?: string;
    };
    if (!response.ok || !payload.uri) {
      throw new Error(payload.error ?? `生成失败（${response.status}）`);
    }

    const at = stamp();
    // 大图先进本机资产库（H3 / ADR-0128）：事件里只留地址，日志不背 base64
    const uri = await persistAsset(payload.uri);
    const event: ProjectEvent = {
      type: "asset.updated",
      at,
      asset: {
        id: input.assetId,
        kind: "image",
        source: "generated",
        uri,
        mime: "image/png",
        // 价目表给了单价就记上；没给就让 costCny 缺省，界面如实说"无价目"
        costCny: typeof payload.cny === "number" ? payload.cny : undefined,
        provenance: {
          modelId: payload.model ?? "unknown",
          prompt: payload.prompt,
          referenceAssetIds: input.referenceAssetIds ?? [],
          createdAt: at,
        },
        createdAt: at,
      },
    };
    const extra = input.after?.(input.assetId, at);
    const appended = extra ? [event, extra] : [event];
    let project = get().project;
    for (const item of appended) project = applyEvent(project, item);
    set({ project, events: [...get().events, ...appended] });
    setJob(undefined);
    return true;
  } catch (error) {
    setJob(undefined);
    set({
      castError:
        error instanceof Error ? `「${input.label}」${error.message}` : "生成失败",
    });
    return false;
  }
}

/** hydrate 只跑一次；ready 之前不写存储，免得把已存的项目盖成示例项目。 */
let hydrated = false;
let ready = false;

function storageMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `本地保存失败：${detail.slice(0, 100)}`;
}

/** 仅供测试：把 hydrate / ready 的门闩复位，让每个用例都能重新恢复一次。 */
export function resetPersistenceForTests(): void {
  hydrated = false;
  ready = false;
}

function firstOpenShotId(project: Project): string {
  const { shots } = toStageView(project);
  return (shots.find((shot) => shot.state === "open") ?? shots[0])?.id ?? "";
}

/**
 * 把一次删除补回来：用「删除之前」的那一份项目写补偿事件（ADR-0076）。
 *
 * 撤销最近一次删除（页头那个按钮）与回收站里恢复早先的删除，
 * 走的是同一条逻辑——区别只在挑哪一条删除事件。
 */
function removalUndoEvents(
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

/**
 * 台词落库（ADR-0044）：一条 `dialogue.updated`，时长变了再一条 `shot.updated`
 * 让所属镜头挪同样的量（不动别人写进去的表演余量）。
 *
 * `durationMs` 不给就按字数估；给了就是还原某一版当时的时长。
 * `textOnly` 只比文本：手动改写时历史时长未必是按估算口径来的，不能顺手改掉。
 */
function commitDialogue(
  { get, set }: Store,
  input: {
    lineId: string;
    text: string;
    durationMs?: number;
    unchanged: string;
    textOnly?: boolean;
  },
): boolean {
  if (get().readOnly) return false;
  const text = input.text.replace(/\s+$/, "");
  if (text.length === 0) {
    set({ castError: "台词不能是空的。" });
    return false;
  }
  const { project, events } = get();
  const line = project.dialogue.find((item) => item.id === input.lineId);
  if (!line) return false;
  const shot = project.shots.find((item) => item.dialogueIds.includes(input.lineId));
  if (shot?.locked) {
    set({ castError: "这一镜已锁定：要改台词先解锁。" });
    return false;
  }

  const durationMs = input.durationMs ?? estimateDialogueMs(text);
  const unchanged =
    text === line.text &&
    (input.textOnly === true || durationMs === line.durationMs);
  if (unchanged) {
    set({ castError: input.unchanged });
    return false;
  }

  const at = stamp();
  const next: ProjectEvent[] = [
    { type: "dialogue.updated", at, lineId: input.lineId, patch: { text, durationMs } },
  ];
  const delta = durationMs - line.durationMs;
  if (shot && delta !== 0) {
    next.push({
      type: "shot.updated",
      at,
      shotId: shot.id,
      patch: { durationMs: Math.max(500, shot.durationMs + delta) },
    });
  }

  set({
    project: next.reduce(applyEvent, project),
    events: [...events, ...next],
    castError: undefined,
  });
  return true;
}

/** 这次写入是「在日志末尾接一段」吗？加载 / 重来会整体换掉日志，不算编辑 */
function appendOnly(before: ProjectEvent[], after: ProjectEvent[]): boolean {
  if (after.length <= before.length) return false;
  for (let index = 0; index < before.length; index += 1) {
    if (after[index] !== before[index]) return false;
  }
  return true;
}

export const useWorkbench = create<WorkbenchState>()((rawSet, get) => {
  /**
   * 阶段硬锁（F8）的唯一闸口：所有写项目的改动都从这里过。
   * 只拦「在日志末尾接事件」的编辑；加载、重来、回滚不动。
   */
  const set: typeof rawSet = ((partial: unknown, replace?: unknown) => {
    const state = get();
    const next = (
      typeof partial === "function"
        ? (partial as (current: WorkbenchState) => unknown)(state)
        : partial
    ) as Partial<WorkbenchState> | null;
    if (next && typeof next === "object") {
      const events = next.events;
      const project = next.project;
      if (events && project && appendOnly(state.events, events)) {
        const lock = stageLockViolation(
          state.project,
          project,
          events.slice(state.events.length),
          state.mode,
        );
        if (lock) {
          (rawSet as (value: Partial<WorkbenchState>) => void)({ lockedNotice: lock.message });
          return;
        }
      }
    }
    (rawSet as (value: unknown, replace?: unknown) => void)(partial, replace);
  }) as typeof rawSet;

  return ({

  project: sampleProject,
  events: initialEvents,
  currentShotId: initialShotId,
  jobs: {},
  mode: storedMode(),

  hydrate: async () => {
    if (hydrated) return;
    hydrated = true;
    const log = getEventLog();

    try {
      const stored = migrateLog(await log.load());

      // 另一个标签页正在写：读得到它的进度，但这一页不改、不存
      if (!(await claimWriter())) {
        if (stored) {
          const project = rebuild(stored);
          set({ project, events: stored, currentShotId: firstOpenShotId(project) });
        }
        set({ readOnly: true });
        return;
      }

      if (stored) {
        const project = rebuild(stored);
        set({ project, events: stored, currentShotId: firstOpenShotId(project) });
        ready = true;
        return;
      }
      // 第一次打开：把示例项目的引导事件写进去，之后就都有据可查
      await log.replace(get().events);
      set({ storageError: undefined });
    } catch (error) {
      set({ storageError: storageMessage(error) });
    }
    ready = true;
  },

  setImagePrice: ({ cny }) => {
    set({ imageCny: cny });
  },

  setVideoPrice: ({ cnyPerSecond }) => {
    set({ videoCnyPerSecond: cnyPerSecond });
  },

  setBudget: (cny) => {
    if (get().readOnly) return;
    if (!(cny > 0) || !Number.isFinite(cny)) return;
    const { project, events } = get();
    const budgetCny = Math.round(cny * 100) / 100;
    if (budgetCny === project.budgetCny) return;

    const event: ProjectEvent = {
      type: "project.updated",
      at: stamp(),
      budgetCny,
    };
    set({ project: applyEvent(project, event), events: [...events, event] });
  },

  setShotBudget: (shotId, cny) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) return false;
    if (cny !== undefined && (!Number.isFinite(cny) || cny <= 0)) {
      set({ castError: "单镜上限要大于 0 元；想取消上限就先清空这一栏。" });
      return false;
    }
    const budgetCny = cny === undefined ? undefined : Math.round(cny * 100) / 100;
    if (budgetCny === shot.budgetCny) return true;

    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId: shot.id,
      // undefined 在落盘时会消失，回读就是「没有上限」，与清空同义
      patch: { budgetCny },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  setRetryLimit: (attempts) => {
    if (get().readOnly) return;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) return;
    const { project, events } = get();
    if (attempts === project.maxAttemptsPerShot) return;

    const event: ProjectEvent = {
      type: "project.updated",
      at: stamp(),
      maxAttemptsPerShot: attempts,
    };
    set({ project: applyEvent(project, event), events: [...events, event] });
  },

  setOnBudgetExceed: (mode) => {
    if (get().readOnly) return;
    const { project, events } = get();
    if (mode === project.onBudgetExceed) return;

    const event: ProjectEvent = {
      type: "project.updated",
      at: stamp(),
      onBudgetExceed: mode,
    };
    set({ project: applyEvent(project, event), events: [...events, event] });
  },

  recordPublish: (input) => {
    if (get().readOnly) return false;
    const platform = input.platform.trim();
    if (!platform) return false;
    if (input.bytes !== undefined && (!Number.isInteger(input.bytes) || input.bytes < 0)) {
      return false;
    }
    const { project, events } = get();
    const recordedAt = stamp();
    // id 只要在这一份项目里唯一即可：时间 + 随机后缀，便于日志里认人
    const id = `pub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const pack: PublishPackage = {
      id,
      platform,
      ...(input.quality ? { quality: input.quality } : {}),
      ...(input.fileName ? { fileName: input.fileName } : {}),
      ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
      ...(input.videoAssetId ? { videoAssetId: input.videoAssetId } : {}),
      recordedAt,
      aiLabel: { explicit: true, implicit: true, standard: "AI生成" },
    };

    const event: ProjectEvent = { type: "publish.recorded", at: recordedAt, package: pack };
    set({ project: applyEvent(project, event), events: [...events, event] });
    return true;
  },

  confirmGate: (stage, note, override) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const meta = stageMetaOf(stage);
    const event: ProjectEvent = {
      type: "gate.confirmed",
      at: stamp(),
      stage,
      signature: stageSignature(project, stage),
      note: (note ?? "").trim().slice(0, 240),
      ...(override ? { override: true } : {}),
    };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        castError: undefined,
      });
      return true;
    } catch (error) {
      set({
        castError: error instanceof Error ? error.message : `「${meta.name}」没确认上。`,
      });
      return false;
    }
  },

  reopenGate: (stage) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    if (!project.gates.some((gate) => gate.stage === stage)) return false;
    const event: ProjectEvent = {
      type: "gate.reopened",
      at: stamp(),
      stage,
    };
    // 回退就是「解锁」：被拦下的那条提示也跟着收起来
    set({ project: applyEvent(project, event), events: [...events, event], lockedNotice: undefined });
    return true;
  },

  setMode: (mode) => {
    persistMode(mode);
    set({ mode, lockedNotice: undefined });
  },

  dismissLockNotice: () => {
    set({ lockedNotice: undefined });
  },

  select: (shotId) => {
    if (shotId === get().currentShotId) return;
    set({ currentShotId: shotId });
  },

  decide: (status) => {
    if (get().readOnly) return;
    const { project, events, currentShotId } = get();
    const shot = project.shots.find((item) => item.id === currentShotId);
    if (!shot || shot.locked) return; // 锁定的镜头不在这里改

    const take = latestTake(shot, new Map(project.takes.map((item) => [item.id, item])));
    if (!take || take.status === status) return; // 没有可改的版本，或状态没变

    const event: ProjectEvent = {
      type: "take.updated",
      at: stamp(),
      takeId: take.id,
      patch: { status },
    };
    const next = applyEvent(project, event);

    set({
      project: next,
      events: [...events, event],
      currentShotId: nextOpenShotId(next, currentShotId),
    });
  },

  removeTake: (takeId) => {
    if (get().readOnly) return false;
    const { project, events, currentShotId } = get();
    const take = project.takes.find((item) => item.id === takeId);
    if (!take) return false;
    const shot = project.shots.find((item) => item.id === take.shotId);
    // 锁定的镜头不动：与留用 / 淘汰一致，先解锁再说
    if (!shot || shot.locked) return false;

    const event: ProjectEvent = { type: "take.removed", at: stamp(), takeId };
    const next = applyEvent(project, event);
    set({
      project: next,
      events: [...events, event],
      castError: undefined,
      currentShotId,
    });
    return true;
  },

  setShotLock: (shotId, locked) => {
    if (get().readOnly) return;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot || Boolean(shot.locked) === locked) return;
    // 锁定是"这一镜定了"：没有留用过的 take 就不许锁（ADR-0041）
    if (locked) {
      const take = latestTake(shot, new Map(project.takes.map((item) => [item.id, item])));
      if (!take || take.status !== "approved") {
        set({ castError: "先留用一条 take，再锁定这一镜。" });
        return;
      }
    }

    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId: shot.id,
      patch: { locked },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
  },

  setShotPlan: (shotId, patch) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再改节拍或镜头目的。" });
      return false;
    }
    if (!patch.beat && !patch.purpose) return false;
    // 只比较真的给了的字段：只改目的时，节拍的 undefined 不代表要抹掉
    const changed: { beat?: BeatKind; purpose?: ShotPurpose } = {};
    if (patch.beat !== undefined && patch.beat !== shot.beat) changed.beat = patch.beat;
    if (patch.purpose !== undefined && patch.purpose !== shot.purpose) {
      changed.purpose = patch.purpose;
    }
    if (!changed.beat && !changed.purpose) return false;

    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId: shot.id,
      patch: changed,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  setShotPerformance: (shotId, performance) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再改表演设计。" });
      return false;
    }

    let next: PerformanceSpec | undefined;
    if (performance !== undefined) {
      const parsed = PerformanceSpecSchema.safeParse(performance);
      if (!parsed.success) {
        set({
          castError: `表演设计不合法：${parsed.error.issues[0]?.message ?? "未知原因"}`,
        });
        return false;
      }
      next = parsed.data;
      const gaze = next.gaze;
      if (gaze.target === "character" && !project.characters.some((item) => item.id === gaze.targetId)) {
        set({ castError: "视线指向的人物不在这部片里。" });
        return false;
      }
      if (gaze.target === "prop" && !project.props.some((item) => item.id === gaze.targetId)) {
        set({ castError: "视线指向的道具不在这部片里。" });
        return false;
      }
    }

    // 同值不写：拖动强度滑块又滑回原位不该留一条事件
    if (JSON.stringify(next) === JSON.stringify(shot.performance)) return false;

    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId: shot.id,
      patch: { performance: next },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  setShotStaging: (shotId, staging) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再改调度。" });
      return false;
    }

    const parsed = StagingMarkSchema.array().safeParse(staging);
    if (!parsed.success) {
      set({
        castError: `镜头调度不合法：${parsed.error.issues[0]?.message ?? "未知原因"}`,
      });
      return false;
    }

    const seen = new Set<string>();
    for (const mark of parsed.data) {
      const key = mark.characterId ?? mark.propId!;
      if (seen.has(key)) {
        set({ castError: "同一个角色或道具只能有一条调度。" });
        return false;
      }
      if (mark.characterId && !shot.characterIds.includes(mark.characterId)) {
        set({ castError: "调度里的角色不在这一镜的出场名单里。" });
        return false;
      }
      if (mark.propId && !shot.propIds.includes(mark.propId)) {
        set({ castError: "调度里的道具不在这一镜的道具名单里。" });
        return false;
      }
      seen.add(key);
    }

    if (JSON.stringify(parsed.data) === JSON.stringify(shot.staging)) return false;

    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId: shot.id,
      patch: { staging: parsed.data },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  setShotBlocking: (shotId, blocking, placement) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再改走位。" });
      return false;
    }

    const parsed = BlockingSchema.safeParse(blocking);
    if (!parsed.success) {
      set({ castError: `走位不合法：${parsed.error.issues[0]?.message ?? "未知原因"}` });
      return false;
    }
    // 越界、不在场由 applyEvent 兜底；这里先给一句人话，免得只看到原始报错
    const space = project.locations.find(
      (location) =>
        location.id === project.scenes.find((scene) => scene.id === shot.sceneId)?.locationId,
    )?.space;
    const problem = blockingProblem(space, shot, parsed.data);
    if (problem) {
      set({ castError: problem.message });
      return false;
    }

    const patch: Partial<Shot> = { blocking: parsed.data };
    if (placement) {
      const placementIssue = placementProblem(space, placement);
      if (placementIssue) {
        set({ castError: placementIssue.message });
        return false;
      }
      patch.camera = { ...shot.camera, placement };
    }
    if (
      JSON.stringify(parsed.data) === JSON.stringify(shot.blocking) &&
      (!placement || JSON.stringify(placement) === JSON.stringify(shot.camera.placement))
    ) {
      return false;
    }

    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId: shot.id,
      patch,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  toggleShotCharacter: (shotId, characterId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再改出场人物。" });
      return false;
    }
    if (!project.characters.some((item) => item.id === characterId)) {
      set({ castError: "找不到这个人物。" });
      return false;
    }

    const present = shot.characterIds.includes(characterId);
    if (present) {
      // 人走了，这一镜里他的话还留着——字幕里会出现一个不在画面上的人
      const speaking = shot.dialogueIds
        .map((id) => project.dialogue.find((line) => line.id === id))
        .some((line) => line?.characterId === characterId);
      if (speaking) {
        const name = project.characters.find((item) => item.id === characterId)?.name ?? "这个人物";
        set({ castError: `${name}在这一镜还有台词：先删掉，或去剧本页点他的名字换人，再把他从出场里拿掉。` });
        return false;
      }
    }

    // 出场顺序就是点名的顺序：先点的人排在提示词前头
    const characterIds = present
      ? shot.characterIds.filter((id) => id !== characterId)
      : [...shot.characterIds, characterId];
    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId,
      patch: { characterIds },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  swapShotCharacter: (shotId, fromId, toId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再换人。" });
      return false;
    }
    if (!shot.characterIds.includes(fromId)) {
      set({ castError: "这个人物不在这一镜的出场里。" });
      return false;
    }
    if (!project.characters.some((item) => item.id === toId)) {
      set({ castError: "找不到要换上的人。" });
      return false;
    }
    if (fromId === toId) return false;

    // 换上的人站在被换那一位，出场顺序不乱；他本来就在这一镜里就并到第一次出现的位置
    const characterIds: string[] = [];
    for (const id of shot.characterIds) {
      const next = id === fromId ? toId : id;
      if (!characterIds.includes(next)) characterIds.push(next);
    }

    const at = stamp();
    const written: ProjectEvent[] = [
      { type: "shot.updated", at, shotId, patch: { characterIds } },
    ];
    const lineIds: string[] = [];
    for (const lineId of shot.dialogueIds) {
      const line = project.dialogue.find((item) => item.id === lineId);
      if (line?.characterId === fromId) {
        written.push({ type: "dialogue.speaker.updated", at, lineId, characterId: toId });
        lineIds.push(lineId);
      }
    }

    set({
      project: written.reduce(applyEvent, project),
      events: [...events, ...written],
      castError: undefined,
      // 只留最近一条：再换一次，上一条就撤不回来了
      lastSwap: {
        shotId,
        fromId,
        toId,
        prevCharacterIds: [...shot.characterIds],
        lineIds,
      },
    });
    return true;
  },

  undoSwap: () => {
    if (get().readOnly) return false;
    const { project, events, lastSwap } = get();
    if (!lastSwap) {
      set({ castError: "没有刚做完的换人可撤。" });
      return false;
    }
    const shot = project.shots.find((item) => item.id === lastSwap.shotId);
    if (!shot) {
      set({ castError: "这一镜已经不在了，撤不回换人。", lastSwap: undefined });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再撤销换人。" });
      return false;
    }
    if (!shot.characterIds.includes(lastSwap.toId)) {
      set({ castError: "这一镜里已经没有换上来的人了，撤不回这次换人。", lastSwap: undefined });
      return false;
    }

    const at = stamp();
    const written: ProjectEvent[] = [
      {
        type: "shot.updated",
        at,
        shotId: lastSwap.shotId,
        patch: { characterIds: [...lastSwap.prevCharacterIds] },
      },
    ];
    for (const lineId of lastSwap.lineIds) {
      const line = project.dialogue.find((item) => item.id === lineId);
      // 之后又被人改过说话人的句子不动：撤销只撤这一次换人
      if (line?.characterId === lastSwap.toId && shot.dialogueIds.includes(lineId)) {
        written.push({ type: "dialogue.speaker.updated", at, lineId, characterId: lastSwap.fromId });
      }
    }

    set({
      project: written.reduce(applyEvent, project),
      events: [...events, ...written],
      castError: undefined,
      lastSwap: undefined,
    });
    return true;
  },

  toggleShotProp: (shotId, propId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再改出场道具。" });
      return false;
    }
    if (!project.props.some((item) => item.id === propId)) {
      set({ castError: "找不到这件道具。" });
      return false;
    }

    // 与人物同一套：道具的顺序就是点名的顺序，先点的排在提示词前头
    const present = shot.propIds.includes(propId);
    const propIds = present
      ? shot.propIds.filter((id) => id !== propId)
      : [...shot.propIds, propId];
    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId,
      patch: { propIds },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  moveShotCharacter: (shotId, characterId, delta) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再改出场顺序。" });
      return false;
    }
    const at = shot.characterIds.indexOf(characterId);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= shot.characterIds.length) return false;

    const characterIds = [...shot.characterIds];
    [characterIds[at], characterIds[to]] = [characterIds[to]!, characterIds[at]!];
    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId,
      patch: { characterIds },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  moveShotProp: (shotId, propId, delta) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再改道具顺序。" });
      return false;
    }
    const at = shot.propIds.indexOf(propId);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= shot.propIds.length) return false;

    const propIds = [...shot.propIds];
    [propIds[at], propIds[to]] = [propIds[to]!, propIds[at]!];
    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId,
      patch: { propIds },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  approveAndLock: (shotId) => {
    if (get().readOnly) return;
    const { project, events, currentShotId } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot || shot.locked) return;

    const take = latestTake(shot, new Map(project.takes.map((item) => [item.id, item])));
    if (!take) {
      set({ castError: "这一镜还没有 take，先有一条才能留用。" });
      return;
    }

    // 两步合成一个动作：先留用（如果还不是 approved），再锁；两条事件都可回放
    const next: ProjectEvent[] = [];
    if (take.status !== "approved") {
      next.push({
        type: "take.updated",
        at: stamp(),
        takeId: take.id,
        patch: { status: "approved" },
      });
    }
    next.push({
      type: "shot.updated",
      at: stamp(),
      shotId: shot.id,
      patch: { locked: true },
    });

    const after = next.reduce((current, event) => applyEvent(current, event), project);
    set({
      project: after,
      events: [...events, ...next],
      // 与「留用」一致：定下来的镜头不挡路，选中挪到下一格还没定的
      currentShotId: nextOpenShotId(after, currentShotId),
      castError: undefined,
    });
  },

  lockCast: (targetType, targetId) => {
    if (get().readOnly) return;
    const { project, events } = get();
    const readiness = castReadiness(project);
    const item = [
      ...readiness.characters,
      ...readiness.locations,
      ...readiness.props,
    ].find(
      (entry) => entry.targetType === targetType && entry.targetId === targetId,
    );
    // 缺资产、缺角度的不许锁：闸门的意义就在这里
    if (!item || item.status === "incomplete") return;

    const at = stamp();
    const event: ProjectEvent = {
      type: "approval.updated",
      at,
      approval: {
        id: `ap-${targetType}-${targetId}`,
        targetType,
        targetId,
        status: "approved",
        approvedAt: at,
        lockedAssetIds: item.assetIds,
      },
    };
    set({ project: applyEvent(project, event), events: [...events, event] });
  },

  unlockCast: (targetType, targetId) => {
    if (get().readOnly) return;
    const { project, events } = get();
    const existing = project.approvals.find(
      (item) => item.targetType === targetType && item.targetId === targetId,
    );
    if (!existing) return;

    const event: ProjectEvent = {
      type: "approval.updated",
      at: stamp(),
      approval: {
        id: existing.id,
        targetType,
        targetId,
        status: "pending",
        lockedAssetIds: [],
        note: existing.note,
      },
    };
    set({ project: applyEvent(project, event), events: [...events, event] });
  },

  generateSheet: async (characterId) => {
    if (get().readOnly) return;
    if (lockedStage({ get, set }, "cast")) return;
    const { project } = get();
    const character = project.characters.find((item) => item.id === characterId);
    if (!character) return;
    // 锁定的定妆不能被覆盖：要重做先解锁（准则 P14）
    if (isLocked(project, "character", characterId)) return;

    const angles = SHEET_ANGLES.filter((angle) => character.sheet[angle]);
    if (angles.length === 0) {
      set({ castError: "这个角色还没有三视图的资产位，先建四个格子" });
      return;
    }

    set({ castError: undefined });
    for (const angle of angles) {
      const ok = await generateOne(
        { get, set },
        {
          key: characterId,
          label: character.name,
          assetId: character.sheet[angle]!,
          job: { kind: "sheet", angle },
          body: {
            kind: "sheet",
            character: {
              name: character.name,
              appearance: character.appearance,
              mustNotChange: character.mustNotChange,
            },
            angle,
          },
        },
      );
      if (!ok) return; // 一格没成，后面的也多半不成；别继续烧钱
    }
  },

  generateMaster: async (locationId) => {
    if (get().readOnly) return;
    if (lockedStage({ get, set }, "cast")) return;
    const { project } = get();
    const location = project.locations.find((item) => item.id === locationId);
    if (!location) return;
    if (isLocked(project, "location", locationId)) return;
    if (!location.masterShotId) {
      set({ castError: `「${location.name}」还没有主镜的资产位` });
      return;
    }

    set({ castError: undefined });
    await generateOne(
      { get, set },
      {
        key: locationId,
        label: location.name,
        assetId: location.masterShotId,
        job: { kind: "master" },
        body: {
          kind: "master",
          location: { name: location.name, description: location.description },
        },
      },
    );
  },

  generateKeyframe: async (shotId, frame = "first") => {
    if (get().readOnly) return false;
    if (lockedStage({ get, set }, "keyframes")) return false;
    const { project } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) return false;
    // 锁定的镜头只读：要重做先解锁
    if (shot.locked) return false;

    // 首尾两帧各占一个资产位，重生成按 id 覆盖（ADR-0038）
    const assetId = frame === "last" ? `a-lastframe-${shot.id}` : `a-keyframe-${shot.id}`;
    // 镜号要按整片的顺序算：`shot.index` 是场内序号，第二场以后会报错镜号
    const no = toStageView(project).shots.find((item) => item.id === shot.id)?.no;
    set({ castError: undefined });
    return generateOne(
      { get, set },
      {
        // 进度分帧记：首帧还在跑时点尾帧，不能把首帧的进度盖掉
        key: `${shot.id}:${frame}`,
        label: no === undefined ? shot.id : shotLabel(no),
        assetId,
        shotId: shot.id,
        job: { kind: "keyframe", frame },
        body: {
          kind: "keyframe",
          frame,
          shot: shotMaterial(project, shot, { frame }),
        },
        referenceAssetIds: shotAnchors(project, shot).refs.map((ref) => ref.assetId),
        after: (id, at) => ({
          type: "shot.updated",
          at,
          shotId: shot.id,
          patch: {
            keyframes:
              frame === "last"
                ? { ...shot.keyframes, lastAssetId: id }
                : { ...shot.keyframes, firstAssetId: id },
          },
        }),
      },
    );
  },

  generateVideo: async (shotId) => {
    if (get().readOnly) return false;
    if (lockedStage({ get, set }, "keyframes")) return false;
    const { project } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) return false;
    if (shot.locked) {
      set({ castError: "这一镜已锁定：要重拍先解锁。" });
      return false;
    }

    // 首帧先行：没有起点的画面，视频只会被模型当成要重画一镜（ADR-0083）
    const firstId = shot.keyframes.firstAssetId;
    const firstFrame = firstId
      ? project.assets.find((asset) => asset.id === firstId)
      : undefined;
    if (!firstFrame?.uri) {
      set({ castError: "这一镜还没有首帧：先去关键帧页出一张，再让它动起来。" });
      return false;
    }

    // 提交前拦超预算：按秒报价 × 这一镜的时长；不知道单价就不拦
    const perSecond = get().videoCnyPerSecond;
    const no = toStageView(project).shots.find((item) => item.id === shot.id)?.no;
    const label = no === undefined ? shot.id : shotLabel(no);
    if (perSecond !== undefined) {
      const unit = Math.round((shot.durationMs / 1000) * perSecond * 100) / 100;
      const { spent } = spendOf(project);
      const keep = project.onBudgetExceed === "keep";
      if (spent + unit > project.budgetCny) {
        set({
          castError: keep
            ? `「${label}」出这一条视频要 ¥${unit.toFixed(2)}，已花 ¥${spent.toFixed(2)} / 预算 ¥${project.budgetCny.toFixed(2)}。按「超预算保留现有结果」，这次不重新出片，这一镜沿用现有的画面。`
            : `「${label}」出视频要 ¥${unit.toFixed(2)}，已花 ¥${spent.toFixed(2)} / 预算 ¥${project.budgetCny.toFixed(2)}。先提高预算再生成。`,
        });
        return false;
      }
      if (shot.budgetCny !== undefined) {
        const shotSpend = shotSpendOf(project, shot.id);
        if (shotSpend.spent + unit > shot.budgetCny) {
          set({
            castError: keep
              ? `「${label}」超出这一镜的上限：这一段要 ¥${unit.toFixed(2)}，这一镜已花 ¥${shotSpend.spent.toFixed(2)} / 上限 ¥${shot.budgetCny.toFixed(2)}。按「超预算保留现有结果」，这次不重新出片，这一镜沿用现有的画面。`
              : `「${label}」超出这一镜的上限：这一段要 ¥${unit.toFixed(2)}，这一镜已花 ¥${shotSpend.spent.toFixed(2)} / 上限 ¥${shot.budgetCny.toFixed(2)}。先在分镜页提高单镜上限，或改项目预算。`,
          });
          return false;
        }
      }
    }

    const jobKey = `${shot.id}:video`;
    const setJob = (value: GenerateJob | undefined) =>
      set({ jobs: { ...get().jobs, [jobKey]: value } });

    set({ castError: undefined });
    let lastFailure = "";
    const maxAttempts = project.maxAttemptsPerShot;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      setJob({ kind: "video", attempt });
      let response: Response;
      try {
        response = await fetch("/api/video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shot: shotMaterial(project, shot),
            firstFrame: firstFrame.uri,
            durationMs: shot.durationMs,
            modelId: getModelChoice("video"),
          }),
        });
      } catch (error) {
        // 连接断在提交前后无法判断任务是否已经建立：不自动重交，避免重复计费
        setJob(undefined);
        const reason = error instanceof Error ? error.message : "连接断了";
        set({
          castError: `「${label}」没出片：${clipReason(reason)}。请求可能已经到了供应商，先去后台确认有没有任务，再决定要不要重试，免得多花一笔。`,
        });
        return false;
      }

      const payload = (await response.json().catch(() => ({}))) as {
        uri?: string;
        model?: string;
        prompt?: string;
        durationMs?: number;
        cny?: number;
        error?: string;
        /** 服务端判定「重交安全」才为 true（B6） */
        retryable?: boolean;
        code?: string;
      };
      if (!response.ok || !payload.uri) {
        const reason = payload.error ?? `生成失败（${response.status}）`;
        if (payload.retryable === true && attempt < maxAttempts) {
          lastFailure = reason;
          set({
            castError: `「${label}」第 ${attempt} 次没出片：${clipReason(reason)}。正在重试（${attempt + 1}/${maxAttempts}）…`,
          });
          await wait(VIDEO_RETRY_DELAYS_MS[attempt - 1] ?? 3000);
          continue;
        }
        setJob(undefined);
        set({
          castError: `「${label}」${attempt > 1 ? `试了 ${attempt} 次` : ""}没出片：${clipReason(reason)}。可以先「贴视频地址导入」顶上。`,
        });
        return false;
      }

      // 每拍一条就新占一个资产位，不覆盖旧 take：多 Take 的意义就是能比
      let n = shot.takeIds.length + 1;
      let assetId = `a-video-${shot.id}-${n}`;
      while (project.assets.some((asset) => asset.id === assetId)) {
        n += 1;
        assetId = `a-video-${shot.id}-${n}`;
      }
      const at = stamp();
      // 视频动辄几 MB：先进本机资产库（H3 / ADR-0128），日志里只留地址
      const uri = await persistAsset(payload.uri);
      const mime = /^data:(video\/[a-z0-9.+-]+)[;,]/i.exec(uri)?.[1];
      const provenance = {
        modelId: payload.model ?? "unknown",
        prompt: payload.prompt,
        referenceAssetIds: firstId ? [firstId] : [],
        createdAt: at,
      };
      const written: ProjectEvent[] = [
        {
          type: "asset.updated",
          at,
          asset: {
            id: assetId,
            kind: "video",
            source: "generated",
            uri,
            ...(mime ? { mime } : {}),
            durationMs: payload.durationMs ?? shot.durationMs,
            costCny: typeof payload.cny === "number" ? payload.cny : undefined,
            provenance,
            createdAt: at,
          },
        },
        {
          type: "take.added",
          at,
          take: {
            id: `take-${shot.id}-${n}`,
            shotId: shot.id,
            assetId,
            provenance,
            status: "draft",
            costCny: typeof payload.cny === "number" ? payload.cny : 0,
          },
        },
      ];
      set({
        project: written.reduce(applyEvent, project),
        events: [...get().events, ...written],
        castError: undefined,
      });
      setJob(undefined);
      return true;
    }

    setJob(undefined);
    set({
      castError: `「${label}」试了 ${maxAttempts} 次没出片：${clipReason(lastFailure || "原因没说")}。`,
    });
    return false;
  },

  attachVideo: (shotId, rawUri) => {
    if (get().readOnly) return false;
    if (lockedStage({ get, set }, "keyframes")) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定：要贴视频先解锁。" });
      return false;
    }

    const uri = rawUri.trim();
    if (!uri) {
      set({ castError: "先贴一条视频地址。" });
      return false;
    }
    if (!/^(https?:\/\/|data:video\/)/i.test(uri)) {
      set({ castError: "视频要先有地址：http(s):// 或 data:video/ 开头。" });
      return false;
    }
    if (uri.length > VIDEO_URI_MAX) {
      set({ castError: "地址太长了：12 MB 以内。" });
      return false;
    }
    const already = shot.takeIds.some(
      (id) =>
        project.assets.find(
          (asset) => asset.id === project.takes.find((take) => take.id === id)?.assetId,
        )?.uri === uri,
    );
    if (already) {
      set({ castError: "这条视频已经贴过了。" });
      return false;
    }

    let n = shot.takeIds.length + 1;
    let assetId = `a-video-${shot.id}-${n}`;
    while (project.assets.some((asset) => asset.id === assetId)) {
      n += 1;
      assetId = `a-video-${shot.id}-${n}`;
    }
    const at = stamp();
    const mime = /^data:(video\/[a-z0-9.+-]+)[;,]/i.exec(uri)?.[1];
    const provenance = {
      modelId: "import",
      referenceAssetIds: [],
      createdAt: at,
    };
    const written: ProjectEvent[] = [
      {
        type: "asset.updated",
        at,
        asset: {
          id: assetId,
          kind: "video",
          source: "upload",
          uri,
          ...(mime ? { mime } : {}),
          durationMs: shot.durationMs,
          provenance,
          createdAt: at,
        },
      },
      {
        type: "take.added",
        at,
        take: {
          id: `take-${shot.id}-${n}`,
          shotId: shot.id,
          assetId,
          provenance,
          status: "draft",
          costCny: 0,
        },
      },
    ];
    set({
      project: written.reduce(applyEvent, project),
      events: [...events, ...written],
      castError: undefined,
    });
    return true;
  },

  setVoiceInfo: (info) => {
    set({ voiceInfo: info });
  },

  setAsrInfo: (info) => {
    set({ asrInfo: info });
  },

  generateVoice: async (lineId) => {
    if (get().readOnly) return false;
    if (lockedStage({ get, set }, "voice")) return false;
    const { project } = get();
    const line = project.dialogue.find((item) => item.id === lineId);
    if (!line) return false;
    const shot = project.shots.find((item) => item.dialogueIds.includes(lineId));
    if (shot?.locked) {
      set({ castError: "这一镜已锁定：要配音先解锁。" });
      return false;
    }
    const character = project.characters.find((item) => item.id === line.characterId);
    const no = shot
      ? toStageView(project).shots.find((item) => item.id === shot.id)?.no
      : undefined;
    const label = `${no === undefined ? "这一句" : shotLabel(no)}${character ? ` · ${character.name}` : ""}`;

    const jobKey = `${lineId}:voice`;
    const setJob = (value: GenerateJob | undefined) =>
      set({ jobs: { ...get().jobs, [jobKey]: value } });

    set({ castError: undefined });
    setJob({ kind: "voice" });
    try {
      const response = await fetch("/api/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: line.text,
          ...(character?.voiceProfileId ? { voice: character.voiceProfileId } : {}),
          modelId: getModelChoice("tts"),
        }),
      });
      const payload = (await response.json()) as {
        uri?: string;
        mime?: string;
        model?: string;
        error?: string;
      };
      if (!response.ok || !payload.uri) {
        throw new Error(payload.error ?? `出声失败（${response.status}）`);
      }

      // 一句台词一个资产位：重配就换掉这一句的旧音轨，不累积成 take
      const assetId = `a-voice-${lineId}`;
      const at = stamp();
      // 音轨也先进资产库（H3 / ADR-0128）：一句 8 MB 的 base64 不该进日志
      const uri = await persistAsset(payload.uri);
      const mime = /^data:(audio\/[a-z0-9.+-]+)[;,]/i.exec(uri)?.[1];
      const written: ProjectEvent[] = [
        {
          type: "asset.updated",
          at,
          asset: {
            id: assetId,
            kind: "audio",
            source: "generated",
            uri,
            ...(payload.mime || mime ? { mime: payload.mime ?? mime } : {}),
            provenance: {
              modelId: payload.model ?? "unknown",
              prompt: line.text,
              referenceAssetIds: [],
              createdAt: at,
            },
            createdAt: at,
          },
        },
        {
          type: "dialogue.updated",
          at,
          lineId,
          patch: { audioAssetId: assetId },
        },
      ];
      set({
        project: written.reduce(applyEvent, project),
        events: [...get().events, ...written],
        castError: undefined,
      });
      setJob(undefined);
      return true;
    } catch (error) {
      setJob(undefined);
      const reason = error instanceof Error ? error.message : "原因没说";
      const clipped = reason.length > 240 ? `${reason.slice(0, 240)}…` : reason;
      set({
        castError: `「${label}」这句没出声：${clipped}。可以先「贴一条音轨」顶上，或稍后再试。`,
      });
      return false;
    }
  },

  attachVoice: (lineId, rawUri) => {
    if (get().readOnly) return false;
    if (lockedStage({ get, set }, "voice")) return false;
    const { project, events } = get();
    const line = project.dialogue.find((item) => item.id === lineId);
    if (!line) {
      set({ castError: "找不到这句台词。" });
      return false;
    }
    const shot = project.shots.find((item) => item.dialogueIds.includes(lineId));
    if (shot?.locked) {
      set({ castError: "这一镜已锁定：要配音先解锁。" });
      return false;
    }

    const uri = rawUri.trim();
    if (!uri) {
      set({ castError: "先贴一条音轨地址。" });
      return false;
    }
    if (!/^(https?:\/\/|data:audio\/)/i.test(uri)) {
      set({ castError: "音轨要先有地址：http(s):// 或 data:audio/ 开头。" });
      return false;
    }
    if (uri.length > VOICE_URI_MAX) {
      set({ castError: "地址太长了：8 MB 以内。" });
      return false;
    }

    const assetId = `a-voice-${lineId}`;
    const at = stamp();
    const mime = /^data:(audio\/[a-z0-9.+-]+)[;,]/i.exec(uri)?.[1];
    const written: ProjectEvent[] = [
      {
        type: "asset.updated",
        at,
        asset: {
          id: assetId,
          kind: "audio",
          source: "upload",
          uri,
          ...(mime ? { mime } : {}),
          provenance: {
            modelId: "import",
            referenceAssetIds: [],
            createdAt: at,
          },
          createdAt: at,
        },
      },
      {
        type: "dialogue.updated",
        at,
        lineId,
        patch: { audioAssetId: assetId },
      },
    ];
    set({
      project: written.reduce(applyEvent, project),
      events: [...events, ...written],
      castError: undefined,
    });
    return true;
  },

  fitLineToAudio: (lineId, rawDurationMs) => {
    if (get().readOnly) return false;
    const { project } = get();
    const line = project.dialogue.find((item) => item.id === lineId);
    if (!line) return false;
    const shot = project.shots.find((item) => item.dialogueIds.includes(lineId));
    if (shot?.locked) return false;

    // 量错的时长不要写进 IR：几百毫秒的音轨不合常理，一分钟的台词也不合
    if (!Number.isFinite(rawDurationMs)) return false;
    const durationMs = Math.round(Math.min(60_000, Math.max(300, rawDurationMs)));
    const delta = durationMs - line.durationMs;
    // 差得太小就不折腾：每次挂音轨都写两条事件，日志会被无意义的抖动塞满
    if (Math.abs(delta) < 40) return false;

    const at = stamp();
    const written: ProjectEvent[] = [
      { type: "dialogue.updated", at, lineId, patch: { durationMs } },
    ];
    if (shot) {
      written.push({
        type: "shot.updated",
        at,
        shotId: shot.id,
        patch: { durationMs: Math.max(500, shot.durationMs + delta) },
      });
    }
    const asset = line.audioAssetId
      ? project.assets.find((item) => item.id === line.audioAssetId)
      : undefined;
    if (asset) {
      written.push({
        type: "asset.updated",
        at,
        asset: { ...asset, durationMs },
      });
    }

    set({
      project: written.reduce(applyEvent, project),
      events: [...get().events, ...written],
    });
    return true;
  },

  transcribeLine: async (lineId) => {
    if (get().readOnly) {
      set({ castError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    if (lockedStage({ get, set }, "voice")) return false;
    const { project } = get();
    const line = project.dialogue.find((item) => item.id === lineId);
    if (!line) return false;
    const shot = project.shots.find((item) => item.dialogueIds.includes(lineId));
    const character = project.characters.find((item) => item.id === line.characterId);
    const no = shot
      ? toStageView(project).shots.find((item) => item.id === shot.id)?.no
      : undefined;
    const label = `${no === undefined ? "这一句" : shotLabel(no)}${character ? ` · ${character.name}` : ""}`;

    const asset = line.audioAssetId
      ? project.assets.find((item) => item.id === line.audioAssetId)
      : undefined;
    if (!asset?.uri) {
      set({ castError: `「${label}」还没有音轨：先出声或贴一条，才有得识别。` });
      return false;
    }

    const jobKey = `${lineId}:asr`;
    const setJob = (value: GenerateJob | undefined) =>
      set({ jobs: { ...get().jobs, [jobKey]: value } });

    set({ castError: undefined });
    setJob({ kind: "asr" });
    try {
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri: asset.uri, modelId: getModelChoice("asr") }),
      });
      const payload = (await response.json()) as {
        text?: string;
        model?: string;
        segments?: { text: string; startMs: number; endMs: number }[];
        error?: string;
      };
      if (!response.ok || !payload.text) {
        throw new Error(payload.error ?? `识别失败（${response.status}）`);
      }
      set({
        asrResult: {
          lineId,
          text: payload.text,
          model: payload.model ?? "unknown",
          segments: payload.segments ?? [],
          createdAt: stamp(),
        },
        castError: undefined,
      });
      setJob(undefined);
      return true;
    } catch (error) {
      setJob(undefined);
      const reason = error instanceof Error ? error.message : "原因没说";
      const clipped = reason.length > 240 ? `${reason.slice(0, 240)}…` : reason;
      set({
        castError: `「${label}」这句没识别出来：${clipped}。`,
      });
      return false;
    }
  },

  applyAsrText: (lineId, rawText) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const line = project.dialogue.find((item) => item.id === lineId);
    if (!line) {
      set({ castError: "找不到这句台词。" });
      return false;
    }
    const shot = project.shots.find((item) => item.dialogueIds.includes(lineId));
    if (shot?.locked) {
      set({ castError: "这一镜已锁定：要改台词先解锁。" });
      return false;
    }
    const text = rawText.trim();
    if (!text) {
      set({ castError: "识别结果是空的，替换不了。" });
      return false;
    }
    if (text === line.text) {
      set({ castError: "识别结果和现在这句一样，不用替换。", asrResult: undefined });
      return false;
    }

    const event: ProjectEvent = {
      type: "dialogue.updated",
      at: stamp(),
      lineId,
      // 只改文字：时长以音轨为准，识别不替它重新估
      patch: { text },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
      asrResult: undefined,
    });
    return true;
  },

  dismissAsrResult: () => {
    set({ asrResult: undefined });
  },

  setCharacterVoice: (characterId, rawVoice) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const character = project.characters.find((item) => item.id === characterId);
    if (!character) {
      set({ castError: "找不到这个人物。" });
      return false;
    }
    const voice = rawVoice.trim();
    if (voice.length > VOICE_PROFILE_MAX) {
      set({ castError: `音色名太长了：${VOICE_PROFILE_MAX} 字以内。` });
      return false;
    }
    if ((character.voiceProfileId ?? "") === voice) return false;

    const at = stamp();
    const event: ProjectEvent = {
      type: "character.updated",
      at,
      characterId,
      patch: { voiceProfileId: voice },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  autoCutTimeline: () => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    const cut = autoCut(project);
    if (cut.items.length === 0) {
      set({
        editError:
          "一条能用的 take 都还没有：先去分镜页生成，或「贴视频地址」导入一条。",
      });
      return false;
    }
    if (timelineEquals(project.timeline.items, cut.items)) {
      // 已经剪过了：不写重复事件，但让界面知道「跳过几镜」这件事仍然成立
      set({ editError: undefined });
      return false;
    }

    const event: ProjectEvent = {
      type: "timeline.updated",
      at: stamp(),
      items: cut.items,
    };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError:
          cut.skipped.length > 0
            ? `${cut.skipped.length} 镜没有可用 take，先跳过了：${cut.skipped
                .map((item) => shotLabel(item.no))
                .join("、")}`
            : undefined,
      });
    } catch (error) {
      set({
        editError: error instanceof Error ? error.message : "初剪失败",
      });
      return false;
    }
    return true;
  },

  setTimelineTake: (itemId, takeId) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    const item = project.timeline.items.find((entry) => entry.id === itemId);
    if (!item) {
      set({ editError: "找不到这个片段。" });
      return false;
    }
    if (item.takeId === takeId) return false;
    const take = project.takes.find((entry) => entry.id === takeId);
    if (!take || take.shotId !== item.shotId) {
      set({ editError: "这一版 take 不属于这个镜头。" });
      return false;
    }
    if (take.status === "rejected") {
      set({ editError: "这一版已经淘汰了：先用回没淘汰的 take。" });
      return false;
    }

    const items = project.timeline.items.map((entry) =>
      entry.id === itemId ? { ...entry, takeId } : entry,
    );
    const event: ProjectEvent = {
      type: "timeline.updated",
      at: stamp(),
      items,
    };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError: undefined,
      });
    } catch (error) {
      set({
        editError: error instanceof Error ? error.message : "换 take 失败",
      });
      return false;
    }
    return true;
  },

  removeTimelineItem: (itemId) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    if (!project.timeline.items.some((entry) => entry.id === itemId)) {
      set({ editError: "找不到这个片段。" });
      return false;
    }

    // 摘掉这一段，后面的整体前移：渲染清单要求首尾相接，不能留空
    const kept = project.timeline.items.filter((entry) => entry.id !== itemId);
    const event: ProjectEvent = {
      type: "timeline.updated",
      at: stamp(),
      items: restack(kept),
    };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError: undefined,
      });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "删片段失败" });
      return false;
    }
    return true;
  },

  moveTimelineItem: (itemId, delta) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    const ordered = [...project.timeline.items].sort((a, b) => a.startMs - b.startMs);
    const from = ordered.findIndex((entry) => entry.id === itemId);
    if (from < 0) return false;
    const to = from + delta;
    if (to < 0 || to >= ordered.length) return false;

    const reordered = [...ordered];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved!);

    const event: ProjectEvent = {
      type: "timeline.updated",
      at: stamp(),
      items: restack(reordered),
    };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError: undefined,
      });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "挪片段失败" });
      return false;
    }
    return true;
  },

  addMusic: ({ uri: rawUri, mime, title, mood, durationMs, licenseRef }) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    if (project.timeline.music.length > 0) {
      set({ editError: "现在只支持一条配乐床：先移掉旧的再加。" });
      return false;
    }
    const uri = rawUri.trim();
    if (!/^data:audio\//i.test(uri)) {
      set({ editError: "配乐要先读成本地音频（data:audio/…）。" });
      return false;
    }
    // 约 18 MB 的音频；base64 后约 24 MB，再大 IndexedDB 与渲染清单都吃不消
    if (uri.length > 24_000_000) {
      set({ editError: "这条音乐太大了（超过约 18 MB）：换一条短一点的。" });
      return false;
    }
    if (!licenseRef.trim()) {
      set({ editError: "配乐必须写授权来源：曲库名、授权书编号或「自己录制」。" });
      return false;
    }
    if (!Number.isFinite(durationMs) || durationMs < 500) {
      set({ editError: "读不出这条音乐的时长：换一个文件再试。" });
      return false;
    }
    const at = stamp();
    let assetId = `a-music-${Date.now().toString(36)}`;
    while (project.assets.some((asset) => asset.id === assetId)) assetId += "x";
    const asset: Asset = {
      id: assetId,
      kind: "audio",
      source: "upload",
      uri,
      mime: mime || "audio/mpeg",
      durationMs: Math.round(durationMs),
      createdAt: at,
    };
    let cueId = `music-${Date.now().toString(36)}`;
    while (project.timeline.music.some((cue) => cue.id === cueId)) cueId += "x";
    const timelineMs = project.timeline.items.reduce(
      (end, item) => Math.max(end, item.startMs + item.durationMs),
      0,
    );
    const cue: MusicCue = {
      id: cueId,
      assetId,
      title: title.trim().slice(0, 120) || "配乐",
      mood: mood.trim().slice(0, 40),
      startMs: 0,
      // 默认循环铺满全片；音乐文件本身多长记在资产上
      durationMs: timelineMs || Math.round(durationMs),
      gainDb: -18,
      duckDb: 15,
      ducking: true,
      loop: true,
      licenseRef: licenseRef.trim().slice(0, 240),
    };
    const written: ProjectEvent[] = [
      { type: "asset.updated", at, asset },
      { type: "timeline.music.updated", at, music: [cue] },
    ];
    try {
      set({
        project: written.reduce(applyEvent, project),
        events: [...events, ...written],
        editError: undefined,
      });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "配乐加不上" });
      return false;
    }
    return true;
  },

  updateMusic: (patch) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    const cue = project.timeline.music[0];
    if (!cue) return false;
    const next: MusicCue = {
      ...cue,
      ...(patch.gainDb !== undefined
        ? { gainDb: Math.max(-40, Math.min(0, Math.round(patch.gainDb))) }
        : {}),
      ...(patch.duckDb !== undefined
        ? { duckDb: Math.max(12, Math.min(18, Math.round(patch.duckDb))) }
        : {}),
      ...(patch.ducking !== undefined ? { ducking: patch.ducking } : {}),
      ...(patch.mood !== undefined ? { mood: patch.mood.slice(0, 40) } : {}),
    };
    const event: ProjectEvent = {
      type: "timeline.music.updated",
      at: stamp(),
      music: [next],
    };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError: undefined,
      });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "配乐改不动" });
      return false;
    }
    return true;
  },

  removeMusic: () => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    if (project.timeline.music.length === 0) return false;
    const event: ProjectEvent = {
      type: "timeline.music.updated",
      at: stamp(),
      music: [],
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      editError: undefined,
    });
    return true;
  },

  generateMissingFrames: async (frame = "first", only) => {

    if (get().readOnly || get().batch) return;
    const { shots } = toStageView(get().project);
    const scope = only ? new Set(only) : undefined;
    const missing = shots
      // 锁定的镜头跳过：批量不是绕过闸门的理由
      .filter((shot) => !shot.locked)
      .filter((shot) => (scope ? scope.has(shot.id) : true))
      .filter((shot) => (frame === "last" ? !shot.hasLastFrame : !shot.hasKeyframe))
      .map((shot) => shot.id);

    if (missing.length === 0) {
      const what = frame === "last" ? "尾帧" : "首帧";
      set({
        castError: scope ? `这一档里没有缺${what}的镜头。` : `${what}都齐了。`,
      });
      return;
    }

    set({ batch: { frame, done: 0, total: missing.length }, castError: undefined });
    try {
      for (const shotId of missing) {
        if (get().readOnly || get().batch?.stop) break;
        const ok = await get().generateKeyframe(shotId, frame);
        const batch = get().batch;
        if (!batch) break;
        set({ batch: { ...batch, done: batch.done + 1 } });
        // 失败（含超预算）就停：后面的也跟着失败，只会多花钱
        if (!ok) break;
      }
    } finally {
      set({ batch: undefined });
    }
  },

  stopBatch: () => {
    const batch = get().batch;
    // 当前这一张已经发出去了，停下只在它结束后生效
    if (batch) set({ batch: { ...batch, stop: true } });
  },

  editDialogue: (lineId, rawText) =>
    commitDialogue(
      { get, set },
      { lineId, text: rawText, unchanged: "台词没改。", textOnly: true },
    ),

  restoreDialogue: (lineId, text, durationMs) =>
    commitDialogue(
      { get, set },
      { lineId, text, durationMs, unchanged: "这句已经是这一版了。" },
    ),
  editSubtitles: (lineId, cues) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    if (!project.dialogue.some((line) => line.id === lineId)) return false;
    const current = project.subtitleOverrides.find((item) => item.lineId === lineId);
    const same =
      cues === null
        ? !current
        : current !== undefined &&
          current.cues.length === cues.length &&
          current.cues.every(
            (cue, index) =>
              cue.text === cues[index]!.text && cue.durationMs === cues[index]!.durationMs,
          );
    if (same) {
      set({ castError: cues === null ? "这句本来就是自动断句。" : "字幕没改。" });
      return false;
    }
    if (cues !== null && cues.some((cue) => cue.text.trim().length === 0)) {
      set({ castError: "每条字幕都要有字。" });
      return false;
    }
    const at = stamp();
    const event: ProjectEvent = { type: "subtitle.updated", at, lineId, cues };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  editAction: (shotId, rawText) => {
    if (get().readOnly) return false;
    const text = rawText.replace(/\s+$/, "");
    if (text.length === 0) {
      set({ castError: "动作不能是空的。" });
      return false;
    }
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) return false;
    if (shot.locked) {
      set({ castError: "这一镜已锁定：要改动作先解锁。" });
      return false;
    }
    if (text === shot.description) {
      set({ castError: "动作没改。" });
      return false;
    }
    const at = stamp();
    const next: ProjectEvent[] = [
      { type: "shot.updated", at, shotId, patch: { description: text } },
    ];
    set({
      project: next.reduce(applyEvent, project),
      events: [...events, ...next],
      castError: undefined,
    });
    return true;
  },


  moveDialogueTo: (lineId, targetShotId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const line = project.dialogue.find((item) => item.id === lineId);
    if (!line) return false;
    const source = project.shots.find((item) => item.dialogueIds.includes(lineId));
    if (!source) return false;
    const target = project.shots.find((item) => item.id === targetShotId);
    if (!target) return false;
    if (source.id === target.id) {
      set({ castError: "这句已经在这一镜里了。" });
      return false;
    }
    if (source.locked || target.locked) {
      set({ castError: "这一镜已锁定：要挪台词先解锁。" });
      return false;
    }
    const at = stamp();
    const written: ProjectEvent[] = [
      {
        type: "shot.updated",
        at,
        shotId: source.id,
        patch: {
          dialogueIds: source.dialogueIds.filter((id) => id !== lineId),
          durationMs: Math.max(500, source.durationMs - line.durationMs),
        },
      },
      {
        type: "shot.updated",
        at,
        shotId: target.id,
        patch: {
          dialogueIds: [...target.dialogueIds, lineId],
          durationMs: target.durationMs + line.durationMs,
        },
      },
    ];
    set({
      project: written.reduce(applyEvent, project),
      events: [...events, ...written],
      castError: undefined,
    });
    return true;
  },

  restoreLine: (lineId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    if (project.dialogue.some((item) => item.id === lineId)) {
      set({ castError: "这句已经在台词里了。" });
      return false;
    }
    // 同一句删过多次：取最后一次，恢复的是删那一刻的正文与镜头。
    const record = removedLines(events)
      .filter((item) => item.lineId === lineId)
      .at(-1);
    if (!record) return false;
    const shot = project.shots.find((item) => item.id === record.shotId);
    if (!shot) {
      set({ castError: "这一句原来的镜头不在了。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定：要恢复台词先解锁。" });
      return false;
    }

    const at = stamp();
    const written: ProjectEvent[] = [
      {
        type: "dialogue.added",
        at,
        shotId: shot.id,
        line: {
          id: record.lineId,
          characterId: record.characterId,
          text: record.text,
          durationMs: record.durationMs,
        },
      },
      {
        type: "shot.updated",
        at,
        shotId: shot.id,
        patch: { durationMs: shot.durationMs + record.durationMs },
      },
    ];
    set({
      project: written.reduce(applyEvent, project),
      events: [...events, ...written],
      castError: undefined,
    });
    return true;
  },

  setDialogueOrder: (shotId, lineIds) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) return false;
    if (shot.locked) {
      set({ castError: "这一镜已锁定：要调台词顺序先解锁。" });
      return false;
    }
    if (lineIds.length !== shot.dialogueIds.length) {
      set({ castError: "这一版顺序里有之后被删掉的台词，恢复不了。" });
      return false;
    }
    if (!lineIds.every((id) => shot.dialogueIds.includes(id))) {
      set({ castError: "这一版顺序和现在的台词对不上。" });
      return false;
    }
    if (lineIds.every((id, i) => id === shot.dialogueIds[i])) {
      set({ castError: "顺序没改。" });
      return false;
    }
    const at = stamp();
    const written: ProjectEvent[] = [
      { type: "shot.updated", at, shotId, patch: { dialogueIds: [...lineIds] } },
    ];
    set({
      project: written.reduce(applyEvent, project),
      events: [...events, ...written],
      castError: undefined,
    });
    return true;
  },

  editScene: (sceneId, patch) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const scene = project.scenes.find((item) => item.id === sceneId);
    if (!scene) return false;
    const next: Partial<Pick<Scene, "space" | "timeOfDay" | "locationId">> = {};
    if (patch.space !== undefined && patch.space !== scene.space) next.space = patch.space;
    if (patch.timeOfDay !== undefined && patch.timeOfDay !== scene.timeOfDay) {
      next.timeOfDay = patch.timeOfDay;
    }
    if (patch.locationId !== undefined && patch.locationId !== scene.locationId) {
      if (!project.locations.some((item) => item.id === patch.locationId)) {
        set({ castError: "找不到这个地点。" });
        return false;
      }
      next.locationId = patch.locationId;
    }
    if (Object.keys(next).length === 0) {
      set({ castError: "场头没改。" });
      return false;
    }
    const at = stamp();
    const written: ProjectEvent[] = [{ type: "scene.updated", at, sceneId, patch: next }];
    set({
      project: written.reduce(applyEvent, project),
      events: [...events, ...written],
      castError: undefined,
    });
    return true;
  },

  editSceneCode: (sceneId, rawCode) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const scene = project.scenes.find((item) => item.id === sceneId);
    if (!scene) return false;
    const code = rawCode.trim();
    if (code !== "" && !/^[0-9A-Za-z]{1,4}$/.test(code)) {
      set({ castError: "场号只能是 1–4 位字母数字，比如 2A。" });
      return false;
    }
    if (code === scene.code) {
      set({ castError: "场号没改。" });
      return false;
    }
    if (
      code !== "" &&
      project.scenes.some((item) => item.id !== sceneId && item.code === code)
    ) {
      set({ castError: `已经有「${code}」这一场了。` });
      return false;
    }
    const at = stamp();
    const written: ProjectEvent[] = [
      { type: "scene.updated", at, sceneId, patch: { code } },
    ];
    set({
      project: written.reduce(applyEvent, project),
      events: [...events, ...written],
      castError: undefined,
    });
    return true;
  },

  addLocation: (name, templateId, description) => {
    if (get().readOnly) return undefined;
    const { project, events } = get();
    const trimmed = name.trim();
    if (!trimmed) {
      set({ castError: "地点总得有个名字。" });
      return undefined;
    }
    if (project.locations.some((item) => item.name === trimmed)) {
      set({ castError: `已经有一个叫「${trimmed}」的地点了。` });
      return undefined;
    }
    const trimmedDescription = (description ?? "").trim();
    if (trimmedDescription.length > LOCATION_DESCRIPTION_MAX) {
      set({ castError: `场景描述太长了：${LOCATION_DESCRIPTION_MAX} 字以内。` });
      return undefined;
    }
    let id = `loc-${Date.now().toString(36)}`;
    while (project.locations.some((item) => item.id === id)) id += "x";
    const location: Location = {
      id,
      name: trimmed,
      description: trimmedDescription,
      referenceImages: [],
      ...(templateId ? { templateId } : {}),
    };
    const event: ProjectEvent = {
      type: "location.added",
      at: stamp(),
      location,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return id;
  },

  editLocation: (locationId, patch) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const location = project.locations.find((item) => item.id === locationId);
    if (!location) {
      set({ castError: "找不到这个地点。" });
      return false;
    }
    // 用 null 表示「清掉几何」：undefined 存进 JSON 就消失，回放会留下旧几何
    const next: Partial<Pick<Location, "name" | "templateId" | "description">> & {
      space?: Location["space"] | null;
    } = {};
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) {
        set({ castError: "地点总得有个名字。" });
        return false;
      }
      if (trimmed !== location.name) {
        if (project.locations.some((item) => item.id !== locationId && item.name === trimmed)) {
          set({ castError: `已经有一个叫「${trimmed}」的地点了。` });
          return false;
        }
        next.name = trimmed;
      }
    }
    if (patch.templateId !== undefined && patch.templateId !== location.templateId) {
      next.templateId = patch.templateId;
      // 换模板顺带换几何（B13.1）：新模板有坐标就写进 space，没有就清掉旧的，
      // 免得旧房间的锚点留在新模板上。作者改过的位置按锚点 id 保留（ADR-0126）。
      const template = sceneTemplateById(patch.templateId);
      next.space = template ? mergeTemplateSpace(location.space, templateSpace(template)) : null;
    } else if (patch.templateId !== undefined && !location.space) {
      // 存量项目：模板早就选好了，但那时还没有坐标（B13.1 之前）。
      // 作者再存一次名字 / 描述时顺手把几何补上，不用专门换一次模板。
      const template = sceneTemplateById(patch.templateId);
      if (template) next.space = templateSpace(template);
    }
    if (patch.space !== undefined) {
      next.space = patch.space;
    }
    if (patch.description !== undefined) {
      const trimmedDescription = patch.description.trim();
      if (trimmedDescription.length > LOCATION_DESCRIPTION_MAX) {
        set({ castError: `场景描述太长了：${LOCATION_DESCRIPTION_MAX} 字以内。` });
        return false;
      }
      if (trimmedDescription !== location.description) next.description = trimmedDescription;
    }
    if (Object.keys(next).length === 0) {
      set({ castError: "地点没改。" });
      return false;
    }
    const event: ProjectEvent = {
      type: "location.updated",
      at: stamp(),
      locationId,
      patch: next,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  addCharacter: (name, appearance) => {
    if (get().readOnly) return undefined;
    const { project, events } = get();
    const trimmed = name.trim();
    if (!trimmed) {
      set({ castError: "人物总得有个名字。" });
      return undefined;
    }
    if (project.characters.some((item) => item.name === trimmed)) {
      set({ castError: `已经有一个叫「${trimmed}」的人物了。` });
      return undefined;
    }
    const trimmedAppearance = (appearance ?? "").trim();
    if (trimmedAppearance.length > CHARACTER_APPEARANCE_MAX) {
      set({ castError: `外形描述太长了：${CHARACTER_APPEARANCE_MAX} 字以内。` });
      return undefined;
    }
    let id = `c-${Date.now().toString(36)}`;
    while (project.characters.some((item) => item.id === id)) id += "x";
    const character: Character = {
      id,
      name: trimmed,
      appearance: trimmedAppearance,
      sheet: {},
      referenceImages: [],
      mustNotChange: [],
    };
    const event: ProjectEvent = {
      type: "character.added",
      at: stamp(),
      character,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return id;
  },

  editCharacter: (characterId, patch) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const character = project.characters.find((item) => item.id === characterId);
    if (!character) {
      set({ castError: "找不到这个人物。" });
      return false;
    }
    const next: Partial<Pick<Character, "name" | "appearance">> = {};
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) {
        set({ castError: "人物总得有个名字。" });
        return false;
      }
      if (trimmed !== character.name) {
        if (project.characters.some((item) => item.id !== characterId && item.name === trimmed)) {
          set({ castError: `已经有一个叫「${trimmed}」的人物了。` });
          return false;
        }
        next.name = trimmed;
      }
    }
    if (patch.appearance !== undefined) {
      const trimmed = patch.appearance.trim();
      if (trimmed.length > CHARACTER_APPEARANCE_MAX) {
        set({ castError: `外形描述太长了：${CHARACTER_APPEARANCE_MAX} 字以内。` });
        return false;
      }
      if (trimmed !== character.appearance) next.appearance = trimmed;
    }
    if (Object.keys(next).length === 0) {
      set({ castError: "人物没改。" });
      return false;
    }
    const event: ProjectEvent = {
      type: "character.updated",
      at: stamp(),
      characterId,
      patch: next,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  addMustNotChange: (characterId, rawText) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const character = project.characters.find((item) => item.id === characterId);
    if (!character) {
      set({ castError: "找不到这个人物。" });
      return false;
    }
    const text = rawText.trim();
    if (!text) {
      set({ castError: "这一条是空的。" });
      return false;
    }
    if (text.length > MUST_NOT_CHANGE_MAX) {
      set({ castError: `这一条太长了：${MUST_NOT_CHANGE_MAX} 字以内。` });
      return false;
    }
    if (character.mustNotChange.includes(text)) {
      set({ castError: `已经有一条「${text}」了。` });
      return false;
    }
    if (character.mustNotChange.length >= MUST_NOT_CHANGE_COUNT_MAX) {
      set({
        castError: `「不许变」最多 ${MUST_NOT_CHANGE_COUNT_MAX} 条：再多会把镜头指令挤掉。`,
      });
      return false;
    }
    const event: ProjectEvent = {
      type: "character.updated",
      at: stamp(),
      characterId,
      patch: { mustNotChange: [...character.mustNotChange, text] },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  removeMustNotChange: (characterId, text) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const character = project.characters.find((item) => item.id === characterId);
    if (!character) {
      set({ castError: "找不到这个人物。" });
      return false;
    }
    if (!character.mustNotChange.includes(text)) return false;
    const event: ProjectEvent = {
      type: "character.updated",
      at: stamp(),
      characterId,
      patch: { mustNotChange: character.mustNotChange.filter((item) => item !== text) },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  addCharacterReference: (characterId, rawUri) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const character = project.characters.find((item) => item.id === characterId);
    if (!character) {
      set({ castError: "找不到这个人物。" });
      return false;
    }
    if (character.referenceImages.length >= REFERENCE_IMAGES_MAX) {
      set({ castError: `参考图最多 ${REFERENCE_IMAGES_MAX} 张：再多会把提示词挤爆。` });
      return false;
    }
    const at = stamp();
    const { asset, error } = makeReferenceAsset(rawUri, project.assets, at);
    if (!asset) {
      set({ castError: error ?? "这张图挂不上。" });
      return false;
    }
    const existing = project.assets.filter((item) => character.referenceImages.includes(item.id));
    if (existing.some((item) => item.uri === asset.uri)) {
      set({ castError: "这张图已经挂过了。" });
      return false;
    }
    const written: ProjectEvent[] = [
      { type: "asset.updated", at, asset },
      {
        type: "character.updated",
        at,
        characterId,
        patch: { referenceImages: [...character.referenceImages, asset.id] },
      },
    ];
    set({
      project: written.reduce(applyEvent, project),
      events: [...events, ...written],
      castError: undefined,
    });
    return true;
  },

  removeCharacterReference: (characterId, assetId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const character = project.characters.find((item) => item.id === characterId);
    if (!character || !character.referenceImages.includes(assetId)) return false;
    const event: ProjectEvent = {
      type: "character.updated",
      at: stamp(),
      characterId,
      patch: { referenceImages: character.referenceImages.filter((id) => id !== assetId) },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  addPropReference: (propId, rawUri) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const prop = project.props.find((item) => item.id === propId);
    if (!prop) {
      set({ castError: "找不到这件道具。" });
      return false;
    }
    if (prop.referenceImages.length >= REFERENCE_IMAGES_MAX) {
      set({ castError: `参考图最多 ${REFERENCE_IMAGES_MAX} 张：再多会把提示词挤爆。` });
      return false;
    }
    const at = stamp();
    const { asset, error } = makeReferenceAsset(rawUri, project.assets, at);
    if (!asset) {
      set({ castError: error ?? "这张图挂不上。" });
      return false;
    }
    const existing = project.assets.filter((item) => prop.referenceImages.includes(item.id));
    if (existing.some((item) => item.uri === asset.uri)) {
      set({ castError: "这张图已经挂过了。" });
      return false;
    }
    const written: ProjectEvent[] = [
      { type: "asset.updated", at, asset },
      {
        type: "prop.updated",
        at,
        propId,
        patch: { referenceImages: [...prop.referenceImages, asset.id] },
      },
    ];
    set({
      project: written.reduce(applyEvent, project),
      events: [...events, ...written],
      castError: undefined,
    });
    return true;
  },

  removePropReference: (propId, assetId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const prop = project.props.find((item) => item.id === propId);
    if (!prop || !prop.referenceImages.includes(assetId)) return false;
    const event: ProjectEvent = {
      type: "prop.updated",
      at: stamp(),
      propId,
      patch: { referenceImages: prop.referenceImages.filter((id) => id !== assetId) },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  addProp: (name, description) => {
    if (get().readOnly) return undefined;
    const { project, events } = get();
    const trimmed = name.trim();
    if (!trimmed) {
      set({ castError: "道具总得有个名字。" });
      return undefined;
    }
    if (project.props.some((item) => item.name === trimmed)) {
      set({ castError: `已经有一件叫「${trimmed}」的道具了。` });
      return undefined;
    }
    const trimmedDescription = (description ?? "").trim();
    if (trimmedDescription.length > PROP_DESCRIPTION_MAX) {
      set({ castError: `道具描述太长了：${PROP_DESCRIPTION_MAX} 字以内。` });
      return undefined;
    }
    let id = `p-${Date.now().toString(36)}`;
    while (project.props.some((item) => item.id === id)) id += "x";
    const prop: Prop = {
      id,
      name: trimmed,
      description: trimmedDescription,
      referenceImages: [],
    };
    const event: ProjectEvent = {
      type: "prop.added",
      at: stamp(),
      prop,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return id;
  },

  editProp: (propId, patch) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const prop = project.props.find((item) => item.id === propId);
    if (!prop) {
      set({ castError: "找不到这件道具。" });
      return false;
    }
    const next: Partial<Pick<Prop, "name" | "description">> = {};
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) {
        set({ castError: "道具总得有个名字。" });
        return false;
      }
      if (trimmed !== prop.name) {
        if (project.props.some((item) => item.id !== propId && item.name === trimmed)) {
          set({ castError: `已经有一件叫「${trimmed}」的道具了。` });
          return false;
        }
        next.name = trimmed;
      }
    }
    if (patch.description !== undefined) {
      const trimmed = patch.description.trim();
      if (trimmed.length > PROP_DESCRIPTION_MAX) {
        set({ castError: `道具描述太长了：${PROP_DESCRIPTION_MAX} 字以内。` });
        return false;
      }
      if (trimmed !== prop.description) next.description = trimmed;
    }
    if (Object.keys(next).length === 0) {
      set({ castError: "道具没改。" });
      return false;
    }
    const event: ProjectEvent = {
      type: "prop.updated",
      at: stamp(),
      propId,
      patch: next,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  removeCharacter: (characterId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const character = project.characters.find((item) => item.id === characterId);
    if (!character) {
      set({ castError: "找不到这个人物。" });
      return false;
    }
    const inShots = project.shots.filter((shot) => shot.characterIds.includes(characterId));
    if (inShots.length > 0) {
      set({
        castError: `「${character.name}」还在 ${inShots.length} 镜的出场里：先去分镜页把他点掉（有台词的要先换人）。`,
      });
      return false;
    }
    const speaking = project.dialogue.filter((line) => line.characterId === characterId);
    if (speaking.length > 0) {
      set({ castError: `「${character.name}」还有 ${speaking.length} 句台词：先删掉或换人。` });
      return false;
    }
    const event: ProjectEvent = {
      type: "character.removed",
      at: stamp(),
      characterId,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  removeProp: (propId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const prop = project.props.find((item) => item.id === propId);
    if (!prop) {
      set({ castError: "找不到这件道具。" });
      return false;
    }
    const used = project.shots.filter((shot) => shot.propIds.includes(propId));
    if (used.length > 0) {
      set({
        castError: `「${prop.name}」还在 ${used.length} 镜里：先去分镜页把它点掉，再删。`,
      });
      return false;
    }
    const event: ProjectEvent = {
      type: "prop.removed",
      at: stamp(),
      propId,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  startProjectFromStory: (draft, meta) => {
    if (get().readOnly) {
      set({ castError: "另一个标签页在编辑：这一页只读，开不了新项目。" });
      return false;
    }
    const { project, events } = get();
    const at = stamp();
    let next: Project;
    try {
      next = projectFromStoryDraft(draft, {
        id: `proj-${Date.now().toString(36)}`,
        at,
        modelId: meta.modelId,
        idea: meta.idea,
        budgetCny: project.budgetCny,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "故事结构不合法";
      set({ castError: `故事没能开工：${detail.slice(0, 240)}` });
      return false;
    }

    // 开新项目 = 在日志末尾再写一条 project.created。旧事件仍留在本地，
    // 但从这一条开始回放，界面只看到新项目（ADR-0088）。
    const event: ProjectEvent = { type: "project.created", at, project: next };
    const applied = applyEvent(project, event);
    set({
      project: applied,
      events: [...events, event],
      currentShotId: firstOpenShotId(applied),
      jobs: {},
      batch: undefined,
      castError: undefined,
      lastSwap: undefined,
      asrResult: undefined,
      editError: undefined,
    });
    return true;
  },

  editStory: (patch) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const story = project.story;
    // 没有实质变化就不写：历史里塞满「改故事：梗概」而内容没动，等于噪音
    const same =
      (patch.logline === undefined || patch.logline.trim() === story.logline) &&
      (patch.synopsis === undefined || patch.synopsis.trim() === story.synopsis) &&
      (patch.genre === undefined || patch.genre.trim() === story.genre) &&
      (patch.audience === undefined || patch.audience.trim() === story.audience) &&
      (patch.tone === undefined || patch.tone.trim() === story.tone) &&
      (patch.openingHook === undefined ||
        patch.openingHook.trim() === story.hooks.opening) &&
      (patch.endingHook === undefined || patch.endingHook.trim() === story.hooks.ending);
    if (same && patch.arcs === undefined && patch.relationships === undefined) {
      set({ castError: "故事没改。" });
      return false;
    }
    const event: ProjectEvent = { type: "story.updated", at: stamp(), patch };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        castError: undefined,
      });
      return true;
    } catch (error) {
      set({
        castError: error instanceof Error ? error.message : "故事没改成。",
      });
      return false;
    }
  },

  editArc: (characterId, patch) => {
    if (get().readOnly) return false;
    const { project } = get();
    const arcs = project.story.arcs;
    const index = arcs.findIndex((arc) => arc.characterId === characterId);
    if (index < 0) {
      set({ castError: "这个角色还没有弧光。" });
      return false;
    }
    const current = arcs[index]!;
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(
      (key) => patch[key] !== undefined && patch[key] !== current[key],
    );
    if (!changed) {
      set({ castError: "弧光没改。" });
      return false;
    }
    const next = arcs.map((arc, at) =>
      at === index ? { ...arc, ...patch } : arc,
    );
    return get().editStory({ arcs: next });
  },

  editRelationship: (fromCharacterId, toCharacterId, rawTension) => {
    if (get().readOnly) return false;
    const { project } = get();
    const tension = rawTension.trim();
    const relations = project.story.relationships;
    const index = relations.findIndex(
      (relation) =>
        relation.fromCharacterId === fromCharacterId &&
        relation.toCharacterId === toCharacterId,
    );
    if (tension.length === 0) {
      if (index < 0) {
        set({ castError: "没有这条关系。" });
        return false;
      }
      return get().editStory({
        relationships: relations.filter((_, at) => at !== index),
      });
    }
    if (index >= 0 && relations[index]!.tension === tension) {
      set({ castError: "关系没改。" });
      return false;
    }
    const next =
      index >= 0
        ? relations.map((relation, at) =>
            at === index ? { ...relation, tension } : relation,
          )
        : [...relations, { fromCharacterId, toCharacterId, tension }];
    return get().editStory({ relationships: next });
  },

  addScene: (locationId, afterSceneId) => {
    if (get().readOnly) return undefined;
    const { project, events } = get();
    const ordered = [...project.scenes].sort((a, b) => a.index - b.index);
    // 插在指定场之后；没指定就接在末尾（ADR-0068）
    const at = afterSceneId
      ? ordered.findIndex((item) => item.id === afterSceneId)
      : ordered.length;
    if (at < 0) {
      set({ castError: "找不到这一场。" });
      return undefined;
    }
    // 新场默认沿用插入点前面那一场的地点、内外景与日夜（ADR-0069）；
    // 还没有场次时退回第一个地点
    const index = afterSceneId ? at + 1 : at;
    const previous = ordered[index - 1];
    const target = locationId ?? previous?.locationId ?? project.locations[0]?.id;
    if (!target) {
      set({ castError: "还没有地点：先去定妆页建一个，场次才有地方发生。" });
      return undefined;
    }
    if (!project.locations.some((item) => item.id === target)) {
      set({ castError: "找不到这个地点。" });
      return undefined;
    }
    let id = `sc-${Date.now().toString(36)}`;
    while (project.scenes.some((item) => item.id === id)) id += "x";
    const scene: Scene = {
      id,
      index,
      code: "",
      locationId: target,
      space: previous?.space ?? "int",
      timeOfDay: previous?.timeOfDay ?? "day",
      shotIds: [],
    };
    const event: ProjectEvent = {
      type: "scene.added",
      at: stamp(),
      scene,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return id;
  },

  addShot: (sceneId, afterShotId) => {
    if (get().readOnly) return undefined;
    const { project, events } = get();
    const scene = project.scenes.find((item) => item.id === sceneId);
    if (!scene) {
      set({ castError: "找不到这一场。" });
      return undefined;
    }
    // 插在指定镜之后；没指定就接在这一场末尾（ADR-0068）
    const after = afterShotId ? scene.shotIds.indexOf(afterShotId) : scene.shotIds.length - 1;
    if (afterShotId && after < 0) {
      set({ castError: "找不到这一镜。" });
      return undefined;
    }
    const index = after + 1;
    let id = `s-${Date.now().toString(36)}`;
    while (project.shots.some((item) => item.id === id)) id += "x";
    const shot: Shot = {
      id,
      sceneId,
      index,
      durationMs: NEW_SHOT_DURATION_MS,
      description: "",
      promptNotes: [],
      shotSize: "medium",
      camera: { angle: "eye", movement: "static", focalMm: 35 },
      characterIds: [],
      propIds: [],
      dialogueIds: [],
      takeIds: [],
      staging: [],
      keyframes: {},
      locked: false,
    };
    const event: ProjectEvent = {
      type: "shot.added",
      at: stamp(),
      shot,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return id;
  },

  removeShot: (shotId) => {
    if (get().readOnly) return false;
    const { project, events, currentShotId } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定：先解锁再删。" });
      return false;
    }

    // 删掉当前这一镜时，选中挪到下一格；没有下一格就退回上一格
    const ordered = toStageView(project).shots;
    const at = ordered.findIndex((item) => item.id === shotId);
    const neighbour = at >= 0 ? (ordered[at + 1] ?? ordered[at - 1])?.id : undefined;
    const event: ProjectEvent = {
      type: "shot.removed",
      at: stamp(),
      shotId,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      currentShotId: currentShotId === shotId ? (neighbour ?? "") : currentShotId,
      castError: undefined,
    });
    return true;
  },

  removeScene: (sceneId) => {
    if (get().readOnly) return false;
    const { project, events, currentShotId } = get();
    const scene = project.scenes.find((item) => item.id === sceneId);
    if (!scene) {
      set({ castError: "找不到这一场。" });
      return false;
    }
    const shots = scene.shotIds
      .map((id) => project.shots.find((item) => item.id === id))
      .filter((item): item is Shot => Boolean(item));
    const locked = shots.find((item) => item.locked);
    if (locked) {
      const no = toStageView(project).shots.find((item) => item.id === locked.id)?.no ?? 0;
      set({
        castError: `这一场里的第 ${no} 镜（${shotLabel(no)}）已锁定：先解锁再删这一场。`,
      });
      return false;
    }

    // 先逐镜删、再删场：回放到任一前缀都不会留下挂在不存在的场上的镜头
    const at = stamp();
    const written: ProjectEvent[] = [
      ...shots.map(
        (item): ProjectEvent => ({ type: "shot.removed", at, shotId: item.id }),
      ),
      { type: "scene.removed", at, sceneId },
    ];
    const next = written.reduce(applyEvent, project);
    const remains = next.shots.map((item) => item.id);
    const currentRemoved = !remains.includes(currentShotId);
    const fallback = currentRemoved
      ? (toStageView(next).shots.find((item) => item.state === "open")?.id ?? remains[0] ?? "")
      : currentShotId;
    set({
      project: next,
      events: [...events, ...written],
      currentShotId: fallback,
      castError: undefined,
    });
    return true;
  },

  moveScene: (sceneId, direction) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const ordered = [...project.scenes].sort((a, b) => a.index - b.index);
    const from = ordered.findIndex((scene) => scene.id === sceneId);
    if (from < 0) {
      set({ castError: "找不到这一场。" });
      return false;
    }
    const toIndex = from + (direction === "up" ? -1 : 1);
    if (toIndex < 0 || toIndex >= ordered.length) {
      set({ castError: direction === "up" ? "已经是第一场。" : "已经是最后一场。" });
      return false;
    }
    return get().moveSceneTo(sceneId, toIndex);
  },

  moveSceneTo: (sceneId, toIndex) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const ordered = [...project.scenes].sort((a, b) => a.index - b.index);
    const from = ordered.findIndex((scene) => scene.id === sceneId);
    if (from < 0) {
      set({ castError: "找不到这一场。" });
      return false;
    }
    if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= ordered.length) {
      set({ castError: "没有这个位置。" });
      return false;
    }
    if (toIndex === from) {
      set({ castError: "场次已经在这个位置。" });
      return false;
    }
    const event: ProjectEvent = {
      type: "scene.moved",
      at: stamp(),
      sceneId,
      toIndex,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  removeLocation: (locationId, moveToId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const location = project.locations.find((item) => item.id === locationId);
    if (!location) {
      set({ castError: "找不到这个地点。" });
      return false;
    }
    const used = project.scenes.filter((scene) => scene.locationId === locationId);
    // 被场次占着：先整批搬走，再删；顺序不能反，回放到任一前缀都不会有悬挂引用
    if (used.length > 0) {
      if (!moveToId) {
        set({
          castError: `还有 ${used.length} 场在「${location.name}」：先把它们搬到别的地点再删。`,
        });
        return false;
      }
      const target = project.locations.find((item) => item.id === moveToId);
      if (!target || target.id === locationId) {
        set({ castError: "搬不到这个地点。" });
        return false;
      }
      const at = stamp();
      const written: ProjectEvent[] = [
        ...used.map(
          (scene): ProjectEvent => ({
            type: "scene.updated",
            at,
            sceneId: scene.id,
            patch: { locationId: moveToId },
          }),
        ),
        { type: "location.removed", at, locationId },
      ];
      set({
        project: written.reduce(applyEvent, project),
        events: [...events, ...written],
        castError: undefined,
      });
      return true;
    }
    const event: ProjectEvent = {
      type: "location.removed",
      at: stamp(),
      locationId,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  undoLastRemoval: () => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const target = undoableRemoval(events, project);
    if (!target) {
      set({ castError: "没有可撤销的删除。" });
      return false;
    }
    // 删除之前的那一份项目：被删对象与它的从属物都还在里面
    const before = rebuild(events.slice(0, target.index));

    try {
      const { written, focusShotId } = removalUndoEvents(
        before,
        project,
        target,
        stamp(),
      );
      set({
        project: written.reduce(applyEvent, project),
        events: [...events, ...written],
        castError: undefined,
        ...(focusShotId ? { currentShotId: focusShotId } : {}),
      });
      return true;
    } catch (error) {
      set({
        castError:
          error instanceof Error ? `撤销不了这次删除：${error.message}` : "撤销不了这次删除。",
      });
      return false;
    }
  },

  restoreRemovalAt: (index) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const event = events[index];
    const target = event ? removalTargetOf(event) : undefined;
    if (!target) {
      set({ historyNotice: "这一步不是删除，回收站只能放回删掉的东西。" });
      return false;
    }
    if (removalAlive(project, target.kind, target.id)) {
      set({ historyNotice: "它已经在项目里了。" });
      return false;
    }
    const before = rebuild(events.slice(0, index));
    try {
      const { written, focusShotId } = removalUndoEvents(
        before,
        project,
        target,
        stamp(),
      );
      set({
        project: written.reduce(applyEvent, project),
        events: [...events, ...written],
        castError: undefined,
        historyNotice: "已从回收站放回。",
        ...(focusShotId ? { currentShotId: focusShotId } : {}),
      });
      return true;
    } catch (error) {
      set({
        historyNotice:
          error instanceof Error ? `放不回来：${error.message}` : "放不回来。",
      });
      return false;
    }
  },

  undo: () => {
    if (get().readOnly) return false;
    const { events } = get();
    const step = nextUndo(events, buildHistory(events));
    if (!step) {
      set({ historyNotice: "已经退到最早，没有更早的改动可撤。" });
      return false;
    }
    return get().restoreTo(step.toEventCount, `撤销：${step.label}`);
  },

  restoreTo: (toEventCount, label) => {
    if (get().readOnly) return false;
    const { events } = get();
    if (
      !Number.isInteger(toEventCount) ||
      toEventCount < 1 ||
      toEventCount > events.length
    ) {
      set({ historyNotice: "回滚的位置不在日志里。" });
      return false;
    }
    // 已经在这一步：不写多余的回滚事件。最后一条是回滚时，它指向的位置就是当前
    if (toEventCount === historyPosition(events) && events.at(-1)?.type !== "project.restored") {
      set({ historyNotice: "已经是这一步了。" });
      return false;
    }

    const event: ProjectEvent = {
      type: "project.restored",
      at: stamp(),
      toEventCount,
      ...(label ? { label } : {}),
    };
    const nextEvents = [...events, event];
    try {
      const restored = rebuild(nextEvents);
      set({
        project: restored,
        events: nextEvents,
        currentShotId: restored.shots.some((shot) => shot.id === get().currentShotId)
          ? get().currentShotId
          : firstOpenShotId(restored),
        lastSwap: undefined,
        castError: undefined,
        historyNotice: label ?? `回到第 ${toEventCount} 条事件之后`,
      });
      return true;
    } catch (error) {
      set({
        historyNotice:
          error instanceof Error ? `回滚失败：${error.message}` : "回滚失败。",
      });
      return false;
    }
  },

  addDialogue: (shotId, characterId, rawText) => {
    if (get().readOnly) return false;
    const text = rawText.replace(/\s+$/, "");
    if (text.length === 0) {
      set({ castError: "台词不能是空的。" });
      return false;
    }
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) return false;
    if (shot.locked) {
      set({ castError: "这一镜已锁定：要加台词先解锁。" });
      return false;
    }
    if (!project.characters.some((item) => item.id === characterId)) {
      set({ castError: "找不到这个说话人。" });
      return false;
    }

    const at = stamp();
    const line = {
      id: `d-${shotId}-${crypto.randomUUID().slice(0, 8)}`,
      characterId,
      text,
      durationMs: estimateDialogueMs(text),
    };
    const next: ProjectEvent[] = [
      { type: "dialogue.added", at, shotId, line },
      {
        type: "shot.updated",
        at,
        shotId,
        patch: { durationMs: shot.durationMs + line.durationMs },
      },
    ];
    set({
      project: next.reduce(applyEvent, project),
      events: [...events, ...next],
      castError: undefined,
    });
    return true;
  },

  removeDialogue: (lineId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const line = project.dialogue.find((item) => item.id === lineId);
    if (!line) return false;
    const shot = project.shots.find((item) => item.dialogueIds.includes(lineId));
    if (shot?.locked) {
      set({ castError: "这一镜已锁定：要删台词先解锁。" });
      return false;
    }

    const at = stamp();
    const next: ProjectEvent[] = [{ type: "dialogue.removed", at, lineId }];
    if (shot) {
      next.push({
        type: "shot.updated",
        at,
        shotId: shot.id,
        patch: { durationMs: Math.max(500, shot.durationMs - line.durationMs) },
      });
    }
    set({
      project: next.reduce(applyEvent, project),
      events: [...events, ...next],
      castError: undefined,
    });
    return true;
  },

  changeSpeaker: (lineId, characterId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const line = project.dialogue.find((item) => item.id === lineId);
    if (!line) return false;
    const shot = project.shots.find((item) => item.dialogueIds.includes(lineId));
    if (shot?.locked) {
      set({ castError: "这一镜已锁定：要换说话人先解锁。" });
      return false;
    }
    if (!project.characters.some((item) => item.id === characterId)) {
      set({ castError: "找不到这个说话人。" });
      return false;
    }
    if (line.characterId === characterId) return false;

    const event: ProjectEvent = {
      type: "dialogue.speaker.updated",
      at: stamp(),
      lineId,
      characterId,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  moveDialogue: (lineId, direction) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.dialogueIds.includes(lineId));
    if (!shot) return false;
    if (shot.locked) {
      set({ castError: "这一镜已锁定：要调顺序先解锁。" });
      return false;
    }

    const ids = [...shot.dialogueIds];
    const from = ids.indexOf(lineId);
    const to = direction === "up" ? from - 1 : from + 1;
    if (to < 0 || to >= ids.length) return false;
    const [moved] = ids.splice(from, 1);
    if (!moved) return false;
    ids.splice(to, 0, moved);

    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId: shot.id,
      patch: { dialogueIds: ids },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  instruct: (text) => {
    if (get().readOnly) return false;
    const { project, currentShotId, events } = get();
    const shot = project.shots.find((item) => item.id === currentShotId);
    if (!shot) return false;
    // 锁定的镜头只读：与生成一致，要改先解锁
    if (shot.locked) return false;

    const parsed = parseInstruction(text, shot);
    if (!parsed) {
      set({
        castError:
          "没听懂这句。现在认得：太暗了 / 太亮 / 换个角度 / 靠近一点 / 拉远 / 手持 / 稳住 / 快一点 / 慢一点。",
      });
      return false;
    }

    // 只写这次真的改了的字段；同样的补充不重复追加
    const patch: Partial<Shot> = {};
    if (parsed.shotSize) patch.shotSize = parsed.shotSize;
    if (parsed.camera) patch.camera = parsed.camera;
    if (parsed.durationMs) patch.durationMs = parsed.durationMs;
    if (parsed.note && !shot.promptNotes.includes(parsed.note)) {
      patch.promptNotes = [...shot.promptNotes, parsed.note];
    }
    if (Object.keys(patch).length === 0) {
      set({ castError: "这句没改动什么：镜头已经是这样了。" });
      return false;
    }

    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId: shot.id,
      patch,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  removeNote: (shotId, note) => {
    if (get().readOnly) return;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot || shot.locked) return;
    if (!shot.promptNotes.includes(note)) return;

    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId: shot.id,
      patch: { promptNotes: shot.promptNotes.filter((item) => item !== note) },
    };
    set({ project: applyEvent(project, event), events: [...events, event] });
  },

  generateProp: async (propId) => {
    if (get().readOnly) return;
    const { project } = get();
    const prop = project.props.find((item) => item.id === propId);
    if (!prop) return;
    if (isLocked(project, "prop", propId)) return;
    if (prop.referenceImages.length >= REFERENCE_IMAGES_MAX) {
      set({ castError: `参考图最多 ${REFERENCE_IMAGES_MAX} 张：再多会把提示词挤爆。` });
      return;
    }

    // 每生成一张就往后挂一张，不覆盖已有的参考图（ADR-0079）
    let assetId = `a-ref-${Date.now().toString(36)}`;
    while (project.assets.some((item) => item.id === assetId)) assetId += "x";

    set({ castError: undefined });
    await generateOne(
      { get, set },
      {
        key: propId,
        label: prop.name,
        assetId,
        job: { kind: "prop" },
        body: {
          kind: "prop",
          prop: { name: prop.name, description: prop.description },
        },
        after: (id, at) => ({
          type: "prop.updated",
          at,
          propId,
          patch: { referenceImages: [...prop.referenceImages, id] },
        }),
      },
    );
  },

  assetInventory: () => inventoryOf(get().project),
  migrateAssets: async () => {
    if (get().readOnly) return { moved: 0, failed: 0, bytes: 0 };
    let moved = 0;
    let failed = 0;
    let bytes = 0;
    // 逐个搬、逐个写事件：中途失败也能停在半个项目的状态上，而不是全丢
    const targets = get().project.assets.filter(
      (asset) => asset.uri && !isStoredAssetUri(asset.uri) && asset.uri.startsWith("data:"),
    );
    for (const asset of targets) {
      const uri = await persistAsset(asset.uri!, { force: true });
      if (!isStoredAssetUri(uri)) {
        failed += 1;
        continue;
      }
      const { project, events } = get();
      const current = project.assets.find((item) => item.id === asset.id);
      if (!current || current.uri === uri) continue;
      const event: ProjectEvent = {
        type: "asset.updated",
        at: stamp(),
        asset: { ...current, uri },
      };
      set({
        project: applyEvent(project, event),
        events: [...events, event],
      });
      moved += 1;
      bytes += inlineBytesOf(asset.uri);
    }
    return { moved, failed, bytes };
  },

  reset: () => {
    // 只读标签页不能把别人的项目覆盖掉（H18）
    if (get().readOnly) return;
    const project = applyEvent(null, initialEvents[0]!);
    set({
      project,
      events: bootstrap(project),
      currentShotId: initialShotId,
      jobs: {},
      batch: undefined,
      castError: undefined,
      lastSwap: undefined,
      asrResult: undefined,
      editError: undefined,
      lockedNotice: undefined,
    });
  },
  });
});

/**
 * 事件日志同步到本地（ADR-0034）。
 *
 * 只追加时一条一条写，重来一遍时整份覆盖：一次决策不该重写上百 MB 的图片。
 */
useWorkbench.subscribe((state, prev) => {
  if (!ready || state.events === prev.events) return;
  const sync = diffEvents(prev.events, state.events);
  if (sync.kind === "none") return;

  const log = getEventLog();
  void (async () => {
    try {
      if (sync.kind === "append") {
        for (const event of sync.events) await log.append(event);
      } else {
        await log.replace(state.events);
      }
      if (useWorkbench.getState().storageError) {
        useWorkbench.setState({ storageError: undefined });
      }
    } catch (error) {
      useWorkbench.setState({ storageError: storageMessage(error) });
    }
  })();
});
