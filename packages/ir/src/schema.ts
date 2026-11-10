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

export const DialogueLineSchema = z.object({
  id: Id,
  characterId: Id,
  text: z.string().min(1),
  /** TTS 音频时长；镜头时长服从它（准则 P5）。 */
  durationMs: z.number().int().positive(),
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

export const ShotSchema = z.object({
  id: Id,
  sceneId: Id,
  index: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  /** 人话描述：观众在这一格里看到什么。提示词由它拼出来。 */
  description: z.string().default(""),
  shotSize: z.enum(["wide", "medium", "close", "extreme-close"]),
  camera: CameraSchema,
  characterIds: z.array(Id).default([]),
  /** 关键道具：有叙事作用、需要跨镜头保持一致的东西（ADR-0030） */
  propIds: z.array(Id).default([]),
  dialogueIds: z.array(Id).default([]),
  takeIds: z.array(Id).default([]),
  keyframes: KeyframesSchema.default({}),
  locked: z.boolean().default(false),
});
export type Shot = z.infer<typeof ShotSchema>;

export const SceneSchema = z.object({
  id: Id,
  index: z.number().int().nonnegative(),
  locationId: Id,
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

export const TimelineSchema = z.object({
  items: z.array(TimelineItemSchema).default([]),
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
  locations: z.array(LocationSchema).default([]),
  characters: z.array(CharacterSchema).default([]),
  props: z.array(PropSchema).default([]),
  scenes: z.array(SceneSchema).default([]),
  shots: z.array(ShotSchema).default([]),
  dialogue: z.array(DialogueLineSchema).default([]),
  takes: z.array(TakeSchema).default([]),
  assets: z.array(AssetSchema).default([]),
  approvals: z.array(ApprovalSchema).default([]),
  timeline: TimelineSchema.default({ items: [] }),
  publishPackages: z.array(PublishPackageSchema).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;
/** 写项目时的形状：带 default 的字段可以省略，parse 后补齐。 */
export type ProjectInput = z.input<typeof ProjectSchema>;
