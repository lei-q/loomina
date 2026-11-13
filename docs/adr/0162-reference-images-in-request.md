# ADR-0162：参考图真正进入出图请求

- 状态：已采纳
- 日期：2026-11-13
- 决策者：用户 + Claude
- 关联：B2、B3、B14、B8、A9、ADR-0029、ADR-0031、ADR-0128、准则 P3 / P4 / P15

## 背景

ADR-0029 定下的口径是：图片接口不收参考图，所以 `ImageInput.referenceAssetIds`
只进契约与溯源，**不塞进没验证过的字段**。这条约束让关键帧能出图，但角色身份
一致性只能靠提示词与验收基线，三视图、道具参考、地点参考图在像素层没有作用。

2026-11-13 用户更换了图像模型。实测同一代理：

| 请求 | 结果 |
| --- | --- |
| `POST /v1/images/edits`，multipart，单张 `image[]` + `size=1024x1536` | 200，返回 `b64_json`，尺寸按请求 |
| 同上，两张 `image[]` | 200 |
| 不带 `image[]` 的 `POST /v1/images/generations` | 200（原路径不变） |

也就是说，之前「参考图进不去」的判断已经不成立了。参考图是短剧一致性的第一层，
继续把它当装饰是浪费。

## 决定

1. **网关层（`packages/gateway`）**
   - `ImageInput` 增加 `references: ImageReference[]`（字节 + mime + 标签）；
     `ImageOutput` 增加 `referenceMode: "edits" | "prompt-only"` 与 `referenceCount`。
   - `TreecloudImageAdapter`：有参考图时走 `POST /v1/images/edits`，multipart
     字段名 `image[]`，`model / prompt / size / n` 照旧；没有参考图时仍走
     `images/generations`，请求体与以前逐字一致。
   - 单张参考图上限 8 MB、最多 4 张——与 `MAX_ANCHORS` 同一个数量级。
   - 只在**代理明确表示不支持**时退回纯文生图：404 / 405，或 400 且错误文本含
     `unsupported` / `not support` / `image request rejected` / `unknown parameter`。
     超时、429、5xx 一律照常报错——悄悄退回会让作者以为参考图生效了。
   - 退回时 `referenceMode` 如实写 `prompt-only`，`referenceCount: 0`。

2. **服务端（`apps/web`）**
   - `POST /api/asset` 收 `references: [{ assetId, uri, label }]`，最多 4 条；
     地址只收 `loomina://` / `s3://` / `data:image/`，不收 http 外链——服务端
     不该被当成任意 URL 的代理。
   - `generateCastImage` 用 `readAssetBytes` 把地址读成字节；读不到的进 `missing`
     名单，不阻塞生成。返回体带 `references: { mode, sent, missing }`。
   - `POST /api/video` 的首帧现在也接受资产库地址：读回字节换成 data URI 再发给
     供应商。以前只认 http(s) 与 data URI，`loomina://` 首帧会直接 400。

3. **客户端（`workbench-store`）**
   - `generateOne` 收 `references`，只传地址与标签，字节由服务端读——浏览器不重复上传。
   - 装配规则：
     - 三视图：当前角度之前的已出格子当参考（正面 → 3/4 → 侧面 → 背面），最多 2 张；
       正面不拿自己当参考。
     - 关键帧：`shotAnchors` 装配出的锚点（人物正面 / 3/4、场景主镜、道具、地点参考）；
       尾帧额外把这一镜的首帧排在第一位——同一镜的两端必须是同一个人、同一间屋子。
     - 地点主镜：地点自己的参考图（B8）。
     - 道具参考图：已有参考图当参考，新的一张延续材质与比例。
   - 只收 `kind === "image"` 且有 `uri` 的资产；缺的跳过，最多 4 张。
   - 出图成功后写一句 `generationNotice`：带了几张、几张读不到、还是退回了纯文生图。
     它与 `castError` 分开——这不是失败，别让作者以为这张没出。
     定妆页与关键帧页各显示一行。

## 理由

- **参考图是一致性的第一层**（P3 / P4）：关键帧阶段锁定身份比在视频阶段反复抽卡便宜一个数量级。
- **契约先于实现**：`referenceAssetIds` 一直在溯源里，现在补上字节通道，历史 take 的
  溯源含义不变，只是新增了「这次真的发了」的字段。
- **失败要可解释**：`referenceMode` 让界面能说清「这张带没带参考图」，而不是让作者猜。
- **不猜供应商能力**：只在明确不支持时退回，偶发故障照常失败——重试一次比悄悄降级更诚实。
- **不新增 IR 字段**：`Provenance.referenceAssetIds` 已经记了 id；`referenceMode` 是
  一次调用的结果，不写进项目，重生成会重新算。

## 后果

**正面**

- 三视图、关键帧、道具、地点主镜都能吃到参考图，角色与空间的像素级一致性第一次有了抓手。
- 尾帧带首帧，减少同一镜两端「不是同一个人」的概率。
- 界面明确说「已带 N 张参考图生成」，作者能判断一致性是不是真的被约束住了。
- 旧项目、旧事件、旧日志不需要迁移：`references` 是请求层字段，不进 IR。
- 没有参考图时请求体与以前逐字一致，不改变任何既有路径的行为。

**负面 / 代价**

- 出图变慢：`images/edits` 比 `images/generations` 多传几 MB，实测单张 1024×1536 仍在 20–50 秒量级。
- 参考图质量直接决定结果：三视图本身画歪了，后面的关键帧会一起歪；这层没有自动校验（B14 只查结构化锚点）。
- 最多 4 张是经验值，多人同框时名额会不够；`shotAnchors` 的取舍规则（脸与房间优先）现在有了像素后果。
- 代理换一家可能又不收参考图，届时 `referenceMode` 会变回 `prompt-only`，界面会如实说，但一致性会退回去。
- 字节要在服务端读一遍再 multipart 上传，单张 8 MB 上限之外没有压缩。

**不做**

- 参考图权重 / 强度参数（供应商未暴露）。
- 自动挑参考图、按相似度排序、按 VLM 判断哪张最像。
- `mask` 局部重绘（B10）、首尾帧插值（B9）。
- 把参考图写进 IR 或事件日志。
- 参考图压缩、裁剪、去背景。

## 备选方案

| 方案 | 不采用的原因 |
| --- | --- |
| 继续只把参考图记进溯源 | 用户已换模型、接口实测可用；放着不用等于放弃一致性 |
| 浏览器直接 multipart 上传 | 密钥与字节都在服务端更简单；浏览器只需要传地址 |
| 所有失败都退回纯文生图 | 超时 / 5xx 退回会让作者以为参考图生效，实际没有 |
| 把 `referenceMode` 写进 `Provenance` | 它是一次调用的结果，不改变项目语义；写进 IR 要多一次迁移 |
| 首帧仍只收 http(s) / data URI | 资产库是默认存储（ADR-0128），不认它等于让视频路径对旧项目失效 |
| 用 4 张以上参考图 | 提示词与 multipart 体积都会涨，收益没有证据 |
