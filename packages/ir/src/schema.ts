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
});
export type Location = z.infer<typeof LocationSchema>;

export const CharacterSchema = z.object({
  id: Id,
  name: z.string().min(1),
  appearance: z.string().default(""),
  voiceProfileId: Id.optional(),
});
export type Character = z.infer<typeof CharacterSchema>;

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
  dialogueIds: z.array(Id).default([]),
  takeIds: z.array(Id).default([]),
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
  locations: z.array(LocationSchema).default([]),
  characters: z.array(CharacterSchema).default([]),
  scenes: z.array(SceneSchema).default([]),
  shots: z.array(ShotSchema).default([]),
  dialogue: z.array(DialogueLineSchema).default([]),
  takes: z.array(TakeSchema).default([]),
  timeline: TimelineSchema.default({ items: [] }),
  publishPackages: z.array(PublishPackageSchema).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;
/** 写项目时的形状：带 default 的字段可以省略，parse 后补齐。 */
export type ProjectInput = z.input<typeof ProjectSchema>;
