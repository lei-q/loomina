"use client";

import {
  applyEvent,
  castReadiness,
  BlockingSchema,
  blockingProblem,
  CompositionSchema,
  FrameSchema,
  GradeSchema,
  LightingSchema,
  LookSchema,
  PerformanceSpecSchema,
  placementProblem,
  ProjectSchema,
  rebuild,
  REFERENCE_IMAGES_MAX,
  RightsRecordSchema,
  sheetSlotAssets,
  sheetSlotsOf,
  SHEET_ANGLES,
  SHEET_LABELS,
  ShotFocusSchema,
  shotAnchors,
  StagingMarkSchema,
  TransitionSchema,
  VOICE_PROFILE_MAX,
  type ApprovalTargetType,
  type Asset,
  type AudioMix,
  type BeatKind,
  type Character,
  type Composition,
  type Frame as FrameSetting,
  type GateStage,
  type Grade,
  type Lighting,
  type Location,
  type Look,
  type Motif,
  type MusicCue,
  type Blocking,
  type Camera,
  type CameraPlacement,
  type PerformanceSpec,
  type Project,
  type Prop,
  type ProjectEvent,
  type PublishPackage,
  type RightsRecordInput,
  type Scene,
  type SheetView,
  type SfxCue,
  type Shot,
  type ShotFocus,
  type ShotPurpose,
  type StagingMark,
  type StoryArc,
  type StoryRelationship,
  type TimelineItem,
  type Transition,
  type VoicePerformance,
  type VoiceTake,
  type SourceDocument,
} from "@loomina/ir";
import {
  parseInstruction,
  projectFromStoryDraft,
  projectFromVerbatimDocument,
  mergeTemplateSpace,
  sceneTemplateById,
  matchShotLanguage,
  shotLanguageById,
  shotLanguagePatch,
  shotMaterial,
  templateSpace,
  type Frame,
  type StoryDraft,
} from "@loomina/pipeline";
import { create } from "zustand";
import {
  diffEvents,
  getEventLog,
  hasWorkspaces,
  indexedDbLog,
  indexedDbLogFor,
  listWorkspaces,
  migrateLog,
  rememberWorkspace,
  rememberedWorkspace,
  saveWorkspace,
  setEventLog,
  type WorkspaceMeta,
} from "@/lib/event-log";
import { estimateDialogueMs } from "@/lib/dialogue";
import type { DoctorRewriteItem } from "@/lib/doctor-ai";
import { askInstructionAi, describeAiPatch, shotSnapshotOf } from "@/lib/instruction-ai";
import { autoCut, timelineEquals } from "@/lib/edit";
import { planMusicFill } from "@/lib/music-curve";
import { instructionsOf, performanceOf } from "@/lib/voice-performance";
import { buildHistory, historyPosition, nextUndo } from "@/lib/history";
import { storyRestorePatch, storyVersionsOf } from "@/lib/story-versions";
import { sharedEntityImport, type SharedEntity } from "@/lib/shared-entities";
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
import {
  inlineBytesOf,
  inventoryOf,
  referencedAssetIds,
  type AssetInventory,
} from "@/lib/asset-inventory";
import { isRemoteAssetUri, isStoredAssetUri } from "@/lib/asset-uri";
import { projectFromTemplate, type ProjectTemplate } from "@/lib/project-template";
import {
  compactEvents,
  inlinePayloadsOf,
  logBytesOf,
  replacementsFor,
  storedIndexOf,
} from "@/lib/log-compact";
import { modelIdFor } from "@/lib/model-choice";
import type { Modality } from "@/lib/config-types";
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

/** 手改过的提示词（ADR-0148）：没有就什么都不加，让服务端按默认那段生成 */
function withPromptOverride(
  get: () => WorkbenchState,
  key: string,
): { prompt?: string } {
  const prompt = get().promptOverrides[key]?.trim();
  return prompt ? { prompt } : {};
}

/**
 * 把资产 id 变成「随请求发出去的参考图」（B2 / ADR-0162）。
 *
 * 只收有地址的图；缺的、不是图的都跳过——服务端还会再按字节校验一次，
 * 这里少带一张比带一个空地址更安全。最多 4 张，与 `MAX_REFERENCES` 对齐。
 */
function referenceImagesOf(
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

function clipReason(reason: string): string {
  return reason.length > 240 ? `${reason.slice(0, 240)}…` : reason;
}

/**
 * 出图之后那句「参考图到底发出去没有」（B2 / ADR-0162）。
 *
 * 三种情况分开说：真的带上了、读不到字节所以少带、供应商不收于是退回纯文生图。
 * 没说清的话，作者会以为身份一致性已经靠参考图锁住了（准则 P3 / P15）。
 */
function referenceNotice(
  result: { mode?: "edits" | "prompt-only"; sent?: number; missing?: string[] } | undefined,
): string | undefined {
  if (!result) return undefined;
  const sent = result.sent ?? 0;
  const missing = result.missing ?? [];
  if (result.mode === "edits" && sent > 0) {
    const tail = missing.length ? `；另有 ${missing.length} 张读不到字节没发出去（${missing.join("、")}）` : "";
    return `已带 ${sent} 张参考图生成${tail}。`;
  }
  if (missing.length > 0) {
    return `参考图读不到字节（${missing.join("、")}），这一张按纯文生图生成。`;
  }
  return "这一张按纯文生图生成：供应商没有接收参考图。";
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
  /** 当前工作空间（C3 / ADR-0188）：每个空间的日志各自独立 */
  workspaceId: string;
  /** 本机的工作空间列表：顶栏切换用 */
  workspaces: WorkspaceMeta[];
  /** 工作空间操作失败的原因 */
  workspaceError?: string;
  currentShotId: string;
  /** 正在生成哪一张：人物 / 场景 / 道具的 id → 任务。出图是分钟级，界面要如实显示进度 */
  jobs: Record<string, GenerateJob | undefined>;
  castError?: string;
  /**
   * 出图成功但有一句要说的话（B2 / ADR-0162）：例如「参考图没发出去，退回纯文生图」。
   * 与 `castError` 分开：这不是失败，别让作者以为这张没出。
   */
  generationNotice?: string;
  /** 模型读懂了哪句（H19）：成功才写，不是错误 */
  instructionNotice?: string;
  /** 正在等模型回话：按钮转圈，防重复点 */
  instructionBusy?: boolean;
  /** 历史抽屉的一句话：刚撤销了什么 / 回滚到了哪一步（F2 / ADR-0109） */
  historyNotice?: string;
  /** 故事版本库的一句话：恢复了哪一版、有几条带不回来（C2） */
  storyNotice?: string;
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
  /**
   * 手改过的模型提示词（ADR-0148）：`阶段:对象[:格]` → 文本。
   *
   * 只影响之后这一次生成，不写事件、不进 IR：它是「这一次想怎么说」，
   * 不是项目事实；刷新就回到代码拼出来的默认提示词。
   */
  promptOverrides: Record<string, string>;
  /** 改 / 清（null）一份提示词：清掉就是恢复默认 */
  setPromptOverride: (key: string, value: string | null) => void;
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
  /** 固定 / 取消固定本项目某个模态的模型（H22）：写一条 `project.updated`；null 取消 */
  setModelPin: (modality: Modality, id: string | null) => void;
  /**
   * 改画面风格与摄影参数（B7 / I5，ADR-0165）：整块写一条 `project.updated`。
   * 改完下一次出图就用新的最后一句；已出的图不会自动重做。
   */
  setLook: (look: Look) => boolean;
  /**
   * 改调色（E4 / ADR-0169）：整块写一条 `project.updated { grade }`。
   * 只影响导出，不影响提示词——已出的图不用重做。
   */
  setGrade: (grade: Grade) => boolean;
  /**
   * 导入一份 .cube 调色表（I3 / ADR-0181）：落一条 `asset.updated { kind:"lut" }`。
   * 只加资产、不改调色——是否启用由作者在面板里勾（再走 `setGrade`）。
   */
  importLut: (input: { name: string; base64: string }) => Promise<{ assetId?: string; error?: string }>;
  /**
   * 把生成好的封面存进资产库（G6 / ADR-0183）：落一条 `asset.updated { kind:"image" }`。
   * 封面和其它图一样按内容寻址；没人引用时会在资产库页标成「没人用」。
   */
  saveCoverAsset: (input: {
    dataUrl: string;
    title: string;
    width: number;
    height: number;
  }) => Promise<{ assetId?: string; error?: string }>;
  /**
   * 改输出画幅与适配方式（E5 / ADR-0170）：整块写一条 `project.updated { frame }`。
   * 只影响导出，不影响提示词——已出的图不用重做。
   */
  setFrame: (frame: FrameSetting) => boolean;
  /**
   * 改这一镜的裁切焦点（E5 / ADR-0170）：一条 `shot.updated { focus }`。
   * `undefined` 恢复居中。只对裁切有意义，换画幅、重渲都跟着走。
   */
  setShotFocus: (shotId: string, focus: ShotFocus | undefined) => boolean;
  /**
   * 新增或改一条授权记录（H7 / ADR-0167）：整条写一条 `rights.updated`，按 id 幂等。
   * 只留档，不拦生成；缺哪一条由合规预检提示。
   */
  upsertRights: (record: RightsRecordInput) => boolean;
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
    /** 这一次渲染花了多少毫秒（H4）：本机渲染不按文件收费，但机器时间是成本 */
    renderMs?: number;
    /** 这一版剪辑的内容指纹（H5）：写进发布包的 aiLabel，标识与内容绑在一起 */
    contentHash?: string;
  }) => boolean;
  /**
   * 发布台账回执（G10 / ADR-0166）：发布之后才有的四项——发布时间、链接、回执、备注。
   * 发布包本身（平台、档位、文件、指纹）是导出那一刻的事实，这里不允许回填改。
   * 只写有变化的字段；四项都没变就不写事件。
   */
  recordPublishReceipt: (
    packageId: string,
    patch: Partial<Pick<PublishPackage, "publishedAt" | "url" | "receipt" | "note">>,
  ) => boolean;
  /** 删掉一条授权记录（H7 / ADR-0167）：写一条 `rights.removed`，只删留档 */
  removeRights: (rightsId: string) => boolean;
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
  /**
   * 整段锁定 / 解锁（H20 / ADR-0133）：一场里所有「能锁」的镜头一次写完。
   *
   * 只锁留用过 take 的镜头——与单镜锁定同一条规则。锁不了的镜头不静默跳过：
   * 返回值告诉界面锁了几条、跳了几条，跳过的原因写进 `castError`。
   */
  setSceneLock: (sceneId: string, locked: boolean) => { locked: number; skipped: number };
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
  /**
   * 套一套镜头语言（I1）：把景别 / 机位 / 运镜 / 焦段四个字段一起写成
   * 一条 `shot.updated`。机位坐标（B13）原样保留；已经正好是这套就不写。
   */
  applyShotLanguage: (shotId: string, languageId: string) => boolean;
  /**
   * 手调摄影参数（I7）：景别 / 机位 / 运镜 / 焦段逐项改，一条 `shot.updated`。
   *
   * 与套说法（I1）是两条路：说法一次换四项，这里一次只改一项，
   * 给「这套挺好，但焦段想再长一点」的进阶用法。机位坐标（B13）原样保留。
   */
  setShotCamera: (
    shotId: string,
    patch: { shotSize?: Shot["shotSize"]; angle?: Camera["angle"]; movement?: Camera["movement"]; focalMm?: number },
  ) => boolean;
  /**
   * 写这一镜的光影模板（I2）：一条 `shot.updated { lighting }`；
   * `undefined` 表示清空（沿用场景与风格给的光）。
   */
  setShotLighting: (shotId: string, lighting: Lighting | undefined) => boolean;
  /** 写这一镜的构图模板（I4）：一条 `shot.updated { composition }`；`undefined` 清空 */
  setShotComposition: (shotId: string, composition: Composition | undefined) => boolean;
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
  /**
   * 四格换回某一版旧图（B1）：写一条 `asset.updated`，不重新生成、不花钱。
   * 定妆锁定时拒绝；换回来的图仍按它原本的生成时间判过期。
   */
  restoreSheetAsset: (assetId: string, version: Asset) => boolean;
  /** 生成场景主镜 */
  generateMaster: (locationId: string) => Promise<void>;
  /** 生成道具参考图 */
  generateProp: (propId: string) => Promise<void>;
  /** 给当前镜生成首帧或尾帧；落一张图 + 一条 shot.updated（ADR-0037 / 0038） */
  generateKeyframe: (shotId: string, frame?: Frame) => Promise<boolean>;
  /**
   * 换回某一版旧关键帧（C2 / ADR-0185）：把选中的旧图内容写回这一帧的资产位，
   * 现在这一版先复制进历史。不重新生成、不花钱。
   */
  useKeyframeVersion: (shotId: string, frame: Frame, assetId: string) => boolean;
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
   *
   * 带表演参数（C2 / ADR-0124）发请求；`keepTake` 为真时另存一版进试听台，
   * 并把这一版设为当前采用的音轨。
   */
  generateVoice: (lineId: string, options?: { keepTake?: boolean }) => Promise<boolean>;
  /**
   * 批量补缺配音（C1）：按台词顺序把还没音轨的句子一句一句念出来。
   * 跳过锁定镜头与空台词；失败即停，已配好的保留。
   */
  generateMissingVoice: () => Promise<{
    attempted: number;
    done: number;
    failedLineId?: string;
  }>;
  /**
   * 改一句的表演参数（C2 / ADR-0124）：一条 `dialogue.updated { performance }`。
   * 传 `undefined` 表示清回默认值。不影响 `durationMs`。
   */
  updatePerformance: (lineId: string, performance: VoicePerformance | undefined) => boolean;
  /**
   * 采用试听台里的某一版（C9 / ADR-0124）：一条 `dialogue.updated { audioAssetId }`。
   * `voiceTakes` 本身不动——试听台记的是「试过哪些」，采用是台词上的事实。
   */
  adoptVoiceTake: (takeId: string) => boolean;
  /** 删掉试听台里的一版（C9）：资产不删，可能还挂在台词上 */
  removeVoiceTake: (takeId: string) => boolean;
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
   * 给一段设接法（E4 / ADR-0169）：一条 `timeline.updated`。
   * `undefined` 表示恢复硬切；第一段不接受——它前面没有画面。
   */
  setTimelineTransition: (itemId: string, transition: Transition | undefined) => boolean;
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
    /** 从成片第几毫秒进来（默认 0）；多条 cue 混排时各占一段 */
    startMs?: number;
    /** 占多长（默认从起点铺到成片末尾） */
    spanMs?: number;
  }) => boolean;
  /**
   * 调配乐：增益 / ducking 深度 / 开关 / 情绪 / 角色 / 动机 / 起点 / 长度；
   * 写一条 `timeline.music.updated`。
   */
  updateMusic: (
    patch: Partial<
      Pick<MusicCue, "gainDb" | "duckDb" | "ducking" | "mood" | "role" | "motifId" | "startMs" | "durationMs">
    >,
    cueId?: string,
  ) => boolean;
  /** 移掉配乐床：不给 id 就全部移掉；写一条 `timeline.music.updated`，资产留在项目里 */
  removeMusic: (cueId?: string) => boolean;
  /**
   * 加一条音效（C7 / ADR-0184）：音频文件先落成资产，再写一条
   * `timeline.sfx.updated`。必须给授权备注；默认只播一遍、不 ducking。
   */
  addSfx: (input: {
    uri: string;
    mime: string;
    title: string;
    durationMs: number;
    licenseRef: string;
    startMs?: number;
    spanMs?: number;
    role?: SfxCue["role"];
    loop?: boolean;
  }) => boolean;
  /** 调音效：起点 / 长度 / 增益 / 循环 / 类型；写一条 `timeline.sfx.updated` */
  updateSfx: (
    patch: Partial<Pick<SfxCue, "gainDb" | "loop" | "role" | "startMs" | "durationMs">>,
    cueId?: string,
  ) => boolean;
  /** 移掉音效：不给 id 就全部移掉；资产留在项目里 */
  removeSfx: (cueId?: string) => boolean;
  /**
   * 三路总线平衡（C7 / ADR-0184）：对白 / 配乐 / 音效各一个 ±12 dB，
   * 写一条 `timeline.mix.updated`。全为 0 时与以前的混音逐字节同构。
   */
  setMix: (patch: Partial<AudioMix>) => boolean;
  /**
   * 按曲线补 cue（C10 / ADR-0125）：给没有配乐覆盖的拍铺上同一条素材，
   * 边界对齐拍的起止，已有 cue 不动。写一条 `timeline.music.updated`（整条替换）。
   */
  fillMusicByCurve: (cueId: string) => boolean;
  /** 新建 / 替换一个主题动机（C10）：写一条 `motif.updated` */
  upsertMotif: (input: Omit<Motif, "id"> & { id?: string }) => boolean;
  /** 删掉一个动机：写一条 `motif.removed`，引用它的 cue 只清 `motifId` */
  removeMotif: (motifId: string) => boolean;
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
   * 规则表没听懂时，显式让文本模型再读一遍（H19 / ADR-0141）。
   * 只回一个补丁、只写一条事件；模型也读不出来就返回 false，不动 IR。
   */
  instructWithModel: (text: string) => Promise<boolean>;
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
  /**
   * 复核一条生成结果（H6 / ADR-0132）：`passed` 表示看过没问题，
   * `rejected` 表示不能用（会拦导出），`null` 表示收回复核、回到「还没看」。
   */
  reviewAsset: (assetId: string, status: "passed" | "rejected" | null, note?: string) => boolean;
  /**
   * 调字幕版式（D3）：传 `null` 清掉某一项、回到模板值。
   * 越界数值被拒（不夹取），界面把错误显示出来。
   */
  setSubtitleLayout: (layout: {
    preset?: "default" | "large";
    fontSizeCqw?: number | null;
    bottomPct?: number | null;
    strokeCqw?: number | null;
    /** 按角色着色（D3）：`null` 清掉覆盖、回到默认开 */
    speakerColors?: boolean | null;
    /** 给某个角色指定颜色（D3）：整份替换，`null` / `{}` 清掉全部 */
    speakerColorOverrides?: Record<string, string> | null;
  }) => boolean;
  /**
   * 双语字幕开关（D5 / ADR-0173）：开不开、第二行语言与位置。
   * 和当前值一样就不写事件；返回 false 表示没写。
   */
  setSubtitleTranslation: (patch: {
    enabled?: boolean;
    lang?: string;
    position?: "below" | "above";
  }) => boolean;
  /**
   * 给一句台词写译文（D5 / ADR-0173）：`null` 清掉。
   * 空串与 `null` 等价——导出一行看不见的字比不写更糟。
   */
  setLineTranslation: (lineId: string, translation: string | null) => boolean;
  /**
   * 品牌包与头尾卡（E9 / ADR-0174）：写一条 `brand.updated`。
   * 卡片时长会让整条时间线后移，成片、字幕、OTIO 一起跟着走。
   * 返回是否真的写进去了——和当前值一样就不写事件。
   */
  setBrand: (patch: {
    name?: string;
    handle?: string;
    color?: string;
    intro?: {
      enabled?: boolean;
      title?: string;
      subtitle?: string;
      durationMs?: number;
    };
    outro?: {
      enabled?: boolean;
      title?: string;
      subtitle?: string;
      durationMs?: number;
    };
  }) => boolean;
  /**
   * 挪一句的配音或字幕（E1 / ADR-0131）：写一条 `dialogue.updated`。
   *
   * 画面轨不能自由拖（渲染清单要求首尾相接），能自由挪的只有这两个叠加层。
   * 传 `null` 归零；越界（±30 秒）由 `applyEvent` 拒。
   */
  shiftLineTrack: (
    lineId: string,
    track: "voice" | "subtitle",
    deltaMs: number | null,
  ) => boolean;
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
  /** `source: "library"` 表示从别的空间取来、本空间没有花过钱（C16） */
  addCharacterReference: (characterId: string, uri: string, source?: Asset["source"]) => boolean;
  removeCharacterReference: (characterId: string, assetId: string) => boolean;
  addPropReference: (propId: string, uri: string, source?: Asset["source"]) => boolean;
  removePropReference: (propId: string, assetId: string) => boolean;
  /**
   * 从别的空间搬一个演员 / 场景 / 道具（C1 / ADR-0190）：
   * 资产按地址复用或登记复制件，实体换新 id，不重新生成、不花钱。
   */
  importSharedEntity: (shared: SharedEntity) => boolean;
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
    meta: {
      modelId: string;
      idea: string;
      /** 生成草稿那一次花的钱与用量（H4）：草稿本身不写 IR，钱得跟着开工一起落账 */
      costCny?: number;
      usage?: { units: number; unit: "tokens" | "chars" };
    },
  ) => boolean;
  /**
   * 逐字导入开工（F6 / ADR-0154）：一条新的 `project.created`。
   * 不调模型；把已经核对过指纹的那一章放进 `story.sourceDocument`，
   * 项目只开一空镜，原文在剧本页对照，不假装已经拆成分镜。
   */
  startProjectFromVerbatim: (document: SourceDocument) => boolean;
  /**
   * 用项目模板开工（F3 / ADR-0180）：一条新的 `project.created`。
   *
   * 班底（人物 / 地点 / 道具与它们的资产记录）与画面风格、画幅、品牌包照搬，
   * 故事与分镜从零开始。模板本身不进事件日志，存在本地 `templates` 仓。
   */
  startProjectFromTemplate: (template: ProjectTemplate, title: string) => boolean;
  /**
   * 读本机的工作空间列表（C3 / ADR-0188）。
   *
   * 第一次打开时把当前空间登记进去，名字取项目名——老日志因此自动成为一个
   * 「默认工作空间」，不搬家、不丢事件。
   */
  refreshWorkspaces: () => Promise<WorkspaceMeta[]>;
  /**
   * 新建一个工作空间：一条独立的日志，从示例项目开工，名字即新项目的标题。
   * 返回新空间的 id；调用方负责整页加载过去（换空间走 reload，见 ADR-0188）。
   */
  createWorkspace: (name: string) => Promise<string | undefined>;
  /** 改工作空间名字：只改本机的登记表，不动项目标题与日志 */
  renameWorkspace: (id: string, name: string) => Promise<boolean>;
  /**
   * 改故事层文字（A16）：一条 `story.updated`。
   * 只改传进来的字段；没改的字段与 `provenance` 都不动。
   */
  editStory: (patch: StoryPatch) => boolean;
  /**
   * 把故事恢复到某一版（C2 / ADR-0187）：一条 `story.updated` 整份写回。
   *
   * `eventIndex` 是这一版落在日志里的位置，来自 `storyVersionsOf`。
   * 指向已删角色的弧光 / 关系带不回来（如实计数，写进 `storyNotice`）。
   * 与现在完全一样时不写事件。
   */
  useStoryVersion: (eventIndex: number) => boolean;
  /**
   * 采用剧本医生的一条改写（A18 / ADR-0123）：台词走 `editDialogue`、
   * 动作走 `editAction`、故事层走 `editStory`——同一个决定只用一套写入口。
   */
  adoptDoctorItem: (item: DoctorRewriteItem) => boolean;
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
  /** 给地点挂一张参考图（B8）：贴地址，建资产，写进 referenceImages */
  addLocationReference: (locationId: string, uri: string, source?: Asset["source"]) => boolean;
  /** 摘掉地点的一张参考图：图留在资产里，可以再挂回来 */
  removeLocationReference: (locationId: string, assetId: string) => boolean;
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
  /**
   * 日志压缩（H3 / ADR-0177）：把事件里还被 base64 占着的素材地址，
   * 换成库里**同一段字节**的地址。
   *
   * 只认内容指纹，不按资产 id 猜——同一个资产位换过图，旧事件里的那张
   * 与现在的这张不是一张。事件条数、顺序、`at` 都不动，也不写新事件：
   * 压缩不改变项目，只改变同一段字节在日志里的写法。
   * 库清单由界面传进来（它本来就已经取过一份），不在这里再发请求。
   */
  compactLog: (files: { uri: string }[]) => Promise<{
    rewritten: number;
    assets: number;
    beforeBytes: number;
    afterBytes: number;
    /** 有几段 base64 在库里找不到同一段字节（没搬过、或文件已被清掉） */
    unmatched: number;
  }>;
  /**
   * 删掉一条没人引用的资产（F4 / ADR-0136）：一条 `asset.removed`。
   *
   * 只在 `referencedAssetIds` 里确实没有它时才写——刚回滚、刚生成还没挂上的
   * 资产看起来也像「没人用」，但那正是最不该删的时刻。盘上的文件不在这里删：
   * 「清理没人引用的文件」是另一个显式动作。
   */
  removeAsset: (assetId: string) => boolean;
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

/** 导入调色表的上限（I3）：.cube 是纯文本，2 MB 已经远超常见表 */
const LUT_BASE64_MAX = Math.ceil((2 * 1024 * 1024 * 4) / 3);

/**
 * 手挂的参考图：现在没有上传通道，先收一个图床 / data URI 地址（ADR-0079）。
 * 返回 Asset 或一句人话；id 在本项目里生成。
 */
function makeReferenceAsset(
  rawUri: string,
  assets: Asset[],
  at: string,
  source: Asset["source"] = "upload",
): { asset?: Asset; error?: string } {
  const uri = rawUri.trim();
  if (!uri) return { error: "先贴一张图的地址。" };
  // 资产库 / 对象存储的地址也认（C4 / ADR-0189）：跨工作空间取素材时，
  // 抄过来的是同一个文件的地址，不复制字节、不重新生成
  const placeable = isStoredAssetUri(uri) || isRemoteAssetUri(uri);
  if (!placeable && !/^(https?:\/\/|data:image\/)/i.test(uri)) {
    return { error: "参考图要先有地址：http(s)://、data:image/ 或资产库地址。" };
  }
  if (uri.length > REFERENCE_URI_MAX) return { error: "地址太长了：400 KB 以内。" };
  let id = `a-ref-${Date.now().toString(36)}`;
  while (assets.some((asset) => asset.id === id)) id += "x";
  const mime = /^data:(image\/[a-z0-9.+-]+)[;,]/i.exec(uri)?.[1];
  return {
    asset: {
      id,
      kind: "image",
      source,
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

/**
 * 角色配色的规范形状（D3 / ADR-0146）：大写十六进制、按角色 id 排序。
 *
 * 排序只为了让「和当前值一样」的比较稳定——对象键序不该决定写不写事件。
 */
function canonicalSpeakerColors(
  value?: Record<string, string> | null,
): Record<string, string> | undefined {
  if (!value) return undefined;
  const ids = Object.keys(value).filter((id) => id.trim().length > 0).sort();
  if (ids.length === 0) return undefined;
  return Object.fromEntries(ids.map((id) => [id, value[id]!.toUpperCase()]));
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
    after?: (assetId: string, at: string) => ProjectEvent | ProjectEvent[] | undefined;
    /** 溯源里记下这一张引用了哪些已锁定的锚点 */
    referenceAssetIds?: string[];
    /**
     * 随请求真正发出去的参考图（B2 / ADR-0162）。
     *
     * 只传地址与标签：字节由服务端从资产库读，浏览器不重复上传。
     * 不传就是纯文生图——这和以前一样，不改任何已有路径的行为。
     */
    references?: { assetId: string; uri: string; label: string }[];
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
  set({ generationNotice: undefined });
  try {
    const response = await fetch("/api/asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input.body,
        modelId: modelIdFor("image", get().project.models),
        ...(input.references?.length ? { references: input.references } : {}),
      }),
    });
    const payload = (await response.json()) as {
      uri?: string;
      model?: string;
      prompt?: string;
      cny?: number;
      error?: string;
      references?: { mode?: "edits" | "prompt-only"; sent?: number; missing?: string[] };
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
    const appended = [
      event,
      ...(extra === undefined ? [] : Array.isArray(extra) ? extra : [extra]),
    ];
    let project = get().project;
    for (const item of appended) project = applyEvent(project, item);
    set({ project, events: [...get().events, ...appended], generationNotice: referenceNotice(payload.references) });
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

/** 这一页停在哪个工作空间：上一次记住的那个，没有就是默认空间（C3） */
const startingWorkspace = rememberedWorkspace();

/** 把当前工作空间登记进本机的列表（第一次打开老日志时也走这里） */
async function registerWorkspace(id: string, name: string): Promise<void> {
  if (!hasWorkspaces()) return;
  try {
    const now = new Date().toISOString();
    const existing = (await listWorkspaces()).find((item) => item.id === id);
    await saveWorkspace(
      existing
        ? { ...existing, name: existing.name || name, lastOpenedAt: now }
        : { id, name, createdAt: now, lastOpenedAt: now },
    );
    useWorkbench.setState({ workspaces: await listWorkspaces() });
  } catch {
    // 列表读不到不影响编辑：顶栏最多显示不出别的空间
  }
}

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
  workspaceId: startingWorkspace,
  workspaces: [],
  currentShotId: initialShotId,
  jobs: {},
  mode: storedMode(),
  promptOverrides: {},

  hydrate: async () => {
    if (hydrated) return;
    hydrated = true;
    // 测试注入的日志原样使用；真浏览器里换成当前工作空间那一条（C3）
    if (getEventLog() === indexedDbLog) {
      setEventLog(indexedDbLogFor(startingWorkspace));
    }
    const log = getEventLog();

    try {
      const stored = migrateLog(await log.load());

      // 另一个标签页正在写同一个空间：读得到它的进度，但这一页不改、不存
      if (!(await claimWriter(startingWorkspace))) {
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
        void registerWorkspace(startingWorkspace, project.title);
        ready = true;
        return;
      }
      // 第一次打开：把示例项目的引导事件写进去，之后就都有据可查
      await log.replace(get().events);
      set({ storageError: undefined });
      void registerWorkspace(startingWorkspace, get().project.title);
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

  setLook: (look) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const parsed = LookSchema.safeParse(look);
    if (!parsed.success) {
      set({ castError: `画面风格不合法：${parsed.error.issues[0]?.message ?? "未知原因"}` });
      return false;
    }
    const next = parsed.data;
    const current = project.look;
    const same =
      current.presetId === next.presetId &&
      current.contrast === next.contrast &&
      current.temperature === next.temperature &&
      current.texture === next.texture &&
      current.aspect === next.aspect &&
      current.note === next.note;
    if (same) return false;
    const event: ProjectEvent = { type: "project.updated", at: stamp(), look: next };
    set({ project: applyEvent(project, event), events: [...events, event], castError: undefined });
    return true;
  },

  setGrade: (grade) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const parsed = GradeSchema.safeParse(grade);
    if (!parsed.success) {
      set({ editError: `调色不合法：${parsed.error.issues[0]?.message ?? "未知原因"}` });
      return false;
    }
    const next = parsed.data;
    const current = project.grade;
    if (
      current.presetId === next.presetId &&
      current.contrast === next.contrast &&
      current.saturation === next.saturation &&
      current.temperature === next.temperature &&
      current.vignette === next.vignette &&
      current.film === next.film &&
      current.grain === next.grain &&
      current.lutAssetId === next.lutAssetId &&
      current.lutName === next.lutName
    ) {
      return false;
    }
    const event: ProjectEvent = { type: "project.updated", at: stamp(), grade: next };
    set({ project: applyEvent(project, event), events: [...events, event], editError: undefined });
    return true;
  },

  importLut: async ({ name, base64 }) => {
    if (get().readOnly) return { error: "页面只读，先解锁。" };
    const clean = base64.replace(/\s+/g, "");
    if (!clean) return { error: "文件是空的。" };
    if (clean.length > LUT_BASE64_MAX) return { error: "调色表太大：.cube 文件 2 MB 以内。" };
    const at = stamp();
    // 与其它素材同一条路：内容寻址进资产库；写不进去就退回 data URI，
    // 作者刚拖进来的表不能因为库不可用就丢掉
    const uri = await persistAsset(`data:application/x-cube;base64,${clean}`, { force: true });
    const { project, events } = get();
    let id = `a-lut-${Date.now().toString(36)}`;
    while (project.assets.some((asset) => asset.id === id)) id += "x";
    const asset: Asset = {
      id,
      kind: "lut",
      source: "upload",
      uri,
      mime: "application/x-cube",
      createdAt: at,
    };
    const event: ProjectEvent = { type: "asset.updated", at, asset };
    set({ project: applyEvent(project, event), events: [...events, event], editError: undefined });
    return { assetId: id };
  },

  saveCoverAsset: async ({ dataUrl, title, width, height }) => {
    if (get().readOnly) return { error: "页面只读，先解锁。" };
    if (!/^data:image\/png;base64,/.test(dataUrl)) return { error: "封面不是 PNG，存不进去。" };
    const at = stamp();
    // 与其它生成物一样：先进资产库，事件里只留地址
    const uri = await persistAsset(dataUrl, { force: true });
    const { project, events } = get();
    let id = `a-cover-${Date.now().toString(36)}`;
    while (project.assets.some((asset) => asset.id === id)) id += "x";
    const asset: Asset = {
      id,
      kind: "image",
      source: "generated",
      uri,
      mime: "image/png",
      width,
      height,
      // 不是模型画的：记一条来源，导出数据里能看出这是本地排版的封面
      provenance: {
        modelId: "loomina.cover",
        prompt: `封面 · ${title} · ${width}×${height}`,
        referenceAssetIds: [],
        createdAt: at,
      },
      createdAt: at,
    };
    const event: ProjectEvent = { type: "asset.updated", at, asset };
    set({ project: applyEvent(project, event), events: [...events, event], editError: undefined });
    return { assetId: id };
  },

  setFrame: (frame) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const parsed = FrameSchema.safeParse(frame);
    if (!parsed.success) {
      set({ editError: `画幅不合法：${parsed.error.issues[0]?.message ?? "未知原因"}` });
      return false;
    }
    const next = parsed.data;
    const current = project.frame;
    if (current.aspect === next.aspect && current.fit === next.fit) return false;
    const event: ProjectEvent = { type: "project.updated", at: stamp(), frame: next };
    set({ project: applyEvent(project, event), events: [...events, event], editError: undefined });
    return true;
  },

  setShotFocus: (shotId, focus) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ editError: "找不到这一镜。" });
      return false;
    }
    let next: ShotFocus | undefined;
    if (focus) {
      const parsed = ShotFocusSchema.safeParse(focus);
      if (!parsed.success) {
        set({ editError: `裁切焦点不合法：${parsed.error.issues[0]?.message ?? "未知原因"}` });
        return false;
      }
      next = parsed.data;
    }
    if (JSON.stringify(shot.focus ?? null) === JSON.stringify(next ?? null)) return false;
    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId: shot.id,
      patch: { focus: next },
    };
    set({ project: applyEvent(project, event), events: [...events, event], editError: undefined });
    return true;
  },

  setTimelineTransition: (itemId, transition) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    const ordered = [...project.timeline.items].sort((a, b) => a.startMs - b.startMs);
    const index = ordered.findIndex((entry) => entry.id === itemId);
    if (index < 0) {
      set({ editError: "找不到这个片段。" });
      return false;
    }
    if (index === 0) {
      set({ editError: "第一段前面没有画面，接法只对第二段之后有意义。" });
      return false;
    }
    const item = ordered[index]!;
    const next = transition
      ? TransitionSchema.safeParse(transition)
      : ({ success: true, data: undefined } as const);
    if (!next.success) {
      set({ editError: `转场不合法：${next.error.issues[0]?.message ?? "未知原因"}` });
      return false;
    }
    if (next.data && next.data.durationMs > item.durationMs / 2) {
      set({ editError: "转场不能超过这一段的一半：再短一点，或先拉长这一镜。" });
      return false;
    }
    if (JSON.stringify(item.transitionIn ?? null) === JSON.stringify(next.data ?? null)) {
      return false;
    }
    const items = ordered.map((entry) =>
      entry.id === itemId
        ? { ...entry, ...(next.data ? { transitionIn: next.data } : { transitionIn: undefined }) }
        : entry,
    );
    const event: ProjectEvent = { type: "timeline.updated", at: stamp(), items };
    try {
      set({ project: applyEvent(project, event), events: [...events, event], editError: undefined });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "改转场失败" });
      return false;
    }
    return true;
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

  setModelPin: (modality, id) => {
    if (get().readOnly) return;
    const { project, events } = get();
    if ((project.models?.[modality] ?? null) === id) return;
    const event: ProjectEvent = {
      type: "project.updated",
      at: stamp(),
      models: { [modality]: id },
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
    // 指纹不是安全哈希，但格式必须对：写坏了下游读不出来（H5）
    if (input.contentHash !== undefined && !/^[0-9a-f]{8}$/.test(input.contentHash)) {
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
      ...(input.renderMs !== undefined && Number.isFinite(input.renderMs) && input.renderMs >= 0
        ? { renderMs: Math.round(input.renderMs) }
        : {}),
      recordedAt,
      aiLabel: {
        explicit: true,
        implicit: true,
        standard: "AI生成",
        ...(input.contentHash ? { contentHash: input.contentHash } : {}),
      },
    };

    const event: ProjectEvent = { type: "publish.recorded", at: recordedAt, package: pack };
    set({ project: applyEvent(project, event), events: [...events, event] });
    return true;
  },

  recordPublishReceipt: (packageId, patch) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const pack = project.publishPackages.find((item) => item.id === packageId);
    if (!pack) return false;
    // 只留下真的变了的字段：空 patch 是「什么都没改」，不写事件
    const next: Partial<Pick<PublishPackage, "publishedAt" | "url" | "receipt" | "note">> = {};
    for (const key of ["publishedAt", "url", "receipt", "note"] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      const trimmed = value.trim();
      if (trimmed === (pack[key] ?? "")) continue;
      next[key] = trimmed;
    }
    if (Object.keys(next).length === 0) return false;
    const event: ProjectEvent = { type: "publish.updated", at: stamp(), packageId, patch: next };
    try {
      set({ project: applyEvent(project, event), events: [...events, event], castError: undefined });
      return true;
    } catch (error) {
      set({ castError: error instanceof Error ? error.message : "回执没记上。" });
      return false;
    }
  },

  upsertRights: (record) => {
    if (get().readOnly) return false;
    const parsed = RightsRecordSchema.safeParse(record);
    if (!parsed.success) {
      set({ castError: `授权记录不合法：${parsed.error.issues[0]?.message ?? "未知原因"}` });
      return false;
    }
    const { project, events } = get();
    const event: ProjectEvent = { type: "rights.updated", at: stamp(), record: parsed.data };
    try {
      set({ project: applyEvent(project, event), events: [...events, event], castError: undefined });
      return true;
    } catch (error) {
      set({ castError: error instanceof Error ? error.message : "授权记录没记上。" });
      return false;
    }
  },

  removeRights: (rightsId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    if (!project.authorizations.some((item) => item.id === rightsId)) return false;
    const event: ProjectEvent = { type: "rights.removed", at: stamp(), rightsId };
    try {
      set({ project: applyEvent(project, event), events: [...events, event], castError: undefined });
      return true;
    } catch (error) {
      set({ castError: error instanceof Error ? error.message : "授权记录没删掉。" });
      return false;
    }
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

  setSceneLock: (sceneId, locked) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return { locked: 0, skipped: 0 };
    }
    const { project, events } = get();
    const scene = project.scenes.find((item) => item.id === sceneId);
    if (!scene) return { locked: 0, skipped: 0 };
    const takeById = new Map(project.takes.map((item) => [item.id, item]));
    const at = stamp();
    const written: ProjectEvent[] = [];
    let skipped = 0;
    for (const shotId of scene.shotIds) {
      const shot = project.shots.find((item) => item.id === shotId);
      if (!shot || Boolean(shot.locked) === locked) continue;
      // 与单镜锁定同一条规则：没留用过 take 的镜头不许锁
      if (locked) {
        const take = latestTake(shot, takeById);
        if (!take || take.status !== "approved") {
          skipped += 1;
          continue;
        }
      }
      written.push({ type: "shot.updated", at, shotId, patch: { locked } });
    }
    if (written.length === 0) {
      set({
        castError:
          locked && skipped > 0
            ? `这一场有 ${skipped} 镜还没留用 take：先留用，再整段锁定。`
            : locked
              ? "这一场都已经锁上了。"
              : "这一场没有锁着的镜头。",
      });
      return { locked: 0, skipped };
    }
    // 一次 applyEvent 多条会写很多次盘；这里逐条过一遍，日志顺序与单镜一致
    let next = project;
    for (const event of written) next = applyEvent(next, event);
    set({
      project: next,
      events: [...events, ...written],
      castError:
        skipped > 0
          ? `锁了 ${written.length} 镜，跳过 ${skipped} 镜（还没留用 take）。`
          : undefined,
    });
    return { locked: written.length, skipped };
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

  applyShotLanguage: (shotId, languageId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再换镜头语言。" });
      return false;
    }
    const language = shotLanguageById(languageId);
    if (!language) return false;
    if (matchShotLanguage(shot)?.id === language.id) {
      set({ castError: "这一镜已经是这套说法了。" });
      return false;
    }
    const patch = shotLanguagePatch(language, shot);
    const event: ProjectEvent = { type: "shot.updated", at: stamp(), shotId: shot.id, patch };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  setShotCamera: (shotId, patch) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再改摄影参数。" });
      return false;
    }

    const next: Partial<Shot> = {};
    if (patch.shotSize !== undefined && patch.shotSize !== shot.shotSize) {
      next.shotSize = patch.shotSize;
    }
    // 机位是整份写回的：只换点了的那几项，走位摆好的坐标不能让这里洗掉
    const camera = { ...shot.camera };
    let cameraChanged = false;
    if (patch.angle !== undefined && patch.angle !== shot.camera.angle) {
      camera.angle = patch.angle;
      cameraChanged = true;
    }
    if (patch.movement !== undefined && patch.movement !== shot.camera.movement) {
      camera.movement = patch.movement;
      cameraChanged = true;
    }
    if (patch.focalMm !== undefined) {
      if (!Number.isFinite(patch.focalMm) || patch.focalMm < 8 || patch.focalMm > 300) {
        set({ castError: "焦段要在 8–300mm 之间。" });
        return false;
      }
      const focalMm = Math.round(patch.focalMm);
      if (focalMm !== shot.camera.focalMm) {
        camera.focalMm = focalMm;
        cameraChanged = true;
      }
    }
    if (cameraChanged) next.camera = camera;
    if (next.shotSize === undefined && next.camera === undefined) return false;

    const event: ProjectEvent = { type: "shot.updated", at: stamp(), shotId: shot.id, patch: next };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  setShotLighting: (shotId, lighting) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再改光影。" });
      return false;
    }
    // 不合法在写之前就挡掉：日志里不该出现回放不了的补丁
    let next: Lighting | undefined;
    if (lighting !== undefined) {
      const parsed = LightingSchema.safeParse(lighting);
      if (!parsed.success) {
        set({ castError: `光影模板不合法：${parsed.error.issues[0]?.message ?? "未知原因"}` });
        return false;
      }
      next = parsed.data;
    }
    const same = JSON.stringify(shot.lighting ?? null) === JSON.stringify(next ?? null);
    if (same) return false;
    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId: shot.id,
      patch: { lighting: next },
    };
    try {
      set({ project: applyEvent(project, event), events: [...events, event], castError: undefined });
      return true;
    } catch (error) {
      set({ castError: error instanceof Error ? error.message : "光影没写上。" });
      return false;
    }
  },

  setShotComposition: (shotId, composition) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再改构图。" });
      return false;
    }
    let next: Composition | undefined;
    if (composition !== undefined) {
      const parsed = CompositionSchema.safeParse(composition);
      if (!parsed.success) {
        set({ castError: `构图模板不合法：${parsed.error.issues[0]?.message ?? "未知原因"}` });
        return false;
      }
      next = parsed.data;
    }
    const same = JSON.stringify(shot.composition ?? null) === JSON.stringify(next ?? null);
    if (same) return false;
    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId: shot.id,
      patch: { composition: next },
    };
    try {
      set({ project: applyEvent(project, event), events: [...events, event], castError: undefined });
      return true;
    } catch (error) {
      set({ castError: error instanceof Error ? error.message : "构图没写上。" });
      return false;
    }
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
    // 旧项目 / 还没补格子的角色（ADR-0144）：点「生成三视图」先补一条
    // `character.updated { sheet }` 把四个资产位占上，再一格一格出图。
    // 已有的格子（可能是作者换过的 id）原样保留。
    let active = character;
    if (SHEET_ANGLES.some((angle) => !character.sheet[angle])) {
      const sheet: Character["sheet"] = sheetSlotsOf(character.id);
      for (const angle of SHEET_ANGLES) {
        const assetId = character.sheet[angle];
        if (assetId) sheet[angle] = assetId;
      }
      const at = stamp();
      // 新占的格子也要有资产记录：不变量要求 sheet 的 id 指得到资产
      const slotEvents: ProjectEvent[] = SHEET_ANGLES.filter(
        (angle) => !character.sheet[angle],
      ).map((angle) => ({
        type: "asset.updated",
        at,
        asset: {
          id: sheet[angle]!,
          kind: "image",
          source: "generated",
          placeholder: true,
          createdAt: at,
        },
      }));
      const event: ProjectEvent = {
        type: "character.updated",
        at,
        characterId: character.id,
        patch: { sheet },
      };
      let nextProject = project;
      for (const item of [...slotEvents, event]) nextProject = applyEvent(nextProject, item);
      set({
        project: nextProject,
        events: [...get().events, ...slotEvents, event],
        castError: undefined,
      });
      active = nextProject.characters.find((item) => item.id === character.id) ?? character;
    } else {
      set({ castError: undefined });
    }

    for (const angle of SHEET_ANGLES) {
      const assetId = active.sheet[angle];
      if (!assetId) continue;
      // 参考图（B2 / ADR-0162）：已经出过的正面 / 3/4 当作这一格的身份锚。
      // 正面是锚点本身，不拿自己当参考；其余角度按「先正后侧」的顺序取前两张。
      const sheetRefs = SHEET_ANGLES.slice(0, SHEET_ANGLES.indexOf(angle))
        .map((other) => ({ assetId: active.sheet[other], label: `${active.name} · ${SHEET_LABELS[other]}` }))
        .filter((ref): ref is { assetId: string; label: string } => Boolean(ref.assetId))
        .slice(0, 2);
      const ok = await generateOne(
        { get, set },
        {
          key: characterId,
          label: active.name,
          assetId,
          job: { kind: "sheet", angle },
          body: {
            kind: "sheet",
            character: {
              name: active.name,
              appearance: active.appearance,
              mustNotChange: active.mustNotChange,
            },
            angle,
            look: get().project.look,
            ...withPromptOverride(get, `sheet:${characterId}:${angle}`),
          },
          references: referenceImagesOf(get().project, sheetRefs),
          referenceAssetIds: sheetRefs.map((ref) => ref.assetId),
        },
      );
      if (!ok) return; // 一格没成，后面的也多半不成；别继续烧钱
    }
  },

  restoreSheetAsset: (assetId, version) => {
    if (get().readOnly) return false;
    if (lockedStage({ get, set }, "cast")) return false;
    const { project, events } = get();
    const character = project.characters.find((item) =>
      SHEET_ANGLES.some((angle) => item.sheet[angle] === assetId),
    );
    if (!character) {
      set({ castError: "这张图不属于任何角色的三视图。" });
      return false;
    }
    if (isLocked(project, "character", character.id)) {
      set({ castError: "定妆已锁定：先解锁再换版本。" });
      return false;
    }
    if (!version.uri || version.id !== assetId) {
      set({ castError: "这一版没有图，换不了。" });
      return false;
    }
    const current = project.assets.find((item) => item.id === assetId);
    if (current?.uri === version.uri) return false;

    const event: ProjectEvent = {
      type: "asset.updated",
      at: stamp(),
      asset: { ...version, id: assetId },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
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
    // 参考图（B2 / ADR-0162）：地点自己的参考图（B8）就是这张主镜要延续的角度与细节。
    // 参考图本身不占主镜的资产位，重生成也不会把它覆盖掉。
    const refs = referenceImagesOf(
      project,
      location.referenceImages.map((assetId) => ({ assetId, label: `${location.name} · 参考图` })),
    );
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
          look: get().project.look,
          ...withPromptOverride(get, `master:${locationId}`),
        },
        references: refs,
        referenceAssetIds: refs.map((ref) => ref.assetId),
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
    // 参考图（B2 / ADR-0162）：把锚点装配出来的那几张真的发出去。
    // 尾帧优先拿首帧当参考——同一镜的两端必须是同一个人、同一间屋子。
    const anchors = shotAnchors(project, shot);
    const firstAsset = shot.keyframes.firstAssetId
      ? project.assets.find((item) => item.id === shot.keyframes.firstAssetId)
      : undefined;
    const refs =
      frame === "last" && firstAsset?.uri
        ? [{ assetId: firstAsset.id, uri: firstAsset.uri, label: "这一镜的首帧" }, ...referenceImagesOf(project, anchors.refs)]
        : referenceImagesOf(project, anchors.refs);

    // 版本库（C2 / ADR-0185）：重生成前把现在这张复制一份挂进历史，
    // 旧的画面与提示词留得下来；复制件不再记钱，免得同一笔花销被数两次。
    const frameKey = frame === "last" ? "last" : "first";
    const currentId =
      frame === "last" ? shot.keyframes.lastAssetId : shot.keyframes.firstAssetId;
    const currentAsset = currentId
      ? project.assets.find((item) => item.id === currentId)
      : undefined;
    const history = shot.keyframes.history ?? { first: [], last: [] };
    const kept = history[frameKey] ?? [];
    const alreadyKept = currentAsset?.uri
      ? kept.some(
          (id) => project.assets.find((item) => item.id === id)?.uri === currentAsset.uri,
        )
      : true;
    let archiveAsset: Asset | undefined;
    if (currentAsset?.uri && !alreadyKept) {
      let archiveId = `a-kfhist-${shot.id}-${frameKey}-${Date.now().toString(36)}`;
      while (project.assets.some((item) => item.id === archiveId)) archiveId += "x";
      const { costCny: _cost, ...rest } = currentAsset;
      archiveAsset = { ...rest, id: archiveId };
    }

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
          ...withPromptOverride(get, `keyframe:${shotId}:${frame}`),
        },
        references: refs.slice(0, 4),
        referenceAssetIds: anchors.refs.map((ref) => ref.assetId),
        after: (id, at) => {
          const events: ProjectEvent[] = [];
          if (archiveAsset) {
            events.push({ type: "asset.updated", at, asset: archiveAsset });
          }
          const nextHistory = archiveAsset
            ? { ...history, [frameKey]: [archiveAsset.id, ...kept].slice(0, 20) }
            : history;
          events.push({
            type: "shot.updated",
            at,
            shotId: shot.id,
            patch: {
              keyframes: {
                ...shot.keyframes,
                ...(frame === "last" ? { lastAssetId: id } : { firstAssetId: id }),
                ...(archiveAsset ? { history: nextHistory } : {}),
              },
            },
          });
          return events;
        },
      },
    );
  },

  useKeyframeVersion: (shotId, frame, assetId) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) return false;
    if (shot.locked) {
      set({ castError: "这一镜已锁定：要换旧版先解锁。" });
      return false;
    }
    const frameKey = frame === "last" ? "last" : "first";
    const chosen = project.assets.find((item) => item.id === assetId && item.uri);
    if (!chosen) {
      set({ castError: "这一版旧图已经不在资产库里了。" });
      return false;
    }
    const standardId = frame === "last" ? `a-lastframe-${shot.id}` : `a-keyframe-${shot.id}`;
    if (assetId === standardId) return true;
    const currentId =
      frame === "last" ? shot.keyframes.lastAssetId : shot.keyframes.firstAssetId;
    const currentAsset = currentId
      ? project.assets.find((item) => item.id === currentId)
      : undefined;
    const at = stamp();
    const history = shot.keyframes.history ?? { first: [], last: [] };
    const kept = history[frameKey] ?? [];
    // 现在这一版也进历史：换过去之后还能换回来
    const alreadyKept = currentAsset?.uri
      ? kept.some(
          (id) => project.assets.find((item) => item.id === id)?.uri === currentAsset.uri,
        )
      : true;
    const written: ProjectEvent[] = [];
    let archiveId: string | undefined;
    if (currentAsset?.uri && !alreadyKept) {
      let id = `a-kfhist-${shot.id}-${frameKey}-${Date.now().toString(36)}`;
      while (project.assets.some((item) => item.id === id)) id += "x";
      archiveId = id;
      const { costCny: _cost, ...rest } = currentAsset;
      written.push({
        type: "asset.updated",
        at,
        asset: { ...rest, id },
      });
    }
    const { costCny: _chosenCost, ...chosenRest } = chosen;
    written.push({
      type: "asset.updated",
      at,
      asset: {
        ...chosenRest,
        id: standardId,
        // 钱记账在资产位上：换回旧版不该让已花的钱消失
        ...(currentAsset?.costCny !== undefined ? { costCny: currentAsset.costCny } : {}),
      },
    });
    written.push({
      type: "shot.updated",
      at,
      shotId: shot.id,
      patch: {
        keyframes: {
          ...shot.keyframes,
          ...(frame === "last"
            ? { lastAssetId: standardId }
            : { firstAssetId: standardId }),
          ...(archiveId
            ? { history: { ...history, [frameKey]: [archiveId, ...kept].slice(0, 20) } }
            : {}),
        },
      },
    });
    try {
      let next = project;
      for (const event of written) next = applyEvent(next, event);
      set({ project: next, events: [...events, ...written], castError: undefined });
    } catch (error) {
      set({ castError: error instanceof Error ? error.message : "换不回这一版" });
      return false;
    }
    return true;
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
            modelId: modelIdFor("video", get().project.models),
            ...withPromptOverride(get, `video:${shotId}`),
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
    if (!/^(https?:\/\/|data:video\/|loomina:\/\/assets\/|s3:\/\/)/i.test(uri)) {
      set({ castError: "视频要先有地址：http(s)://、data:video/、本机资产库或对象存储地址开头。" });
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

  setPromptOverride: (key, value) => {
    const next = { ...get().promptOverrides };
    if (value === null || !value.trim()) delete next[key];
    else next[key] = value;
    set({ promptOverrides: next });
  },

  setVoiceInfo: (info) => {
    set({ voiceInfo: info });
  },

  setAsrInfo: (info) => {
    set({ asrInfo: info });
  },

  generateVoice: async (lineId, options) => {
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
      // 表演参数（C2 / ADR-0124）：只影响这一次出声，不改 `durationMs`
      const performance = performanceOf(line);
      // 手改过的念白提示词优先（ADR-0148）：它替代由表演参数拼出来的 instructions
      const instructed = instructionsOf(performance);
      const instructions = get().promptOverrides[`voice:${lineId}`]?.trim() || instructed;
      const response = await fetch("/api/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: line.text,
          ...(character?.voiceProfileId ? { voice: character.voiceProfileId } : {}),
          modelId: modelIdFor("tts", get().project.models),
          ...(performance.rate !== 1 ? { speed: performance.rate } : {}),
          ...(instructions ? { instructions } : {}),
        }),
      });
      const payload = (await response.json()) as {
        uri?: string;
        mime?: string;
        model?: string;
        /** 念了多少字（H4）：配音按字计价，用量随调用一起回来 */
        chars?: number;
        /** 这一句花了多少（元）；没填单价时缺省 */
        cny?: number;
        error?: string;
      };
      if (!response.ok || !payload.uri) {
        throw new Error(payload.error ?? `出声失败（${response.status}）`);
      }

      const at = stamp();
      const keepTake = options?.keepTake === true;
      // 音轨也先进资产库（H3 / ADR-0128）：一句 8 MB 的 base64 不该进日志
      const uri = await persistAsset(payload.uri);
      // 请求与落盘期间作者可能又点了一次：资产 id、序号与写回基准都要按最新的项目算
      const base = get().project;
      // 普通重配：一句台词一个资产位，换掉旧音轨；
      // 存一版（C9）：每版占自己的资产，否则试听台里几版会指向同一段音频
      let assetId = `a-voice-${lineId}`;
      let takeId = "";
      if (keepTake) {
        // 序号按现有版本数往下排；删过版本后可能撞号，所以两处都退让到不撞为止
        const seq = base.voiceTakes.filter((take) => take.lineId === lineId).length + 1;
        assetId = `a-voice-${lineId}-t${seq}`;
        while (base.assets.some((asset) => asset.id === assetId)) assetId += "x";
        takeId = `vt-${lineId}-t${seq}`;
        while (base.voiceTakes.some((take) => take.id === takeId)) takeId += "x";
      }
      const mime = /^data:(audio\/[a-z0-9.+-]+)[;,]/i.exec(uri)?.[1];
      // 配音按字计价（H4）：金额与用量记在溯源里——音轨资产本身没有 costCny 的口径，
      // 而「这一句念了多少字」只有调用那一刻知道
      const voiceProvenance = {
        modelId: payload.model ?? "unknown",
        prompt: line.text,
        referenceAssetIds: [],
        createdAt: at,
        ...(typeof payload.cny === "number" ? { costCny: payload.cny } : {}),
        ...(typeof payload.chars === "number" && payload.chars > 0
          ? { usage: { units: payload.chars, unit: "chars" as const } }
          : {}),
      };
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
            ...(typeof payload.cny === "number" ? { costCny: payload.cny } : {}),
            provenance: voiceProvenance,
            createdAt: at,
          },
        },
        {
          type: "dialogue.updated",
          at,
          lineId,
          patch: { audioAssetId: assetId },
        },
        // 存一版（C9 / ADR-0124）：进试听台，同时设为当前采用的音轨
        ...(keepTake
          ? [
              {
                type: "voice.take.added" as const,
                at,
                take: {
                  id: takeId,
                  lineId,
                  assetId,
                  performance,
                  provenance: voiceProvenance,
                  createdAt: at,
                },
              },
            ]
          : []),
      ];
      // 按最新项目应用：请求期间可能已经有别的写入（历史、别的句子）
      set({
        project: written.reduce(applyEvent, base),
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

  generateMissingVoice: async () => {
    if (get().readOnly) return { attempted: 0, done: 0 };
    const lockedShots = new Set(
      get().project.shots.filter((shot) => shot.locked).map((shot) => shot.id),
    );
    const shotOfLine = (lineId: string) =>
      get().project.shots.find((shot) => shot.dialogueIds.includes(lineId));
    const targets = get().project.dialogue.filter(
      (line) =>
        !line.audioAssetId &&
        line.text.trim().length > 0 &&
        !lockedShots.has(shotOfLine(line.id)?.id ?? ""),
    );
    let done = 0;
    for (const line of targets) {
      // 顺序执行期间作者可能刚补了这一句：跳过，不重复花钱
      const current = get().project.dialogue.find((item) => item.id === line.id);
      if (!current || current.audioAssetId) continue;
      const ok = await get().generateVoice(line.id);
      if (!ok) return { attempted: targets.length, done, failedLineId: line.id };
      done += 1;
    }
    return { attempted: targets.length, done };
  },

  updatePerformance: (lineId, performance) => {
    if (get().readOnly) {
      set({ castError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    if (lockedStage({ get, set }, "voice")) return false;
    const { project, events } = get();
    const line = project.dialogue.find((item) => item.id === lineId);
    if (!line) {
      set({ castError: "找不到这句台词。" });
      return false;
    }
    const shot = project.shots.find((item) => item.dialogueIds.includes(lineId));
    if (shot?.locked) {
      set({ castError: "这一镜已锁定：要改表演先解锁。" });
      return false;
    }
    const event: ProjectEvent = {
      type: "dialogue.updated",
      at: stamp(),
      lineId,
      // 清回默认值要真的去掉字段：`undefined` 过不了 JSON，用 `null` 当清空信号
      patch: { performance: performance ?? null },
    };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        castError: undefined,
      });
    } catch (error) {
      set({ castError: error instanceof Error ? error.message : "表演参数存不下来" });
      return false;
    }
    return true;
  },

  adoptVoiceTake: (takeId) => {
    if (get().readOnly) {
      set({ castError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    if (lockedStage({ get, set }, "voice")) return false;
    const { project, events } = get();
    const take = project.voiceTakes.find((item) => item.id === takeId);
    if (!take) {
      set({ castError: "找不到这一版配音。" });
      return false;
    }
    const line = project.dialogue.find((item) => item.id === take.lineId);
    if (!line) {
      set({ castError: "这一版配音挂的台词已经删了。" });
      return false;
    }
    if (line.audioAssetId === take.assetId) return true;
    const event: ProjectEvent = {
      type: "dialogue.updated",
      at: stamp(),
      lineId: take.lineId,
      patch: { audioAssetId: take.assetId },
    };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        castError: undefined,
      });
    } catch (error) {
      set({ castError: error instanceof Error ? error.message : "换不了这一版" });
      return false;
    }
    return true;
  },

  removeVoiceTake: (takeId) => {
    if (get().readOnly) {
      set({ castError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    if (lockedStage({ get, set }, "voice")) return false;
    const { project, events } = get();
    const take = project.voiceTakes.find((item) => item.id === takeId);
    if (!take) return false;
    const line = project.dialogue.find((item) => item.id === take.lineId);
    // 正采用的那一版不能从试听台删掉：那会让「当前音轨」指向一条不在台面上的记录
    if (line?.audioAssetId === take.assetId) {
      set({ castError: "这一版正被采用：先换成别的版本再删。" });
      return false;
    }
    const event: ProjectEvent = { type: "voice.take.removed", at: stamp(), takeId };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        castError: undefined,
      });
    } catch (error) {
      set({ castError: error instanceof Error ? error.message : "这一版删不掉" });
      return false;
    }
    return true;
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
        body: JSON.stringify({ uri: asset.uri, modelId: modelIdFor("asr", get().project.models) }),
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

  addMusic: ({ uri: rawUri, mime, title, mood, durationMs, licenseRef, startMs, spanMs }) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    // 渲染清单最多 4 条配乐：加第 5 条渲染时会整份被拒，提前拦
    if (project.timeline.music.length >= 4) {
      set({ editError: "配乐最多 4 条（渲染清单上限）：先合并或移掉一条。" });
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
    // 多条 cue 混排（C4）：每段可以有自己的起点与长度；
    // 不给就从 0 铺到成片末尾，与只有一条时的旧行为一致
    const start = Math.max(0, Math.round(startMs ?? 0));
    if (timelineMs > 0 && start >= timelineMs) {
      set({ editError: "这一段配乐的起点在成片之外：先把它挪回时间线里。" });
      return false;
    }
    const span = Math.max(
      500,
      Math.round(spanMs ?? (timelineMs > start ? timelineMs - start : durationMs)),
    );
    const cue: MusicCue = {
      id: cueId,
      assetId,
      title: title.trim().slice(0, 120) || "配乐",
      mood: mood.trim().slice(0, 40),
      startMs: start,
      // 默认循环铺满这一段；音乐文件本身多长记在资产上
      durationMs: span,
      gainDb: -18,
      duckDb: 15,
      ducking: true,
      loop: true,
      role: "bed",
      licenseRef: licenseRef.trim().slice(0, 240),
    };
    const written: ProjectEvent[] = [
      { type: "asset.updated", at, asset },
      { type: "timeline.music.updated", at, music: [...project.timeline.music, cue] },
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

  updateMusic: (patch, cueId) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    // 没给 id 时沿用旧行为（只有一条 cue 的时代）：改第一条
    const cue = cueId
      ? project.timeline.music.find((item) => item.id === cueId)
      : project.timeline.music[0];
    if (!cue) return false;
    const timelineEnd = project.timeline.items.reduce(
      (end, item) => Math.max(end, item.startMs + item.durationMs),
      0,
    );
    // 起点不夹：输入框夹住只会让数字自己跳回去，说清楚为什么不动更好
    if (patch.startMs !== undefined) {
      const start = Math.round(patch.startMs);
      if (!Number.isFinite(start) || start < 0 || (timelineEnd > 0 && start >= timelineEnd)) {
        set({ editError: "这一段的起点在成片之外：先把它挪回时间线里。" });
        return false;
      }
    }
    const next: MusicCue = {
      ...cue,
      ...(patch.startMs !== undefined ? { startMs: Math.round(patch.startMs) } : {}),
      ...(patch.durationMs !== undefined
        ? { durationMs: Math.max(500, Math.round(patch.durationMs)) }
        : {}),
      ...(patch.gainDb !== undefined
        ? { gainDb: Math.max(-40, Math.min(0, Math.round(patch.gainDb))) }
        : {}),
      ...(patch.duckDb !== undefined
        ? { duckDb: Math.max(12, Math.min(18, Math.round(patch.duckDb))) }
        : {}),
      ...(patch.ducking !== undefined ? { ducking: patch.ducking } : {}),
      ...(patch.mood !== undefined ? { mood: patch.mood.slice(0, 40) } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.motifId ? { motifId: patch.motifId } : {}),
    };
    // 清动机要真的去掉字段：`motifId: undefined` 留在对象上不算清干净
    if (patch.motifId === "") delete (next as { motifId?: string }).motifId;
    const event: ProjectEvent = {
      type: "timeline.music.updated",
      at: stamp(),
      music: project.timeline.music.map((item) => (item.id === cue.id ? next : item)),
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

  removeMusic: (cueId) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    if (project.timeline.music.length === 0) return false;
    const music = cueId
      ? project.timeline.music.filter((cue) => cue.id !== cueId)
      : [];
    if (cueId && music.length === project.timeline.music.length) return false;
    const event: ProjectEvent = {
      type: "timeline.music.updated",
      at: stamp(),
      music,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      editError: undefined,
    });
    return true;
  },

  addSfx: ({ uri: rawUri, mime, title, durationMs, licenseRef, startMs, spanMs, role, loop }) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    if (project.timeline.sfx.length >= 8) {
      set({ editError: "音效最多 8 条（渲染清单上限）：先移掉一条。" });
      return false;
    }
    const uri = rawUri.trim();
    if (!/^data:audio\//i.test(uri)) {
      set({ editError: "音效要先读成本地音频（data:audio/…）。" });
      return false;
    }
    if (uri.length > 24_000_000) {
      set({ editError: "这条音效太大了（超过约 18 MB）：换一条短一点的。" });
      return false;
    }
    if (!licenseRef.trim()) {
      set({ editError: "音效必须写授权来源：音效库名、授权书编号或「自己录制」。" });
      return false;
    }
    if (!Number.isFinite(durationMs) || durationMs < 100) {
      set({ editError: "读不出这条音效的时长：换一个文件再试。" });
      return false;
    }
    const at = stamp();
    let assetId = `a-sfx-${Date.now().toString(36)}`;
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
    let cueId = `sfx-${Date.now().toString(36)}`;
    while (project.timeline.sfx.some((cue) => cue.id === cueId)) cueId += "x";
    const timelineMs = project.timeline.items.reduce(
      (end, item) => Math.max(end, item.startMs + item.durationMs),
      0,
    );
    const start = Math.max(0, Math.round(startMs ?? 0));
    if (timelineMs > 0 && start >= timelineMs) {
      set({ editError: "这条音效的起点在成片之外：先把它挪回时间线里。" });
      return false;
    }
    const remaining = timelineMs > start ? timelineMs - start : durationMs;
    const loopOn = loop === true;
    // 默认按文件本身的长度放；循环音效默认铺到片尾
    const span = Math.max(
      100,
      Math.round(spanMs ?? (loopOn ? remaining : Math.min(durationMs, remaining))),
    );
    const cue: SfxCue = {
      id: cueId,
      assetId,
      title: title.trim().slice(0, 120) || "音效",
      startMs: start,
      durationMs: span,
      gainDb: -12,
      loop: loopOn,
      role: role ?? "foley",
      licenseRef: licenseRef.trim().slice(0, 240),
    };
    const written: ProjectEvent[] = [
      { type: "asset.updated", at, asset },
      { type: "timeline.sfx.updated", at, sfx: [...project.timeline.sfx, cue] },
    ];
    try {
      set({
        project: written.reduce(applyEvent, project),
        events: [...events, ...written],
        editError: undefined,
      });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "音效加不上" });
      return false;
    }
    return true;
  },

  updateSfx: (patch, cueId) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    const cue = cueId
      ? project.timeline.sfx.find((item) => item.id === cueId)
      : project.timeline.sfx[0];
    if (!cue) return false;
    const timelineEnd = project.timeline.items.reduce(
      (end, item) => Math.max(end, item.startMs + item.durationMs),
      0,
    );
    if (patch.startMs !== undefined) {
      const start = Math.round(patch.startMs);
      if (!Number.isFinite(start) || start < 0 || (timelineEnd > 0 && start >= timelineEnd)) {
        set({ editError: "这条音效的起点在成片之外：先把它挪回时间线里。" });
        return false;
      }
    }
    const next: SfxCue = {
      ...cue,
      ...(patch.startMs !== undefined ? { startMs: Math.round(patch.startMs) } : {}),
      ...(patch.durationMs !== undefined
        ? { durationMs: Math.max(100, Math.round(patch.durationMs)) }
        : {}),
      ...(patch.gainDb !== undefined
        ? { gainDb: Math.max(-40, Math.min(0, Math.round(patch.gainDb))) }
        : {}),
      ...(patch.loop !== undefined ? { loop: patch.loop } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
    };
    const event: ProjectEvent = {
      type: "timeline.sfx.updated",
      at: stamp(),
      sfx: project.timeline.sfx.map((item) => (item.id === cue.id ? next : item)),
    };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError: undefined,
      });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "音效改不动" });
      return false;
    }
    return true;
  },

  removeSfx: (cueId) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    if (project.timeline.sfx.length === 0) return false;
    const sfx = cueId
      ? project.timeline.sfx.filter((cue) => cue.id !== cueId)
      : [];
    if (cueId && sfx.length === project.timeline.sfx.length) return false;
    const event: ProjectEvent = {
      type: "timeline.sfx.updated",
      at: stamp(),
      sfx,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      editError: undefined,
    });
    return true;
  },

  setMix: (patch) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    const clamp = (value: number | undefined, fallback: number) =>
      value === undefined || !Number.isFinite(value)
        ? fallback
        : Math.max(-12, Math.min(12, Math.round(value)));
    const mix: AudioMix = {
      dialogueDb: clamp(patch.dialogueDb, project.timeline.mix.dialogueDb),
      musicDb: clamp(patch.musicDb, project.timeline.mix.musicDb),
      sfxDb: clamp(patch.sfxDb, project.timeline.mix.sfxDb),
    };
    if (
      mix.dialogueDb === project.timeline.mix.dialogueDb &&
      mix.musicDb === project.timeline.mix.musicDb &&
      mix.sfxDb === project.timeline.mix.sfxDb
    ) {
      return true;
    }
    const event: ProjectEvent = { type: "timeline.mix.updated", at: stamp(), mix };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError: undefined,
      });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "三路平衡改不动" });
      return false;
    }
    return true;
  },

  fillMusicByCurve: (cueId) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    const source = project.timeline.music.find((cue) => cue.id === cueId);
    if (!source) {
      set({ editError: "先有一条配乐，才能按曲线铺。" });
      return false;
    }
    const plan = planMusicFill(project, source);
    if (plan.cues.length === 0) {
      set({
        editError:
          plan.outOfCut > 0
            ? `成片时间线只排到这里：还有 ${plan.outOfCut} 拍的配乐位在成片之外，先初剪把镜头排进来。`
            : "每一拍都已经有配乐了，不用再铺。",
      });
      return false;
    }
    const event: ProjectEvent = {
      type: "timeline.music.updated",
      at: stamp(),
      music: [...project.timeline.music, ...plan.cues],
    };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError: plan.overflow
          ? `渲染清单最多 4 条配乐：先合并相邻的拍，还有 ${plan.skipped} 段没铺。`
          : undefined,
      });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "按曲线铺配乐失败" });
      return false;
    }
    return true;
  },

  upsertMotif: (input) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    let id = input.id?.trim();
    if (!id) {
      id = `motif-${Date.now().toString(36)}`;
      while (project.motifs.some((motif) => motif.id === id)) id += "x";
    }
    const motif: Motif = {
      id,
      label: input.label.trim().slice(0, 40),
      targetKind: input.targetKind,
      targetId: input.targetId,
      assetId: input.assetId,
      licenseRef: input.licenseRef.trim().slice(0, 240),
      note: input.note.trim().slice(0, 200),
    };
    const event: ProjectEvent = { type: "motif.updated", at: stamp(), motif };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError: undefined,
      });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "动机存不下来" });
      return false;
    }
    return true;
  },

  removeMotif: (motifId) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    if (!project.motifs.some((motif) => motif.id === motifId)) return false;
    const event: ProjectEvent = { type: "motif.removed", at: stamp(), motifId };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError: undefined,
      });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "动机删不掉" });
      return false;
    }
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

  shiftLineTrack: (lineId, track, deltaMs) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    const line = project.dialogue.find((item) => item.id === lineId);
    if (!line) return false;
    const key = track === "voice" ? "voiceOffsetMs" : "subtitleOffsetMs";
    // 收的是**增量**不是目标值：连点时 React 闭包里的旧值会让第二次点击算成
    // 「还是 0 → 100」，于是被下面的同值短路吃掉。读 store 里的当前值才连得上。
    const current = line[key] ?? 0;
    const next = deltaMs === null ? 0 : current + Math.round(deltaMs);
    if (next === current) return false;
    const at = stamp();
    const event: ProjectEvent = {
      type: "dialogue.updated",
      at,
      lineId,
      patch: { [key]: next === 0 ? null : next },
    };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError: undefined,
      });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "挪不动这条轨道。" });
      return false;
    }
    return true;
  },

  reviewAsset: (assetId, status, note) => {
    if (get().readOnly) {
      set({ editError: "另一个标签页正在编辑：这里只读。" });
      return false;
    }
    const { project, events } = get();
    const asset = project.assets.find((item) => item.id === assetId);
    if (!asset) {
      // 静默返回 false 会让界面上的按钮看起来像坏了：说清是资产没了
      set({ editError: `资产 ${assetId} 不在项目里：复核记不上去。` });
      return false;
    }
    const at = stamp();
    const trimmed = note?.trim();
    // 复核走独立事件：`asset.updated` 是合并语义，删不掉「收回复核」的字段
    const event: ProjectEvent = {
      type: "asset.reviewed",
      at,
      assetId,
      status,
      ...(status === "rejected" && trimmed ? { note: trimmed } : {}),
    };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError: undefined,
      });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "复核没有写进去。" });
      return false;
    }
    return true;
  },

  setSubtitleLayout: (layout) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    // 和当前值一样就不写事件：拖滑块时每一步都记一条，日志会被噪声灌满
    const current = project.subtitleLayout;
    const currentOverrides = canonicalSpeakerColors(current.speakerColorOverrides);
    const overridesProvided = layout.speakerColorOverrides !== undefined;
    const requestedOverrides = overridesProvided
      ? canonicalSpeakerColors(layout.speakerColorOverrides)
      : undefined;
    // 传了但规范化后为空（`null` / `{}`）：要清掉，不能当成「没提这一项」
    const overridesPatch = overridesProvided ? (requestedOverrides ?? null) : undefined;
    const same =
      (layout.preset === undefined || layout.preset === current.preset) &&
      (layout.fontSizeCqw === undefined ||
        (layout.fontSizeCqw === null
          ? current.fontSizeCqw === undefined
          : current.fontSizeCqw === layout.fontSizeCqw)) &&
      (layout.bottomPct === undefined ||
        (layout.bottomPct === null
          ? current.bottomPct === undefined
          : current.bottomPct === layout.bottomPct)) &&
      (layout.strokeCqw === undefined ||
        (layout.strokeCqw === null
          ? current.strokeCqw === undefined
          : current.strokeCqw === layout.strokeCqw)) &&
      (layout.speakerColors === undefined ||
        (layout.speakerColors === null
          ? current.speakerColors === undefined
          : (current.speakerColors ?? true) === layout.speakerColors)) &&
      (overridesPatch === undefined ||
        JSON.stringify(requestedOverrides) === JSON.stringify(currentOverrides));
    if (same) return false;
    const at = stamp();
    const nextLayout =
      overridesPatch === undefined
        ? layout
        : { ...layout, speakerColorOverrides: overridesPatch };
    const event: ProjectEvent = { type: "subtitle.layout.updated", at, layout: nextLayout };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError: undefined,
      });
    } catch (error) {
      // 越界由 applyEvent 拒；界面要看见原因，不能静默不动
      set({ editError: error instanceof Error ? error.message : "字幕版式没改成功。" });
      return false;
    }
    return true;
  },

  setSubtitleTranslation: (patch) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const current = project.subtitleTranslation;
    const lang = patch.lang === undefined ? undefined : patch.lang.trim();
    // 和当前值一样就不写事件：开关点两下不该在日志里留两条
    const same =
      (patch.enabled === undefined || patch.enabled === current.enabled) &&
      (lang === undefined || lang === current.lang) &&
      (patch.position === undefined || patch.position === current.position);
    if (same) return false;
    const at = stamp();
    const event: ProjectEvent = {
      type: "subtitle.translation.updated",
      at,
      patch: {
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(lang !== undefined ? { lang } : {}),
        ...(patch.position !== undefined ? { position: patch.position } : {}),
      },
    };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError: undefined,
      });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "双语字幕没改成功。" });
      return false;
    }
    return true;
  },

  setLineTranslation: (lineId, translation) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const line = project.dialogue.find((item) => item.id === lineId);
    if (!line) return false;
    const next = translation === null ? undefined : translation.trim() || undefined;
    if (next === (line.translation?.trim() || undefined)) return false;
    const at = stamp();
    const event: ProjectEvent = {
      type: "dialogue.translation.updated",
      at,
      lineId,
      translation: next ?? null,
    };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError: undefined,
      });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "译文没写进去。" });
      return false;
    }
    return true;
  },

  setBrand: (patch) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const current = project.brand;
    // 和当前值一样就不写事件：拖一次时长滑块不该在日志里留一串记录
    const clean = {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.handle !== undefined ? { handle: patch.handle.trim() } : {}),
      ...(patch.color !== undefined ? { color: patch.color.toUpperCase() } : {}),
    };
    const sameTop =
      (clean.name === undefined || clean.name === current.name) &&
      (clean.handle === undefined || clean.handle === current.handle) &&
      (clean.color === undefined || clean.color === current.color);
    const cardPatchOf = (role: "intro" | "outro") => {
      const given = patch[role];
      if (!given) return undefined;
      const base = current[role];
      const next = {
        ...(given.enabled !== undefined ? { enabled: given.enabled } : {}),
        ...(given.title !== undefined ? { title: given.title.trim() } : {}),
        ...(given.subtitle !== undefined ? { subtitle: given.subtitle.trim() } : {}),
        ...(given.durationMs !== undefined ? { durationMs: given.durationMs } : {}),
      };
      const same =
        (next.enabled === undefined || next.enabled === base.enabled) &&
        (next.title === undefined || next.title === base.title) &&
        (next.subtitle === undefined || next.subtitle === base.subtitle) &&
        (next.durationMs === undefined || next.durationMs === base.durationMs);
      return { next, same };
    };
    const intro = cardPatchOf("intro");
    const outro = cardPatchOf("outro");
    if (sameTop && intro?.same !== false && outro?.same !== false) return false;
    const at = stamp();
    const event: ProjectEvent = {
      type: "brand.updated",
      at,
      patch: {
        ...clean,
        ...(intro && !intro.same ? { intro: intro.next } : {}),
        ...(outro && !outro.same ? { outro: outro.next } : {}),
      },
    };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        editError: undefined,
      });
    } catch (error) {
      set({ editError: error instanceof Error ? error.message : "品牌包没改成功。" });
      return false;
    }
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
      // 新建人物先把四格占上（ADR-0144）
      sheet: sheetSlotsOf(id),
      referenceImages: [],
      mustNotChange: [],
    };
    // 四格的占位资产必须先于人物存在：不变量要求 sheet 里的 id 都指得到资产
    const at = stamp();
    const slotEvents: ProjectEvent[] = sheetSlotAssets(id, at).map((asset) => ({
      type: "asset.updated",
      at,
      asset,
    }));
    const event: ProjectEvent = {
      type: "character.added",
      at,
      character,
    };
    const nextEvents = [...events, ...slotEvents, event];
    let nextProject = project;
    for (const item of [...slotEvents, event]) nextProject = applyEvent(nextProject, item);
    set({
      project: nextProject,
      events: nextEvents,
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

  addCharacterReference: (characterId, rawUri, source) => {
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
    const { asset, error } = makeReferenceAsset(rawUri, project.assets, at, source);
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

  addPropReference: (propId, rawUri, source) => {
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
    const { asset, error } = makeReferenceAsset(rawUri, project.assets, at, source);
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

  importSharedEntity: (shared) => {
    if (get().readOnly) {
      set({ castError: "现在是只读：换到能写的窗口再取。" });
      return false;
    }
    const { project, events } = get();
    try {
      const imported = sharedEntityImport(shared, project, stamp());
      set({
        project: imported.events.reduce(applyEvent, project),
        events: [...events, ...imported.events],
        castError: undefined,
      });
      return true;
    } catch (error) {
      set({
        castError: error instanceof Error ? `这个取不过来：${error.message}` : "这个取不过来。",
      });
      return false;
    }
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
        ...(meta.costCny !== undefined ? { costCny: meta.costCny } : {}),
        ...(meta.usage ? { usage: meta.usage } : {}),
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
      // 新项目的 id 全换了：上一份项目的手改提示词留着只会错位
      promptOverrides: {},
    });
    return true;
  },

  startProjectFromTemplate: (template, title) => {
    if (get().readOnly) {
      set({ castError: "另一个标签页在编辑：这一页只读，开不了新项目。" });
      return false;
    }
    const { project, events } = get();
    const at = stamp();
    let next: Project;
    try {
      next = projectFromTemplate(template, {
        id: `proj-${Date.now().toString(36)}`,
        at,
        title,
        budgetCny: project.budgetCny,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "模板结构不合法";
      set({ castError: `模板没能开工：${detail.slice(0, 240)}` });
      return false;
    }
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
      // 新项目的 id 全换了：上一份项目的手改提示词与模板无关
      promptOverrides: {},
    });
    return true;
  },

  refreshWorkspaces: async () => {
    if (!hasWorkspaces()) return [];
    try {
      let list = await listWorkspaces();
      // 第一次打开：当前空间还没登记，用项目名补一条
      if (list.length === 0) {
        await registerWorkspace(get().workspaceId, get().project.title);
        list = await listWorkspaces();
      }
      set({ workspaces: list, workspaceError: undefined });
      return list;
    } catch (error) {
      set({ workspaceError: error instanceof Error ? error.message : "读不到工作空间列表。" });
      return [];
    }
  },

  createWorkspace: async (rawName) => {
    const name = rawName.trim();
    if (!name) {
      set({ workspaceError: "工作空间要有名字。" });
      return undefined;
    }
    if (name.length > 40) {
      set({ workspaceError: "名字最多 40 个字。" });
      return undefined;
    }
    if (!hasWorkspaces()) {
      set({ workspaceError: "这个浏览器不支持多工作空间。" });
      return undefined;
    }

    try {
      const list = await listWorkspaces();
      if (list.some((item) => item.name === name)) {
        set({ workspaceError: "已经有同名的工作空间。" });
        return undefined;
      }

      const id = `w-${Date.now().toString(36)}`;
      const now = new Date().toISOString();
      // 新空间从示例项目开工：作者随后可以在故事页换成自己的项目
      const seed = ProjectSchema.parse({ ...sampleProject, id: `p-${id}`, title: name });
      await indexedDbLogFor(id).replace(bootstrap(seed));
      await saveWorkspace({ id, name, createdAt: now, lastOpenedAt: now });
      rememberWorkspace(id);
      set({ workspaces: await listWorkspaces(), workspaceError: undefined });
      return id;
    } catch (error) {
      set({ workspaceError: error instanceof Error ? error.message : "工作空间没建成。" });
      return undefined;
    }
  },

  renameWorkspace: async (id, rawName) => {
    const name = rawName.trim();
    if (!name) {
      set({ workspaceError: "工作空间要有名字。" });
      return false;
    }
    if (name.length > 40) {
      set({ workspaceError: "名字最多 40 个字。" });
      return false;
    }
    if (!hasWorkspaces()) return false;
    try {
      const list = await listWorkspaces();
      if (list.some((item) => item.id !== id && item.name === name)) {
        set({ workspaceError: "已经有同名的工作空间。" });
        return false;
      }
      const target = list.find((item) => item.id === id);
      if (!target) {
        set({ workspaceError: "找不到这个工作空间。" });
        return false;
      }
      await saveWorkspace({ ...target, name });
      set({ workspaces: await listWorkspaces(), workspaceError: undefined });
      return true;
    } catch (error) {
      set({ workspaceError: error instanceof Error ? error.message : "名字没改成。" });
      return false;
    }
  },

  startProjectFromVerbatim: (document) => {
    if (get().readOnly) {
      set({ castError: "另一个标签页在编辑：这一页只读，开不了新项目。" });
      return false;
    }
    const { project, events } = get();
    const at = stamp();
    let next: Project;
    try {
      next = projectFromVerbatimDocument(document, {
        id: `proj-${Date.now().toString(36)}`,
        at,
        budgetCny: project.budgetCny,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "逐字原文不合法";
      set({ castError: `逐字导入没能开工：${detail.slice(0, 240)}` });
      return false;
    }
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
      promptOverrides: {},
    });
    return true;
  },

  adoptDoctorItem: (item) => {
    if (get().readOnly) return false;
    // 采用不是「更聪明的写入口」：三种改动各走各的既有校验（锁镜、时长重估、空文本）
    if (item.kind === "dialogue") return get().editDialogue(item.lineId, item.text);
    if (item.kind === "shot") return get().editAction(item.shotId, item.text);
    return get().editStory({ [item.field]: item.text } as StoryPatch);
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
        storyNotice: undefined,
      });
      return true;
    } catch (error) {
      set({
        castError: error instanceof Error ? error.message : "故事没改成。",
      });
      return false;
    }
  },

  useStoryVersion: (eventIndex) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const version = storyVersionsOf(events).find((item) => item.eventIndex === eventIndex);
    if (!version) {
      set({ castError: "找不到这一版故事。" });
      return false;
    }
    const restore = storyRestorePatch(project.story, version.story, project.characters);
    if (!restore) {
      set({ castError: "现在就是这一版，没有要改的。" });
      return false;
    }
    const event: ProjectEvent = { type: "story.updated", at: stamp(), patch: restore.patch };
    try {
      const nextProject = applyEvent(project, event);
      const dropped = restore.droppedArcs + restore.droppedRelationships;
      set({
        project: nextProject,
        events: [...events, event],
        castError: undefined,
        storyNotice:
          dropped > 0
            ? `已恢复这一版；其中 ${dropped} 条弧光 / 关系指向已删角色，没有带回来。`
            : "已恢复这一版。",
      });
      return true;
    } catch (error) {
      set({ castError: error instanceof Error ? error.message : "故事没恢复成。" });
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

  addLocationReference: (locationId, rawUri, source) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const location = project.locations.find((item) => item.id === locationId);
    if (!location) {
      set({ castError: "找不到这个地点。" });
      return false;
    }
    if (location.referenceImages.length >= REFERENCE_IMAGES_MAX) {
      set({ castError: `参考图最多 ${REFERENCE_IMAGES_MAX} 张：再多会把提示词挤爆。` });
      return false;
    }
    const at = stamp();
    const { asset, error } = makeReferenceAsset(rawUri, project.assets, at, source);
    if (!asset) {
      set({ castError: error ?? "这张图挂不上。" });
      return false;
    }
    const existing = project.assets.filter((item) => location.referenceImages.includes(item.id));
    if (existing.some((item) => item.uri === asset.uri)) {
      set({ castError: "这张图已经挂过了。" });
      return false;
    }
    const written: ProjectEvent[] = [
      { type: "asset.updated", at, asset },
      {
        type: "location.updated",
        at,
        locationId,
        patch: { referenceImages: [...location.referenceImages, asset.id] },
      },
    ];
    set({
      project: written.reduce(applyEvent, project),
      events: [...events, ...written],
      castError: undefined,
    });
    return true;
  },

  removeLocationReference: (locationId, assetId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const location = project.locations.find((item) => item.id === locationId);
    if (!location || !location.referenceImages.includes(assetId)) return false;
    const event: ProjectEvent = {
      type: "location.updated",
      at: stamp(),
      locationId,
      patch: {
        referenceImages: location.referenceImages.filter((id) => id !== assetId),
      },
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

  instructWithModel: async (text) => {
    if (get().readOnly) return false;
    if (get().instructionBusy) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;

    const { project, currentShotId } = get();
    const shot = project.shots.find((item) => item.id === currentShotId);
    if (!shot) return false;
    if (shot.locked) {
      set({ castError: "这一镜已锁定：要改先解锁。" });
      return false;
    }

    const shotNo = project.shots.findIndex((item) => item.id === shot.id) + 1;
    set({ instructionBusy: true, castError: undefined, instructionNotice: undefined });

    const result = await askInstructionAi(trimmed, shotSnapshotOf(shot, shotNo));

    // 等模型这段时间里，作者可能切了镜头 / 锁了镜头 / 换了标签页：都别把补丁写到别的镜头
    const latest = get();
    const target = latest.project.shots.find((item) => item.id === shot.id);
    if (!target || target.locked || latest.readOnly) {
      set({ instructionBusy: false });
      return false;
    }

    if (!result.ok) {
      set({ instructionBusy: false, castError: result.error });
      return false;
    }

    const patch: Partial<Shot> = {};
    if (result.patch.shotSize) patch.shotSize = result.patch.shotSize;
    if (result.patch.camera) patch.camera = result.patch.camera;
    if (result.patch.durationMs) patch.durationMs = result.patch.durationMs;
    if (result.patch.note && !target.promptNotes.includes(result.patch.note)) {
      patch.promptNotes = [...target.promptNotes, result.patch.note];
    }
    if (Object.keys(patch).length === 0) {
      set({ instructionBusy: false, castError: "模型读到的和现在一样：这次没有改动。" });
      return false;
    }

    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId: target.id,
      patch,
    };
    set({
      project: applyEvent(latest.project, event),
      events: [...latest.events, event],
      instructionBusy: false,
      instructionNotice: describeAiPatch(result.patch, result.reason),
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
    // 参考图（B2 / ADR-0162）：已有的参考图当成这件道具的同一件东西，
    // 新的一张要延续它的材质、颜色与比例。第一张没有参考，纯文生图。
    const refs = referenceImagesOf(
      project,
      prop.referenceImages.map((id) => ({ assetId: id, label: `${prop.name} · 参考图` })),
    );
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
          look: get().project.look,
          ...withPromptOverride(get, `prop:${propId}`),
        },
        references: refs,
        referenceAssetIds: refs.map((ref) => ref.assetId),
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

  removeAsset: (assetId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const asset = project.assets.find((item) => item.id === assetId);
    if (!asset) {
      set({ castError: "找不到这条资产。" });
      return false;
    }
    if (referencedAssetIds(project).has(assetId)) {
      set({ castError: "这条资产还在用：先把它从引用它的地方摘掉，再删。" });
      return false;
    }
    const event: ProjectEvent = { type: "asset.removed", at: stamp(), assetId };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },
  compactLog: async (files) => {
    const { events } = get();
    const beforeBytes = logBytesOf(events);
    const untouched = { rewritten: 0, assets: 0, beforeBytes, afterBytes: beforeBytes, unmatched: 0 };
    if (get().readOnly) return untouched;
    const inline = inlinePayloadsOf(events);
    if (inline.uris.length === 0) return untouched;
    const { map, unmatched } = await replacementsFor(inline.uris, storedIndexOf(files));
    if (map.size === 0) return { ...untouched, unmatched };
    const compaction = compactEvents(events, map);
    const afterBytes = logBytesOf(compaction.events);
    // 当前项目里还在用这些 base64 的资产跟着换地址：压缩之后
    // `rebuild(events)` 就是这个样子，内存里那份不能和日志对不上
    const project = get().project;
    const assets = project.assets.map((asset) => {
      const to = asset.uri ? map.get(asset.uri) : undefined;
      return to ? { ...asset, uri: to } : asset;
    });
    set({ events: compaction.events, project: { ...project, assets } });
    return {
      rewritten: compaction.rewritten,
      assets: compaction.assets,
      beforeBytes,
      afterBytes,
      unmatched,
    };
  },

  migrateAssets: async () => {
    if (get().readOnly) return { moved: 0, failed: 0, bytes: 0 };
    let moved = 0;
    let failed = 0;
    let bytes = 0;
    // 逐个搬、逐个写事件：中途失败也能停在半个项目的状态上，而不是全丢
    const targets = get().project.assets.filter(
      (asset) => asset.uri && !isStoredAssetUri(asset.uri) && !isRemoteAssetUri(asset.uri) && asset.uri.startsWith("data:"),
    );
    for (const asset of targets) {
      const uri = await persistAsset(asset.uri!, { force: true });
      if (!isStoredAssetUri(uri) && !isRemoteAssetUri(uri)) {
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
      storyNotice: undefined,
      lastSwap: undefined,
      asrResult: undefined,
      editError: undefined,
      lockedNotice: undefined,
      promptOverrides: {},
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
