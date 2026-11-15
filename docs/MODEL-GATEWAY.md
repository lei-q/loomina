# 模型网关：中转站实况与适配策略

> 本文件记录**实测**得到的供应商契约，不是推测。
> 最后一次实测：2026-11-11（`GET /v1/models`、`GET /v1/model/info`、`POST /v1/images/generations`、`POST /v1/images/edits`、`POST /v1/chat/completions`）。
> 供应商换版本时，先改这里，再改代码（[`../packages/gateway/src/treecloud.ts`](../packages/gateway/src/treecloud.ts)）。

## 一、结论先行

1. 中转站**不是**标准 OpenAI 协议。图片接口是 OpenAI 兼容的，视频接口不是——它是自定义的 `/v1/videos/generations` 任务式接口。
2. 只有 `GET /v1/models` 有 OpenAPI 规范（`/openapi.json`）。图片、视频接口**没有**规范文档，只能靠试探和错误信息还原契约。
3. 价格从 `GET /v1/models` 的 `pricing.lines[]` 里读，**不要抄进代码当常量**。本文抄了一份快照，只为估算，真实结算以账单选。
4. 计费模型是「按预算预授权 → 成功后按实际 usage 结算 → 释放差额」。所以**失败的请求也可能占用额度**（见 402 / 429 处理）。

## 二、接口契约

### 模型目录

```
GET /v1/models
```

返回 `data[]`，每项关键字段：

| 字段 | 含义 |
| --- | --- |
| `id` | 模型 ID，调用时原样使用 |
| `type` | `chat` / `image` / `video` |
| `api_interfaces[]` | `{ protocol, method, path }`，告诉你该模型走哪个端点 |
| `pricing` | `customer-pricing/v1`，`lines[]` 里每条是一个计费维度 |
| `context_length` / `max_output_tokens` / `supported_parameters` | 仅 chat 有意义 |

实测数量：chat 59、image 14、video 6。

### 图片

```
POST /v1/images/generations
{ "model": "gpt-image-2-c", "prompt": "...", "size": "1024x1536", "n": 1 }
```

- OpenAI 兼容。`model`、`prompt` 必填（缺了返回 400，`param` 指明是哪个）。
- 返回 `data[0].url` 或 `data[0].b64_json`。
- **慢**：实测一次请求挂到 300s 才被上游判 `deadline_exceeded`。必须自己设超时（默认 120s）。
- **不接受参考图**：请求体只有 `model / prompt / size / n`，没有实测过可用的 `images/edits` 或主体参考字段。`ImageInput.referenceAssetIds` 只进契约与溯源，**不要塞进没验证过的字段**（ADR-0029）。图片接口接通前，资产锚点只作用于提示词与验收基线，不作用于像素。
- 见过 `503 image_response_invalid`——上游返回体无法解析，不是我们的参数错。

### 文本（chat）

```
POST /v1/chat/completions
{ "model": "claude-sonnet-5-5", "messages": [{ "role": "system", "content": "..." }],
  "max_tokens": 16000 }
```

- OpenAI 兼容。`message.content` 可能是字符串，也可能是 `[{ type: "text", text }]` 数组，适配器两种都收。
- **不要传 `temperature`**：代理上的 Anthropic 模型只接受默认值，传 `0.7` 直接 400。`TreecloudChatAdapter` 只发 `model / messages / max_tokens`（ADR-0088）。
- 模型可用性会变：2026-11-11 实测 `qwen3.8-max` 回 `403 No authorized bound group supports this request`，`claude-sonnet-5-5` / `claude-haiku-5-5` 正常。模型取 `TEXT_MODEL`，没配抛 `text_not_configured`（500），一个请求都不发。
- **必须给足 `max_tokens`**：故事草稿一份约 8–11k completion tokens，其中一半是推理；8000 会在 JSON 中途被截断。故事入口用 16000、超时 150s，实测 60–90 秒返回。
- 空内容回 502 `chat_empty_text`，不把空字符串当成功。`usage` 里的 prompt / completion tokens 进 provenance，便于之后按 token 记账。

### 视频

```
POST /v1/videos/generations
{ "model": "minimax-h3", "prompt": "...", "resolution": "768p", "seconds": 4,
  "content": [{ "type": "image_url", "image_url": { "url": "https://..." } }] }

GET /v1/videos/generations/{id}
```

- 任务式：提交返回 `{ id, status, object: "video.generation", provider_notification_mode: "polling" }`，之后轮询。
- 状态值：`queued` / `running` / `succeeded` / `failed`（实测见过前三个）。
- **图生视频必须用 `content[].image_url.url`**。顶层 `image_url` 会被拒绝：`top-level image_url is unsupported; use content[].image_url.url`。
- `resolution` 是枚举，传错报 `unsupported <X> resolution`。
- `seconds` 是整数秒。我们的 IR 用毫秒，提交时四舍五入，最小 1 秒。
- 失败时可能带 `error.message`（例如内容审核不通过），要原样记进 Take 的失败原因，不要吞掉。

### 错误格式

两种都存在，适配器都要能吃：

```json
{ "error": { "code": "invalid_request", "message": "...", "param": "model", "type": "invalid_request_error" } }
{ "code": 17003, "message": "AI token quota exceeded", "type": "rate_limit_error" }
```

响应头带 `X-Request-ID`，排障靠它，**不要**把 API Key 或提示词贴给客服。

| HTTP | 含义 | 处理 |
| --- | --- | --- |
| 400 | 参数错 / 内容策略拒绝 | 不重试，改参数 |
| 402 | 余额或输出预算不足 | 不重试，停线报警 |
| 429 | 配额 / 限流 | 按 `Retry-After` 退避，限制次数 |
| 5xx | 上游异常 | 先确认请求是否已执行，再决定是否重试 |

## 三、价目快照（2026-11-09，人民币，含当前折扣）

只收录**能换算成每秒 / 每张**的模型。按 token 计价的（seedance 系列）没有公开 token 公式，离线估不出来，不进价目表——**估不出来的价格不是价格**。

### 视频

| 模型 | 分辨率 | 单价 |
| --- | --- | --- |
| `wan3.0-video` | 480p / 720p / 1080p | ¥0.3 / ¥0.6 / ¥1.2 每秒 |
| `wan3.0-video-prime` | 480p / 720p / 1080p | ¥0.45 / ¥0.9 / ¥1.8 每秒 |
| `minimax-h3` | 768p / 2k | ¥0.5 / ¥0.8 每秒 |
| `seedance-2.0` | 480p–1080p | ¥21–38.25 / 百万 output tokens |
| `seedance-2-5` | 480p–1080p | ¥42–77 / 百万 output tokens |
| `seedance-2-5-d` | 480p–1080p | ¥33.6–61.6 / 百万 output tokens |

补充：`minimax-h3` 的首帧图超出免费额度部分 ¥0.2 / 张；带视频输入（`video_input=true`）时单价不同，seedance 系列带视频输入反而更便宜。

### 图片

| 模型 | 单价 |
| --- | --- |
| `gpt-image-2-c` 及 `2.5/2.6-flare/sunburst-c` | ¥0.12 / 张 |
| 其余 gpt-image / gemini 系列 | 按 output token 计，约 ¥163.8–655.2 / 百万 |

`-c` 后缀是**按张计价**的通道，和同名的 token 计价模型是两条价格。做关键帧优先选 `-c`。

## 四、对成本模型的修正

按 `minimax-h3 @ 768p` 算，一个 4 秒镜头：

```
关键帧 ¥0.12 + 视频 4 × ¥0.5 = ¥2.12
```

`docs/COST.md` 里假设的「视频每秒 ¥1.5、关键帧 ¥0.3」偏高约 30%–40%。这不是好消息——**真实成本比假设低，意味着通过率才是瓶颈，不是单价**。一个镜头重做 4 次就是 ¥8.48，重做 10 次就超过一条 60 秒成片的预算。

所以 S1 的产出重点不是「便宜」，而是：**首次通过率**、**失败维度分布**、**平均重试次数**。

## 五、工程约束（写进适配器，不写进业务）

| 约束 | 取值 | 原因 |
| --- | --- | --- |
| 单请求超时 | 120s（探针 150s） | 实测图片接口能挂 300s |
| 429 重试 | 最多 2 次，按 `Retry-After` | 配额错误重试无意义 |
| 其他错误 | 不重试 | 4xx 是参数错，5xx 先核对 |
| 轮询间隔 | 5s | 视频任务通常几十秒到几分钟 |
| 轮询超时 | 10 分钟 | 超时按失败处理，不无限等 |
| 密钥回显 | 错误信息里替换成 `<redacted>` | 兜底，防止日志泄漏 |

`secrity.env` 已被 `.gitignore` 的 `*.env` 覆盖。密钥**只在**探针进程内存里出现，不写盘、不进报告。

## 六、还没搞清楚的

- 视频成功返回体里视频地址的确切字段名（只见过 `queued/running`）。适配器目前按 `url / video_url / output / output.url / data[0].url / outputs[0].url` 依次找，拿到真实成功样本后收敛成唯一字段。
- 图片接口的耗时分布（样本只有一个 504）。
- 429 的配额窗口长度与恢复时间。
- 是否有独立的余额 / 用量查询接口。
- 内容审核拒绝的具体错误码集合。

以上每一条，都在 S1 测绘里补齐，然后回写本文件。

## 七、复现方式

```bash
# 只看计划，不花钱
pnpm probe:s1 -- --dry-run

# 真实跑 8 个镜头（粗估 ¥18.96，预算护栏 ¥30）
pnpm probe:s1 -- --shots 8 --resolution 768p --budget 30
```

报告写到 `artifacts/s1/probe-<时间戳>.json`（已 gitignore），字段见 `docs/COST.md` 的「可观测性」。

## 八、第二家实测：callfansai（LiteLLM 代理，2026-11-09）

用户更换了 `BASE_URL` 与 `API_KEY` 之后重新测绘。结论：**换 Key 没有解决问题，因为瓶颈在上游账户，不在 Key。**

| 能力 | 端点 | 结果 |
| --- | --- | --- |
| 模型目录 | `GET /v1/models` | 200，字段是 `mode` 不是 `type`，**没有 `pricing`、没有 `api_interfaces`** |
| 对话 | `POST /v1/chat/completions` | 200，Key 与计费正常 |
| 图片 | `POST /v1/images/generations` | 503 `Image request rejected`（gpt-image / gemini 全部如此） |
| 图片（走 chat） | `POST /v1/chat/completions` + `modalities:["image","text"]` | 400 `invalid model price` —— 代理的图片计价配置是坏的 |
| 视频 | `POST /v1/videos` | 路由存在；`seedance-2.0` → **429 `17003 AI token quota exceeded`**；`wan3.0-video` 等 → 403 `GROUP_ROUTING_FAILED` |

### 关键发现

1. **这是 LiteLLM 代理，不是 treecloud 协议。** 视频路由是 `POST /v1/videos` + `GET /v1/videos/{id}`，与第一家的 `/v1/videos/generations` 不同。错误体是 LiteLLM 的包装格式（`litellm.RateLimitError: ... OpenAIException - {...}`）。
2. **两家的视频 429 是同一个错误码 `17003 AI token quota exceeded`**——说明它们转到同一个上游媒体账户。换中转站、换 Key 都不改变这个配额。
3. **图片在两家都坏，但坏法不同**：第一家 `image_response_invalid` / 300s 超时；第二家 `Image request rejected` / `invalid model price`。第二种是代理自己的计费配置错误，用户侧无法绕过。
4. `MODEL_NAME=minimax-h3` 在第二家根本不存在；第二家的目录里只有 `seedance-2.0`、`seedance-2-5`、`wan3.0-video*`。

### 适配器相应改动

- `VIDEO_API=treecloud | litellm` 选择路由族；不填按 treecloud。遇到 `404/405`（路由不存在、无副作用）自动换另一条并记住。
- 429 分两种：限流按 `Retry-After` 重试；配额耗尽（`17003` / `quota exceeded`）**不重试**。
- `--text-only` 允许跳过关键帧、单独验证视频通路（关键帧接口坏掉时用）。

### 对 S1 的影响

S1 仍未完成，且不是代码问题：

1. 关键帧接口在两家都不可用 → 图生视频无法开始。
2. 视频配额在上游耗尽 → 文生视频也无法开始。

**需要用户侧解决**（任一即可）：给上游媒体账户充值/提额；让代理方修好图片计价；或提供官方直连 Key（火山方舟 Seedance / 阿里云百炼 Wan / OpenAI 或 Gemini 图片）。

## 九、2026-11-10 复测：图片接口恢复，参考图仍然进不去

2026-11-09 的结论是"图片在两家都坏"。今天在第二家（LiteLLM 代理）复测，**普通出图已经能用**，坏掉的是"带参考图"那条路。

| 能力 | 端点 | 结果 |
| --- | --- | --- |
| 模型目录 | `GET /v1/models` | 200，71 个模型：chat 46 / video_generation 7 / image_generation 10 / realtime 3 / audio_speech 2 / audio_transcription 3。字段仍是 `mode`，**没有 `pricing`、没有 `api_interfaces`** |
| 模型价格 | `GET /v1/model/info` | 200，LiteLLM 的 `litellm_params` 里带 `output_cost_per_image` / `output_cost_per_second_<res>`。这是 11-09 时不知道的端点 |
| 图片（生成） | `POST /v1/images/generations` | **200**。`gemini-2.5-flash-image` 1024×1536 → 25.6s；`gpt-image-2` 1024×1024 → 23.8s；`gpt-image-2-c` 1024×1024 → 43.1s。返回 `data[0].b64_json` 与 `url` |
| 图片（编辑 / 参考） | `POST /v1/images/edits`（multipart，一张 PNG） | **400** `unsupported_parameter` / `Image request rejected`（LiteLLM 转到 OpenAI 后拒绝） |
| 图片（走 chat） | `POST /v1/chat/completions` + `modalities:["image","text"]` | 仍是 **400** `invalid model price` |
| 视频 | 未复测 | 配额与路由状态未知，见第八节 |

### 结论

1. **出图能力恢复，不是代码问题。** 11-09 的 `503 image_response_invalid` 是当时的偶发上游故障，同型号今天连 `gpt-image-2-c` 都能出图（只是慢）。
2. **参考图依然送不进去。** 生成接口只吃 `model / prompt / size / n`；`images/edits` 被代理直接拒绝；chat 的图片计价是坏的。ADR-0029 的约束不变：`ImageInput.referenceAssetIds` 只进契约与溯源，**不要塞进没验证过的字段**。
3. **"能不能带参考图生成"与"能不能出图"是两件事**，之前混在一起说成"图片接口不通"，导致 FEATURES 里的判断偏悲观。分开记：关键帧能出，身份一致性还不能靠参考图保证。
4. **价格信号要分开看。** `/v1/model/info` 的 `output_cost_per_image` 是 LiteLLM 口径（惯例为美元），与第三节 `/v1/models` 抓到的人民币快照不是同一套数：`gpt-image-2-c` 在 LiteLLM 是 `0.0278`，快照是 ¥0.12。**在拿到账单对上之前，不拿它改写 CNY 价目表**，只用来比较型号之间的相对贵贱。

### 这轮测到的媒体单价（LiteLLM 口径，单位未确认）

| 类型 | 模型 | `output_cost_*` |
| --- | --- | --- |
| 图片 / 张 | `gpt-image-2-c` | 0.0278 |
| 图片 / 张 | `qwen-image-3.0` | 0.03 |
| 图片 / 张 | `gemini-2.5-flash-image` | 0.039 |
| 图片 / 张 | `gemini-3.1-flash-image` | 0.045 |
| 图片 / 张 | `gpt-image-2.5-flare` / `sunburst` | 0.07 |
| 图片 / 张 | `gemini-3-pro-image-preview` | 0.134 |
| 图片 / 张 | `gpt-image-2` | 0.27 |
| 视频 / 秒 | `minimax-h3` 768p / 2k | 0.08 / 0.13 |
| 视频 / 秒 | `wan3.0-video` 480p / 720p / 1080p | 0.041 / 0.083 / 0.165 |
| 视频 / 秒 | `wan3.0-video-prime` 480p / 720p / 1080p | 0.064 / 0.127 / 0.254 |
| 视频 / 秒 | `seedance-2.0` 480p / 720p / 1080p / 4k | 0.135 / 0.303 / 0.682 / 1.555 |

`gpt-image-2` 是 `gpt-image-2-c` 的约 10 倍价，同样是出图，草稿档没有理由用它。`wan3.0-video-prime` 比 `wan3.0-video` 贵一倍多，是否值这个价要在 S1 里按通过率算。

### 下一步

1. 拿一张真实账单，确认 `/v1/model/info` 的计价单位，再决定要不要用它替换 `packages/gateway/src/pricing.ts` 里的人民币快照（不变量 39：价目只有一份）。
2. 参考图这条路没有现成出口。要等代理支持 `images/edits`，或换一家能收图的接口；在此之前，三视图与道具参考只能靠提示词与验收基线起作用。
3. 视频配额一旦恢复，用 `gemini-2.5-flash-image` 出首帧 → `minimax-h3` 图生视频跑通最小 i2v 链路。

## 十、配置入口（2026-11-11，ADR-0094）

模型不再只能写死在 `secrity.env`：`/settings` 可配多个供应商与五种模态的多个模型，每种模态一个默认，存本机 `.loomina/config.json`（0600）。请求按 `modelId` 解析到供应商与真实模型名，再填进 `TreecloudConfig` 的 `textModel` / `imageModel` / `videoModel` / `ttsModel` / `asrModel` 槽位。

同一页底部有只读「能力矩阵」（ADR-0098）：按模型列出代码实际发送的字段、价目表里查到的单价、人工填写的商用条款，以及最近 S1 测绘的尝试 / 通过 / 花费 / 失败码。它不替代本节的能力测绘，也不参与路由；供应商侧未验证的能力一律标「未测」。

- 没保存过配置时，页面显示由 `secrity.env` 生成的临时视图，默认模型为文本 `deepseek-v4.1-flash-1017`、图像 `gpt-image-2-c`、视频 `minimax-h3`、配音 `seedance-2.0`；`ASR_MODEL` 未配时识别不可用。
- `MODEL_NAME` 是视频模型的旧名，仍作为 `VIDEO_MODEL` 的兜底；新配置建议直接写 `VIDEO_MODEL`。
- 密钥只在服务端解析；浏览器拿不到 Base URL 之外的供应商凭据，`GET /api/config` 只回 `hasKey`。
- 价目仍只来自 `ModelPrice` 表：所选模型不在表里时界面显示「无价目」，不编造单价（不变量 39 / 41）。

## 十一、待供应商确认（2026-11-15，ADR-0245 / ADR-0247）

这三件事在客户端侧已经做到头了，需要代理方或模型供应商给口径。复现命令都写在这里，
免得下次再从零试一遍。

### 1. 图生视频到底怎么传首帧

- 模型清单（`GET /v1/models`）里视频模态有 8 个，全部 `mode: video_generation`：
  `seedance-2.0`、`seedance-2-5`、`seedance-unfiltered`、`wan3.0-video`、
  `wan3.0-video-unfiltered`、`wan3.0-video-prime`、`wan3.0-video-prime-unfiltered`、`minimax-h3`。
- 现状：`content: [{ type: "image_url", image_url: { url } }]` 被 `wan3.0-*` 接受，
  但**产物第 0 帧与输入图无关**；`seedance` / `minimax-h3` 回
  `content or prompt is required`（prompt 明明传了），换成
  `content: [image, text]` 又回 `video content requires exactly one media source`。
- 要问的：
  1. i2v 的 content 结构样例（把「一个媒体源」的完整 JSON 给一份）；
  2. 图片是否必须是**公网可访问 URL**，data URI 是否支持；
  3. 是否支持 multipart 上传图片文件；
  4. 请求里 `content` 与 `prompt` 的优先级/互斥关系。
- 判定方法不要用真实素材：塞一张纯洋红 720×1280 合成图，取产物第 0 帧看颜色
  （ADR-0245）。HTTP 200 只代表任务建立了。

### 2. TTS / ASR 的部署地址与计费

- 清单里有 `qwen-audio-3.0-tts-plus` / `-tts-flash`（audio_speech）与
  `qwen-audio-3.0-asr-flash` / `-filetrans` / `-streaming`（audio_transcription）。
- TTS：`POST /v1/audio/speech` → 400 `url error, please check url`
  （阿里云错误页口径，指向**部署 base URL 配错**）。
- ASR：`POST /v1/audio/transcriptions`（multipart + `response_format=json`）→
  400 `The upstream audio request failed`；不带 `response_format` 时提示
  `native ASR supports response_format json or text`，说明参数层是通的。
- 要问的：可用的部署地址、计费口径（当前价目表里没有音频，记账显示「未定价」）。

### 3. `seedance` 的单价

- 价目表里有 `seedance` 的历史快照，但代理的模型 id 是 `seedance-2.0` / `seedance-2-5`，
  取不到价（R39）。两次首帧实验花了多少，目前无法从回执里读出来。

### 回话之后怎么落

- **i2v 打通**：新 ADR 更新 B3 与 RISKS 的 B3 行；把各模型能吃多大尺寸、必填字段、
  480p 是否锁横屏写进能力矩阵（B12），别只写在 ADR 里。
- **音频可用**：配 `TTS_MODEL` / `ASR_MODEL`，依次验 C1 / C2 / C9 / D1；
  音频单价进 `packages/gateway/src/pricing.ts`，否则记账一直显示「未定价」。
- **seedance 报价**：补价目表并去掉 R39 里的「未知」，再决定要不要纳入默认候选。
