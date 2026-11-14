/**
 * 工作台状态与动作的类型（从 `workbench-store.ts` 拆出，2026-11-15）。
 *
 * 单独一个文件是为了让按领域拆出去的 action 切片能引用类型，
 * 而不必反过来 import store 的实现——那会形成循环。
 *
 * 这里只有类型：没有任何运行时值。
 */

import type {
  ApprovalTargetType,
  Asset,
  AudioMix,
  BeatKind,
  Blocking,
  Camera,
  CameraPlacement,
  Character,
  Composition,
  Frame as FrameSetting,
  GateStage,
  Grade,
  Lighting,
  Location,
  Look,
  Motif,
  MusicCue,
  PerformanceSpec,
  Project,
  ProjectEvent,
  ProjectSkill,
  Prop,
  PublishPackage,
  RightsRecordInput,
  Scene,
  SfxCue,
  Shot,
  ShotFocus,
  ShotPurpose,
  SheetView,
  SkillStage,
  SourceDocument,
  StagingMark,
  StoryArc,
  StoryRelationship,
  TimelineItem,
  Transition,
  VoicePerformance,
} from "@loomina/ir";
import type { BatchPatch } from "./shot-batch";
import type { ShotTemplate } from "./shot-template";
import type { SharedEntity } from "./shared-entities";
import type { DoctorRewriteItem } from "./doctor-ai";
import type { WorkbenchMode } from "./stage-lock";
import type { WorkspaceMeta } from "./event-log";
import type { ProjectTemplate } from "./project-template";
import type { Frame, StoryDraft } from "@loomina/pipeline";
import type { AssetInventory } from "./asset-inventory";
import type { Modality } from "./config-types";

export type Decision = "approved" | "rejected";

/** 故事层可改的字段（A16）；与 `story.updated` 的 patch 同一形状 */
export type StoryPatch = Extract<ProjectEvent, { type: "story.updated" }>["patch"];

/** 正在生成哪一张：定妆台的三类资产共用一条进度记录（视频按 `${shotId}:video` 记）。 */
export type GenerateJob =
  | { kind: "sheet"; angle: SheetView }
  | { kind: "master" }
  | { kind: "prop" }
  | { kind: "keyframe"; frame: Frame }
  | { kind: "video"; attempt?: number }
  | { kind: "voice" }
  | { kind: "asr" };

export type WorkbenchState = {
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
  /** 剧本版本库的一句话：写回了几条、哪些带不回来（C14 / ADR-0204） */
  scriptNotice?: string;
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
  /**
   * 结果缓存（H14 / ADR-0208）：同一套输入已经出过的图，直接复用不再花钱。
   * 存在 localStorage，跨页面生效；关掉之后每次都真去生成。
   */
  reuseCache: boolean;
  /** 开关结果缓存；关掉时界面上要能看出「这次会真花钱」 */
  setReuseCache: (on: boolean) => void;
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
   * 加一条技能（C.5 / ADR-0191）：整份 `skills` 写一条 `project.updated`。
   * 技能会改下一次出图的提示词；已出的图不自动重做。
   */
  addSkill: (input: {
    name: string;
    description?: string;
    stage?: SkillStage;
    body: string;
  }) => string | undefined;
  updateSkill: (
    skillId: string,
    patch: Partial<Pick<ProjectSkill, "name" | "description" | "stage" | "body" | "enabled">>,
  ) => boolean;
  removeSkill: (skillId: string) => boolean;
  /**
   * 取用别的空间的一条技能（C.5 / ADR-0202）：抄成当前项目的一条新技能。
   *
   * 内容照抄、id 重新编（`sk-<时间戳>`），默认启用；同名同内容的已在就不重复加。
   * 不调模型、不花钱。
   */
  adoptSharedSkill: (skill: ProjectSkill) => boolean;
  /**
   * 导入一批技能（C18 / ADR-0210）：一次 `project.updated { skills }`。
   *
   * 传进来的 id 由 `parseSkillsFile` 重编好；这里再兜一次「与本项目已有 id 撞车」。
   * 不调模型、不花钱。
   */
  importSkills: (skills: ProjectSkill[]) => boolean;
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
   * 按场批量套用摄影参数（I7 第三档）：一场一条事件一条事件地写。
   *
   * 锁定的镜跳过、已经是这样的镜不写。返回实际写了几条事件。
   * 所有事件共用一个 `at`：整批是一次操作，撤销一步整批退回。
   */
  applyShotBatch: (sceneId: string, patch: BatchPatch) => number;
  /**
   * 写这一镜的光影模板（I2）：一条 `shot.updated { lighting }`；
   * `undefined` 表示清空（沿用场景与风格给的光）。
   */
  setShotLighting: (shotId: string, lighting: Lighting | undefined) => boolean;
  /** 写这一镜的构图模板（I4）：一条 `shot.updated { composition }`；`undefined` 清空 */
  setShotComposition: (shotId: string, composition: Composition | undefined) => boolean;
  /**
   * 接上一段（C.6 / ADR-0192）：本段开头先重复上一段最后 `tailMs` 毫秒的动作；
   * `null` 表示明确硬接。开头那一镜没有上一段，拒绝。
   */
  setShotContinuation: (shotId: string, tailMs: number | null) => boolean;
  /**
   * 套一份镜头模板（F3 / ADR-0207）：一条 `shot.updated`，只换摄影做法。
   *
   * 写景别 / 机位三参数 / 可选光影与构图；动作、台词、时长、出场人物与道具不动。
   * 锁定的镜头拒绝；模板里没有的光影 / 构图不清空这一镜原来的。
   */
  applyShotTemplate: (shotId: string, template: ShotTemplate) => boolean;
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
  /**
   * 从废片库取回一拍（C14 / ADR-0193）。
   *
   * 淘汰的拍改回待审并挪到本镜最后；日志里删掉的拍按原记录重新 `take.added`。
   * 不重新生成、不花钱。锁定的镜头拒绝；已留用的拍不在这里动。
   */
  restoreTake: (takeId: string) => boolean;
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
  attachVideo: (shotId: string, uri: string, source?: Asset["source"]) => boolean;
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
   * 从废片库取回一版配音（C14 / ADR-0196）：按日志里的原记录重新
   * `voice.take.added`，只回到试听台，不自动采用、不重新配音、不花钱。
   */
  restoreVoiceTake: (takeId: string) => boolean;
  /**
   * 贴一条音轨当这一句的配音（ADR-0085）：收 http(s):// 或 data:audio/。
   * 供应商配额不通、或已经用自己的录音时，都走这条路。
   */
  attachVoice: (lineId: string, uri: string, source?: Asset["source"]) => boolean;
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
      Pick<
        MusicCue,
        | "gainDb"
        | "duckDb"
        | "ducking"
        | "mood"
        | "role"
        | "motifId"
        | "startMs"
        | "durationMs"
        | "fadeInMs"
        | "fadeOutMs"
      >
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
    patch: Partial<
      Pick<SfxCue, "gainDb" | "loop" | "role" | "startMs" | "durationMs" | "fadeInMs" | "fadeOutMs">
    >,
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
   * 按作用域改（E11）：一句话可以落在这一镜 / 这一场 / 整片。
   *
   * 作用域从话里认（`parseInstructionScope`），认不出就按当前这一镜。
   * 锁定的镜跳过；每镜各自算补丁（同一句话在不同镜上可能改不同的东西）。
   * 整批共用一个 `at`：撤销一步整批退回。返回写了几条事件。
   */
  instructScope: (text: string) => number;
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
   * 新建一个工作空间：一条独立的日志，名字即新项目的标题。
   *
   * 不给 `fromWorkspaceId` 时从示例项目开工；给了就照那个空间的**设定**
   * 开工（故事 / 演员 / 场景 / 道具 / 技能 / 风格，不带成片，C.1 / ADR-0197）。
   * 返回新空间的 id；调用方负责整页加载过去（换空间走 reload，见 ADR-0188）。
   */
  createWorkspace: (name: string, fromWorkspaceId?: string) => Promise<string | undefined>;
  /** 改工作空间名字：只改本机的登记表，不动项目标题与日志 */
  renameWorkspace: (id: string, name: string) => Promise<boolean>;
  /**
   * 删掉一个工作空间（C15 / ADR-0201）：事件行、日志版本、登记表一起清。
   *
   * 不能删当前打开的空间（先切走再删）；素材文件不删，字节可能被别的空间用着。
   * 返回删掉了几条事件；失败写 `workspaceError`。
   */
  deleteWorkspace: (id: string) => Promise<number | undefined>;
  /**
   * 导出某个空间的完整事件日志（C15 / 删除前导出）。
   *
   * 删空间不可恢复，删之前至少能留个底。返回文件名与 JSON 文本，
   * **下载由组件做**——store 不碰 DOM，这样这段逻辑可测。
   * 空间不存在或读不出来时写 `workspaceError` 并返回 undefined。
   */
  exportWorkspace: (
    id: string,
  ) => Promise<{ fileName: string; json: string } | undefined>;
  /**
   * 一次删掉所有已归档的空间（C15 批量删除）。
   *
   * 只删归档的：正在打开的那个不可能归档，所以不会被误删。
   * 返回删掉的空间数；一个都没有时返回 0 且不报错。
   */
  deleteArchivedWorkspaces: () => Promise<number>;
  /**
   * 归档 / 取消归档一个工作空间（C15 / ADR-0210）：只改登记表里的 `archivedAt`。
   *
   * 归档 = 从主列表与跨空间取用清单里隐藏；日志、素材、连载归属都不动。
   * 正在打开的空间不能归档（写锁与内存项目还挂着）。
   */
  archiveWorkspace: (id: string, archived: boolean) => Promise<boolean>;
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
   * 把剧本 / 分镜写回某一版（C14 / ADR-0204）：一批事件只改当前仍存在的
   * 场 / 镜 / 句的剧本字段，不动 take / 关键帧 / 配音 / 时间线。
   * 同批共用一个 `at`，撤销一步可退；与现在一致时不写事件。
   */
  restoreScriptVersion: (eventIndex: number) => boolean;
  /**
   * 取用别的空间的一版故事（C1 / ADR-0198）：一条 `story.updated` 整份写回。
   *
   * 弧光 / 关系只带本空间有**同名同 id** 角色的那些，其余过滤并计数——
   * 名字对不上就不算同一个人，不把弧光安到别人身上。不调模型、不花钱。
   * 与本空间现在一致时不写事件。
   */
  adoptSharedStory: (source: Project, fromWorkspaceName: string) => boolean;
  /**
   * 取用别的空间的一场剧本（C1 / ADR-0199）：场 + 镜 + 台词整场追加到末尾。
   *
   * 地点与出场演员必须本空间同名同 id，否则整场拒绝（不取半场）；
   * 对不上的道具只摘引用。id 全部重编、关键帧 / take / 配音 / 时间线不跟。
   * 同一批事件共用一个 `at`，撤销一步就能整场退回。不调模型、不花钱。
   */
  adoptSharedScene: (source: Project, sceneId: string, fromWorkspaceName: string) => boolean;
  /**
   * 整本剧本一起取（C24 / ADR-0212）：按场序串行、一次写一批事件。
   *
   * 缺人 / 缺地点的场跳过并计数，其余照取；同一批共用一个 `at`，撤销一步整本退回。
   * 一场都没取成时不写事件。不调模型、不花钱。
   */
  adoptSharedScenes: (
    source: Project,
    sceneIds: string[],
    fromWorkspaceName: string,
  ) => { scenes: number; shots: number; lines: number; skipped: number } | undefined;
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
  /**
   * 把废片库里的旧关键帧挂成人物 / 场景 / 道具的参考图（C2 / ADR-0200）。
   *
   * 只登记引用，不复制文件、不重新生成、不花钱；图片已经在资产里，直接挂同一个 id。
   */
  attachTrashReference: (
    assetId: string,
    target: { kind: "character" | "location" | "prop"; id: string },
  ) => boolean;
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
