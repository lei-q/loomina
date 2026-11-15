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
  MUST_NOT_CHANGE_COUNT_MAX,
  MUST_NOT_CHANGE_MAX,
  PerformanceSpecSchema,
  placementProblem,
  ProjectSchema,
  ProjectSkillSchema,
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
  type ProjectSkill,
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
  type SkillStage,
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
  parseInstructionScope,
  previousShotOf,
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
  deleteWorkspace as deleteWorkspaceRows,
  diffEvents,
  getEventLog,
  hasWorkspaces,
  DEFAULT_WORKSPACE_ID,
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
import { sceneBatchOf, sceneImportEvents, sceneReadiness } from "@/lib/shared-scenes";
import { storyImportPatch } from "@/lib/shared-stories";
import type { CastImageRequest } from "@/lib/generate-image";
import { findCachedAsset, referenceHashesOf, reuseAssetEvents } from "@/lib/generation-cache";
import { nextEpisodeNo } from "@/lib/series";
import { imagePlanOf } from "@/lib/image-plan";
import { replayRestore, scriptRestoreEvents, scriptVersionsOf } from "@/lib/script-versions";
import {
  sanitizeShotTemplate,
  shotTemplatePatch,
  type ShotTemplate,
} from "@/lib/shot-template";
import { storyRestorePatch, storyVersionsOf } from "@/lib/story-versions";
import { takeFromLog, voiceTakeFromLog } from "@/lib/trash";
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
import { projectFromSetup, setupSourceProblem } from "@/lib/workspace-template";
import { castActions } from "@/lib/workbench-actions-cast";
import { workspaceActions } from "@/lib/workbench-actions-workspace";
import { generateOne, lockedStage } from "@/lib/workbench-generate";
import { batchPlanOf, type BatchPatch } from "@/lib/shot-batch";
import {
  appendOnly,
  bootstrap,
  canonicalSpeakerColors,
  clipReason,
  isLocked,
  nextOpenShotId,
  promptKeyOf,
  referenceImagesOf,
  referenceNotice,
  registerWorkspace as registerWorkspaceRow,
  removalUndoEvents,
  restack,
  withPromptOverride,
} from "@/lib/workbench-helpers";
import {
  workspaceExportFileName,
  workspaceExportOf,
} from "@/lib/workspace-export";
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

/** 结果缓存开关（H14 / ADR-0208）：默认开着；关掉就每次都真去生成 */
const CACHE_KEY = "loomina.reuseCache";

function storedReuseCache(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(CACHE_KEY) !== "off";
  } catch {
    return true;
  }
}

function persistReuseCache(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, on ? "on" : "off");
  } catch {
    // 隐私模式写不进就不记：这次切换照常生效
  }
}

/**
 * B6: 视频失败重试。只重试服务端明确说「没在跑、重交安全」的失败；
 * 路由决定 retryable，客户端不做更聪明的猜测。
 * 重试上限由项目设置（H10 的 maxAttemptsPerShot），这里只放每次之间的等待。
 */
const VIDEO_RETRY_DELAYS_MS = [1200, 3000];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * 审片台的本地状态（ADR-0027）。
 *
 * - `events` 是事实，`project` 是它跑出来的结果，两者一起持有只是为了少算；
 * - 选格子不发事件，只有留用 / 淘汰才写一条 `take.updated`；
 * - 日志落在浏览器本地（IndexedDB，ADR-0034），刷新不会把花过钱的图丢掉。
 */
import type { Decision, GenerateJob, StoryPatch, WorkbenchState } from "./workbench-types";
export type { Decision, GenerateJob, StoryPatch, WorkbenchState };


/** 新镜头的默认时长：没有台词时先给 3 秒，随后在分镜页改（ADR-0064） */
const NEW_SHOT_DURATION_MS = 3000;

/** 场景描述的上限：这句会整句进主镜提示词，长了会把画面指令挤掉（ADR-0063） */
const LOCATION_DESCRIPTION_MAX = 200;

/** 外形描述的上限：同样会整句进提示词（ADR-0071） */
const CHARACTER_APPEARANCE_MAX = 200;

/** 道具描述的上限：同样会整句进提示词（ADR-0072） */
const PROP_DESCRIPTION_MAX = 200;

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

type Store = {
  get: () => WorkbenchState;
  set: (partial: Partial<WorkbenchState>) => void;
};

/** hydrate 只跑一次；ready 之前不写存储，免得把已存的项目盖成示例项目。 */
let hydrated = false;
let ready = false;

/** 这一页停在哪个工作空间：上一次记住的那个，没有就是默认空间（C3） */
const startingWorkspace = rememberedWorkspace();

/** 把当前工作空间登记进本机的列表（第一次打开老日志时也走这里） */

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
  // 工作空间那七个动作在单独的切片里（见 workbench-actions-workspace.ts）：
  // 它们只碰本机登记表与各空间日志，与项目内容无关，是最独立的一组。
  ...workspaceActions({ get, set }, stamp),
  // 定妆台的锁定与出图在单独的切片里（见 workbench-actions-cast.ts）：
  // 它们会花钱，必须共用同一份 lockedStage 闸口与 generateOne。
  ...castActions({ get, set }, stamp),
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


  project: sampleProject,
  events: initialEvents,
  workspaceId: startingWorkspace,
  workspaces: [],
  currentShotId: initialShotId,
  jobs: {},
  mode: storedMode(),
  reuseCache: storedReuseCache(),
  promptOverrides: {},

  hydrate: async () => {
    if (hydrated) return;
    hydrated = true;
    // 测试注入的日志原样使用；真浏览器里换成当前工作空间那一条（C3）
    if (getEventLog() === indexedDbLog) {
      setEventLog(indexedDbLogFor(startingWorkspace));
    }
    let log = getEventLog();

    try {
      // 直链兜底（C15 / ADR-0210）：记住的空间读不出日志就退回默认空间。
      // 不自动新建空空间——那是猜，猜错比退回更糟。
      if (hasWorkspaces() && startingWorkspace !== DEFAULT_WORKSPACE_ID) {
        const metas = await listWorkspaces().catch(() => []);
        const known = metas.some((meta) => meta.id === startingWorkspace);
        const stored = await log.load().catch(() => undefined);
        if (!known && (stored === undefined || stored.events.length === 0)) {
          rememberWorkspace(DEFAULT_WORKSPACE_ID);
          setEventLog(indexedDbLogFor(DEFAULT_WORKSPACE_ID));
          log = getEventLog();
          set({
            workspaceId: DEFAULT_WORKSPACE_ID,
            storageError: "上次打开的工作空间找不到了，已回到默认空间。",
          });
        }
      }

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
        void registerWorkspaceRow(startingWorkspace, project.title, set);
        ready = true;
        return;
      }
      // 第一次打开：把示例项目的引导事件写进去，之后就都有据可查
      await log.replace(get().events);
      set({ storageError: undefined });
      void registerWorkspaceRow(startingWorkspace, get().project.title, set);
    } catch (error) {
      set({ storageError: storageMessage(error) });
    }
    ready = true;
  },

  setReuseCache: (on) => {
    persistReuseCache(on);
    set({ reuseCache: on });
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

  addSkill: ({ name, description, stage, body }) => {
    if (get().readOnly) {
      set({ castError: "现在是只读：换到能写的窗口再改技能。" });
      return undefined;
    }
    const { project, events } = get();
    const trimmed = name.trim();
    if (!trimmed) {
      set({ castError: "技能得有个名字。" });
      return undefined;
    }
    let id = `sk-${Date.now().toString(36)}`;
    while (project.skills.some((skill) => skill.id === id)) id += "x";
    const at = stamp();
    const parsed = ProjectSkillSchema.safeParse({
      id,
      name: trimmed,
      description: (description ?? "").trim(),
      stage: stage ?? "all",
      body: body.trim(),
      enabled: true,
      createdAt: at,
    });
    if (!parsed.success) {
      set({ castError: `技能不合法：${parsed.error.issues[0]?.message ?? "未知原因"}` });
      return undefined;
    }
    const event: ProjectEvent = {
      type: "project.updated",
      at,
      skills: [...project.skills, parsed.data],
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return id;
  },

  updateSkill: (skillId, patch) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const current = project.skills.find((skill) => skill.id === skillId);
    if (!current) return false;
    const merged = {
      ...current,
      ...patch,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.body !== undefined ? { body: patch.body.trim() } : {}),
    };
    const parsed = ProjectSkillSchema.safeParse(merged);
    if (!parsed.success) {
      set({ castError: `技能不合法：${parsed.error.issues[0]?.message ?? "未知原因"}` });
      return false;
    }
    const same = (Object.keys(patch) as Array<keyof typeof patch>).every(
      (key) => parsed.data[key] === current[key],
    );
    if (same) return false;
    const event: ProjectEvent = {
      type: "project.updated",
      at: stamp(),
      skills: project.skills.map((skill) => (skill.id === skillId ? parsed.data : skill)),
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  removeSkill: (skillId) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    if (!project.skills.some((skill) => skill.id === skillId)) return false;
    const event: ProjectEvent = {
      type: "project.updated",
      at: stamp(),
      skills: project.skills.filter((skill) => skill.id !== skillId),
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  importSkills: (incoming) => {
    if (get().readOnly) {
      set({ castError: "现在是只读：换到能写的窗口再导入技能。" });
      return false;
    }
    if (incoming.length === 0) {
      set({ castError: "这个文件里没有能导入的技能。" });
      return false;
    }
    const { project, events } = get();
    const used = new Set(project.skills.map((skill) => skill.id));
    const parsed: ProjectSkill[] = [];
    for (const skill of incoming) {
      let id = skill.id;
      while (used.has(id)) id += "x";
      used.add(id);
      const next = ProjectSkillSchema.safeParse({ ...skill, id });
      if (!next.success) {
        set({ castError: `技能不合法：${next.error.issues[0]?.message ?? "未知原因"}` });
        return false;
      }
      parsed.push(next.data);
    }
    const event: ProjectEvent = {
      type: "project.updated",
      at: stamp(),
      skills: [...project.skills, ...parsed],
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
  },

  adoptSharedSkill: (skill) => {
    if (get().readOnly) {
      set({ castError: "现在是只读：换到能写的窗口再改技能。" });
      return false;
    }
    const { project, events } = get();
    const same = (item: ProjectSkill) =>
      item.name.trim() === skill.name.trim() && item.body.trim() === skill.body.trim();
    if (project.skills.some(same)) {
      set({ castError: "这条技能已经在用了。" });
      return false;
    }
    let id = `sk-${Date.now().toString(36)}`;
    while (project.skills.some((item) => item.id === id)) id += "x";
    const parsed = ProjectSkillSchema.safeParse({
      ...skill,
      id,
      enabled: true,
      createdAt: stamp(),
    });
    if (!parsed.success) {
      set({ castError: `技能不合法：${parsed.error.issues[0]?.message ?? "未知原因"}` });
      return false;
    }
    const event: ProjectEvent = {
      type: "project.updated",
      at: stamp(),
      skills: [...project.skills, parsed.data],
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
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

  restoreTake: (takeId) => {
    if (get().readOnly) {
      set({ castError: "现在是只读：换到能写的窗口再取回。" });
      return false;
    }
    const { project, events } = get();
    const existing = project.takes.find((take) => take.id === takeId);
    // 删掉的拍只剩日志里的记录：take.added 里有原始 take
    const take = existing ?? takeFromLog(events, takeId);
    if (!take) {
      set({ castError: "日志里找不到这一拍。" });
      return false;
    }
    const shot = project.shots.find((item) => item.id === take.shotId);
    if (!shot) {
      set({ castError: "这一镜已经删了，拍子挂不回去。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再取回。" });
      return false;
    }
    if (existing?.status === "approved") {
      set({ castError: "这一拍已经留用了，不用从废片库取回。" });
      return false;
    }
    const at = stamp();

    // 删掉的一拍：按原记录放回去（新记录仍是待审，作者再决定留不留用）
    if (!existing) {
      const event: ProjectEvent = {
        type: "take.added",
        at,
        take: { ...take, status: "draft" },
      };
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        castError: undefined,
      });
      return true;
    }

    // 淘汰的一拍：改回待审，并挪到镜头最后一拍（界面默认显示的那一拍）
    const needsStatus = existing.status !== "draft";
    const needsOrder = shot.takeIds.at(-1) !== takeId;
    if (!needsStatus && !needsOrder) {
      set({ castError: "这一拍已经在镜头最后，也是待审状态。" });
      return false;
    }
    const written: ProjectEvent[] = [];
    if (needsStatus) {
      written.push({ type: "take.updated", at, takeId, patch: { status: "draft" } });
    }
    if (needsOrder) {
      written.push({
        type: "shot.updated",
        at,
        shotId: shot.id,
        patch: {
          takeIds: [...shot.takeIds.filter((id) => id !== takeId), takeId],
        },
      });
    }
    const next = written.reduce(applyEvent, project);
    set({
      project: next,
      events: [...events, ...written],
      castError: undefined,
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

  applyShotTemplate: (shotId, template) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再套模板。" });
      return false;
    }
    // 机位坐标（B13）不跟着模板走：那是摆位事实，不是拍法
    const patch: Partial<Shot> = {
      ...shotTemplatePatch(sanitizeShotTemplate(template)),
      camera: {
        ...shot.camera,
        ...shotTemplatePatch(sanitizeShotTemplate(template)).camera!,
      },
    };
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

  applyShotBatch: (sceneId, patch) => {
    if (get().readOnly) return 0;
    const plan = batchPlanOf(get().project, sceneId, patch);
    if ("error" in plan || plan.changes.length === 0) {
      if ("error" in plan) set({ castError: plan.error });
      return 0;
    }
    const at = stamp();
    let project = get().project;
    const appended: ProjectEvent[] = [];
    for (const change of plan.changes) {
      const event: ProjectEvent = {
        type: "shot.updated",
        at,
        shotId: change.shotId,
        patch: change.next,
      };
      project = applyEvent(project, event);
      appended.push(event);
    }
    set({ project, events: [...get().events, ...appended], castError: undefined });
    return appended.length;
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

  setShotContinuation: (shotId, tailMs) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      set({ castError: "找不到这一镜。" });
      return false;
    }
    if (shot.locked) {
      set({ castError: "这一镜已锁定，先解锁再改接续。" });
      return false;
    }
    let next = null as { tailMs: number } | null;
    if (tailMs !== null) {
      if (!Number.isInteger(tailMs) || tailMs < 500 || tailMs > 5000) {
        set({ castError: "回头时长要是 0.5–5 秒的整数毫秒。" });
        return false;
      }
      const previous = previousShotOf(project, shot.id);
      if (!previous) {
        set({ castError: "这一镜是开头，没有上一段可接。" });
        return false;
      }
      next = { tailMs };
    }
    const current = shot.continuation ?? null;
    const same =
      (current === null && next === null) ||
      (current !== null && next !== null && current.tailMs === next.tailMs);
    if (same) return false;
    const event: ProjectEvent = {
      type: "shot.updated",
      at: stamp(),
      shotId: shot.id,
      patch: { continuation: next },
    };
    try {
      set({ project: applyEvent(project, event), events: [...events, event], castError: undefined });
      return true;
    } catch (error) {
      set({ castError: error instanceof Error ? error.message : "接续没写上。" });
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
      stamp,
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
          skills: project.skills,
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

  attachVideo: (shotId, rawUri, source = "upload") => {
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
      // 从别的空间取来的片子是「拿过来的」，不是这次导入的
      modelId: source === "library" ? "library" : "import",
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
          source,
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

  restoreVoiceTake: (takeId) => {
    if (get().readOnly) {
      set({ castError: "现在是只读：换到能写的窗口再取回。" });
      return false;
    }
    if (lockedStage({ get, set }, "voice")) return false;
    const { project, events } = get();
    if (project.voiceTakes.some((take) => take.id === takeId)) {
      set({ castError: "这一版还在试听台里，不用取回。" });
      return false;
    }
    const take = voiceTakeFromLog(events, takeId);
    if (!take) {
      set({ castError: "日志里找不到这一版配音。" });
      return false;
    }
    if (!project.dialogue.some((line) => line.id === take.lineId)) {
      set({ castError: "这句台词已经删了，配音挂不回去。" });
      return false;
    }
    if (!project.assets.some((asset) => asset.id === take.assetId)) {
      set({ castError: "这一版的音频资产已经不在项目里了。" });
      return false;
    }
    const event: ProjectEvent = { type: "voice.take.added", at: stamp(), take };
    try {
      set({
        project: applyEvent(project, event),
        events: [...events, event],
        castError: undefined,
      });
    } catch (error) {
      set({ castError: error instanceof Error ? error.message : "这一版取不回来。" });
      return false;
    }
    return true;
  },

  attachVoice: (lineId, rawUri, source = "upload") => {
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
    if (!/^(https?:\/\/|data:audio\/|loomina:\/\/assets\/|s3:\/\/)/i.test(uri)) {
      set({
        castError:
          "音轨要先有地址：http(s)://、data:audio/、本机资产库或对象存储地址开头。",
      });
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
          source,
          uri,
          ...(mime ? { mime } : {}),
          provenance: {
            // 从别的空间取来的音轨是「拿过来的」，不是这次导入的
            modelId: source === "library" ? "library" : "import",
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
      loop: true, fadeInMs: 0, fadeOutMs: 0,
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
      loop: loopOn, fadeInMs: 0, fadeOutMs: 0,
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

  restoreScriptVersion: (eventIndex) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const version = scriptVersionsOf(events).find((item) => item.eventIndex === eventIndex);
    if (!version) {
      set({ scriptNotice: "找不到这一版剧本。" });
      return false;
    }
    const restore = scriptRestoreEvents(project, version.project, stamp());
    if (restore.events.length === 0) {
      set({ scriptNotice: "现在就是这一版，没有要改的。" });
      return false;
    }
    try {
      // 先整批在草稿上回放：任何一条不合法都不落半份剧本
      const nextProject = replayRestore(project, restore.events);
      const skipped =
        restore.missingScenes + restore.missingShots + restore.missingLines +
        restore.lockedShots + restore.droppedLocations;
      set({
        project: nextProject,
        events: [...events, ...restore.events],
        castError: undefined,
        scriptNotice:
          (skipped > 0
            ? `已写回这一版：${restore.events.length} 条改动；${skipped} 处带不回来（已删结构 / 锁定镜头 / 失效地点不重建）。`
            : `已写回这一版：${restore.events.length} 条改动。`) +
          "关键帧、take 与配音没有动；想连别的阶段一起回退，用「整份回到这里」。",
      });
      return true;
    } catch (error) {
      set({ scriptNotice: error instanceof Error ? error.message : "这一版剧本没写回来。" });
      return false;
    }
  },

  adoptSharedStory: (source, fromWorkspaceName) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const imported = storyImportPatch(project, source);
    if (!imported) {
      set({ castError: "现在就是这一版故事，没有要改的。" });
      return false;
    }
    const event: ProjectEvent = { type: "story.updated", at: stamp(), patch: imported.patch };
    try {
      const nextProject = applyEvent(project, event);
      const dropped = imported.droppedArcs + imported.droppedRelationships;
      set({
        project: nextProject,
        events: [...events, event],
        castError: undefined,
        storyNotice:
          dropped > 0
            ? `已取用「${fromWorkspaceName}」的故事；其中 ${dropped} 条弧光 / 关系因本空间没有同名角色，没有带过来。`
            : `已取用「${fromWorkspaceName}」的故事。`,
      });
      return true;
    } catch (error) {
      set({ castError: error instanceof Error ? error.message : "故事没取成。" });
      return false;
    }
  },

  adoptSharedScene: (source, sceneId, fromWorkspaceName) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const sourceScene = source.scenes.find((scene) => scene.id === sceneId);
    if (!sourceScene) {
      set({ castError: "找不到这一场。" });
      return false;
    }
    const tag = Date.now().toString(36);
    const imported = sceneImportEvents(source, project, sceneId, tag, stamp());
    if (!imported) {
      const readiness = sceneReadiness(source, project, sourceScene);
      set({
        castError: readiness.missing.length
          ? `这一场取不过来：本空间缺 ${readiness.missing.join("、")}。`
          : "这一场取不过来。",
      });
      return false;
    }

    try {
      // 先整批在草稿上回放：任何一条不合法都不落半场
      let nextProject = project;
      for (const event of imported.events) nextProject = applyEvent(nextProject, event);
      set({
        project: nextProject,
        events: [...events, ...imported.events],
        castError: undefined,
      });
      return true;
    } catch (error) {
      set({ castError: error instanceof Error ? error.message : "这一场没取成。" });
      return false;
    }
  },

  adoptSharedScenes: (source, sceneIds, fromWorkspaceName) => {
    if (get().readOnly) return undefined;
    const { project, events } = get();
    const at = stamp();
    const batch = sceneBatchOf(source, project, Date.now().toString(36), at, sceneIds);
    if (batch.events.length === 0) {
      const reasons = batch.skipped
        .slice(0, 4)
        .map((item) => `${item.label}缺${item.missing.join("、")}`)
        .join("；");
      set({
        castError: reasons
          ? `一场都没取过来：${reasons}${batch.skipped.length > 4 ? " 等" : ""}。`
          : "没有可取的场。",
      });
      return undefined;
    }

    try {
      // 先在草稿上整批回放：任何一条不合法都不落半本剧本
      let nextProject = project;
      for (const event of batch.events) nextProject = applyEvent(nextProject, event);
      set({
        project: nextProject,
        events: [...events, ...batch.events],
        castError: undefined,
        generationNotice: undefined,
      });
      return {
        scenes: batch.scenes,
        shots: batch.shots,
        lines: batch.lines,
        skipped: batch.skipped.length,
      };
    } catch (error) {
      set({ castError: error instanceof Error ? error.message : "整本没取成。" });
      return undefined;
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

  attachTrashReference: (assetId, target) => {
    if (get().readOnly) return false;
    const { project, events } = get();
    const asset = project.assets.find((item) => item.id === assetId);
    if (!asset) {
      set({ castError: "这个文件已经不在项目里了。" });
      return false;
    }
    if (asset.kind !== "image") {
      set({ castError: "只有图片能当参考图；视频要先抽一帧。" });
      return false;
    }

    const current =
      target.kind === "character"
        ? project.characters.find((item) => item.id === target.id)
        : target.kind === "location"
          ? project.locations.find((item) => item.id === target.id)
          : project.props.find((item) => item.id === target.id);
    if (!current) {
      set({ castError: "找不到要挂的那一条。" });
      return false;
    }
    if (current.referenceImages.includes(assetId)) {
      set({ castError: "这张图已经挂过了。" });
      return false;
    }
    if (current.referenceImages.length >= REFERENCE_IMAGES_MAX) {
      set({ castError: `参考图最多 ${REFERENCE_IMAGES_MAX} 张：再多会把提示词挤爆。` });
      return false;
    }

    const at = stamp();
    const referenceImages = [...current.referenceImages, assetId];
    const event: ProjectEvent =
      target.kind === "character"
        ? { type: "character.updated", at, characterId: target.id, patch: { referenceImages } }
        : target.kind === "location"
          ? { type: "location.updated", at, locationId: target.id, patch: { referenceImages } }
          : { type: "prop.updated", at, propId: target.id, patch: { referenceImages } };
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
          "没听懂这句。现在认得：太暗了 / 太亮 / 换个角度 / 靠近一点 / 拉远 / 手持 / 稳住 / 快一点 / 慢一点 / 压抑一点 / 柔和一点。",
      });
      return false;
    }

    // 只写这次真的改了的字段；同样的补充不重复追加
    const patch: Partial<Shot> = {};
    if (parsed.shotSize) patch.shotSize = parsed.shotSize;
    if (parsed.camera) patch.camera = parsed.camera;
    if (parsed.durationMs) patch.durationMs = parsed.durationMs;
    if (parsed.lighting) patch.lighting = parsed.lighting;
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

  instructScope: (text) => {
    if (get().readOnly) return 0;
    const { project, currentShotId } = get();
    const current = project.shots.find((item) => item.id === currentShotId);
    if (!current) return 0;

    const scope = parseInstructionScope(text);
    // 作用域里的镜：整片 = 全部，这一场 = 同场，这一镜 = 当前
    const inScope =
      scope === "film"
        ? project.shots
        : scope === "scene"
          ? project.shots.filter((item) => item.sceneId === current.sceneId)
          : [current];

    const at = stamp();
    let next = project;
    const appended: ProjectEvent[] = [];
    let understood = false;
    for (const shot of inScope) {
      if (shot.locked) continue;
      const parsed = parseInstruction(text, shot);
      if (!parsed) continue;
      understood = true;
      const patch: Partial<Shot> = {};
      if (parsed.shotSize) patch.shotSize = parsed.shotSize;
      if (parsed.camera) patch.camera = parsed.camera;
      if (parsed.durationMs) patch.durationMs = parsed.durationMs;
      if (parsed.lighting) patch.lighting = parsed.lighting;
      if (parsed.note && !shot.promptNotes.includes(parsed.note)) {
        patch.promptNotes = [...shot.promptNotes, parsed.note];
      }
      if (Object.keys(patch).length === 0) continue;
      const event: ProjectEvent = { type: "shot.updated", at, shotId: shot.id, patch };
      next = applyEvent(next, event);
      appended.push(event);
    }

    if (!understood) {
      set({
        castError:
          "没听懂这句。现在认得：太暗了 / 太亮 / 换个角度 / 靠近一点 / 拉远 / 手持 / 稳住 / 快一点 / 慢一点 / 压抑一点 / 柔和一点。前面还可以说「这一场」「整片」。",
      });
      return 0;
    }
    if (appended.length === 0) {
      set({ castError: "这句没改动什么：范围内的镜头已经是这样了。" });
      return 0;
    }
    set({ project: next, events: [...get().events, ...appended], castError: undefined });
    return appended.length;
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
      stamp,
      {
        key: propId,
        label: prop.name,
        assetId,
        job: { kind: "prop" },
        body: {
          kind: "prop",
          prop: { name: prop.name, description: prop.description },
          look: get().project.look,
          skills: get().project.skills,
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
      scriptNotice: undefined,
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
