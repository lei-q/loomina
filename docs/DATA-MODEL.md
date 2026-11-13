# 数据模型：Project IR

> **Project IR 是唯一事实来源**（准则 P2）。画面、音频、字幕、发布包都是它的派生物。
> 下面是 TypeScript 形态的**概念模型**，不是最终代码；改动数据结构前先看本文与 ADR-0001。

## 1. 顶层结构

```ts
type ID = string;          // UUID / nanoid
type ISODate = string;     // "2026-11-09T10:00:00Z"

interface Project {
  id: ID;
  title: string;
  logline: string;
  version: number;          // 每应用一条事件 +1（含回滚），只增不减；ADR-0113
  budgetCny: number;        // 预算上限（元），默认 60；ADR-0035
  maxAttemptsPerShot: number;          // 同一镜最多自动试几次（含第一次），1–5，默认 3；ADR-0101
  onBudgetExceed: "block" | "keep";    // 超预算处置：阻断 / 保留现有结果，默认 block；ADR-0101
  createdAt: ISODate;
  updatedAt: ISODate;

  bible: StoryBible;        // 故事圣经：全剧共享
  episodes: Episode[];      // 分集
  assets: Asset[];          // 全项目资产（图/视频/音频/字体）
  approvals: Approval[];    // 阶段闸门：定妆 / 道具确认（ADR-0028）
  gates: GateRecord[];      // 阶段确认记录：七阶段各一条，带内容指纹（ADR-0100）
  subtitleOverrides: SubtitleOverride[];  // 手改断句（D2 / ADR-0117），默认 []
  subtitleLayout: SubtitleLayout;         // 字幕版式（D3 / ADR-0130），默认 { preset: "default" }
  look: Look;                             // 画面风格与摄影参数（B7 / I5 / ADR-0165）
  grade: Grade;                           // 调色：导出时对画面的色彩调整（E4 / ADR-0169）
  publishPackages: PublishPackage[];      // 发布台账：发布包 + 回执（G10 / ADR-0166）
  authorizations: RightsRecord[];         // 授权留档：肖像 / 声音 / 素材 / 音乐（H7 / ADR-0167）

  settings: ProjectSettings;
}

interface ProjectSettings {
  aspectRatio: "9:16" | "16:9" | "1:1";
  resolution: "720p" | "1080p" | "4k";
  language: "zh-CN" | "en-US";
  defaultStyleId?: ID;      // 指向 StyleProfile
}
```

> **落地情况（ADR-0100，2026-11-11）**：`Project.gates: GateRecord[]` 是七个阶段的确认记录，同一阶段最多一条（确认即覆盖）。每条记下确认时这一阶段内容的 8 位 FNV-1a 指纹；读模型把现算指纹与记录比对，得出 `none / confirmed / stale` 三态。确认与回退只走 `gate.confirmed` / `gate.reopened` 两条事件，追加不删历史；回退只删这一阶段的记录，不级联下游。旧项目没有该字段，zod 默认 `[]`，`LOG_VERSION` 仍为 1。

## 2. 故事圣经（一致性锚点）

```ts
interface StoryBible {
  synopsis: string;
  themes: string[];
  characters: Character[];
  locations: Location[];
  props: Prop[];
  relationships: Relationship[];
  timeline: TimelineEvent[];
  rules: string[];          // 世界观规则（"这个世界没有电"）
  styles: StyleProfile[];   // 摄影/色彩/质感预设
}

interface Character {
  id: ID;
  name: string;
  role: "protagonist" | "antagonist" | "supporting" | "extra";
  appearance: Appearance;   // 外貌硬约束
  wardrobe: WardrobeItem[]; // 分场服装
  voice: VoiceProfile;      // → TTS 音色
  personality: string;
  arc: string;
  sheet: CharacterSheet;    // 定妆三视图 → Asset（ADR-0028）
  referenceImages: ID[];    // → Asset（表情表、服装变体，无角度语义）
  mustNotChange: string[];  // 监工重点：痣、疤、发型、配饰
}

/**
 * 三视图四格。槽位有角度语义，不用数组：
 * 插一张表情图不会让"侧面"变成"正面"。
 */
interface CharacterSheet {
  front?: ID;
  threeQuarter?: ID;
  side?: ID;
  back?: ID;
}

// 是否"必须"四格齐全由镜头决定：有近景 / 特写的角色才强制。
// 判定与定妆闸门的规则见 §5.1。

interface Appearance {
  ageRange: string;
  gender: string;
  height: string;
  build: string;
  hair: string;
  eyes: string;
  skin: string;
  distinctive: string[];
}

interface Location {
  id: ID;
  name: string;
  templateId?: string;      // 走廊 / 门口 / 桌边 / 门厅：决定主镜剪影（ADR-0059）
  description: string;      // 这地方长什么样，整句进主镜提示词，≤200 字（ADR-0063）
  masterShotId?: ID;        // 主镜：本场所有镜头共用的空间与光线基准
  referenceImages: ID[];    // 其他机位 / 细节图
  lightingDefaults: LightingSpec;
}

> **落地情况（ADR-0063，2026-11-10）**：`Location.description`（默认 `""`）已进 IR，旧日志靠默认值补齐；改描述写 `location.updated { locationId, patch: { description } }`，`location.added` 也带这一格。上限 200 字。`Location.templateId` 由 ADR-0059 落地。`lightingDefaults` 仍只在文档里。

interface Prop {
  id: ID;
  name: string;
  description: string;
  referenceImages: ID[];
  ownerCharacterId?: ID;
}

type RelationshipKind =
  | "lover" | "family" | "rival" | "friend" | "enemy" | "mentor" | "other";

interface Relationship {
  id: ID;
  fromCharacterId: ID;
  toCharacterId: ID;
  kind: RelationshipKind;
  description: string;
  tension: string;          // 戏剧张力描述，供生成参考
}
```

> **落地情况（ADR-0088，2026-11-11）**：故事入口先落了 Story Bible 里能被下游引用的那一刀，实际进 IR 的形状是 `Project.story`：
>
> ```ts
> interface StoryBible {
>   logline: string;        // 默认 ""
>   synopsis: string;
>   genre: string;
>   audience: string;
>   tone: string;
>   hooks: { opening: string; ending: string };
>   arcs: {                 // 按 characterId 引用，一人最多一条
>     characterId: ID;
>     want: string; need: string; wound: string;
>     flaw: string; secret: string; agency: string; arc: string;
>   }[];
>   relationships: { fromCharacterId: ID; toCharacterId: ID; tension: string }[];
>   provenance?: Provenance; // 文本模型与原始想法
> }
> ```
>
> 上面的 `themes` / `rules` / `styles`、`Character.role` / `wardrobe` / `voice`、独立 `Relationship.kind` 仍只在文档里；`arcs` 与 `relationships` 是这一刀新增的、可被故事入口写入的字段。Beat 与 ScriptDoctorReport 没有进 IR（A11 / A2 未做）。旧日志缺 `story` 时由 zod 默认值补齐；`LOG_VERSION` 升到 2，v1 → v2 迁移目前是恒等变换。
>
> **逐字原文槽位（F6 / ADR-0154，2026-11-13）**：`StoryBible.sourceDocument?` 是可选择的只读参考文档，形状为 `{ title, chapterIndex, chapterCount, text, fileName?, sourceChars, importedAt, fingerprint }`。`text` 只存作者选中的一章（≤2 万字），CRLF 已归一为 `\n`；`fingerprint` 是 8 位 FNV-1a，只用来发现误改，不防篡改。它不进 `story.updated` 白名单，模型生成路径也不读；换章节要写新的 `project.created`。旧项目没有这个字段，zod 按 `undefined` 补齐，不升 `LOG_VERSION`。逐字项目开出来是一个地点 / 一场 / 一空镜 / 零台词，原文在 `/script` 的「逐字原文」面板里长期对照。

> **故事层单独编辑（A16 / ADR-0121）**：`story.updated` 只收白名单字段——`logline` / `synopsis` / `genre` / `audience` / `tone`、`openingHook` / `endingHook`、整组 `arcs`、整组 `relationships`。**不整块替换 `story`**：`provenance` 记的是这份故事从哪来，作者改字不该把它抹掉。文字字段写入前 `trim()`，空串表示清空；`patch` 一个字段都没有时拒绝。校验在 `applyEvent` 里：弧光的 `characterId` 必须存在且不重复；关系两端必须是不同且存在的角色，同一对（有向）不能写两遍。`arcs` / `relationships` 整组替换是事件层形状，store 另给 `editArc(characterId, patch)` 与 `editRelationship(from, to, tension)` 两个语义化入口（张力写空即删）。

## 3. 分集 / 场 / 镜

```ts
interface Episode {
  id: ID;
  index: number;
  title: string;
  hook: string;             // 前 3 秒钩子
  climax: string;
  endHook: string;          // 结尾留钩
  scenes: Scene[];
}

interface Scene {
  id: ID;
  index: number;
  locationId: ID;
  code: string;             // 显式场号：`2A`、跳号；空串按顺序编号（ADR-0080）
  space: "int" | "ext";     // 内 / 外景（ADR-0050）
  timeOfDay: "day" | "night" | "dawn" | "dusk";  // 日夜（ADR-0050）
  mood: string;
  summary: string;
  lighting: LightingSpec;
  characterIds: ID[];       // 本场出场人物
  propIds: ID[];
  shots: Shot[];
}

interface Shot {
  id: ID;
  index: number;
  sceneId: ID;
  // ADR-0096：第一版挂在镜头上，独立 Beat 实体未建；未标时由读模型推断
  beat?: "hook" | "setup" | "escalation" | "turn" | "climax" | "resolution" | "endHook";
  purpose?: "establish" | "information" | "emotion" | "reaction" | "transition" | "hook";

  // 叙事
  description: string;
  action: string;           // 走位 / 动作
  dialogue?: DialogueLine[];

  // 影像（结构化，可编译为提示词）
  camera: CameraSpec;
  lighting: LightingSpec;
  durationMs: number;       // 通常由对白音频决定（准则 P5）

  // 生成
  status: "draft" | "keyframe" | "generating" | "review" | "approved";
  keyframes?: Keyframes;
  takes: Take[];            // 多版本
  activeTakeId?: ID;
  segments?: GenerationSegment[];  // 超过模型时长上限时拆分
  referenceAssetIds?: ID[];        // 本镜使用的参考图（角色/场景/道具）

  // 一致性
  characterIds: ID[];
  propIds: ID[];
  continuity: ContinuityNote[];
  timingPolicy?: "dialogue-first" | "visual-first";  // 音画冲突时的裁决（L7）
  consistency?: ConsistencyReport;

  budgetCny?: number;       // 这一镜最多花多少（正数）；不写只受项目预算约束（ADR-0100）

  prompt?: PromptRecord;    // 最终提示词与编译来源
}

interface GenerationSegment {
  id: ID;
  index: number;
  startMs: number;
  endMs: number;
  firstFrameAssetId?: ID;   // 可来自上一段尾帧（谨慎使用，会漂移）
  lastFrameAssetId?: ID;
  takeIds: ID[];
  activeTakeId?: ID;
}

interface DialogueLine {
  id: ID;
  characterId: ID;
  text: string;
  emotion?: string;
  audioAssetId?: ID;        // 当前采用的 TTS 音轨（ADR-0085）
  performance?: VoicePerformance;  // 逐句表演参数（ADR-0124，见 §12）
  voiceOffsetMs?: number;   // 配音相对台词起点挪多少毫秒（E1 / ADR-0131），±30000
  subtitleOffsetMs?: number;// 字幕相对台词起点挪多少毫秒（E1 / ADR-0131），±30000
  durationMs?: number;
}

interface Keyframes {
  firstAssetId?: ID;
  lastAssetId?: ID;
}
```

> **落地情况（ADR-0096，2026-11-11）**：`Shot.beat?: BeatKind` 与 `Shot.purpose?: ShotPurpose` 已进 IR，都是可选字段；旧日志回放不受影响。生成提示词要求模型直接标，中文别名可解析，不认识的词留空。没有标注的镜头由 `apps/web/lib/storyboard.ts` 在读模型里推断，推断不写回 IR；作者在分镜页「检查」抽屉里改过才写 `shot.updated`。覆盖率（每拍同时有信息与情绪 / 反应镜头）与 V1 / V2 / V4 / V5 / V6 / V8 校验都是读模型结论，不落字段。

> **落地情况（ADR-0039，2026-11-10）**：`Shot.promptNotes: string[]`（zod 默认 `[]`）是一句话指令落下的补充要求，提示词里作为「补充：…」原样带上；改结构字段（景别 / 机位 / 运镜）走同一条 `shot.updated` 的 patch，不改版本号。

> **落地情况（ADR-0037 / ADR-0038，2026-11-10）**：`Shot.keyframes` 已进 IR（zod 默认 `{}`，老日志靠默认值补齐，`LOG_VERSION` 仍为 1）。分镜页可生成首尾两帧：首帧资产 id 固定 `a-keyframe-<shotId>`，写 `firstAssetId`；尾帧固定 `a-lastframe-<shotId>`，写 `lastAssetId`。每帧一条 `asset.updated` 加一条 `shot.updated`，patch 里的 `keyframes` 是完整对象（生成尾帧不抹掉首帧）；重生成按 id 覆盖。两帧都不参与 take。

> **落地情况（ADR-0100，2026-11-11）**：`Shot.budgetCny?: number` 是这一镜的金额上限，只接受正数，`shot.updated` 的 patch 可带它，`undefined` 表示清除。`shotSpendOf(project, shotId)` 现算已花：该镜所有 take 的 `costCny` + 首尾帧资产的 `costCny`；take 引用的视频资产不重复计入（成本已记在 take 上）。图像 / 视频生成前先过项目预算、再过单镜上限，超了一次请求都不发。文本生成不设单镜上限（token 单价未知）。

> **落地情况（ADR-0050，2026-11-10）**：`Scene.space`（`int` / `ext`，默认 `int`）与 `Scene.timeOfDay`（`day` / `night` / `dawn` / `dusk`，默认 `day`）已进 IR；老日志靠默认值补齐，`LOG_VERSION` 仍为 1。改场头写 `scene.updated { sceneId, patch }`，patch 只收这两个字段；地点与场号属于结构，不在这一刀里改。

> **落地情况（ADR-0080，2026-11-11）**：`Scene.code: string`（zod 默认 `""`）是**显式场号**，`2A`、跳号都行，1–4 位字母数字；空串表示按 `index` 顺序显示「第 N 场」。它只是**显示用的名字**：场次挪位后 `index` 重排，`code` 跟着这一场走（`2A` 挪到第二位还是 `2A`）；同一项目内不允许重复（空串除外）。改动写 `scene.updated { code }`，与内 / 外景同一条事件。

> **落地情况（ADR-0044 / 0045 / 0046 / 0047，2026-11-10）**：台词没有按上面的草图挂在 `Shot.dialogue` 上，而是**项目级一张表**：`Project.dialogue: DialogueLine[]` 存本体，`Shot.dialogueIds: ID[]` 存这一镜说哪几句、顺序就是数组顺序。剧本页先读表、再按 `dialogueIds` 取，回放时两处一起动。台词相关事件四种：`dialogue.updated`（只改文本与时长）、`dialogue.speaker.updated`（只换 `characterId`）、`dialogue.added`（整句进来并挂到镜头）、`dialogue.removed`（整句摘掉并清理所有引用）；加删句同时写一条 `shot.updated { durationMs }`，镜头时长跟着加减（准则 P5）。时长目前按 0.3 秒 / 字估（ADR-0044），接 TTS 后换成真实音频时长。

> **落地情况（ADR-0085，2026-11-11）**：`DialogueLine.audioAssetId?: ID` 已进 IR，指向 `kind: "audio"` 的 Asset；`dialogue.updated` 的 patch 可带它，回放时校验资产存在且是音频。音轨资产 id 固定为 `a-voice-<lineId>`（一句一个资产位，重配就换掉旧的，不累积成 take）。`Asset.durationMs` 记音轨真实时长：网关不猜，交给浏览器 `loadedmetadata` 量，量到之后由 `fitLineToAudio` 写一条 `dialogue.updated { durationMs }` + 一条 `shot.updated { durationMs }`（按差值挪镜头，P5）+ 一条 `asset.updated` 补记时长。`Character.voiceProfileId` 现在可改（`character.updated` 的 patch 增加这个字段，空串表示用回默认音色）。供应商 TTS 走 `POST /v1/audio/speech`，需要 `TTS_MODEL`；没配时不出声，界面如实说，可以「贴音轨」导入。

```ts
interface CameraSpec {
  shotSize:
    | "extreme-close" | "close" | "medium-close"
    | "medium" | "medium-full" | "full" | "wide" | "extreme-wide";
  angle: "eye" | "high" | "low" | "dutch" | "top" | "over-shoulder" | "pov";
  movement:
    | "static" | "push-in" | "pull-out" | "pan-left" | "pan-right"
    | "tilt-up" | "tilt-down" | "track" | "handheld" | "crane" | "orbit";
  focalLengthMm: number;    // 14 / 24 / 35 / 50 / 85 / 135
  aperture?: number;        // f/1.4 等，控制景深
  composition:
    | "center" | "rule-of-thirds" | "leading-lines"
    | "frame-in-frame" | "symmetry" | "negative-space";
  subjectPlacement?: string;
}

interface LightingSpec {
  keyRatio: number;         // 主辅光比，如 4 = 4:1
  colorTempK: number;       // 3200 / 5600 / 7000
  timeOfDay?: string;
  keyDirection?: string;    // 侧逆光 / 顶光 / 窗光
  practicals?: string[];    // 实用光源：台灯、霓虹、烛光
  mood: string;             // 冷峻 / 温暖 / 压抑 / 梦幻
  filmStock?: string;       // 胶片质感描述
}
```

## 4. 生成版本与溯源

```ts
interface Take {
  id: ID;
  shotId: ID;
  assetId: ID;              // 生成的视频
  createdAt: ISODate;
  model: ModelRef;
  seed?: number;
  prompt: PromptRecord;
  referenceAssetIds: ID[];
  qa?: QAResult;
  userApproved?: boolean;
}

interface ModelRef {
  provider: string;         // "seedance" / "kling" / "veo" ...
  model: string;
  version?: string;
}

interface PromptRecord {
  positive: string;
  negative?: string;
  compiledFrom: "camera" | "manual" | "hybrid";
  params?: Record<string, unknown>;
}

interface QAResult {
  score: number;            // 0–1
  issues: QAIssue[];        // 穿帮 / 不一致 / 画质
  checkedAt: ISODate;
}

interface QAIssue {
  kind: "character" | "wardrobe" | "prop" | "lighting" | "geometry" | "artifact";
  severity: "low" | "medium" | "high";
  description: string;
  frameMs?: number;
}

interface ContinuityNote {
  kind: "must" | "avoid";
  text: string;
}

/** 场景空间与连续性台账：谁在哪、朝哪、穿什么、拿什么、轴线在哪 */
interface SceneState {
  sceneId: ID;
  entries: ContinuityEntry[];
}

interface ContinuityEntry {
  atShotId: ID;
  positions: Record<ID, string>;   // characterId → "左/中/右/画外"
  facing: Record<ID, "left" | "right" | "toward" | "away">;
  wardrobe: Record<ID, string>;
  props: Record<ID, string>;       // propId → "在右手 / 桌上"
  screenDirection: string;         // 轴线方向，如 "A→B 从左到右"
  notes: string[];
}

/** 阶段闸门：确认即锁定，锁定的资产不得被流程悄悄覆盖（准则 P14） */
interface Approval {
  id: ID;
  targetType: "character" | "location" | "storyboard" | "animatic" | "shot" | "final";
  targetId: ID;
  status: "pending" | "approved" | "rejected";
  approvedAt?: ISODate;
  lockedAssetIds: ID[];
  note?: string;
}

/** 阶段确认记录：只记「确认时这一阶段是什么样」，不锁编辑（ADR-0100） */
interface GateRecord {
  stage: "story" | "script" | "cast" | "storyboard" | "keyframes" | "voice" | "edit";
  signature: string;   // 8 位 hex，FNV-1a；对不上表示确认后内容改过
  at: ISODate;
  note: string;        // ≤240 字，默认空
}

/** 语义编辑：用户说人话，系统映射为结构化参数补丁（L5 / F7） */
interface SemanticEdit {
  id: ID;
  targetType: "shot" | "scene" | "style";
  targetId: ID;
  instruction: string;         // "这个镜头再压抑一点，别太亮"
  patch: {
    camera?: Partial<CameraSpec>;
    lighting?: Partial<LightingSpec>;
    styleId?: ID;
  };
  status: "proposed" | "applied" | "rejected";
  appliedAt?: ISODate;
}

/** 预算护栏：没有它，重试就是无底洞（准则 P14 / H10） */
interface Budget {
  projectId: ID;
  limitCny: number;
  spentCny: number;
  perShotLimitCny?: number;
  maxAttemptsPerShot: number;
  onExceed: "block" | "downgrade" | "manual";
}
```

> **落地情况（ADR-0035 / ADR-0100 / ADR-0101，2026-11-10 / 11）**：项目级上限是 `Project.budgetCny`（默认 60）+ 一条 `project.updated` 事件；镜头级上限是 `Shot.budgetCny?`，走 `shot.updated`。"已花"都由现算函数得出（`spendOf(project)` / `shotSpendOf(project, shotId)`），不落字段。图像与视频在提交前先过项目预算、再过单镜上限（知道单价、且会超就一次请求都不发）。`Project.maxAttemptsPerShot`（1–5，默认 3）与 `onBudgetExceed`（`block` / `keep`，默认 `block`）同样走 `project.updated`，applyEvent 校验范围；视频自动重试读前者，超预算时后者决定是阻断还是保留现有结果（`keep` 同样不发请求）。**文本模态的单镜上限仍没做**（token 单价未知，R28）。

> **渲染清单（ADR-0101，2026-11-11）**：`/api/render` 的请求体是派生清单，不是 IR。`RenderManifest.quality: "draft" | "final"` 决定尺寸、帧率与编码参数：草稿 540×960 / 24fps / CRF 30 / ultrafast / 96k，定稿 1080×1920 / 30fps / CRF 20 / veryfast / 128k。服务端按档位校验尺寸与帧率，不自动换档；不带 `quality` 的旧清单按定稿处理。

> **地点参考图（ADR-0152，2026-11-12）**：`Location.referenceImages` 不再只是 schema 里的字段——`location.updated` 的 `patch` 接受 `referenceImages`（整份替换，校验重复 / 上限 8 / 资产存在），挂图时先写 `asset.updated`。镜头锚点在地点主镜之后追加地点参考图（标签 `「地点名」 · 参考图`），排在道具之后；地点锁定时只认锁定版本里的图。

### 4.4 审片决定的写回（ADR-0027）

审片台上只有两个动作会写数据：留用、淘汰。两者都是同一条事件：

```ts
type TakeUpdatedEvent = {
  type: "take.updated";
  at: ISODate;
  takeId: ID;
  // 只允许改生成结果的状态与元数据；id 与 shotId 不可改
  patch: Partial<Omit<Take, "id" | "shotId">> & { status?: TakeStatus };
};

type TakeStatus = "draft" | "approved" | "rejected";
```

- **选中看哪一格不是事件**，只是界面状态。
- 一个镜头有多条 take 时，审片台展示最新一条（按 `provenance.createdAt`）并只改这一条；旧版本原样留在日志与列表里。
- 锁定（`shot.locked`）的镜头在审片台只读；要改必须先解锁，解锁本身要留痕。
- `takeId` 不存在时事件应用失败并报错，不静默跳过。

生成结果回写资产也是同一个模式（ADR-0031）：一张图落成一条 `asset.updated`，按 `id` upsert；占位资产带 id 没有 `uri`，生成后只补 `uri / mime / provenance`，不换 id。

```ts
type AssetUpdatedEvent = {
  type: "asset.updated";
  at: ISODate;
  asset: Asset;   // 按 id upsert；已锁定的资产不得被覆盖（准则 P14）
};
```

项目级设置同样走事件（ADR-0035）。预算改了要留痕，否则"什么时候从 60 改成 19 的"说不清：

```ts
type ProjectUpdatedEvent = {
  type: "project.updated";
  at: ISODate;
  budgetCny: number;   // 只接受正数；非正数在 applyEvent 里直接抛错
};
```

> **画面风格（ADR-0165，2026-11-13）**：`Project.look` 是 `{ presetId, contrast, temperature, texture, aspect, note }`，全部带默认值（`""` / `balanced` / `neutral` / `grain` / `9:16` / `""`），缺省即「实拍电影质感、自然光、轻微胶片颗粒」。`project.updated` 新增可选 `look?: Look`：**整块替换**，`applyEvent` 用 `LookSchema` 校验后才落库（越界与超长在进日志前被挡掉）。IR 里不存编译出来的提示词——提示词是这组参数的纯函数（`compileLook`），换一句写法不该变成一次项目改动。定妆 / 主镜 / 道具三条出图请求各自带一份 `look`，服务端 `parseLook` 不合法就当没带（风格错不拦整张图）。

> **光影与构图（I2 / I4，ADR-0168，2026-11-13）**：`Shot` 新增两个可选字段。`lighting: { source: window | lamp | overhead | practical | moon, position: front | side | back | top | under, mood: flat | modeled | silhouette, note ≤60 }` 与 `composition: { rule: thirds | centered | leading | frame | diagonal | negative, note ≤60 }`，都有默认值，缺省即「没写」。三项（含 I1 的景别 / 机位）都走已有的 `shot.updated`，`applyEvent` 对这两项用 schema 校验后才落库。清空写属性值为 `undefined`——JSON 序列化时消失，回放就是「没写」。与 `Project.look` 分工：风格管整条片子的光比与色温，`lighting` 管这一镜的光源是谁。编译（`compileLighting` / `compileComposition`）是纯函数，结果不进 IR；两项都没写时提示词与旧口径逐字一致。

> **发布台账与回执（G10 / ADR-0166，2026-11-13）**：`PublishPackage` 新增四个可选字段 `publishedAt` / `url` / `receipt` / `note`（依次 ≤40 / 300 / 200 / 200 字）。`publish.recorded` 仍然是「导出这一刻的事实」（平台、档位、文件、AI 指纹），只追加；发布之后才有的事走新事件 `publish.updated { packageId, patch }`，`patch` 只允许这四个键，其余键在 `applyEvent` 里抛错，合并后整包再过一遍 `PublishPackageSchema`。`publishedAt` 与 `recordedAt` 分开：先导出、隔天再发是常态，合成一个时间就看不出「这一版到底发了没有」。

> **授权记录（H7 / ADR-0167，2026-11-13）**：`Project.authorizations: RightsRecord[]`，默认 `[]`。一条记录是 `{ id, subject, kind: portrait | voice | asset | music | other, targetId?, grantor, grantedAt, expiresAt, evidence, note }`，字段都有长度上限、后五项默认空串。事件 `rights.updated { record }` 按 id 幂等 upsert，`rights.removed { rightsId }` 删一条（不存在就抛错）。缺哪一条、哪一条过期**不写 IR**：`lib/rights.ts` 的 `rightsReport` 每次从当前项目现算，合规预检（G8）把它的结果并进「素材授权」一项。`expiresAt` 为空表示不限期，非空时只比日期部分。

> **项目固定模型（ADR-0150，2026-11-12）**：`Project.models` 是 `{ text?, image?, video?, tts?, asr? }`，值为本机配置的模型 id，缺省 `{}`。`project.updated` 新增可选 `models?: Partial<Record<Modality, string | null>>`：非空字符串固定、`null` 取消、不传的模态不动；空串与不认识的模态在 `applyEvent` 里抛错。取值优先级是「项目固定 > 本机选择 > 服务端默认」，生成、报价与故事入口共用 `modelIdFor(modality, project.models)`。

阶段确认同样走事件（ADR-0100）。确认与回退各一条，只追加、不删历史：

```ts
type GateConfirmedEvent = {
  type: "gate.confirmed";
  at: ISODate;
  stage: GateStage;            // story / script / cast / storyboard / keyframes / voice / edit
  signature: string;           // /^[0-9a-f]{8}$/，确认时这一阶段内容的指纹
  note?: string;               // ≤240 字，落库前裁掉首尾空白
};

type GateReopenedEvent = {
  type: "gate.reopened";
  at: ISODate;
  stage: GateStage;            // 只删这一阶段的确认记录，不碰下游
};
```

`gate.confirmed` 按 stage upsert（同一阶段只留最新一条）；`gate.reopened` 对没有记录的 stage 是空操作，不写日志。

## 4.5 分镜规划与一致性

### Beat 与覆盖率

```ts
interface Beat {
  id: ID;
  sceneId: ID;
  type: "hook" | "setup" | "inciting" | "escalation"
      | "turn" | "climax" | "resolution" | "endHook";
  summary: string;
  information: string;      // 观众必须知道什么
  emotion: string;          // 观众应该感到什么
  powerShift?: string;
  startMs: number;
  endMs: number;
}

interface CoveragePlan {
  id: ID;
  beatId: ID;
  pattern: string;          // "dialogue_2person" / "confrontation" ...
  shots: PlannedShot[];
  estimatedCostCny?: number;
}

interface PlannedShot {
  purpose: Shot["purpose"];
  shotSize: CameraSpec["shotSize"];
  subjectIds: ID[];
  estimatedDurationMs: number;
}
```

### 3D 走位与机位

```ts
interface Blocking {
  id: ID;
  sceneId: ID;
  beatId?: ID;
  actors: {
    characterId: ID;
    position: [number, number, number];
    facingRad: number;
    path?: [number, number, number][];
  }[];
  props: { propId: ID; position: [number, number, number] }[];
  axis: { from: [number, number, number]; to: [number, number, number] };
}

interface CameraPlacement {
  id: ID;
  shotId: ID;
  position: [number, number, number];
  target: [number, number, number];
  focalLengthMm: number;    // 与 CameraSpec 合并后编译为提示词
  frustum?: number[];       // 可视锥，用于 3D 板显示
}
```

### 校验与一致性

```ts
interface ValidationReport {
  id: ID;
  targetId: ID;             // 分镜方案 / 场 / 集
  violations: {
    rule: string;           // V1–V10
    severity: "error" | "warning";
    shotIds: ID[];
    message: string;
    suggestion?: string;
  }[];
  estimatedCostCny?: number;
  estimatedDurationMs?: number;
}

interface ConsistencyReport {
  shotId: ID;
  identity: { score: number; perCharacter: { characterId: ID; score: number }[] };
  wardrobe: { score: number; issues: string[] };
  scene: { score: number; issues: string[] };
  lighting: { score: number; issues: string[] };
  spatial: { score: number; issues: string[] };
  style: { score: number };
  overall: number;
  threshold: number;        // 按景别分级
  verdict: "pass" | "review" | "fail";
  checkedAt: ISODate;
}
```

---

## 5. 资产与音频 / 字幕 / 时间线

```ts
interface Asset {
  id: ID;
  kind: "image" | "video" | "audio" | "font" | "lut";
  uri: string;              // 资产地址：`loomina://assets/<sha256>.<ext>`（本机资产库）或 `data:` / `https://`（存量）
  mime: string;
  width?: number;
  height?: number;
  durationMs?: number;
  hash?: string;            // 去重与缓存
  source: AssetSource;      // 上传 / 生成 / 素材库
  provenance?: Take;
  costCny?: number;         // 生成这张实际花了多少；没价目就不写（ADR-0033）
  review?: AssetReview;     // 生成结果的人工复核（H6 / ADR-0132）；缺省 = 还没看
  createdAt: ISODate;
}

type AssetSource = "upload" | "generated" | "library" | "imported";

/** 生成结果的人工复核（H6 / ADR-0132）：像素与视频没有模型审核，作者终审 */
interface AssetReview {
  status: "passed" | "rejected";
  at: ISODate;
  note?: string;            // 标「不可用」时的原因
}

/**
 * 资产地址的三种形态（H3 / ADR-0128）：
 * - `loomina://assets/<sha256>.<ext>`：本机资产库，内容寻址，浏览器经 `GET /api/asset/<hash>.<ext>` 读；
 * - `data:`：存量项目与迁移前的素材，继续可用；
 * - `https://`：供应商直接回的地址（生成的图 / 视频）。
 * IR 只存字符串，换实现（本地 → S3）不影响任何引用方。
 */

interface AudioClip {
  id: ID;
  kind: "dialogue" | "voiceover" | "music" | "sfx";
  assetId: ID;
  startMs: number;          // 时间线位置
  durationMs: number;
  gainDb?: number;
  ducking?: boolean;
  characterId?: ID;
  text?: string;            // 对白/旁白原文
}

interface SubtitleCue {
  id: ID;
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: ID;
  styleId?: ID;
  editedByUser?: boolean;   // 人工覆盖层标记（准则 P7）
}

interface Timeline {
  id: ID;
  episodeId: ID;
  videoTrack: TimelineItem[];
  audioTracks: AudioTrack[];
  subtitleTrack: SubtitleCue[];
  durationMs: number;
}

interface TimelineItem {
  id: ID;
  shotId: ID;
  takeId: ID;
  startMs: number;
  endMs: number;
  transitionIn?: string;
  transitionOut?: string;
}

interface AudioTrack {
  id: ID;
  kind: "dialogue" | "music" | "sfx" | "voiceover";
  clips: AudioClip[];
}
```

### 5.1 资产层与定妆闸门（ADR-0028）

`packages/ir` 先落了资产层的一个窄实现：`Asset` 目前只有 `image / video / audio` 三类，`uri` 可为空（示例素材没有真图，界面用占位剪影），溯源字段是 `Provenance` 而不是整个 `Take`。

**落地位置**：事件日志存在浏览器 IndexedDB（库 `loomina`，仓 `events`，`seq` 自增），按条追加、回放重建；`parseEvents` 是硬闸门，任何一条不像话就整份丢弃、回到示例项目（ADR-0034）。

**资产地址的落地口径（H3 / ADR-0128，2026-11-11）**：`uri` 仍是字符串，但有了三种形态与一个存储边界——

- `loomina://assets/<sha256>.<ext>`：本机资产库（`.loomina/assets/`，0700 / 0600，内容寻址、同一段字节只存一份、单文件上限 200 MB）。浏览器经 `GET /api/asset/<hash>.<ext>` 读（immutable 缓存）；渲染路由直接拿到本地路径，不再 base64 解码。
- `data:`：存量项目与迁移前的素材，继续可用。
- `https://`：供应商直接回的地址。

`AssetStore` 接口（`read` / `put` / `remove` / `list`）与 `LOOMINA_ASSET_STORE=local|s3` 是切换点；`S3AssetStore` 只做 SigV4 预签名 PUT / GET，**依赖方案待确认**，不引 `@aws-sdk/client-s3`。迁移是设置页的显式动作，旧事件里的 data URI 不动（日志只追加，后写的 `asset.updated` 覆盖前面的）；回收**只列不删**。

**已落地（H3.1，2026-11-12）**：`apps/web/lib/asset-uri.ts` 管地址（`audio/webm` 落 `.weba`，保证扩展名唯一反推 mime；`assetHref()` 给浏览器换成 `/api/asset/<hash>.<ext>`），`apps/web/lib/asset-store.ts` 管读写（临时文件 + `rename`，写失败不留半个文件）。生成路径的 data URI 超过 **128 KB** 自动进库；导出（预览 HTML / OTIO / 发布包）前 `hydrateView()` 读回字节，读不回来保留原地址并计数。

```ts
interface Asset {
  id: ID;
  kind: "image" | "video" | "audio";
  uri?: string;             // 对象存储地址；示例数据为空
  source: AssetSource;
  mime?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  provenance?: Provenance;  // 哪个模型、什么时候、什么参数
  costCny?: number;         // 价目表里的单价（元）；没价目就不写，别当 0（ADR-0033）
  createdAt: ISODate;
}

interface Approval {
  id: ID;
  targetType: "character" | "location" | "prop";
  targetId: ID;
  status: "pending" | "approved" | "rejected";
  approvedAt?: ISODate;
  lockedAssetIds: ID[];     // 确认那一刻锁住的资产；之后新增的不在锁内
  note?: string;
}
```

**闸门规则**（`packages/ir/src/cast.ts`）：

| 目标 | 何时算"必须齐" | 齐的定义 |
| --- | --- | --- |
| 角色 | 该角色出现在任何 `close` / `extreme-close` 镜头 | `sheet` 四格（正面 / 3-4 / 侧面 / 背面）都有资产 |
| 场景 | 总是 | `masterShotId` 指向存在的资产 |
| 道具 | 有任何镜头的 `propIds` 引用它 | `referenceImages` 非空 |

- 没有镜头引用的道具仍然显示在定妆台，但 `required: false`，不拖住「进分镜」：可以先备图，也可以一直不备。

- 缺格 / 缺主镜的目标状态是 `incomplete`，不能锁定：界面禁用按钮，`lockCast` 也直接返回（双保险）。
- 锁定写一条 `approval.updated`，按 `(targetType, targetId)` upsert，不产生并列的两条；解锁把同一条改回 `pending` 并清空 `lockedAssetIds`。
- "进分镜"只在 `lockedCount === totalRequired` 时出现；这是数据推出的事实，不是界面的开关。
- 三视图内部是否像同一个人（intra-sheet 一致性）还没有验收，当前只保证"四格都填了"。

**每镜参考图不落库。** 生成前由 `shotAnchors(project, shot)` 现算（ADR-0029 / ADR-0030）：人物按景别取格（单人选正面 + 3/4，多人每人正面），场景带主镜，道具各取第一张参考图，顺序为**人物 → 场景 → 道具**，总数不超过 4 张，超了先丢道具；有已通过的 `Approval` 时只用 `lockedAssetIds`。缺锚点时链路拒绝生成，`ShotRunResult.anchorAssetIds` 只用于核对，不写回 IR。

**新增不变量**

51. **资产库按内容寻址**（H3 / ADR-0128）：同一段字节只存一份，`uri` 里的 hash 与内容一致。
52. **资产回收只列不删**：未被任何引用方指向的资产标记为「未引用」，清理必须是显式动作。
53. **资产库地址的扩展名唯一反推 mime**（H3.1）：`/api/asset/<hash>.<ext>` 的 `Content-Type` 只能由扩展名给出，所以一种 mime 一个后缀（`audio/webm` 用 `weba`，`webm` 只属于视频）。
54. **导出物自包含**（H3.1 / P20）：预览 HTML、OTIO 与发布包在导出前把 `loomina://` 读回 `data:`；读不回来保留原地址并在提示里数出来，不假装完整。

### 5.2 时间线的落地（ADR-0086）

IR 里的时间线目前是窄实现：**只有画面轨**，音频与字幕不单独落数据，按片段起点从台词派生。

```ts
interface Timeline {
  items: TimelineItem[];   // 按 startMs 排；事件里允许乱序，读模型自己排
  music: MusicCue[];       // 配乐床（ADR-0099）；旧日志缺省为 []
}

// 叠加层偏移（E1 / ADR-0131）：挂在 DialogueLine 上，只有作者挪过的句子才有
// （不另建轨表——画面轨必须首尾相接，能自由挪的只有叠加层）
// voiceOffsetMs?: number;     整数毫秒，|x| ≤ 30000，缺省按 0
// subtitleOffsetMs?: number;  同上，两条互不影响

// 手改断句（D2 / ADR-0117）：只有作者改过的句子才在这里
interface SubtitleOverride {
  lineId: ID;
  cues: { text: string; durationMs: number }[];  // 1–20 条，text 非空
}

// 字幕版式（D3 / ADR-0130）：只存作者改过的项，缺省跟着 preset 模板
interface SubtitleLayout {
  preset: "default" | "large";
  fontSizeCqw?: number;    // 2–12，相对画面宽度
  bottomPct?: number;      // 2–45，离底边
  strokeCqw?: number;      // 0–3，描边粗细
}

interface TimelineItem {
  id: string;              // 初剪固定 tl-<shotId>
  shotId: string;
  takeId: string;          // 必须存在，且 take.shotId === shotId
  startMs: number;         // 非负整数
  durationMs: number;      // 正整数；初剪取 shot.durationMs
  transitionIn?: Transition;  // 接进上一段的转场（E4 / ADR-0169）；缺省是硬切
}

// 转场只做不改变时长的淡入淡出：上一段末尾淡到黑（或白），下一段开头淡回来
interface Transition {
  kind: "black" | "white";
  durationMs: number;      // 100–600，且不超过这一段的一半
}

// 调色（E4 / ADR-0169）：与 look 分工——look 管生成时的提示词，grade 管导出
interface Grade {
  presetId: string;        // 空串表示没选预设
  contrast: "flat" | "natural" | "punchy";
  saturation: "muted" | "natural" | "rich";
  temperature: "cool" | "neutral" | "warm";
  vignette: boolean;
}
```

**写入方式**：画面轨只有一种事件 `timeline.updated { items }`，整条替换；配乐只有一种事件 `timeline.music.updated { music }`，同样整条替换。两条事件分开，换 take 不该顺手重写音乐。applyEvent 当场校验与 `validateProject` 同口径：id 不重复、镜头存在、take 存在且属于该镜、起点 / 时长合法、片段不重叠、转场颜色与时长合法（单侧不超过这一段的一半）。`timeline.updated` 与 `shot.removed` 都保留现有 `music`。

> **转场与调色（E4 / ADR-0169，2026-11-13）**：`TimelineItem.transitionIn?: { kind: "black" | "white"; durationMs }` 挂在**后一段**上，缺省是硬切；第一段上的值没有意义，渲染时忽略。只做不改变时长的淡入淡出——`xfade` 会让两段重叠、成片比时间线短，字幕与配音整体错位（准则 P5）。`Project.grade` 是导出时对拼好画面的色彩调整（三档对比 / 饱和 / 色温 + 暗角），默认档不产生任何滤镜；与 `Project.look` 分工：`look` 进提示词（改它要重出图），`grade` 只进渲染（改它只重渲一遍）。两项都走既有事件：转场走 `timeline.updated` 整条替换，调色走 `project.updated { grade }` 整块替换。

`MusicCue`（ADR-0099）当前形状：

```ts
interface MusicCue {
  id: string;
  assetId: string;         // 必须是 kind === "audio" 的资产
  title: string;
  mood: string;            // 作者标的情绪，不参与自动选曲
  startMs: number;         // 非负整数
  durationMs: number;      // 正整数
  gainDb: number;          // -40–0，默认 -18
  duckDb: number;          // 12–18，默认 15
  ducking: boolean;        // 默认 true
  loop: boolean;           // 默认 true
  role: "bed" | "hit" | "transition";  // 缺省 "bed"（C10）
  motifId?: string;        // 指向 Project.motifs（C10）；清空时删字段，不写 undefined
  licenseRef: string;      // 必填；空串拒绝写入（不变量 28）
}
```

校验：资产存在且是音频、授权备注非空、起点在成片之内、增益与 ducking 深度在范围内；`motifId` 若存在，必须是 `project.motifs` 里的 id（C10）。

**落地细节（C10 第一档，2026-11-12）**

- **校验顺序**：`timeline.music.updated` 先跑 `checkMusic`（上面这些，人话报错），再逐条 `MusicCueSchema.safeParse` 填 `role` 默认值。反过来 zod 的英文报错会盖掉「起点不合法」，而旧日志缺 `role` 时必须走一次 `safeParse` 才补得上默认值。
- **`motifId` 的清空**：`undefined` 在 JSON 里会消失，所以 store 里清动机用 `delete` 删字段（`patch.motifId === ""` 时），不是赋 `undefined`。事件回放里 `motif.removed` 用解构去掉字段。
- **`Motif` 的生命周期**：`motif.updated { motif }` 按 id 幂等替换，`motif.removed { motifId }` 删并清掉引用它的 cue 的 `motifId`（cue 保留）。`character.removed` 删掉指向该角色的角色动机与以他为端点的关系动机；`story.updated` 删掉 `from->to` 已不存在的关系动机。
- **曲线不进 IR**：`analyzeMusicCurve(project)`（`apps/web/lib/music-curve.ts`）每次现算，与剧本医生同一口径。读模型 `EditMusic` 带出 `role` / `motifId`，界面不直接读 IR。
- **成片之外的拍**：曲线按分镜的 `BeatSpan` 算，`MusicBeatLine.inCut` 标记这一拍是否落在 `timeline.items` 覆盖的区间里。`timeline.music.updated` 拒「起点在成片之外」，所以「按曲线铺」只铺 `inCut` 的拍，其余在界面上说明「先初剪把这一镜排进来」。

**初剪规则**：场次顺序 → 场内镜序；每镜优先最后一条 `approved`，否则最后一条非 `rejected`；没有可用 take 的镜头跳过，store 把镜号写进 `editError`。时长读 `shot.durationMs`，起点累计。

**派生规则**（`toEditView`）：

- 画面：take 的 `kind === "video"` 资产 uri → take 的图片资产 uri → 镜头的首帧 / 尾帧 → 空。
- 字幕与音轨：同一镜的 `dialogueIds` 从片段起点依次累加 `durationMs`；`audioAssetId` 指向的音频 uri 就是这一句的音轨。
- 断句（ADR-0087）：每句台词按标点切小句、合并到每行不超过 `maxChars`（12 / 16 / 20，默认 16）个可见字，再按可见字数把 `durationMs` 分给各条 cue（每条至少 600ms，总和严格等于台词时长）。cue 是由读模型现算的，**不落 IR**：改字数档位只重算显示，不写事件。
- 手改断句（D2 / ADR-0117）：作者改过的那一句以 `subtitleOverrides` 为准，没改过的仍走自动断句。覆盖按**整句**存，不按单条 cue 存——单条 cue 的 id 是「第几段」，改了每行字数就会错位。覆盖里的 `durationMs` 是相对权重，读模型按比例缩放到整句时长，舍入误差落在最后一条，所以时间总和永远等于 `line.durationMs`。改字数档位不影响已覆盖的句子。
- 版式（D3 / ADR-0130）：`Project.subtitleLayout` 只存作者**改过**的项——`preset`（default / large）、`fontSizeCqw`、`bottomPct`、`strokeCqw`。没写的项跟着 `preset` 那档模板走，所以换模板时调过的字号留着、没调过的位置跟着换。读模型把两者合成 `EditView.subtitleStyle`，预览 HTML、ASS 与成片叠加层都用这同一份；`subtitleCustom` 只用来在界面上显示「已调」与「恢复模板」。越界（字号 2–12、离底边 2–45、描边 0–3）在 `applyEvent` 里拒绝而不夹取：夹取会把「填错了」悄悄改成另一个数。清空某一项写 `null`，不写 `undefined`（后者过 JSON 会消失）。
- 按角色着色（D3 / ADR-0140）：`Project.subtitleLayout.speakerColors` 只存**开关**（缺省开、`false` 全白、`null` 清掉覆盖）；颜色本身不进 IR，读模型按 `project.characters` 的顺序从六色板取（前六个角色一定不撞色，之后轮回），没有说话人的句子用白色。`EditCue.speakerColor` 由读模型派生，编辑页、预览 HTML、ASS 行内覆盖与成片叠加层共用这一份。
- 叠加层偏移（E1 / ADR-0131）：`DialogueLine.voiceOffsetMs` / `subtitleOffsetMs` 是**作者把这一句的配音 / 字幕相对「本该开始」的位置挪了多少毫秒**，可正可负，缺省 0。画面轨必须首尾相接（渲染清单要求片段时长之和严格等于成片全长），所以能自由挪的只有叠加层，而且**按句**挪而不是按轨挪——一条独立的「音频轨」需要另一套与画面解耦的时间轴，当前没有转场与叠画，做了也是空转。写入走既有 `dialogue.updated` 的 patch：`undefined` 不改、数字覆盖、`null` 归零；非整数或超过 ±30 秒在 `applyEvent` 里拒绝。读模型算出 `audioStartMs` / `cueStartMs`，并把起点夹进 `[0, totalMs - durationMs]`：IR 里留着作者填的原值，只在读模型夹，因为「填了 30 秒」是作者的事实，夹取发生在渲染边界。断句后的每一条 cue 的绝对起点都从 `cueStartMs` 起算。
- 总数：全长 = 最晚片段终点；`missing` = 没进时间线的镜头数。

> **落地情况（ADR-0102，2026-11-11）**：实际进 IR 的 `PublishPackage` 是精简的发布记录，只回答「什么时候、往哪个平台、发了哪一版成片」：

```ts
interface PublishPackage {
  id: ID;
  platform: string;                 // 平台 id，如 douyin / youtube-shorts
  videoAssetId?: ID;                // 只有存成资产时才写；当前渲染结果直接下载，留空
  quality?: "draft" | "final";      // 这一包对应的成片档位（H13）
  fileName?: string;                // 成片文件名与字节数，便于找回交付物
  bytes?: number;                   // 非负整数
  recordedAt?: string;              // 写入 IR 的时间
  aiLabel?: AILabel;                // 必须 explicit + implicit，否则 applyEvent 拒绝
}
```

写入只走 `publish.recorded { package }`：id 唯一、平台非空、AI 标识完整、字节数为非负整数；通过后追加，不覆盖旧记录。发布包下载 JSON 的完整内容（标题、简介、话题、字幕、`platformChecks`、`warnings`、`compliance`、`video`、`coverArt`）仍只在本机文件里，不进事件日志。

**封面（G6 / ADR-0139）**：封面 PNG 是导出物，不进 IR；发布包 JSON 的 `coverArt` 只记文件名、字节数、第几镜、第几毫秒、尺寸、平台与生成时间，用来核对「发出去的是哪一张」。

**导出**：预览 HTML、OTIO、SRT、发布包 JSON 都是本地生成的文件；只有发布包 JSON 会额外写一条 `publish.recorded`（ADR-0102）。视频渲染已由 E6 / H13 实现，发布包视频位在导出过成片后带文件名、字节数与档位。

**导出前合规证据（ADR-0095）**：成片页先跑 `preflightProject`，得到四项检查、命中项与内容指纹；MP4 渲染清单与发布包 JSON 都带 `compliance: { ok, checkedAt, signature, reviewAcknowledged, findings }`。这是导出物的字段，不写回 IR：规则与确认状态不属于作品数据。

**识别（ADR-0087）不新增 IR 字段。** ASR 结果只放在 store 的内存里（`asrResult`，只留最近一条），刷新即丢；用户确认后写一条 `dialogue.updated { text }`，**不带 `durationMs`**——时长仍以音轨为准（准则 P5）。服务端只收 `data:audio/…;base64`（上限 8 MB），不抓外部地址。

## 6. 风格 / 发布

```ts
interface StyleProfile {
  id: ID;
  name: string;             // "王家卫式暖调" / "冷峻悬疑"
  lutId?: ID;
  grain: number;            // 0–1
  contrast: number;
  saturation: number;
  defaultLighting: LightingSpec;
  referenceImages: ID[];
  tags: string[];
}

interface PublishPackage {
  id: ID;
  episodeId: ID;
  target: "douyin" | "xiaohongshu" | "bilibili" | "tiktok" | "x" | "generic";
  videoAssetId: ID;
  coverAssetId?: ID;
  title: string;
  description: string;
  hashtags: string[];
  aiLabel: AILabel;         // 合规标识
  status: "draft" | "ready" | "published" | "failed";
  publishedAt?: ISODate;
  platformPostId?: string;
}

interface AILabel {
  explicit: boolean;        // 画面/简介可见标识
  implicit: boolean;        // 元数据隐式标识
  standard?: string;        // 依据的规范
}
```

## 7. 不变量（实现时必须保证）

1. **所有生成物都有 provenance**：model / seed / prompt / 参考图 / 时间。
2. **Shot 的 `characterIds` / `propIds` 必须存在**（`REF_SHOT_CHARACTER` / `REF_SHOT_PROP`）。
3. **`durationMs` 与对白音频一致**（差值超过阈值时标警告，不静默改）。
4. **SubtitleCue 的 `editedByUser` 一旦为 true，自动流程不得覆盖**。
5. **Timeline 引用的 `takeId` 必须属于该 `shotId`**。
6. **发布包必须携带 AILabel**，未设置不得进入 published。
7. 删除资产前检查引用；被引用的资产只能软删除。
8. **单镜时长不得超过所选模型的安全上限**；超限必须拆 `segments`，且段数受控（准则 P13 / ADR-0012）。
9. **`SceneState` 必须与同场镜头的走位/服装/道具一致**；不一致时阻断生成并提示。
10. **经 `Approval` 锁定的资产不得被自动流程覆盖**；修改必须先解锁并留痕。
11. **预算超限时不得提交新任务**；降级路径必须显式记录。
12. 任何镜头状态变化都必须经过单一状态机，不允许直接改 `status`。
13. **每个 Shot 必须归属一个 Beat，且每个 Beat 至少有一个信息镜头与一个情绪镜头**（准则 P15）。*当前状态（ADR-0096）：`Shot.beat` 仍可选，缺省由读模型推断；覆盖率在分镜页提示但不阻断。等阶段闸门（F8 / F9）接入后再收紧为必填与硬校验。*
14. **`CameraPlacement` 必须遵守动作轴线**，除非该镜被显式标记为过渡镜（V3）。
15. **Take 进入 approved 前必须有 `ConsistencyReport`**，且 verdict 不为 fail。
16. `Blocking.axis` 变更必须触发同场所有机位的重新校验。
17. **审片台上的 take 决议只能通过 `take.updated` 写入**；切换当前镜、展开画面等浏览动作不得产生事件（ADR-0027）。
18. **`Character.sheet` / `referenceImages` / `Location.masterShotId` / `referenceImages` 引用的资产必须存在**（`REF_ASSET`）。
19. **`Approval` 的 `targetType + targetId` 必须指向存在的角色 / 场景 / 道具**（`APPROVAL_TARGET`）。
20. **`Approval.lockedAssetIds` 里的每个 id 必须是存在的资产**（`APPROVAL_LOCKED_ASSET`）。
21. **定妆闸门**：有近景 / 特写镜头的角色，三视图四格未齐不得锁定；场景无主镜不得锁定（`cast.ts` 判定，`lockCast` 与界面各守一道，ADR-0028）。
22. **锚点不齐不得生成**：`shotAnchors().missing` 非空时，必须在调用任何模型之前失败（ADR-0029）。
23. **道具进入镜头即成为必锁项**：`Shot.propIds` 引用的道具必须有一张参考图，缺图不得锁定，也不得生成（`cast.ts` 与锚点两道，ADR-0030）。
24. **`StoryBible.arcs` 只能引用存在的人物**（`REF_STORY_CHARACTER`）；`StoryBible.relationships` 的两端也必须是存在的人物。
25. **每个 `characterId` 最多一条弧光**（`STORY_ARC_UNIQUE`）；重复时整份项目不合法。

> 本节只收跨层的结构不变量（1–25）。各层自己的不变量写在该层末尾，编号不重排：表演 21–24（§11）、声音 25–29（§12）、发布 30–35（§13）、成本 36–41（§14）、配置 42–45（§15）、本次新增的空间 46–47（§11.5）、声音 48–50（§12）与资产 51–54（§5.1）。

## 8. 与 OTIO 的映射

| Project IR | OpenTimelineIO |
| --- | --- |
| `Timeline` | `Timeline` |
| `TimelineItem` | `Clip`（`source_range` = take 的入出点） |
| `AudioTrack` | `Track(kind=Audio)` |
| `SubtitleCue` | `Track(kind=Text)` / 外部 SRT 引用 |
| `Asset.uri` | `ExternalReference(target_url)` |
| `Project` | `Timeline.metadata["loomina:project"]` |

> 只导出**渲染所需的最小集**；IR 里的叙事、一致性、QA 信息不回写 OTIO。

## 9. 版本策略

- 项目整体 `version` 单调递增：`applyEvent` 每应用一条事件就 +1（`project.created` 用事件自带的起始版本），回滚同样 +1——回到旧内容也是一次状态变更。所以它是「改到第几版」，不是「日志里还剩什么」；真实的先后顺序看日志本身。
- 每个保存点生成快照（或事件日志重放）。
- 早期实现：**事件日志 + 定期快照**，比"每次全量存 JSON"更省空间，也天然支持撤销。
- 破坏性 schema 变更必须写迁移脚本，并在 ADR 中记录。

## 10. 故事层（ADR-0017 / STORY.md）

```ts
interface Premise {
  genre: string;            // 都市情感 / 逆袭打脸 / 甜宠……
  audience: string;
  tone: string;
  constraints: string[];    // 人物数、场景数、时长、预算
}

interface Hook {
  type: "suspense" | "conflict" | "contrast" | "crisis" | "secret" | "flashback"
      | "reversal" | "threat" | "revelation" | "countdown" | "unfinished";
  position: "open" | "end";
  text: string;
  scores: { curiosity: number; urgency: number; visual: number; freshness: number };
}

interface CharacterArc {
  characterId: ID;
  want: string;
  need: string;
  wound: string;
  flaw: string;
  secret: string;
  agency: string;   // 主动做出的选择
  arc: string;
}

interface ScriptDoctorReport {
  version: number;
  scores: {
    hook: number;
    premiseClarity: number;
    desireObstacleStakes: number;
    beatDensity: number;
    reversal: number;
    characterAgency: number;
    relationshipTension: number;
    dialogueEfficiency: number;
    emotionalPayoff: number;
    endHook: number;
    feasibility: number;
    originality: number;
  };
  findings: { dimension: string; severity: "info" | "warn" | "block"; note: string }[];
  rewrites: { mode: string; targetBeatId?: ID; suggestion: string }[];
}

interface OriginalityReport {
  similarity: number;                 // 0–1
  matches: { source: string; type: "text" | "beat" | "character" | "relationship"; score: number }[];
  action: "pass" | "review" | "block";
}
```

**新增不变量**

17. **每个项目必须有一个已评分的 `logline`**，总分低于阈值不得进入分镜。*落地口径（ADR-0123）：不硬拦，warn 级发现并入 `script` 阶段的可豁免缺口。*
18. **`ScriptDoctorReport` 中任何 `block` 级 finding 未处理，不得进入分镜**。*落地口径（ADR-0123）：`block` 只留给真正的结构错误（没有场次 / 没有镜头），由分镜闸门的 `missing` 承担；12 维分数不设否决权。*
19. **`OriginalityReport.action === "block"` 时不得发布**；`review` 时必须有人工确认记录。
20. **`CharacterArc` 必须属于 `StoryBible` 中的人物**。

**落地形态（A18 / ADR-0123，2026-11-11）**

- `ScriptDoctorReport` **不进 IR**：它是 `analyzeScript(project)` 的返回值，与 `analyzeStoryboard` / `analyzeConsistency` 同类——只读、可单测、不写事件。分数是当前剧本的函数，改一句台词就该变，存下来要配失效机制而它没有跨会话引用价值。
- 12 维里 10 维本地可算，每维带 `source: "local" | "model" | "unmeasured"` 与 `score: number | null`：`emotionalPayoff` 标 `model`（未测），`originality` 标 `unmeasured`（等 A8）。**未测算出来写 `null`，不写 0 分**——0 分是「很差」，未测是「不知道」。
- 改写建议分两档：本地建议（零成本）与 `POST /api/doctor`（一次一模式，返回建议不写事件）。作者点「采用」才落 `story.updated` / `dialogue.updated` / `shot.updated`。

**落地细节（A18 第一档，2026-11-12）**

- `apps/web/lib/script-doctor.ts` 的 `analyzeScript(project, { loglineScore? })` 返回 `ScriptDoctorReport`：`dims`（12 条，每条 `score: number | null`）、`overall`（**只按已测维度平均**，一位小数；一维都没测才是 `null`）、`measured` / `total`、`findings`（按 warn → info 排序）、`suggestions`（固定 6 条）、`seconds`、`shotNos`（镜 id → 全片镜号，抽屉跳转用）。
- 空项目不是「未测」：钩子、结尾、可拍性这些维度**确实能判定为不合格**，给低分；只有 `emotionalPayoff`（要模型）与 `originality`（要 A8）保持 `null`。「没有台词」同样是 `dialogueEfficiency: null`，理由写「没有可算的内容」，不按 0 分处理。
- `hook` 是**结构代理**：只回答「开场是不是钩子拍、够不够短、前 15 秒有没有升级 / 转折」，回答不了「这个钩子抓不抓人」。这句原话写在维度的 `reason` 里。
- 触发条件只出 `warn` / `info` 两级发现，没有 `block`；`stage-flow.ts` 的 `readinessOf("script")` 在结构缺口为空时把 warn 数写成 `剧本医生：N 项偏低` 进 `waivable`，确认弹层复用 ADR-0118 的「我知道」勾选，**不新增事件**。
- 6 种改写模式的第一档只给 `target` + `direction`（改哪里、往哪个方向），**不改字**：第二档的 `/api/doctor` 与「采用」未做。减人物 / 减场景明写「工具不会替你删——删角色会牵动镜头、台词与 take」。


## 11. 表演层（ADR-0019 / PERFORMANCE.md）

```ts
interface PerformanceSpec {
  shotId: ID;
  objective: string;              // 这场戏他要什么（只能一个）
  emotion: { surface: string; subtext: string };
  beats: ActionBeat[];            // 起 / 转 / 落
  gaze: GazeTarget;               // 必填
  intensity: 1 | 2 | 3 | 4 | 5;
  avoid: string[];                // 明确不做什么
}

interface ActionBeat {
  phase: "before" | "during" | "after";
  micro: string;                  // 微表情
  body: string;                   // 姿态/手
  action?: string;
  startMs: number;
  endMs: number;
}

interface GazeTarget {
  target: "character" | "prop" | "camera" | "off-screen";
  targetId?: ID;
  direction: "left" | "right" | "up" | "down" | "center";
}
```

**新增不变量**

21. **每个 Shot 必须有 `PerformanceSpec`**，且只有一个 objective。
22. **`GazeTarget` 必填**；缺失不得进入生成。
23. **表演动作必须与模型能力矩阵兼容**；超范围动作必须拆段或改设计。
24. **首尾帧的表情/姿态必须与 `PerformanceSpec` 的起止一致**，否则关键帧不合格。

**落地形态（ADR-0103，2026-11-11）**

- 实际 IR 中没有独立的 `PerformanceSpec.shotId`：它是 `Shot.performance?: PerformanceSpec`，镜头本身是宿主，避免 id 与宿主不一致。
- `Shot` 同时新增 `staging: StagingMark[]`（默认 `[]`）：一条只挂 `characterId` 或 `propId`（二选一），带 `side`（左/中/右）、`depth`（前/中/后景）与 `note`。
- 写入走 `shot.updated { performance? , staging? }`，`applyEvent` 做 zod 校验并把默认值补进事件，保证实时与回放逐字段一致。
- `performance` 是可选的：存量项目不受影响；不变量 21 / 22 目前由分镜检查 V10 warning 提示，不阻断生成（见 ADR-0103 决策 6）。

## 11.5 空间层（B13 / ADR-0126，2026-11-11）

```ts
type Vec3 = [number, number, number];

interface LocationSpace {
  dimensions: Vec3;                     // 宽 × 深 × 高（米）
  anchors: {
    id: ID;
    kind: "door" | "window" | "furniture" | "prop" | "light" | "mirror" | "wall";
    label?: string;                     // 人话名字（"沙发（中左）"）；旧数据没有就显示 id
    position: Vec3;
    facingRad: number;
    capacity: number;                   // 可站 / 坐人数；0 = 不可承载
  }[];
}

interface Blocking {
  actors: { characterId: ID; position: Vec3; facingRad: number }[];
  props: { propId: ID; position: Vec3 }[];
}

interface CameraPlacement {
  position: Vec3;
  target: Vec3;
}
```

- 挂载：`Location.space?`、`Shot.blocking?`、`Shot.camera.placement?`；全部可选，存量项目不受影响。
- 坐标系：地点局部坐标，原点在房间中心地面，单位米，右手系，Y 向上。坐标必须落在 `dimensions` 内（0.1 m 容差），越界**拒绝**而不是夹取。
- `blocking.actors[].characterId` 必须是这一镜的 `characterIds` 之一；不在场的人不能有走位。
- `camera.angle` 不从几何反推：角度是摄影意图，几何只是执行（ADR-0126 决策 2）。
- `suggestBlocking()` / `checkAxis()` 是纯函数，只给建议、不写事件。越轴检查在**有坐标时用精确版**，没有坐标时退回 ADR-0108 的调度近似版，文案区分「越轴」与「像越轴」。
- depth / edge 导出（B13.3）需要 WebGL 渲染器，依赖未确认；`DepthExporter` 接口先定，实现留空。

**落地细节（B13.1，2026-11-12）**

- 校验在 `applyEvent`：`location.updated { space }` 查尺寸为正、锚点 id 不重复且落在场地内；`shot.updated { blocking }` 查在场 / 不重复 / 不越界；`shot.updated { camera }` 查两点不重合（< 5 cm）且都在场地内。纯计算放在 `packages/ir/src/geometry.ts`，事件与 store 共用同一份。
- `space: null` 表示**清掉几何**（换成没有坐标的旧模板时用）。不用 `undefined`：它存进 JSON 就消失，回放会留下旧几何。
- 换模板时按锚点 id 合并：作者挪过的位置留着，新模板没有的锚点丢掉（`mergeTemplateSpace`）。存量地点（模板早就选好、但没有 `space`）在再存一次名字 / 描述时顺手补上。
- 10 个场景模板的锚点坐标与朝向落在 `packages/pipeline/src/scene-templates.ts`；`templateSpace()` 把它转成 IR 形状。
- 俯视图只决定 X / Z。拖人物时 Y 保留 0（地面），拖机位时保留原高度——不然机位会被压到地上。

**新增不变量**

46. **走位里的角色必须在这一镜出场**（`BLOCKING_ACTOR_IN_SHOT`）；`camera.placement` 的 `position` 与 `target` 不得重合。
47. **空间坐标不得越出地点尺寸**（`SPACE_OUT_OF_BOUNDS`）；越界拒绝，不夹取。

**落地细节（B13.2 立面与遮挡，2026-11-12）**

- **不加字段**。相机高度就是 `camera.placement.position[1]`，朝向就是 `blocking.actors[].facingRad`，家具高度就是锚点 `position[1]`；立面与遮挡全是派生结论，和剧本医生、音乐曲线同一口径——**不进 IR**。
- `elevationOf(project, shot)` → `{ distanceM, groundDistanceM, pitchDeg, cameraHeightM, targetHeightM, angleFromGeometry, declaredAngle, agrees, summary }`。`angleFromGeometry` 由俯仰角换档（≥60° `top`、≥10° `high`、≤−10° `low`、其余 `eye`）；`agrees` 是它与 `camera.angle` 是否同档。**几何不改写 `angle`**：档位是摄影意图，坐标只是事实（与 §11.5 同一条）。
- `occlusionsOf(project, shot, space?)` → `{ kind: "anchor" | "actor", id, label, at, heightM, sightHeightM }[]`，按离机位由近到远排。`at` 是视线上的比例（0 机位、1 目标）。
- 判定口径：XZ 平面上最近距离 ≤ 半径，且遮挡物高度 ≥ 该处视线高度（容差 2 cm），且 `at` 不在两端 0.15 m 以内。
- **房间边界的墙跳过**：模板里的 `wall` 锚点都贴着边界（`|x| ≈ 半宽` 或 `|z| ≈ 半深`，0.2 m 容差），屋里两个人之间穿不过去；只有立在屋里的隔断按整面墙算，高度取 `dimensions[2]`。
- 被摄者本人不算遮挡（目标点站在谁身上，谁就不挡自己）。

**新增不变量**

无。立面与遮挡是提示，不是事实：同一份坐标下结论可以随锚点高度估计变化，所以不进不变量、不拦生成（R51 / R56）。

**落地细节（H6 生成结果复核，2026-11-12，ADR-0132）**

- **只审会进成片的三类**：画面轨上的 take、首尾帧（没有视频的镜头会拿它当画面）、台词配音。定妆三视图、参考图、场景主镜不进成片，不审——它们影响的是下一次生成。
- **三态**：没有 `review` = 还没看（进「待确认」，导出前要勾一下）；`passed` = 看过；`rejected` = 不能用（**硬阻断**导出）。「还没看」不硬拦是有意的：示例项目与刚生成的结果一上来全是没看，硬拦会让导出按钮第一天就点不动。
- **事件是 `asset.reviewed`，不复用 `asset.updated`**：后者是合并语义（`{ ...item, ...event.asset }`），`undefined` 过 JSON 会消失，所以「收回复核」删不掉字段。`asset.reviewed { status: null }` 明确表示回到还没看，handler 里解构掉整个 `review`。
- **缺资产单独一类**：引用了不存在资产的条目照样列出（`exists: false`），按钮禁用、写「资产不存在」，并进「待确认」——成片里那一格会是空的，得有人认下来。
- **预检多一项 `review`**：`preflightProject` 的检查从四项变五项，复核结论以三种 `ruleId` 进 `findings`（`review-rejected` block / `review-pending` review / `review-missing` review），与别的合规项共用指纹与确认机制。

**落地细节（H3 对象存储，2026-11-12）**

- **地址多一种形状，不加字段**。`Asset.uri` 仍是字符串：`data:`（旧项目）、`loomina://assets/<sha256>.<ext>`（本机库）、`s3://<bucket>/<key>`（对象存储）。引用方（`Shot.keyframes`、`Take.assetId`、`DialogueLine.audioAssetId`、`MusicCue.assetId`、`Character.sheet`、`referenceImages`）一个都不用改。
- key 形状 `<prefix>/<前两位>/<sha256>.<ext>`：内容寻址，同一个对象只存一份；前两位做目录是为了单个前缀下的对象数不炸。
- **凭据不进 IR、不进日志、不回浏览器**：`.loomina/config.json` 的 `storage` 段（0600）或服务端 `LOOMINA_S3_*` 环境变量。`/api/config` 只回 `endpoint` / `endpointHost` / `bucket` / `region` / `pathStyle` / `source` / `active`。
- `ConfigFile.storage?` 是唯一新增的配置字段，可选；没有它就是只用本机资产库。

**落地细节（B13.3 结构参考图，2026-11-12）**

- **同样不加字段**。结构参考图读的是 `Location.space` + `Shot.camera.placement` + `Shot.blocking`，输出的是图元（`StructureFrame`），不落库、不进事件。
- 焦段口径：`Shot.camera.focalMm` 是 **35 mm 全画幅等效**。竖幅时画面宽对应全画幅短边 24 mm，像素焦距 = `画面宽 × focalMm / 24`；走位板视锥的 `fovRad` 也用同一个 24 mm（B13.1 时误写成 9.6 mm，B13.3 落地时改正）。
- 派生结论不进 IR：`outside`（整个偏出画面的人数）与 `culled`（机位背后、被近平面裁掉的件数）只在图注里说，不写回项目。

**新增不变量**

无。结构参考图只是把已有坐标投到画面上，没有新的可校验事实。

## 12. 声音层（ADR-0020 / SOUND.md）

```ts
interface VoiceProfile {
  characterId: ID;
  timbre: string;
  age: string;
  accent?: string;
  basePitch: number;
  consentRef?: ID;          // 声音授权
}

interface LinePerformance {
  dialogueLineId: ID;
  voiceProfileId: ID;
  rate: number;
  pitch: number;
  volume: number;
  breathiness: number;
  emphasis: { text: string; strength: number }[];
  pauses: { afterChar: number; ms: number }[];
  emotion: string;
  takes: ID[];
}

// 设计目标（未全部落地）。当前 IR 只实现配乐床一条，
// 形状见 5.2：Asset 引用 + title / startMs / durationMs / gainDb / duckDb / ducking / loop / licenseRef。
// role / motifId / endMs / 多 cue 编排仍未做。
interface MusicCue {
  id: ID;
  startMs: number;
  endMs: number;
  role: "bed" | "hit" | "transition" | "silence";
  mood: string;
  motifId?: ID;
  duckUnderDialogue: boolean;
  licenseRef?: ID;
}

interface SfxCue {
  id: ID;
  atMs: number;
  kind: "foley" | "accent" | "offscreen" | "transition";
  assetId: ID;
  gainDb: number;
}

interface MixSpec {
  dialogueLufs: number;
  musicUnderDialogueDb: number;
  masterLufs: number;       // ≈ −14
  truePeakDb: number;       // ≤ −1
  monoCompatible: boolean;
}
```

**新增不变量**

25. **每条对白必须有 `VoiceProfile` 与 `LinePerformance`**，否则不得生成配音。*落地口径（ADR-0124）：两者都是可选字段，缺失时按默认值处理；参数影响下一次出声，不阻断既有音轨的使用。*
26. **台词期间音乐必须 ducking**；未经 ducking 的音乐不得进入混音。
27. **成片必须通过响度与真峰值检查**（≈ −14 LUFS / ≤ −1 dBTP）。
28. **所有音乐/音色资产必须有授权引用**；无授权不得发布。
29. **静音观看时字幕必须能独立传达剧情信息**。

**落地形态（C2 / C9 / C10，ADR-0124 / ADR-0125，2026-11-11）**

```ts
interface VoicePerformance {
  rate: number;          // 0.5–2.0
  pitch: number;         // -12–+12 半音
  volume: number;        // 0.25–2.0 线性
  breathiness: number;   // 0–1
  emphasis: { start: number; end: number; strength: 1 | 2 | 3 }[];
  pauses: { afterChar: number; ms: number }[];
  emotion: string;
  ending: "rise" | "flat" | "fall";
}

interface VoiceTake {
  id: ID;
  lineId: ID;
  assetId: ID;
  performance: VoicePerformance;
  provenance: Provenance;
  createdAt: ISODate;
}

interface Motif {
  id: ID;
  label: string;
  targetKind: "character" | "relationship" | "location";
  targetId: ID;          // 关系用 `${from}->${to}`
  assetId: ID;
  licenseRef: string;
  note: string;
}
```

- `DialogueLine.performance?: VoicePerformance`：走既有 `dialogue.updated` 的 patch，不新增事件类型。重音与停顿**按字符区间**定位；`end` 超过字数时拒绝写入，文本改短后越界项被确定性丢弃（不抛错）。
- `Project.voiceTakes: VoiceTake[]`：配音的多版本试听台。`DialogueLine.audioAssetId` 语义不变，仍是「当前采用的那条」；采用某版 = 一条 `dialogue.updated { audioAssetId }`。事件 `voice.take.added` / `voice.take.removed`。
- `MusicCue` 新增 `role`（`bed` / `hit` / `transition`，缺省 `bed`）与 `motifId?`；**不新增 `silence` 角色**，留白就是没有 cue。
- `Project.motifs: Motif[]`：主题动机。同一目标只许一个动机；`motif.removed` 清掉引用它的 cue 的 `motifId` 但保留 cue。
- 情绪曲线（`analyzeMusicCurve`）**不进 IR**，与剧本医生同一口径。

**新增不变量**

48. **重音与停顿的字符区间不得越出当前台词**（`VOICE_RANGE_OUT_OF_BOUNDS`）；文本改短时越界项被丢弃而非报错。
49. **配音 Take 的 `assetId` 必须是 `kind: "audio"` 且存在的资产**（`VOICE_TAKE_ASSET`）。
50. **同一个动机目标只能有一个动机**（`MOTIF_TARGET_UNIQUE`）；动机的 `licenseRef` 不得为空。

**落地细节（C2 / C9 第一档，2026-11-12）**

- **默认值**：`VoicePerformance` 八项全带 zod 默认（`rate` 1、`pitch` 0、`volume` 1、`breathiness` 0、`emphasis` `[]`、`pauses` `[]`、`emotion` `""`、`ending` `"flat"`），所以旧日志回放不补字段也不报错，`LOG_VERSION` 仍为 1。`Project.voiceTakes` 默认 `[]`。
- **字符区间口径**：`emphasis.start` / `end`、`pauses.afterChar` 都按 `[...text].length`（码点）数，与界面选中的字符一一对应；`end` 是开区间。
- **清空参数用 `null`**：`dialogue.updated` 的 patch 里 `performance` 三态——`undefined` 不改、`null` 清回默认（回放时 `delete` 字段）、对象则整组覆盖。`undefined` 过 JSON 会消失，写进日志等于没改，所以清空必须显式。
- **写入时校验、改短时裁剪**：只改参数或同时改长文本时越界抛错；只改短文本、没带 `performance` 时按新字数确定性丢弃越界项（不抛错），回放结果与实时一致。
- **每版一个资产**：「再念一版」用 `a-voice-<lineId>-t<n>`，普通重配仍是 `a-voice-<lineId>`。`voice.take.added` 校验 id 不重复、台词存在、资产存在且是音频，并按当时的文本再跑一次 `checkPerformance`；`voice.take.removed` 只摘记录，不删资产。正被采用的那一版（`audioAssetId === take.assetId`）拒绝删除。
- **删台词连带清试听台**：`dialogue.removed` 同时过滤掉 `lineId` 相同的 take（资产留在库里），否则不变量 49 的 `REF_VOICE_TAKE_LINE` 会被旧记录打穿。
- **请求体**：`speed`（clamp 0.5–2）与 `instructions`（≤300 字，提示语，不改字）；停顿靠 `inputOf` 插标点表达，不是 SSML。供应商忽略时与不传一致。


## 13. 发布与合规层（ADR-0021 / PUBLISHING.md）

```ts
// 当前实现（ADR-0099）：PLATFORM_SPEC_VERSION = "2026-11"，
// 9 份规格；durationMs 的 min / max 可缺省，maxFileBytes 可缺省；
// 标题字数、话题数、码率、封面列在 reference 里，只提示不硬拦。
interface PlatformSpec {
  id: PlatformId;
  name: string;
  version: string;         // 表级版本，发布包记 specVersion
  aspectRatios: string[];
  resolution: { width: number; height: number };
  durationMs: { min?: number; max?: number };
  maxFileBytes?: number;
  codec: "H.264";
  fps: number;
  coverRatio: string;
  titleMaxChars?: number;
  hashtagMax?: number;
  bitrateMbps?: [number, number];
  subtitleMode: "burn-in" | "sidecar" | "both";
  publishMode: "api" | "share" | "export-only";
  reference: string[];     // 未逐条复核的字段
  note: string;
}

interface ComplianceCheck {
  id: ID;
  packageId: ID;
  checks: {
    kind: "spec" | "ai-label" | "content-safety" | "authorization" | "copyright";
    verdict: "pass" | "review" | "block";
    detail: string;
    model?: string;
    reviewer?: string;
    at: ISODate;
  }[];
  overall: "pass" | "review" | "block";
}

interface AuthorizationRecord {
  id: ID;
  assetId: ID;
  kind: "model-output" | "music" | "voice" | "font" | "portrait" | "text";
  grantee: string;
  scope: string;
  expiresAt?: ISODate;
  documentRef: ID;
}
```

**新增不变量**

30. **未通过 `ComplianceCheck` 的发布包不得进入 exported/published。**
31. **`AILabel` 必须在渲染阶段写入**，不得在发布阶段补。
32. **每个素材必须有 `AuthorizationRecord`**，缺失即 block。
33. **发布包必须自包含**：视频、封面、标题、简介、话题、字幕、标识缺一不可。
34. **不得移除平台已添加的 AI 标识。**
35. **禁止任何逆向登录、模拟点击、绕过审核的发布方式。**

## 14. 成本层（ADR-0022 / COST.md）

```ts
interface ModelPrice {
  modelId: string;
  unit: "image" | "video-second" | "tts-char" | "llm-token" | "music-track";
  priceCny: number;
  tier: "draft" | "final";
  effectiveFrom: ISODate;
}

interface CostEstimate {
  projectId: ID;
  shots: { shotId: ID; estimatedCny: number; basis: string }[];
  audioCny: number;
  totalCny: number;
  confidence: "low" | "medium" | "high";
}

interface CostLedger {
  id: ID;
  projectId: ID;
  shotId?: ID;
  modelId: string;
  tier: "draft" | "final";
  units: number;
  cny: number;
  at: ISODate;
}
```

**新增不变量**

36. **每次生成必须写入 `CostLedger`**，无记账的任务不得提交。
37. **超过项目或镜头预算上限时不得提交新任务**；降级路径必须显式记录。
38. **确认动作之前的渲染必须是 draft 档**，不得直接 final。
39. **模型单价只能来自 `ModelPrice` 表**，不得在业务代码中硬编码。
40. **同一镜头连续两次在同一 QA 维度失败时，禁止继续重试**，必须回到设计层修改。
41. **生成资产的成本只能来自价目表**；价目表里没有这个模型时不得记 0，只能留空并单独计数（ADR-0033）。

## 15. 本机供应商与模型配置（H22 / ADR-0094）

不是 Project IR 的一部分，也不进事件日志；它描述「这台机器用哪家供应商、哪个模型」。

```ts
type Modality = "text" | "image" | "video" | "tts" | "asr";

interface ProviderRecord {
  id: string;            // 小写字母 / 数字 / 连字符，≤40
  name: string;
  baseUrl: string;       // http(s)，无账号、查询串、锚点；不带结尾斜杠
  apiKey?: string;       // 只在服务端文件与内存里；接口返回时整字段删除
  videoApi?: "treecloud" | "litellm";
}

interface ModelRecord {
  id: string;            // 全局唯一，默认 `<providerId>:<model>`
  providerId: string;
  modality: Modality;
  model: string;         // 发给供应商的真实模型名
  label: string;         // 界面显示名，缺省「供应商 / 模型名」
  resolution?: string;   // 仅视频
  voice?: string;        // 仅配音
  terms?: string;        // 商用条款 / 能力备注，人工填写，≤240 字；能力矩阵只读展示（ADR-0098）
}

interface ConfigFile {
  version: 1;
  providers: ProviderRecord[];
  models: ModelRecord[];
  defaults: Partial<Record<Modality, string>>;  // 有该模态模型时必有
}
```

落盘路径为仓库根 `.loomina/config.json`（可用 `LOOMINA_CONFIG` 覆盖），目录 0700、文件 0600，写入走临时文件 + `rename`。文件不存在时由 `secrity.env` 生成临时视图，第一次保存才落盘；临时视图不把 `API_KEY` 复制进记录，密钥按供应商 id `env` 在调用时回读。浏览器拿到的 `PublicConfig` 把 `apiKey` 整个删掉，只给 `hasKey` / `keyFromEnv`；页面选择存 `localStorage` 的 `loomina.model.<modality>`，不属于项目数据。

**新增不变量**

42. **密钥不得离开服务端**：任何接口返回、日志与错误文本都不能出现 `apiKey` 原值；供应商回显先替换再截断。
43. **有模型的模态必须有默认**，且默认必须属于该模态；保存时不允许「有模型但不知道用哪个」。
44. **同一供应商、同一模态下的同一个真实模型不得重复。**
45. **Base URL 只收 http(s)**，不得带账号、查询串或锚点；不在业务代码里硬编码供应商地址与模型名，统一走配置解析。
