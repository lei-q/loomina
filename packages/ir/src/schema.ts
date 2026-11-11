import { z } from "zod";

export const Id = z.string().min(1);
export type Id = z.infer<typeof Id>;

/**
 * 生成物的来源。所有 Take 必须有 provenance（DATA-MODEL 不变量 1）。
 */
export const ProvenanceSchema = z.object({
  modelId: z.string().min(1),
  prompt: z.string().optional(),
  seed: z.number().int().optional(),
  referenceAssetIds: z.array(Id).default([]),
  createdAt: z.string().min(1),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const LocationSchema = z.object({
  id: Id,
  name: z.string().min(1),
  templateId: Id.optional(),
  /** 场景描述：这地方长什么样——空间、陈设、光线；进主镜提示词（ADR-0063） */
  description: z.string().default(""),
  /** 场景主镜：本场所有镜头共用的空间与光线锚点（CONSISTENCY.md 第一层） */
  masterShotId: Id.optional(),
  /** 其他机位/细节参考图 */
  referenceImages: z.array(Id).default([]),
});
export type Location = z.infer<typeof LocationSchema>;

export const SheetView = z.enum(["front", "threeQuarter", "side", "back"]);
export type SheetView = z.infer<typeof SheetView>;

/** 定妆三视图：四格各自指向一张 Asset（正面 / 3-4 / 侧面 / 背面）。 */
export const CharacterSheetSchema = z.object({
  front: Id.optional(),
  threeQuarter: Id.optional(),
  side: Id.optional(),
  back: Id.optional(),
});
export type CharacterSheet = z.infer<typeof CharacterSheetSchema>;

export const CharacterSchema = z.object({
  id: Id,
  name: z.string().min(1),
  appearance: z.string().default(""),
  voiceProfileId: Id.optional(),
  /** 定妆三视图；有近景的角色必须四格齐全（cast.ts） */
  sheet: CharacterSheetSchema.default({}),
  /** 不带角度语义的参考图：表情表、服装变体、道具持握等 */
  referenceImages: z.array(Id).default([]),
  /** 监工重点：痣、疤、发型分缝、耳饰、纹身；编译提示词时必须原样带上 */
  mustNotChange: z.array(z.string()).default([]),
});
export type Character = z.infer<typeof CharacterSchema>;

/** 人物弧光（ADR-0017 / ADR-0088）：按 characterId 挂到 Story Bible 上，供下游引用。 */
export const StoryArcSchema = z.object({
  characterId: Id,
  /** 表层欲望：他在这一集里想拿到什么 */
  want: z.string().default(""),
  /** 深层需要：他真正缺的是什么 */
  need: z.string().default(""),
  /** 创伤：过去留下的裂缝 */
  wound: z.string().default(""),
  /** 缺陷：让他做错选择的东西 */
  flaw: z.string().default(""),
  /** 秘密：观众或别人还不知道的事 */
  secret: z.string().default(""),
  /** 主动性：他主动做出的选择 */
  agency: z.string().default(""),
  /** 这一集的弧光：从哪走到哪 */
  arc: z.string().default(""),
});
export type StoryArc = z.infer<typeof StoryArcSchema>;

/** 关系张力：每对关系要回答「想要 / 害怕 / 隐瞒」里的至少一件（STORY.md 第五节）。 */
export const StoryRelationshipSchema = z.object({
  fromCharacterId: Id,
  toCharacterId: Id,
  tension: z.string().default(""),
});
export type StoryRelationship = z.infer<typeof StoryRelationshipSchema>;

export const StoryHooksSchema = z.object({
  /** 开场钩子：前 3 秒抓住注意力的那一句 / 那个动作 */
  opening: z.string().default(""),
  /** 结尾钩子：这一集结束时留下的悬念 */
  ending: z.string().default(""),
});
export type StoryHooks = z.infer<typeof StoryHooksSchema>;

/**
 * Story Bible（ADR-0017 / ADR-0088）。
 *
 * 第一刀只收下游真正会引用的字段：logline、人物弧光、关系张力与钩子。
 * Beat / ScriptDoctorReport / OriginalityReport 等有评分标定后再进 IR，
 * 不先造没人读的空壳。
 */
export const StoryBibleSchema = z.object({
  logline: z.string().default(""),
  synopsis: z.string().default(""),
  genre: z.string().default(""),
  audience: z.string().default(""),
  tone: z.string().default(""),
  hooks: StoryHooksSchema.default({}),
  arcs: z.array(StoryArcSchema).default([]),
  relationships: z.array(StoryRelationshipSchema).default([]),
  /** 这份故事由哪个文本模型、根据什么输入生成 */
  provenance: ProvenanceSchema.optional(),
});
export type StoryBible = z.infer<typeof StoryBibleSchema>;

export const PropSchema = z.object({
  id: Id,
  name: z.string().min(1),
  description: z.string().default(""),
  referenceImages: z.array(Id).default([]),
});
export type Prop = z.infer<typeof PropSchema>;

export const AssetKindSchema = z.enum(["image", "video", "audio"]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

/**
 * 资产：一切被生成或上传的东西。
 * 语义（"这是三视图的侧面"）不在资产上，而在引用它的一侧——
 * 同一张图可能既是某人的侧面，又是某场戏的参考。
 */
export const AssetSchema = z.object({
  id: Id,
  kind: AssetKindSchema,
  /** 对象存储地址；示例素材没有 uri，界面用占位图渲染 */
  uri: z.string().optional(),
  source: z.enum(["upload", "generated", "library", "imported"]),
  mime: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().positive().optional(),
  provenance: ProvenanceSchema.optional(),
  /**
   * 生成这一张实际花了多少（元），来自价目表（ADR-0033）。
   * 价目表里没有这个模型就不写：未知不等于免费。
   */
  costCny: z.number().nonnegative().optional(),
  createdAt: z.string().min(1),
});
export type Asset = z.infer<typeof AssetSchema>;

export const ApprovalTargetType = z.enum(["character", "location", "prop"]);
export type ApprovalTargetType = z.infer<typeof ApprovalTargetType>;

/** 阶段闸门：确认即锁定，锁定的资产不得被流程悄悄覆盖（准则 P14）。 */
export const ApprovalSchema = z.object({
  id: Id,
  targetType: ApprovalTargetType,
  targetId: Id,
  status: z.enum(["pending", "approved", "rejected"]).default("pending"),
  approvedAt: z.string().optional(),
  /** 确认那一刻锁住的资产；之后新增的资产不在锁内 */
  lockedAssetIds: z.array(Id).default([]),
  note: z.string().optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

/**
 * 阶段闸门（F8 / F9）：七个阶段，键与路由一一对应。
 *
 * 与 `Approval` 分开：`Approval` 锁的是一个角色 / 场景 / 道具，
 * 阶段闸门确认的是「这一阶段的整体内容」——签名一变就过期，需要再确认。
 */
export const GATE_STAGES = [
  "story",
  "script",
  "cast",
  "storyboard",
  "keyframes",
  "voice",
  "edit",
] as const;
export const GateStageSchema = z.enum(GATE_STAGES);
export type GateStage = z.infer<typeof GateStageSchema>;

export const GateRecordSchema = z.object({
  stage: GateStageSchema,
  /** 确认那一刻的内容指纹（8 位十六进制）；内容一变，这条确认就过期 */
  signature: z.string().regex(/^[0-9a-f]{8}$/),
  at: z.string().min(1),
  /** 作者留下的一句话；不写就空着 */
  note: z.string().max(240).default(""),
});
export type GateRecord = z.infer<typeof GateRecordSchema>;

export const DialogueLineSchema = z.object({
  id: Id,
  characterId: Id,
  text: z.string().min(1),
  /** TTS 音频时长；镜头时长服从它（准则 P5）。 */
  durationMs: z.number().int().positive(),
  /** 这一句的配音资产（ADR-0085）；没有就是还没配。 */
  audioAssetId: Id.optional(),
});
export type DialogueLine = z.infer<typeof DialogueLineSchema>;

export const CameraSchema = z.object({
  angle: z.enum(["eye", "low", "high", "top"]),
  movement: z.enum(["static", "push", "pull", "pan", "tilt", "handheld"]),
  focalMm: z.number().positive(),
});
export type Camera = z.infer<typeof CameraSchema>;

/** 首/尾帧（ADR-0037）：视频生成先有一张定住这一刻的图。 */
export const KeyframesSchema = z.object({
  firstAssetId: Id.optional(),
  lastAssetId: Id.optional(),
});
export type Keyframes = z.infer<typeof KeyframesSchema>;

/** 短剧节拍（A11 / STORY.md 第 ④ 步）：一镜属于哪一拍。 */
export const BeatKindSchema = z.enum([
  "hook",
  "setup",
  "escalation",
  "turn",
  "climax",
  "resolution",
  "endHook",
]);
export type BeatKind = z.infer<typeof BeatKindSchema>;

/** 这一镜在覆盖率里承担什么（A12 / STORYBOARD.md V5）。 */
export const ShotPurposeSchema = z.enum([
  "establish",
  "information",
  "emotion",
  "reaction",
  "transition",
  "hook",
]);
export type ShotPurpose = z.infer<typeof ShotPurposeSchema>;

export const ShotSchema = z.object({
  id: Id,
  sceneId: Id,
  index: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  /** 人话描述：观众在这一格里看到什么。提示词由它拼出来。 */
  description: z.string().default(""),
  /** 一句话指令落下的补充要求（ADR-0039）：提示词里作为"补充：…"原样带上 */
  promptNotes: z.array(z.string()).default([]),
  shotSize: z.enum(["wide", "medium", "close", "extreme-close"]),
  camera: CameraSchema,
  /**
   * 故事节拍与镜头目的（A11 / A12，ADR-0096）。
   * 可选：旧项目没有这两个字段，分镜检查会按镜序推断，不把推断偷偷写回 IR。
   */
  beat: BeatKindSchema.optional(),
  purpose: ShotPurposeSchema.optional(),
  characterIds: z.array(Id).default([]),
  /** 关键道具：有叙事作用、需要跨镜头保持一致的东西（ADR-0030） */
  propIds: z.array(Id).default([]),
  dialogueIds: z.array(Id).default([]),
  takeIds: z.array(Id).default([]),
  keyframes: KeyframesSchema.default({}),
  locked: z.boolean().default(false),
  /**
   * 这一镜最多花多少钱（元，H10）。不写就是只受项目预算约束。
   * 单镜上限与项目上限同时生效：先到的那条拦。
   */
  budgetCny: z.number().positive().optional(),
});
export type Shot = z.infer<typeof ShotSchema>;

export const SceneSchema = z.object({
  id: Id,
  index: z.number().int().nonnegative(),
  /** 显式场号（ADR-0080）：`2A`、跳号都行；空着按顺序显示「第 N 场」 */
  code: z.string().max(4).default(""),
  locationId: Id,
  /** 内 / 外景（ADR-0050）：场头第一眼要能看出来 */
  space: z.enum(["int", "ext"]).default("int"),
  /** 日夜（ADR-0050）：光线与提示词的第一个变量 */
  timeOfDay: z.enum(["day", "night", "dawn", "dusk"]).default("day"),
  shotIds: z.array(Id).default([]),
});
export type Scene = z.infer<typeof SceneSchema>;

export const TakeSchema = z.object({
  id: Id,
  shotId: Id,
  assetId: Id,
  provenance: ProvenanceSchema,
  status: z.enum(["draft", "approved", "rejected"]).default("draft"),
  costCny: z.number().nonnegative().default(0),
});
export type Take = z.infer<typeof TakeSchema>;

export const TimelineItemSchema = z.object({
  id: Id,
  shotId: Id,
  takeId: Id,
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
});
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

/**
 * 配乐床（C4 / C12）。
 *
 * 一条音乐铺在时间线上，台词出现时按 `duckDb` 压下去；音乐文件必须先落成
 * `kind: "audio"` 的资产。`licenseRef` 不是饰品：没有它就不该加进来。
 */
export const MusicCueSchema = z.object({
  id: Id,
  assetId: Id,
  title: z.string().min(1).max(120),
  /** 情绪标签，用于选曲与复盘；空串表示没标 */
  mood: z.string().max(40).default(""),
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  /** 音乐相对对白的基准增益；响度归一化在总线上做 */
  gainDb: z.number().min(-40).max(0).default(-18),
  /** 台词下压低多少 dB；准则要求 12–18 */
  duckDb: z.number().min(12).max(18).default(15),
  ducking: z.boolean().default(true),
  /** 音乐比片子短时是否循环铺满这一段 */
  loop: z.boolean().default(true),
  /** 授权来源备注：文件名 / 曲库 / 授权书编号，不允许空 */
  licenseRef: z.string().min(1).max(240),
});
export type MusicCue = z.infer<typeof MusicCueSchema>;

export const TimelineSchema = z.object({
  items: z.array(TimelineItemSchema).default([]),
  music: z.array(MusicCueSchema).default([]),
});
export type Timeline = z.infer<typeof TimelineSchema>;

export const AILabelSchema = z.object({
  explicit: z.boolean(),
  implicit: z.boolean(),
  standard: z.string().optional(),
});
export type AILabel = z.infer<typeof AILabelSchema>;

export const PublishPackageSchema = z.object({
  id: Id,
  platform: z.string().min(1),
  videoAssetId: Id,
  aiLabel: AILabelSchema.optional(),
});
export type PublishPackage = z.infer<typeof PublishPackageSchema>;

export const ProjectSchema = z.object({
  id: Id,
  title: z.string().min(1),
  version: z.number().int().nonnegative(),
  /**
   * 这条片子的预算上限（元）。写进项目而不是写进界面：预算是项目自己的约束，
   * 换设备、刷新、重放事件日志之后还得是同一个数（准则 P14 / H10）。
   */
  budgetCny: z.number().positive().default(60),
  /** 故事层（ADR-0017 / ADR-0088）：logline、人物弧光、关系与钩子 */
  story: StoryBibleSchema.default({}),
  locations: z.array(LocationSchema).default([]),
  characters: z.array(CharacterSchema).default([]),
  props: z.array(PropSchema).default([]),
  scenes: z.array(SceneSchema).default([]),
  shots: z.array(ShotSchema).default([]),
  dialogue: z.array(DialogueLineSchema).default([]),
  takes: z.array(TakeSchema).default([]),
  assets: z.array(AssetSchema).default([]),
  approvals: z.array(ApprovalSchema).default([]),
  /** 阶段闸门的确认记录：一个阶段最多一条，重复确认按阶段覆盖（F8 / F9） */
  gates: z.array(GateRecordSchema).default([]),
  timeline: TimelineSchema.default({ items: [] }),
  publishPackages: z.array(PublishPackageSchema).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;
/** 写项目时的形状：带 default 的字段可以省略，parse 后补齐。 */
export type ProjectInput = z.input<typeof ProjectSchema>;
