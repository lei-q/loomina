"use client";

import {
  applyEvent,
  castReadiness,
  rebuild,
  REFERENCE_IMAGES_MAX,
  SHEET_ANGLES,
  shotAnchors,
  VOICE_PROFILE_MAX,
  type ApprovalTargetType,
  type Asset,
  type Character,
  type Location,
  type Project,
  type Prop,
  type ProjectEvent,
  type Scene,
  type SheetView,
  type Shot,
} from "@loomina/ir";
import { parseInstruction, shotMaterial, type Frame } from "@loomina/pipeline";
import { create } from "zustand";
import { diffEvents, getEventLog, migrateLog } from "@/lib/event-log";
import { estimateDialogueMs } from "@/lib/dialogue";
import { autoCut, timelineEquals } from "@/lib/edit";
import { claimWriter } from "@/lib/writer-lock";
import {
  latestTake,
  removedLines,
  shotLabel,
  spendOf,
  toStageView,
  undoableRemoval,
} from "@/lib/read-model";
import { sampleProject } from "@/lib/sample-project";

export type Decision = "approved" | "rejected";

/** 正在生成哪一张：定妆台的三类资产共用一条进度记录（视频按 `${shotId}:video` 记）。 */
export type GenerateJob =
  | { kind: "sheet"; angle: SheetView }
  | { kind: "master" }
  | { kind: "prop" }
  | { kind: "keyframe"; frame: Frame }
  | { kind: "video" }
  | { kind: "voice" };

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
  /** 成片页的错误：初剪没得剪、换 take 不合规，都写在这里（ADR-0086） */
  editError?: string;
  /** 登记配音模型：声音页进页面时问一次服务端 */
  setVoiceInfo: (info: { model?: string; voice?: string }) => void;
  /** 登记价目：定妆台进页面时问一次服务端 */
  setImagePrice: (price: { model: string; cny?: number }) => void;
  setVideoPrice: (price: { model: string; cnyPerSecond?: number }) => void;
  /** 改预算上限：写一条 `project.updated`，预算改了要留痕 */
  setBudget: (cny: number) => void;
  /** 从本地日志恢复；已经恢复过就什么都不做 */
  hydrate: () => Promise<void>;
  select: (shotId: string) => void;
  /** 锁 / 解锁一镜：留用过的镜头才能锁；读写都留痕（ADR-0041） */
  setShotLock: (shotId: string, locked: boolean) => void;
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
  /** 给一个角色指定音色：一条 `character.updated`；空串表示用回默认音色（ADR-0085） */
  setCharacterVoice: (characterId: string, voice: string) => boolean;
  /**
   * 自动初剪（ADR-0086）：按剧本顺序、优先留用 take 生成整条时间线，
   * 写一条 `timeline.updated`。没有可用 take 的镜头跳过并报出来。
   */
  autoCutTimeline: () => boolean;
  /** 换某一镜用的 take：一条 `timeline.updated` 整条替换（ADR-0086） */
  setTimelineTake: (itemId: string, takeId: string) => boolean;
  /** 批量补缺：按镜号顺序一帧一帧生成，跳过锁定，失败即停（ADR-0042 附记） */
  generateMissingFrames: (frame?: Frame) => Promise<void>;
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
  /** 改地点名字 / 模板 / 描述：一条 `location.updated`（ADR-0059 / ADR-0063） */
  editLocation: (
    locationId: string,
    patch: Partial<Pick<Location, "name" | "templateId" | "description">>,
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
  /** 新建场次：一条 `scene.added`，加在末尾或指定场之后，沿用前一场的地点与日夜（ADR-0064 / 0068 / 0069） */
  addScene: (locationId?: string, afterSceneId?: string) => string | undefined;
  /** 新建镜头：一条 `shot.added`，加在这一场末尾或指定镜之后（ADR-0064 / ADR-0068） */
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
  /** 划掉一条补充要求：同样写一条 shot.updated（ADR-0039 附记） */
  removeNote: (shotId: string, note: string) => void;
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

/** 当前镜之后第一格还没定的；到末尾就回到开头找；全定完了就原地不动。 */
function nextOpenShotId(project: Project, fromId: string): string {
  const { shots } = toStageView(project);
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
    const { spent } = spendOf(get().project);
    const budget = get().project.budgetCny;
    if (spent + unit > budget) {
      set({
        castError: `「${input.label}」超出预算：这一张 ¥${unit.toFixed(2)}，已花 ¥${spent.toFixed(2)} / 预算 ¥${budget.toFixed(2)}。先提高预算再生成。`,
      });
      return false;
    }
  }

  setJob(input.job);
  try {
    const response = await fetch("/api/asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.body),
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

    const at = new Date().toISOString();
    const event: ProjectEvent = {
      type: "asset.updated",
      at,
      asset: {
        id: input.assetId,
        kind: "image",
        source: "generated",
        uri: payload.uri,
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

  const at = new Date().toISOString();
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

export const useWorkbench = create<WorkbenchState>()((set, get) => ({
  project: sampleProject,
  events: initialEvents,
  currentShotId: initialShotId,
  jobs: {},

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
      at: new Date().toISOString(),
      budgetCny,
    };
    set({ project: applyEvent(project, event), events: [...events, event] });
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
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
      shotId: shot.id,
      patch: { locked },
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
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
      at: new Date().toISOString(),
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

    const at = new Date().toISOString();
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

    const at = new Date().toISOString();
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
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
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
        at: new Date().toISOString(),
        takeId: take.id,
        patch: { status: "approved" },
      });
    }
    next.push({
      type: "shot.updated",
      at: new Date().toISOString(),
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

    const at = new Date().toISOString();
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
      at: new Date().toISOString(),
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
        job: { kind: "keyframe", frame },
        body: { kind: "keyframe", frame, shot: shotMaterial(project, shot) },
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
      if (spent + unit > project.budgetCny) {
        set({
          castError: `「${label}」出视频要 ¥${unit.toFixed(2)}，已花 ¥${spent.toFixed(2)} / 预算 ¥${project.budgetCny.toFixed(2)}。先提高预算再生成。`,
        });
        return false;
      }
    }

    const jobKey = `${shot.id}:video`;
    const setJob = (value: GenerateJob | undefined) =>
      set({ jobs: { ...get().jobs, [jobKey]: value } });

    set({ castError: undefined });
    setJob({ kind: "video" });
    try {
      const response = await fetch("/api/video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shot: shotMaterial(project, shot),
          firstFrame: firstFrame.uri,
          durationMs: shot.durationMs,
        }),
      });
      const payload = (await response.json()) as {
        uri?: string;
        model?: string;
        prompt?: string;
        durationMs?: number;
        cny?: number;
        error?: string;
      };
      if (!response.ok || !payload.uri) {
        throw new Error(payload.error ?? `生成失败（${response.status}）`);
      }

      // 每拍一条就新占一个资产位，不覆盖旧 take：多 Take 的意义就是能比
      let n = shot.takeIds.length + 1;
      let assetId = `a-video-${shot.id}-${n}`;
      while (project.assets.some((asset) => asset.id === assetId)) {
        n += 1;
        assetId = `a-video-${shot.id}-${n}`;
      }
      const at = new Date().toISOString();
      const mime = /^data:(video\/[a-z0-9.+-]+)[;,]/i.exec(payload.uri)?.[1];
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
            uri: payload.uri,
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
    } catch (error) {
      setJob(undefined);
      const reason =
        error instanceof Error ? error.message : "原因没说";
      // 供应商原文可能很长：截断保留可判断的部分，前面补一句人话（ADR-0083）
      const clipped = reason.length > 240 ? `${reason.slice(0, 240)}…` : reason;
      set({
        castError: `「${label}」没出片：${clipped}。可以先「贴视频地址导入」顶上，或稍后再试。`,
      });
      return false;
    }
  },

  attachVideo: (shotId, rawUri) => {
    if (get().readOnly) return false;
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
    const at = new Date().toISOString();
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

  generateVoice: async (lineId) => {
    if (get().readOnly) return false;
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
      const at = new Date().toISOString();
      const mime = /^data:(audio\/[a-z0-9.+-]+)[;,]/i.exec(payload.uri)?.[1];
      const written: ProjectEvent[] = [
        {
          type: "asset.updated",
          at,
          asset: {
            id: assetId,
            kind: "audio",
            source: "generated",
            uri: payload.uri,
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
    const at = new Date().toISOString();
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

    const at = new Date().toISOString();
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

    const at = new Date().toISOString();
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
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
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

  generateMissingFrames: async (frame = "first") => {

    if (get().readOnly || get().batch) return;
    const { shots } = toStageView(get().project);
    const missing = shots
      // 锁定的镜头跳过：批量不是绕过闸门的理由
      .filter((shot) => !shot.locked)
      .filter((shot) => (frame === "last" ? !shot.hasLastFrame : !shot.hasKeyframe))
      .map((shot) => shot.id);

    if (missing.length === 0) {
      set({ castError: frame === "last" ? "尾帧都齐了。" : "首帧都齐了。" });
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
    const at = new Date().toISOString();
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
    const at = new Date().toISOString();
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

    const at = new Date().toISOString();
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
    const at = new Date().toISOString();
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
    const at = new Date().toISOString();
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
    const at = new Date().toISOString();
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
      at: new Date().toISOString(),
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
    const next: Partial<Pick<Location, "name" | "templateId" | "description">> = {};
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
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
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
    const at = new Date().toISOString();
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
      at: new Date().toISOString(),
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
    const at = new Date().toISOString();
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
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
      propId,
    };
    set({
      project: applyEvent(project, event),
      events: [...events, event],
      castError: undefined,
    });
    return true;
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
      at: new Date().toISOString(),
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
      keyframes: {},
      locked: false,
    };
    const event: ProjectEvent = {
      type: "shot.added",
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
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
    const at = new Date().toISOString();
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
      at: new Date().toISOString(),
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
      const at = new Date().toISOString();
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
      at: new Date().toISOString(),
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
    const { project, events, currentShotId } = get();
    const target = undoableRemoval(events, project);
    if (!target) {
      set({ castError: "没有可撤销的删除。" });
      return false;
    }
    // 删除之前的那一份项目：被删对象与它的从属物都还在里面
    const before = rebuild(events.slice(0, target.index));
    const at = new Date().toISOString();
    const written: ProjectEvent[] = [];
    let focusShotId: string | undefined;

    try {
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
            shot: { ...shot, index: Math.min(shot.index, scene.shotIds.length), dialogueIds: [], takeIds: [] },
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

      const next = written.reduce(applyEvent, project);
      set({
        project: next,
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

    const at = new Date().toISOString();
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

    const at = new Date().toISOString();
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
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
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
      at: new Date().toISOString(),
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

  reset: () => {
    const project = applyEvent(null, initialEvents[0]!);
    set({
      project,
      events: bootstrap(project),
      currentShotId: initialShotId,
      jobs: {},
      batch: undefined,
      castError: undefined,
      lastSwap: undefined,
    });
  },
}));

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
