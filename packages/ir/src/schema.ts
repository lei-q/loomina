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

/** 三维坐标：地点局部坐标，米，右手系，Y 向上（B13 / ADR-0126） */
export const Vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export type Vec3 = z.infer<typeof Vec3Schema>;

/** 地点里的一处固定物：门、窗、桌……（B13 / ADR-0126） */
export const LocationAnchorSchema = z.object({
  id: Id,
  kind: z.enum(["door", "window", "furniture", "prop", "light", "mirror", "wall"]),
  /** 人话名字（"沙发（中左）"）；俯视图上标得出来，也方便作者对上模板。旧数据没有就显示 id */
  label: z.string().optional(),
  position: Vec3Schema,
  /** 绕 Y 轴朝向，弧度 */
  facingRad: z.number().finite().default(0),
  /** 可站 / 坐人数；0 表示不可承载 */
  capacity: z.number().int().nonnegative().default(0),
});
export type LocationAnchor = z.infer<typeof LocationAnchorSchema>;

/**
 * 地点几何（B13 / ADR-0126）：坐标是事实，不是提示词。
 *
 * 只有选了带几何的场景模板才有；没有的项目照旧走 ADR-0108 的调度近似越轴。
 */
export const LocationSpaceSchema = z.object({
  /** 宽 × 深 × 高（米） */
  dimensions: Vec3Schema,
  anchors: z.array(LocationAnchorSchema).default([]),
});
export type LocationSpace = z.infer<typeof LocationSpaceSchema>;

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
  /** 几何事实（B13）：模板带的尺寸与锚点；没有就没有坐标 */
  space: LocationSpaceSchema.optional(),
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
  /**
   * 带条件确认（A12）：确认时明知还有可豁免的缺口（例如覆盖率不满），
   * 勾了「我知道」才写进这一条。缺省 false，旧日志读出来也是 false。
   */
  override: z.boolean().default(false),
});
export type GateRecord = z.infer<typeof GateRecordSchema>;

/** 重音：按字符区间定位，不按文本匹配（C2 / ADR-0124） */
export const EmphasisSpanSchema = z.object({
  /** 起始字符下标（含） */
  start: z.number().int().nonnegative(),
  /** 结束字符下标（不含）；写入时不得超过当前字数 */
  end: z.number().int().positive(),
  /** 1–3，默认 2 */
  strength: z.number().int().min(1).max(3).default(2),
});
export type EmphasisSpan = z.infer<typeof EmphasisSpanSchema>;

/** 停顿：第 afterChar 个字之后停 ms 毫秒（C2 / ADR-0124） */
export const PauseMarkSchema = z.object({
  afterChar: z.number().int().nonnegative(),
  ms: z.number().int().min(50).max(2000),
});
export type PauseMark = z.infer<typeof PauseMarkSchema>;

/**
 * 逐句表演参数（C2 / C9 / ADR-0124）。
 *
 * 它描述「下一次出声要怎么念」，不改 `durationMs`——时长以真实音轨为准（P5）。
 * 供应商可能忽略其中几项，界面如实标「当前模型可能不支持」。
 */
export const VoicePerformanceSchema = z.object({
  /** 0.5–2.0，1 为原速 */
  rate: z.number().min(0.5).max(2).default(1),
  /** 半音偏移，−12–+12 */
  pitch: z.number().min(-12).max(12).default(0),
  /** 线性增益，0.25–2.0 */
  volume: z.number().min(0.25).max(2).default(1),
  /** 气声比例 0–1 */
  breathiness: z.number().min(0).max(1).default(0),
  emphasis: z.array(EmphasisSpanSchema).max(8).default([]),
  pauses: z.array(PauseMarkSchema).max(8).default([]),
  /** 情绪标签，进提示词；空串表示不标 */
  emotion: z.string().max(20).default(""),
  /** 句尾走向 */
  ending: z.enum(["rise", "flat", "fall"]).default("flat"),
});
export type VoicePerformance = z.infer<typeof VoicePerformanceSchema>;

export const DialogueLineSchema = z.object({
  id: Id,
  characterId: Id,
  text: z.string().min(1),
  /** TTS 音频时长；镜头时长服从它（准则 P5）。 */
  durationMs: z.number().int().positive(),
  /** 这一句的配音资产（ADR-0085）；没有就是还没配。 */
  audioAssetId: Id.optional(),
  /** 逐句表演参数（C2 / ADR-0124）；没写按默认值处理 */
  performance: VoicePerformanceSchema.optional(),
});
export type DialogueLine = z.infer<typeof DialogueLineSchema>;

/**
 * 配音的一版（C9 / ADR-0124）：试听台里的一条。
 *
 * 不进 `DialogueLine`——视频 Take 与配音 Take 语义不同（一个比画面，一个比读法）。
 * `DialogueLine.audioAssetId` 仍是「当前采用的那条」。
 */
export const VoiceTakeSchema = z.object({
  id: Id,
  lineId: Id,
  assetId: Id,
  performance: VoicePerformanceSchema,
  provenance: ProvenanceSchema,
  createdAt: z.string().min(1),
});
export type VoiceTake = z.infer<typeof VoiceTakeSchema>;

/** 机位在场地里的位置（B13 / ADR-0126）：几何事实，不改写 `angle` */
export const CameraPlacementSchema = z.object({
  position: Vec3Schema,
  target: Vec3Schema,
});
export type CameraPlacement = z.infer<typeof CameraPlacementSchema>;

export const CameraSchema = z.object({
  angle: z.enum(["eye", "low", "high", "top"]),
  movement: z.enum(["static", "push", "pull", "pan", "tilt", "handheld"]),
  focalMm: z.number().positive(),
  /**
   * 机位坐标（B13）：有它才能算「在轴线哪一侧」。
   * 与 `angle` 分开——角度是摄影意图，坐标只是几何事实。
   */
  placement: CameraPlacementSchema.optional(),
});
export type Camera = z.infer<typeof CameraSchema>;

/** 一镜的走位（B13 / ADR-0126）：谁在哪、朝哪；坐标是场地局部坐标 */
export const BlockingSchema = z.object({
  actors: z
    .array(
      z.object({
        characterId: Id,
        position: Vec3Schema,
        facingRad: z.number().finite(),
      }),
    )
    .default([]),
  props: z.array(z.object({ propId: Id, position: Vec3Schema })).default([]),
});
export type Blocking = z.infer<typeof BlockingSchema>;

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

/**
 * 视线目标（B17 / PERFORMANCE.md 十二）。
 *
 * 「他看哪」不是形容词，是一个可以检查的引用：看人 / 看道具时必须带上 id，
 * 看镜头或画外时不该带——两头都校验，避免 id 对不上却一路带进提示词。
 */
export const GazeTargetSchema = z
  .object({
    target: z.enum(["character", "prop", "camera", "off-screen"]),
    targetId: Id.optional(),
    direction: z.enum(["left", "right", "up", "down", "center"]),
  })
  .superRefine((value, ctx) => {
    if ((value.target === "character" || value.target === "prop") && !value.targetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "看人 / 看道具时必须指定是谁 / 哪件道具",
      });
    }
    if ((value.target === "camera" || value.target === "off-screen") && value.targetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "看镜头 / 画外时不该带 id",
      });
    }
  });
export type GazeTarget = z.infer<typeof GazeTargetSchema>;

/** 起 / 转 / 落三段表演节拍（B16 / ADR-0019）。 */
export const ActionBeatSchema = z
  .object({
    phase: z.enum(["before", "during", "after"]),
    /** 微表情：嘴角、眼睑、呼吸这些镜头里看得见的小动作 */
    micro: z.string().default(""),
    /** 姿态 / 手：身体怎么摆、手在干什么 */
    body: z.string().default(""),
    action: z.string().optional(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
  })
  .refine((beat) => beat.endMs >= beat.startMs, {
    message: "表演节拍的结束时间不能早于开始时间",
  });
export type ActionBeat = z.infer<typeof ActionBeatSchema>;

/**
 * 表演设计（B16 / ADR-0019）：一镜一个 objective，一个情绪转折，起转落三段。
 *
 * 可选字段：存量项目没有表演设计，生成照旧；分镜检查会把缺失列成待补，
 * 新写的镜头在检查面板里补一次即可（ADR-0103）。
 */
export const PerformanceSpecSchema = z.object({
  /** 这一镜他要什么：只能一个 */
  objective: z.string().default(""),
  emotion: z
    .object({
      surface: z.string().default(""),
      subtext: z.string().default(""),
    })
    .default({}),
  beats: z.array(ActionBeatSchema).max(3).default([]),
  /** 必填：缺失时这一镜的提示词不知道该让角色看哪 */
  gaze: GazeTargetSchema,
  intensity: z.number().int().min(1).max(5).default(3),
  /** 明确不做什么：防过火、防手部畸变 */
  avoid: z.array(z.string()).default([]),
});
export type PerformanceSpec = z.infer<typeof PerformanceSpecSchema>;

/** 镜头内的一条站位：左右 × 前后，道具也可以有（B17）。 */
export const StagingMarkSchema = z
  .object({
    characterId: Id.optional(),
    propId: Id.optional(),
    side: z.enum(["left", "center", "right"]).default("center"),
    depth: z.enum(["foreground", "midground", "background"]).default("midground"),
    note: z.string().default(""),
  })
  .refine((mark) => Boolean(mark.characterId) !== Boolean(mark.propId), {
    message: "一条调度只挂一个角色或一件道具",
  });
export type StagingMark = z.infer<typeof StagingMarkSchema>;

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
  /**
   * 表演设计（B16 / B17，ADR-0103）。可选：存量项目没有，生成照旧，
   * 分镜检查会把缺失列出来；补过之后才进提示词。
   */
  performance: PerformanceSpecSchema.optional(),
  /** 镜头内调度（B17）：谁在左 / 右、前 / 后；道具也可以标 */
  staging: z.array(StagingMarkSchema).default([]),
  /** 这一镜的走位（B13）：谁在哪、朝哪；坐标是场地局部坐标 */
  blocking: BlockingSchema.optional(),
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
  /**
   * 这一段在音乐结构里干什么（C10 / ADR-0125）：铺底、重音、转场。
   * 旧日志读出来是 `bed`。它不影响渲染，只用于曲线显示与复盘。
   */
  role: z.enum(["bed", "hit", "transition"]).default("bed"),
  /** 这条 cue 用的是哪个主题动机（C10）；空 = 没有动机 */
  motifId: Id.optional(),
  /** 授权来源备注：文件名 / 曲库 / 授权书编号，不允许空 */
  licenseRef: z.string().min(1).max(240),
});
export type MusicCue = z.infer<typeof MusicCueSchema>;

/**
 * 主题动机（C10 / ADR-0125，SOUND.md 第五节「leitmotif」）。
 *
 * 一段可循环的短素材，代表一个人 / 一对关系 / 一个地点。它是**创作决定**，
 * 无法从别的数据推出来，所以是本次唯一新增的 IR 实体；情绪曲线本身仍是派生的。
 *
 * 第一版只做「同一段素材重复出现」：变奏要音频处理，等 C4 生成音乐之后再做。
 */
export const MotifSchema = z.object({
  id: Id,
  /** 人话名字，例如「林晚的灯」 */
  label: z.string().min(1).max(40),
  /** 代表谁 / 哪对关系 / 哪个地点 */
  targetKind: z.enum(["character", "relationship", "location"]),
  /**
   * 关系没有自己的 id，用 `${from}->${to}`（有向，与 A16 一致）。
   * 角色被删时，指向它的关系动机一起失效，由 `character.removed` 清理。
   */
  targetId: Id,
  /** 动机音频：一段可循环的短素材 */
  assetId: Id,
  /** 授权来源，与 cue 同一口径：没有它不许存 */
  licenseRef: z.string().min(1).max(240),
  note: z.string().max(200).default(""),
});
export type Motif = z.infer<typeof MotifSchema>;

/**
 * 手动断句覆盖（D2）。
 *
 * 自动断句是读模型派生出来的，不落 IR；作者手动改过某一句的字幕之后，
 * 这一句的断句就以这里为准。按「整句」覆盖而不是按单条字幕 id 覆盖：
 * 单条 id 是「第几段」，改了每行字数就会错位。
 */
export const SubtitleCueOverrideSchema = z.object({
  text: z.string().min(1).max(200),
  durationMs: z.number().int().positive(),
});

export const SubtitleOverrideSchema = z.object({
  lineId: Id,
  cues: z.array(SubtitleCueOverrideSchema).min(1).max(20),
});
export type SubtitleOverride = z.infer<typeof SubtitleOverrideSchema>;

/**
 * 字幕版式（D3）：字号、离底边距离与描边。
 *
 * 两档模板（默认 / 大字）只是起点。作者改过的项存这里，没改的项跟着模板走——
 * 所以三个数值都可选，缺省表示「用模板的」。这是创作决定，推不出来，
 * 因此进 IR 而不是留在界面状态里：换设备、刷新、回放日志之后还是同一个版式。
 */
export const SubtitleLayoutSchema = z.object({
  /** 从哪一档模板改的；换档位时没改过的项跟着换 */
  preset: z.enum(["default", "large"]).default("default"),
  /** 字号，相对画面宽度的百分比（cqw） */
  fontSizeCqw: z.number().min(2).max(12).optional(),
  /** 离画面底边的距离（%）：避开平台底部操作栏 */
  bottomPct: z.number().min(2).max(45).optional(),
  /** 描边粗细（cqw） */
  strokeCqw: z.number().min(0).max(3).optional(),
});
export type SubtitleLayout = z.infer<typeof SubtitleLayoutSchema>;

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
  /** 成片资产；渲染结果没存成资产时留空，不编一个不存在的 id（ADR-0102） */
  videoAssetId: Id.optional(),
  /** 发布出去的档位（H13）：draft / final */
  quality: z.enum(["draft", "final"]).optional(),
  /** 成片文件名与字节数：便于回溯这一包对应哪个交付物 */
  fileName: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  /** 这条发布记录写入 IR 的时间 */
  recordedAt: z.string().optional(),
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
  /** 同一镜最多自动试几次（H10）：包含第一次，1–5，默认 3 */
  maxAttemptsPerShot: z.number().int().min(1).max(5).default(3),
  /** 超预算时的处置（H10）：阻断，或保留现有结果不再调用生成 */
  onBudgetExceed: z.enum(["block", "keep"]).default("block"),
  /** 故事层（ADR-0017 / ADR-0088）：logline、人物弧光、关系与钩子 */
  story: StoryBibleSchema.default({}),
  /** 主题动机（C10 / ADR-0125）：代表一个人 / 一对关系 / 一个地点 */
  motifs: z.array(MotifSchema).default([]),
  locations: z.array(LocationSchema).default([]),
  characters: z.array(CharacterSchema).default([]),
  props: z.array(PropSchema).default([]),
  scenes: z.array(SceneSchema).default([]),
  shots: z.array(ShotSchema).default([]),
  dialogue: z.array(DialogueLineSchema).default([]),
  /** 配音的多版本试听台（C9 / ADR-0124）：采用哪一版仍是 `audioAssetId` */
  voiceTakes: z.array(VoiceTakeSchema).default([]),
  takes: z.array(TakeSchema).default([]),
  assets: z.array(AssetSchema).default([]),
  approvals: z.array(ApprovalSchema).default([]),
  /** 阶段闸门的确认记录：一个阶段最多一条，重复确认按阶段覆盖（F8 / F9） */
  gates: z.array(GateRecordSchema).default([]),
  timeline: TimelineSchema.default({ items: [] }),
  /** 手动断句覆盖（D2）：只有作者改过的句子才在这里，没改的走自动断句 */
  subtitleOverrides: z.array(SubtitleOverrideSchema).default([]),
  /** 字幕版式（D3）：作者调过的字号 / 位置 / 描边；没调过就用默认档 */
  subtitleLayout: SubtitleLayoutSchema.default({}),
  publishPackages: z.array(PublishPackageSchema).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;
/** 写项目时的形状：带 default 的字段可以省略，parse 后补齐。 */
export type ProjectInput = z.input<typeof ProjectSchema>;
