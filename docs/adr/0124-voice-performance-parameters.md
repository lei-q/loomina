# ADR-0124：逐句配音表演参数进 IR，多 Take 走「试听台」

- 日期：2026-11-11
- 状态：已采纳
- 关联：C2、C9、C1、C12、A20、ADR-0085、ADR-0020、ADR-0003

## 背景

SOUND.md 第三节把配音定义为表演：语速、音高、音量、气声、停顿、重音位置、句尾走向、呼吸，共 8 类参数；还要求「多 Take：同一句给 3 个读法让用户选」。DATA-MODEL 第 12 节早就有 `LinePerformance` 的草图。

现状是：`DialogueLine` 只有 `{ id, characterId, text, durationMs, audioAssetId }`。音色按角色（`Character.voiceProfileId`），**逐句的表演参数一个都没有**。ADR-0085 当时明确拒绝了「每条音轨都是一个 Take」，理由是「配音没有比较需求，只会让 takes 混进两种语义」。

现在 C2 / C9 把这件事摆回桌面，同时有个硬约束：`POST /v1/audio/speech` 实测 **403 分组未授权**，出声路径至今没跑通过。设计必须让「参数能存、能编辑、能回放」与「暂时念不出来」同时成立。

## 决策

### 1. 参数挂在台词上，作为可选字段

```ts
export const VoicePerformanceSchema = z.object({
  /** 0.5–2.0，1 为原速 */
  rate: z.number().min(0.5).max(2).default(1),
  /** 半音偏移，-12–+12 */
  pitch: z.number().min(-12).max(12).default(0),
  /** 线性增益，0.25–2.0 */
  volume: z.number().min(0.25).max(2).default(1),
  /** 气声比例 0–1 */
  breathiness: z.number().min(0).max(1).default(0),
  /** 重音：按字符区间定位，不按文本匹配 */
  emphasis: z.array(
    z.object({
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
      strength: z.number().min(1).max(3).default(2),
    }),
  ).max(8).default([]),
  /** 停顿：第 afterChar 个字之后停 ms 毫秒 */
  pauses: z.array(
    z.object({ afterChar: z.number().int().nonnegative(), ms: z.number().int().min(50).max(2000) }),
  ).max(8).default([]),
  /** 情绪标签，进提示词；空串表示不标 */
  emotion: z.string().max(20).default(""),
  /** 句尾走向：上扬 / 平 / 下沉 */
  ending: z.enum(["rise", "flat", "fall"]).default("flat"),
});
```

`DialogueLineSchema` 增加 `performance: VoicePerformanceSchema.optional()`。

- **可选**：存量项目与现有事件形状不受影响；没写的句子按默认值（原速、平、无重音）处理。
- **走 `dialogue.updated`**：它的 `patch` 已经是 `Partial<Omit<DialogueLine, "id" | "characterId">>`，新字段自动可写，不需要新事件类型。`applyEvent` 里补一条校验：`performance` 里的字符区间与数值范围。
- **不改 `durationMs`**：准则 P5 规定时长以音轨为准。参数只影响下一次出声，时长仍由浏览器量出的音轨决定。改了 rate 但没重新出声，`durationMs` 不动——这是对的，它描述的是手上这条音轨。

### 2. 重音与停顿按字符区间，不按文本

SOUND.md 的草图写的是 `emphasis: { text, strength }`。**不采用**：同一句里「我不去」出现两次时文本匹配有歧义；作者改一个字，所有按文本定位的重音全部失效，而且失效得无声无息。

字符区间（`start` / `end`）在写入时校验 `end <= [...text].length`，越界直接报错。文本之后被改短时，`applyEvent` 丢弃越界的重音与停顿，**不抛错**——改台词不该被上一次的重音标记挡住。丢弃是确定性的，回放结果一致。

### 3. 多 Take：新增 `Project.voiceTakes`，`audioAssetId` 仍是唯一「在用的那条」

```ts
export const VoiceTakeSchema = z.object({
  id: Id,
  lineId: Id,
  assetId: Id,
  performance: VoicePerformanceSchema,
  provenance: ProvenanceSchema,
  createdAt: z.string().min(1),
});
```

- `Project.voiceTakes: VoiceTake[]`（默认 `[]`）。
- `DialogueLine.audioAssetId` **语义不变**：它指向当前采用的那条音轨。采用某一 Take = 写一条 `dialogue.updated { audioAssetId: take.assetId }`。
- 事件：`voice.take.added { take }` / `voice.take.removed { takeId }`。资产本身不删（与 B5 的视频 Take 同一口径）。两个新类型要补进 `event-log.ts` 的 `EVENT_TYPES` 白名单（那个 record 少一行就编译不过）。**`LOG_VERSION` 不需要升**：`performance` 与 `voiceTakes` 都带默认值，旧日志照旧解析，没有任何事件形状被改变。

这样 ADR-0085 的担心被绕开了：**Take 不进 `DialogueLine`**，不会与 `takes`（视频）混在一起；配音的 Take 是一张独立的试听台，采用才回到台词上。

### 4. 出声请求带上参数

`TreecloudSpeechAdapter.speak()` 的请求体增加可选的 `speed`（`rate`）与 `instructions`（由 emotion / ending / breathiness 拼成一句中文提示）。**不假设供应商支持 SSML**——网关只发 OpenAI 兼容字段，供应商忽略多余字段时行为与现在一致。

`emphasis` / `pauses` 第一版**只进提示词文本，不改请求结构**：在 `input` 里按停顿插入标点，把重音词写成「重读：…」的旁注是错的——那会改变念出来的字。因此第一版只把 `pauses` 转成逗号 / 省略号，`emphasis` 与 `breathiness` 记进 IR、进提示词、但**不承诺生效**。界面上如实标「当前模型可能不支持」。

这条是本次设计里最重要的诚实项：**没有跑通的字段不许写成「已支持」**。

### 5. 界面：声音页每句一个「表演」折叠

- 每句下方 `表演` 按钮展开：4 个滑块（语速 / 音高 / 音量 / 气声）、句尾三选一、情绪输入、重音与停顿的逐项列表。
- 重音用**选中文本**的方式加：在句子文本里选中一段 → 点「重读」，按选区字符下标写入。比让作者填数字可靠。
- 停顿同理：光标位置 → 「加停顿」。
- 参数改动写一条 `dialogue.updated { performance }`，与文本编辑共用同一套历史与回退。
- 有 Take 时展开区下方列出「试听台」：每条带参数摘要、播放、采用、删除。
- **TTS 未配置时**：滑块照常可编辑（数据要能存），「出声 / 再来一版」禁用并写「还没配配音模型」。这是唯一一处「能存不能跑」的界面，文案要说清。

### 6. 成本

| 项 | 估计 |
| --- | --- |
| 单句出声 | 1 次 TTS 调用；价目表未收录，界面只记次数 |
| 一句 3 个 Take | 3 次调用 |
| 全片重配（20 句 × 3 Take） | 60 次调用 |
| 工程 | schema + 事件 1 天；声音页参数区 2 天；试听台 1.5 天 |

多 Take 的成本是线性的，所以在界面上必须**先看到「这一句已有几版」再点**，不能默认生成 3 版。

## 理由

- **参数进 IR 才有回滚**：存在组件 state 里，刷新就没了；写进事件日志，撤销、历史、回放全都免费拿到。
- **区间优于文本**：文本匹配在重复词与改字两种情况下都会静默失效，静默失效比报错更糟。
- **Take 独立成表**：视频 Take 与配音 Take 语义不同（一个比画面，一个比读法），塞进同一个数组会让「这一镜有几拍」这类计数全部要改口径。
- **不假装支持 SSML**：供应商契约里没有 SSML 字段，写了也不生效，还会让作者以为调了参数就一定会变。

## 后果

**正面**

- 逐句表演参数可存、可改、可撤销、可回放，不依赖供应商是否支持。
- 多 Take 有自己的位置，采用哪一版是显式的一条事件。
- 音色（角色级）与表演（句级）职责分开，与 SOUND.md 的四层声音结构一致。

**负面**

- **TTS 403 未解，整条出声链路无法端到端验证**；参数是否真的生效只能等分组授权。
- `emphasis` / `breathiness` 第一版不承诺生效，界面上有「可能不支持」的说明。
- 多 Take 每次都是真花钱的调用，没有本地试听就无法先听再存。

**跟进**

- TTS 分组授权后补一次探针，把实际支持的字段写进 MODEL-GATEWAY，并把「可能不支持」改成事实。
- 句尾走向与呼吸如果供应商不支持，改为在文本末尾加标点 / 在音频上做后处理（C12 之后）。
- 与 A20（台词压缩）联动：超长句在医生抽屉里能被点名，改写后重配。

## 验证（设计阶段口径）

- schema 单测：默认值补齐、`rate` / `pitch` 越界被拒、`emphasis.end > 字数` 被拒、停顿 `ms` 越界被拒。
- 事件单测：`dialogue.updated { performance }` 只改这一句；文本改短后越界的重音被丢弃且回放一致；`voice.take.added` 重复 id 被拒；采用 Take 后 `audioAssetId` 指向它的资产。
- 读模型单测：声音页每句带出参数与 Take 数；未配置 TTS 时 `voiceInfo()` 为空、按钮禁用。
- 浏览器（TTS 未通时）：改一句语速 → 写一条事件、历史可见；刷新后滑块仍在原值；「出声」按钮禁用并显示原因。

## 备选方案

| 方案 | 不采用的原因 |
| --- | --- |
| 参数放组件 state | 刷新即丢，撤销 / 历史 / 回放全都拿不到 |
| 重音按文本匹配（SOUND.md 草图） | 重复词有歧义，改一个字后静默失效 |
| 配音 Take 塞进 `DialogueLine.takes` | 与视频 Take 语义不同，计数与界面口径全要改 |
| 新增 `line.performance.updated` 事件 | 与 `dialogue.updated` 完全同构，只会让事件类型膨胀 |
| 第一版就发 SSML | 供应商契约没有这个字段，写了不生效却让人以为生效 |
| 改 rate 时同步改 `durationMs` | 时长必须以真实音轨为准（P5），没重新出声就没有新时长 |
| 默认一次生成 3 个 Take | 每次都是真花钱的调用，必须先让作者看到已有几版再点 |
