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
  /**
   * 这一次生成实际花了多少（元，H4）。
   *
   * 图像 / 视频有价目表可查，钱记在 `Asset.costCny` 上；文本与配音只能按用量折算
   * （token / 字数），而用量只有调用那一刻知道，所以记在溯源里。
   * 缺省表示不知道多少钱——不是 0。
   */
  costCny: z.number().nonnegative().optional(),
  /**
   * 这次生成消耗了多少（H4）：文本是 token，配音是字。
   *
   * 与 `costCny` 一起记：单价是作者填的估算，用量是供应商给的事实。
   * 只留金额的话，事后想核「这个数怎么来的」就无从查起。
   */
  usage: z
    .object({
      units: z.number().nonnegative(),
      unit: z.enum(["tokens", "chars"]),
    })
    .optional(),
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
 * 逐字导入的原文槽位（F6 / ADR-0154）。
 *
 * 只存作者选中的一章，不复制进 `provenance.prompt`；它是「这一章本来写了什么」
 * 的只读参考，不是分镜结构。指纹只用来发现本地误改，不防篡改。
 * `story.updated` 不收这个字段：换章节要写新的 `project.created`。
 */
export const SourceDocumentSchema = z.object({
  title: z.string().min(1),
  chapterIndex: z.number().int().nonnegative(),
  chapterCount: z.number().int().positive(),
  text: z.string().min(1),
  fileName: z.string().min(1).optional(),
  sourceChars: z.number().int().nonnegative(),
  importedAt: z.string().min(1),
  fingerprint: z.string().regex(/^[0-9a-f]{8}$/),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

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
  /** 逐字导入时选中的一章；旧项目没有，改编项目也没有 */
  sourceDocument: SourceDocumentSchema.optional(),
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
/**
 * 生成结果的人工复核（H6 / ADR-0132）。
 *
 * 像素与视频没有可用的模型审核服务，所以这一层由作者自己看：每一张会进成片的
 * 生成结果要么标「已看」，要么标「不可用」。没有记录 = 还没复核。
 * 审核结果进 IR：它是作者对这条片子做过的判断，刷新、换设备、回放日志都得在。
 */
export const AssetReviewSchema = z.object({
  status: z.enum(["passed", "rejected"]),
  at: z.string().min(1),
  /** 标「不可用」时写清原因；标「已看」可以不写 */
  note: z.string().optional(),
});
export type AssetReview = z.infer<typeof AssetReviewSchema>;

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
  /** 人工复核结果（H6）；缺省表示还没看 */
  review: AssetReviewSchema.optional(),
  /**
   * 只是占位（ADR-0144）：新建人物的四格先占资产位，还没有图。
   * 有 uri 的真实资产不该带这个标记；写了 uri 的新资产会自动把它清掉。
   */
  placeholder: z.boolean().optional(),
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
  /**
   * 这一句的配音相对它「本该开始」的位置挪了多少毫秒（E1 / ADR-0131）。
   *
   * 画面轨必须首尾相接（渲染清单要求），所以能自由挪的只有叠加层；
   * 配音与字幕各存一个偏移，互不影响：字幕挪了不该带着声音一起走。
   * 缺省（或 0）就是贴着台词走；旧日志没有这个字段，读出来按 0 处理。
   */
  voiceOffsetMs: z.number().int().optional(),
  /** 这一句的字幕相对本该开始的位置挪了多少毫秒（E1 / ADR-0131） */
  subtitleOffsetMs: z.number().int().optional(),
  /**
   * 这一句的译文（D5 / ADR-0173）：双语的第二行。
   *
   * 只存人写 / 模型给的那一行，不存语言代码：一部片子的目标语言是
   * `Project.subtitleTranslation.lang` 一个决定，逐句再记一次只会互相打架。
   * 缺省表示这句还没翻——双语导出时这一条只出原文，不编一行假的。
   */
  translation: z.string().max(400).optional(),
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

/**
 * 光影模板（I2）：这一镜的光**从哪来、往哪打、塑不塑形**。
 *
 * 光比与色温是整条片子的风格（`Project.look`），这里只管「这一场的光源是谁」——
 * 窗光、台灯、顶灯、实用光源、月光。两者分工明确，避免同一个旋钮在两个地方各说一套。
 */
export const LIGHTING_SOURCES = ["window", "lamp", "overhead", "practical", "moon"] as const;
export const LIGHTING_POSITIONS = ["front", "side", "back", "top", "under"] as const;
export const LIGHTING_MOODS = ["flat", "modeled", "silhouette"] as const;

export const LightingSchema = z.object({
  source: z.enum(LIGHTING_SOURCES).default("window"),
  /** 主光相对人的方向：正面平 / 侧面立体 / 逆光轮廓 / 顶光压 / 底光怪 */
  position: z.enum(LIGHTING_POSITIONS).default("side"),
  /** 塑形：平（不塑形）/ 立体（明暗过渡）/ 剪影（只剩轮廓） */
  mood: z.enum(LIGHTING_MOODS).default("modeled"),
  note: z.string().max(60).default(""),
});
export type Lighting = z.infer<typeof LightingSchema>;

/**
 * 构图模板（I4）：画面里主体放在哪、视线往哪走。
 * 只写构图意图，不写镜头参数——景别与机位是另一组字段。
 */
export const COMPOSITION_RULES = [
  "thirds",
  "centered",
  "leading",
  "frame",
  "diagonal",
  "negative",
] as const;

export const CompositionSchema = z.object({
  rule: z.enum(COMPOSITION_RULES).default("thirds"),
  note: z.string().max(60).default(""),
});
export type Composition = z.infer<typeof CompositionSchema>;

/**
 * 裁切焦点（E5）：画面里要留住的那一点，按宽高的比例写。
 *
 * 只对 `fit: "crop"` 有意义；模糊填充不裁画面，焦点用不上。
 * 不是「主体追踪」——追踪要认出人脸与人体，这里由作者点一下，
 * 但点过一次之后换画幅、重渲都跟着走。
 */
export const ShotFocusSchema = z.object({
  x: z.number().min(0).max(1).default(0.5),
  y: z.number().min(0).max(1).default(0.5),
});
export type ShotFocus = z.infer<typeof ShotFocusSchema>;

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
  /** 光影模板（I2）：可选；没写就沿用场景与风格给的光 */
  lighting: LightingSchema.optional(),
  /** 构图模板（I4）：可选；没写就让模型自己构图 */
  composition: CompositionSchema.optional(),
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
  /**
   * 换画幅时留住画面的哪一块（E5 / ADR-0170）：0 是左 / 上，0.5 是居中，1 是右 / 下。
   *
   * 竖屏裁成横屏时只留下画面里的一条横带：人站在画面上三分之一，
   * 居中裁就把头裁掉了。裁哪条由 `focus.y` 决定，`focus.x` 管另一半情况
   * （横屏素材裁成竖屏）。不写按居中——与没有这个字段时的行为一致。
   */
  focus: ShotFocusSchema.optional(),
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

/**
 * 转场（E4 / ADR-0169）。
 *
 * 只做**不改变时长**的过渡：上一段末尾淡到黑（或白），下一段开头从黑（或白）淡入。
 * 叠化（两段画面同时存在）需要两段重叠，会让成片比时间线短，
 * 后面的字幕与配音跟着整体错位——时长是音轨定的（准则 P5），不为一个转场让步。
 */
export const TRANSITION_KINDS = ["black", "white"] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

/**
 * 一段怎么接进上一段。挂在**后一段**上（`transitionIn`）：删掉前一段时，
 * 后面那段的接法跟着它一起走，不用去改别人的字段。
 *
 * 时长 100–600ms：再长就变成两个画面都停着不动，短剧的节奏经不起。
 */
export const TransitionSchema = z.object({
  kind: z.enum(TRANSITION_KINDS),
  durationMs: z.number().int().min(100).max(600).default(300),
});
export type Transition = z.infer<typeof TransitionSchema>;

export const TimelineItemSchema = z.object({
  id: Id,
  shotId: Id,
  takeId: Id,
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  /**
   * 这一段怎么接进上一段（E4）；不写就是硬切。
   * 第一段上的值没有意义（它前面没有东西），渲染时忽略。
   */
  transitionIn: TransitionSchema.optional(),
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
  /**
   * 按角色给字幕着色（D3）：缺省开，显式 `false` 才是全白。
   *
   * 多人对话时颜色比名字好认；颜色本身不存 IR——按 `project.characters`
   * 的顺序从固定色板取，角色顺序不变颜色就不变。
   */
  speakerColors: z.boolean().optional(),
  /**
   * 给某个角色指定颜色（D3 / ADR-0146）：角色 id → `#RRGGBB`。
   *
   * 缺省时按 `project.characters` 的顺序从固定色板取；只存作者改过的角色，
   * 删掉某个键就回到色板默认。界面只提供色板里的六个颜色，IR 只校验格式。
   */
  speakerColorOverrides: z
    .record(z.string().min(1), z.string().regex(/^#[0-9a-fA-F]{6}$/))
    .optional(),
});
export type SubtitleLayout = z.infer<typeof SubtitleLayoutSchema>;

/**
 * 双语字幕的开关（D5 / ADR-0173）。
 *
 * 只有三件事：开不开、第二行是哪一种语言、第二行放上面还是下面。
 * 译文本身在 `DialogueLine.translation` 上——译文属于那一句台词，
 * 换断句、挪位置都跟着它走，不该在版式里再存一份。
 */
export const SubtitleTranslationSchema = z.object({
  /** 关掉就是单语：导出、预览、烧进画面全都回到一行 */
  enabled: z.boolean().default(false),
  /**
   * 第二行的语言名，只用于界面与导出注释（`en` / `ja` / `ko`…）。
   * 不做语言校验：作者写「English」也照用，这里不是翻译服务的参数。
   */
  lang: z.string().max(20).default("en"),
  /** 第二行的位置：`below` 是第一行下面（默认），`above` 放上面 */
  position: z.enum(["below", "above"]).default("below"),
});
export type SubtitleTranslation = z.infer<typeof SubtitleTranslationSchema>;

export const TimelineSchema = z.object({
  items: z.array(TimelineItemSchema).default([]),
  music: z.array(MusicCueSchema).default([]),
});
export type Timeline = z.infer<typeof TimelineSchema>;

export const AILabelSchema = z.object({
  explicit: z.boolean(),
  implicit: z.boolean(),
  standard: z.string().optional(),
  /**
   * 这一份产物的内容指纹（H5 / ADR-0138）：8 位十六进制。
   *
   * 只有一句「AI生成」的话，把它抄到别的视频上也没人发现；指纹把标识与
   * 具体那一版剪辑绑在一起。它不是安全哈希，也不防篡改——只证明「这份标识
   * 属于这份产物」。可选：历史发布包没有它，读旧日志不能报错。
   */
  contentHash: z
    .string()
    .regex(/^[0-9a-f]{8}$/)
    .optional(),
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
  /**
   * 交付这一包的那次本机渲染花了多少毫秒（H4）。
   *
   * 本机 ffmpeg 不按文件收费，但渲染要占机器时间；记下来才能在账单里说清
   * 「这一版花了多少机器时间」，而不是笼统写「不花钱」。
   */
  renderMs: z.number().int().nonnegative().optional(),
  /**
   * 实际发布出去的时间（G10 / ADR-0166）。
   *
   * 与 `recordedAt` 分开：先导出成片、隔天才发是常态，
   * 记成同一件事会让台账看不出「这一版到底发了没有」。
   */
  publishedAt: z.string().max(40).optional(),
  /** 发布链接（G10）：平台回执里的地址；空表示还没发 */
  url: z.string().max(300).optional(),
  /** 平台回执 / 审核结果（G10）：作者自己贴回来的一行字 */
  receipt: z.string().max(200).optional(),
  /** 备注（G10）：这一版为什么重发、投了哪个号 */
  note: z.string().max(200).optional(),
  aiLabel: AILabelSchema.optional(),
});
export type PublishPackage = z.infer<typeof PublishPackageSchema>;

/**
 * 授权记录（H7 / ADR-0167）。
 *
 * 短剧里最常见的两类麻烦是「这张脸是谁的」与「这段声音是谁的」。
 * 这里只留档：谁给的、给了什么、什么时候到期、凭证在哪。
 * 不校验凭证本身——合同在作者手里，工具只保证发布前看得见缺哪一条。
 */
export const RIGHTS_KINDS = ["portrait", "voice", "asset", "music", "other"] as const;

export const RightsRecordSchema = z.object({
  id: Id,
  /** 授权对象的人话名字（「林晚的肖像」「周衡的配音」） */
  subject: z.string().min(1).max(60),
  kind: z.enum(RIGHTS_KINDS),
  /** 关联到项目里的角色 / 道具 / 地点；对不上就留空 */
  targetId: Id.optional(),
  /** 授权方：谁给的 */
  grantor: z.string().max(60).default(""),
  /** 授权日期；空表示没填 */
  grantedAt: z.string().max(20).default(""),
  /** 到期日；空表示不限期 */
  expiresAt: z.string().max(20).default(""),
  /** 凭证位置：合同编号、存放路径或一句说明 */
  evidence: z.string().max(200).default(""),
  note: z.string().max(200).default(""),
});
export type RightsRecord = z.infer<typeof RightsRecordSchema>;
/** 写授权记录时的形状：带 default 的字段可以省略，parse 后补齐 */
export type RightsRecordInput = z.input<typeof RightsRecordSchema>;

/**
 * 项目固定的模型（H22）。
 *
 * 值是本机配置里的模型 id（`ModelRecord.id`），IR 不校验它在不在当前配置里：
 * 同一个项目换一台机器、换一份配置打开时，讲的是「这个项目想用哪个模型」，
 * 能不能用由生成前的网关解析回答。
 */
export const ModelPinsSchema = z.object({
  text: z.string().min(1).optional(),
  image: z.string().min(1).optional(),
  video: z.string().min(1).optional(),
  tts: z.string().min(1).optional(),
  asr: z.string().min(1).optional(),
});
export type ModelPins = z.infer<typeof ModelPinsSchema>;

export const MODALITY_KEYS = ["text", "image", "video", "tts", "asr"] as const;

/**
 * 画面风格与摄影参数（B7 / I5，ADR-0165）。
 *
 * 只存「作者选的」这几项，不存编译出来的提示词：提示词是这些参数的函数，
 * 换一句写法不该变成一次项目改动。每一项留空表示用默认值。
 */
export const LookSchema = z.object({
  /** 风格预设 id（`packages/pipeline` 的 `LOOK_PRESETS`）；空串表示没选 */
  presetId: z.string().max(40).default(""),
  /** 光比：`soft` 柔 / `balanced` 标准 / `hard` 硬 */
  contrast: z.enum(["soft", "balanced", "hard"]).default("balanced"),
  /** 色温倾向：`warm` 暖 / `neutral` 中性 / `cool` 冷 */
  temperature: z.enum(["warm", "neutral", "cool"]).default("neutral"),
  /** 质感：`clean` 干净 / `grain` 胶片颗粒 / `dream` 柔焦 */
  texture: z.enum(["clean", "grain", "dream"]).default("grain"),
  /** 画幅描述进提示词；目前只支持竖屏 9:16 */
  aspect: z.literal("9:16").default("9:16"),
  /** 作者手写的补充风格句（最多 80 字）；空串表示没有 */
  note: z.string().max(80).default(""),
});
export type Look = z.infer<typeof LookSchema>;

/** 一项都没改的 look：`ProjectSchema` 的默认值就是它 */
export const DEFAULT_LOOK: Look = LookSchema.parse({});

export const GRADE_CONTRASTS = ["flat", "natural", "punchy"] as const;
export const GRADE_SATURATIONS = ["muted", "natural", "rich"] as const;
export const GRADE_TEMPERATURES = ["cool", "neutral", "warm"] as const;

/**
 * 调色（E4 / ADR-0169）：整条片子的色彩倾向，在渲染时作用在拼好的画面上。
 *
 * 与 `Project.look` 分工：`look` 决定**生成时**提示词里的质感（模型画成什么样），
 * `grade` 决定**导出时**对已拍好的画面做多少色彩调整。改 `look` 要重出图，
 * 改 `grade` 只重渲一遍——两者都不是同一种成本，不该合成一个旋钮。
 *
 * 只收三档对比 / 饱和 / 色温加一个暗角：短剧的调色是「统一」，不是「创作」。
 * 真正的 LUT（.cube 文件）属于 I3，这里不做（见 ADR-0169 的「不做」）。
 */
export const GradeSchema = z.object({
  /** 调色预设 id（`apps/web/lib/render-effects.ts` 的 `GRADE_PRESETS`）；空串表示没选 */
  presetId: z.string().max(40).default(""),
  /** 对比：`flat` 压平 / `natural` 原样 / `punchy` 加对比 */
  contrast: z.enum(GRADE_CONTRASTS).default("natural"),
  /** 饱和：`muted` 退色 / `natural` 原样 / `rich` 加饱和 */
  saturation: z.enum(GRADE_SATURATIONS).default("natural"),
  /** 色温：`cool` 偏蓝 / `neutral` 原样 / `warm` 偏橙 */
  temperature: z.enum(GRADE_TEMPERATURES).default("neutral"),
  /** 暗角：压住画面四角，把视线收到中间 */
  vignette: z.boolean().default(false),
});
export type Grade = z.infer<typeof GradeSchema>;

/** 一项都没改的 grade：渲染时不加任何滤镜，成片与以前逐字节同构 */
export const DEFAULT_GRADE: Grade = GradeSchema.parse({});

/* ------------------------------------------------------------------ */
/* 画幅（E5 / ADR-0170）                                                */
/* ------------------------------------------------------------------ */

/**
 * 输出画幅。竖屏是短剧的主场，横屏与方形是为了分发到别的平台。
 *
 * 与 `Look.aspect` 分工：`look.aspect` 写进**生成提示词**（让模型按竖构图作画），
 * `Project.frame` 决定**导出时**裁成什么形状。两者可以不同——
 * 用竖屏生成、再裁成 16:9 发横屏平台，是短剧分发的常态。
 */
export const FRAME_ASPECTS = ["9:16", "16:9", "1:1"] as const;
export type FrameAspect = (typeof FRAME_ASPECTS)[number];

/**
 * 画幅与适配方式（E5）。
 *
 * - `pad`：留边。整幅画面缩到放得下，空出来的地方填底色。这是默认——
 *   以前导出的成片就是这么做的，改默认会让旧项目重渲一遍就不一样了；
 * - `crop`：裁切。铺满画幅，多出来的部分切掉，留住哪一块由 `Shot.focus` 决定；
 * - `blur`：模糊填充。整幅画面缩小放进去，空出来的地方用同一帧的模糊放大填充。
 *   竖屏素材转横屏时，裁切会切掉一半以上的高度，模糊填充能保住构图。
 */
export const FRAME_FITS = ["pad", "crop", "blur"] as const;
export type FrameFit = (typeof FRAME_FITS)[number];

export const FrameSchema = z.object({
  aspect: z.enum(FRAME_ASPECTS).default("9:16"),
  fit: z.enum(FRAME_FITS).default("pad"),
});
export type Frame = z.infer<typeof FrameSchema>;

export const DEFAULT_FRAME: Frame = FrameSchema.parse({});

/**
 * 一张头 / 尾卡（E9 / ADR-0174）。
 *
 * 头尾卡不是时间线里的镜头：它们没有镜头、没有 take，只有一段时长和几行字。
 * 存进 IR 是因为卡片内容本身是创作决定——换设备、重放事件日志之后
 * 还得是同一张卡、同一个时长。
 */
export const BrandCardSchema = z.object({
  /** 这张卡出不出现在成片里；关掉时字都留着，随时能再开 */
  enabled: z.boolean().default(false),
  /** 主标题（头卡一般是片名，尾卡一般是「下一集」之类） */
  title: z.string().max(60).default(""),
  /** 副标题：头卡放集数 / 类型，尾卡放时间 / 关注提示 */
  subtitle: z.string().max(60).default(""),
  /** 这张卡多长，毫秒；0.5–10 秒 */
  durationMs: z.number().int().min(500).max(10000).default(2000),
});
export type BrandCard = z.infer<typeof BrandCardSchema>;

/**
 * 品牌包（E9 / ADR-0174）：落款名、账号说明、卡片的底子颜色，以及头尾两张卡。
 *
 * 只做「静态卡」这一层：不做动态 logo、不做贴片广告、不接模板市场。
 */
export const BrandSchema = z.object({
  /** 落款名（片名 / 工作室）；空着就不落款 */
  name: z.string().max(40).default(""),
  /** 账号或期数说明，如 `@织光机` `第 03 集`；空着不写 */
  handle: z.string().max(60).default(""),
  /**
   * 卡片底色，六位十六进制。字色按明暗自动取——深底配浅字，
   * 不让作者手动挑第二个颜色（挑错了就是看不见的字）。
   */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#121215"),
  /** 片头卡：开篇的字幕板 */
  intro: BrandCardSchema.default({}),
  /** 片尾卡：收尾的下一集 / 关注提示 */
  outro: BrandCardSchema.default({}),
});
export type Brand = z.infer<typeof BrandSchema>;

export const DEFAULT_BRAND: Brand = BrandSchema.parse({});

export const ProjectSchema = z.object({
  id: Id,
  title: z.string().min(1),
  version: z.number().int().nonnegative(),
  /**
   * 这个项目固定下来的模型（H22）：留空表示没固定，跟着本机当前选择走。
   *
   * 写进 IR 而不是 localStorage：模型是项目约束的一部分，
   * 换浏览器、刷新、重放事件日志之后还得是同一个模型。
   */
  models: ModelPinsSchema.default({}),
  /**
   * 画面风格与摄影参数（B7 / I5，ADR-0165）：所有出图提示词的最后一句由它编译。
   */
  look: LookSchema.default({}),
  /**
   * 调色（E4 / ADR-0169）：导出时对画面做的色彩调整，只影响渲染，不影响提示词。
   */
  grade: GradeSchema.default({}),
  /**
   * 输出画幅（E5 / ADR-0170）：导出时裁成什么形状、裁切不够时怎么补。
   */
  frame: FrameSchema.default({}),
  /**
   * 品牌包与头尾卡（E9 / ADR-0174）：落款、账号说明、卡片底色、两张卡。
   * 卡片时长进 IR，成片、预览、SRT 与 OTIO 的时间都按它整体后移。
   */
  brand: BrandSchema.default({}),
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
  /** 双语字幕（D5 / ADR-0173）：开不开、第二行语言与位置；译文在每句台词上 */
  subtitleTranslation: SubtitleTranslationSchema.default({}),
  publishPackages: z.array(PublishPackageSchema).default([]),
  /**
   * 授权记录（H7 / ADR-0167）：肖像、声音、素材、音乐各一条。
   * 只留档，不拦生成；发布前由合规预检提示缺哪一条。
   */
  authorizations: z.array(RightsRecordSchema).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;
/** 写项目时的形状：带 default 的字段可以省略，parse 后补齐。 */
export type ProjectInput = z.input<typeof ProjectSchema>;
