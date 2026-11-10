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
  version: number;          // 单调递增，配合版本快照
  createdAt: ISODate;
  updatedAt: ISODate;

  bible: StoryBible;        // 故事圣经：全剧共享
  episodes: Episode[];      // 分集
  assets: Asset[];          // 全项目资产（图/视频/音频/字体）
  publishPackages: PublishPackage[];

  settings: ProjectSettings;
}

interface ProjectSettings {
  aspectRatio: "9:16" | "16:9" | "1:1";
  resolution: "720p" | "1080p" | "4k";
  language: "zh-CN" | "en-US";
  defaultStyleId?: ID;      // 指向 StyleProfile
}
```

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
  referenceImages: ID[];    // → Asset（多角度/表情）
  mustNotChange: string[];  // 监工重点：痣、疤、发型、配饰
}

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
  description: string;
  referenceImages: ID[];
  lightingDefaults: LightingSpec;
}

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
  timeOfDay: string;
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
  beatId?: ID;
  purpose: "establish" | "information" | "emotion" | "reaction" | "transition" | "hook";

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
  audioAssetId?: ID;        // TTS 结果
  durationMs?: number;
}

interface Keyframes {
  firstAssetId?: ID;
  lastAssetId?: ID;
}

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
  uri: string;              // 对象存储地址
  mime: string;
  width?: number;
  height?: number;
  durationMs?: number;
  hash?: string;            // 去重与缓存
  source: AssetSource;      // 上传 / 生成 / 素材库
  provenance?: Take;
  createdAt: ISODate;
}

type AssetSource = "upload" | "generated" | "library" | "imported";

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
2. **Shot 的 `characterIds` / `propIds` 必须存在于 `bible`**。
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
13. **每个 Shot 必须归属一个 Beat，且每个 Beat 至少有一个信息镜头与一个情绪镜头**（准则 P15）。
14. **`CameraPlacement` 必须遵守动作轴线**，除非该镜被显式标记为过渡镜（V3）。
15. **Take 进入 approved 前必须有 `ConsistencyReport`**，且 verdict 不为 fail。
16. `Blocking.axis` 变更必须触发同场所有机位的重新校验。
17. **审片台上的 take 决议只能通过 `take.updated` 写入**；切换当前镜、展开画面等浏览动作不得产生事件（ADR-0027）。

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

- 项目整体 `version` 单调递增；每个保存点生成快照（或事件日志重放）。
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

17. **每个项目必须有一个已评分的 `logline`**，总分低于阈值不得进入分镜。
18. **`ScriptDoctorReport` 中任何 `block` 级 finding 未处理，不得进入分镜**。
19. **`OriginalityReport.action === "block"` 时不得发布**；`review` 时必须有人工确认记录。
20. **`CharacterArc` 必须属于 `StoryBible` 中的人物**。

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

25. **每条对白必须有 `VoiceProfile` 与 `LinePerformance`**，否则不得生成配音。
26. **台词期间音乐必须 ducking**；未经 ducking 的音乐不得进入混音。
27. **成片必须通过响度与真峰值检查**（≈ −14 LUFS / ≤ −1 dBTP）。
28. **所有音乐/音色资产必须有授权引用**；无授权不得发布。
29. **静音观看时字幕必须能独立传达剧情信息**。

## 13. 发布与合规层（ADR-0021 / PUBLISHING.md）

```ts
interface PlatformSpec {
  platform: PlatformId;
  version: string;
  aspectRatios: string[];
  resolution: { width: number; height: number };
  durationMs: { min: number; max: number };
  maxFileBytes: number;
  codec: string;
  cover: { ratio: string; safeArea: string };
  titleMaxChars: number;
  hashtagMax: number;
  subtitleMode: "burn-in" | "sidecar" | "both";
  publishMode: "api" | "share" | "export-only";
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
