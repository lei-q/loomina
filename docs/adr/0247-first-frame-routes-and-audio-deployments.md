# ADR-0247：首帧输入的路由穷举与音频模态现状

- 状态：已采纳（诊断结论）
- 日期：2026-11-15
- 决策者：用户 + Claude
- 关联：B3、C1、D1、H22、B12、R39、ADR-0245、ADR-0087

## 一、首帧输入：客户端能试的形状已经穷举完

ADR-0245 证明了 `wan3.0-video-unfiltered` 收下 `content[].image_url` 但不用图。
这一轮把「是不是我们传错了」这个问题问到底：先读代理的模型清单，再把请求体形状穷举一遍。

### 模型清单（`GET /v1/models`，76 个，带 `mode`）

| 模态 | 模型 |
| --- | --- |
| video_generation | `seedance-2.0`、`seedance-2-5`、`seedance-unfiltered`、`wan3.0-video`、`-unfiltered`、`-prime`、`-prime-unfiltered`、`minimax-h3` |
| audio_speech | `qwen-audio-3.0-tts-plus`、`qwen-audio-3.0-tts-flash` |
| audio_transcription | `qwen-audio-3.0-asr-flash`、`-filetrans`、`-streaming` |
| image_generation | `gpt-image-2` / `-c` / `2.5` / `2.6` 系列、`gemini-*-image`、`qwen-image-3.0`、`seedream-unfiltered` |

### 形状矩阵（首帧用纯洋红 720×1280 合成图）

判定标准：产物第 0 帧平均 RGB 是否接近洋红；不是洋红 = 图没被用。

| 请求体形状 | `seedance-2.0` | `minimax-h3` | `wan3.0-*` |
| --- | --- | --- | --- |
| `content:[{type:"image_url",image_url:{url}}]`（网关现用） | 400 `content or prompt is required` | 400 同上 | **200，但第 0 帧不是洋红** |
| `content:[{type:"text"},{type:"image_url"}]` | 400 `video content requires exactly one media source` | 400 同上 | 400 `duplicate multipart` |
| `content:[<data URI 字符串>]` | 200，但第 0 帧不是洋红 | 未测 | 未测 |
| `content:{...}`（对象而非数组） | 200，但第 0 帧不是洋红 | 未测 | 未测 |
| 顶层 `image` / `images` / `image_url` | 200，但第 0 帧不是洋红（未知字段被忽略） | 200，同上 | 200，同上 |
| 顶层 `first_frame` | 未测 | 未测 | 200，但第 0 帧不是洋红 |
| 顶层 `input_reference` | 400 `unsupported video media content type` | 400 同上 | 200，但第 0 帧不是洋红 |

补充观察：

- `wan3.0` 系列在 `480p` 下固定输出 **854×480 横屏**，竖屏短剧用不了；`720p` 才是 720×1280。
- 200 只代表「任务建立了」。未知字段被静默忽略，所以**不能用状态码判断能力**。

### 决定

1. **客户端侧到此为止**：形状、字段名、模态都试过了，剩下的变量在供应商内部。
2. 继续向供应商要三样东西：i2v 的字段契约、可访问的图片 URL（而不是 data URI）是否必需、
   是否支持 multipart 上传。
3. `minimax-h3` / `seedance` 说的 `content or prompt is required` 与 `requires exactly one media source`
   自相矛盾（我们两个都传了），说明它们的 content 解析器期望的是另一种结构——**由供应商给出样例**。

### 成本

本轮视频实验：`wan3.0-video-prime-unfiltered` ¥1.20、`wan3.0-video-unfiltered` 两次共 ¥2.40、
seedance 两次（**价目未知**，受 R39 约束，需向供应商核价）。加 ADR-0245 的 ¥3.72，
今天首帧探测合计 **¥7.32 + 两次 seedance 未知价**。

## 二、音频：模型存在，部署坏了；`TTS_MODEL` 连模态都配错了

### 事实

1. 模型清单里有 `qwen-audio-3.0-tts-plus/flash`（audio_speech）与
   `qwen-audio-3.0-asr-flash/filetrans/streaming`（audio_transcription）。
2. `POST /v1/audio/speech`（`qwen-audio-3.0-tts-flash`）→ **400 `url error, please check url`**，
   阿里云错误码页面的口径 → **代理侧部署的 base URL 配错了**，不是我们的参数问题。
   对比：`seedance-2.0` 走同一个端点回的是 404「No deployments available … in cooldown」。
3. `POST /v1/audio/transcriptions`（`qwen-audio-3.0-asr-flash`，`response_format=json`，
   用本机资产库里的真实 wav）→ **400 `The upstream audio request failed`**。
   不带 `response_format` 时先报 `native ASR supports response_format json or text`——
   端点与参数层是通的，坏在上游。

### 根因之一（我们自己的错）

`SEED_MODELS.tts` 写的是 **`seedance-2.0`——那是一个视频模型**。从 ADR-0085 起，
默认 TTS 一直指着一个视频模型，所以「出声失败」里混着一部分配置错误。

### 决定

1. `SEED_MODELS.tts` 改为 `qwen-audio-3.0-tts-flash`；本地 `TTS_MODEL` 同步改掉。
2. `SEED_MODELS.asr` **保持 `undefined`**：部署未通时给个默认值，只会让界面假装有能力
   （ADR-0087 的立场），模型名写进本 ADR，等供应商修好再配。
3. 网关代码不改：错误如实透传，界面继续显示供应商原因。
4. 向供应商要：TTS / ASR 的可用部署地址与计费口径（音频目前不在价目表里）。

## 三、教训

- **先看清单再猜字段**：`/v1/models` 带着 `mode`，一眼就能看出 `TTS_MODEL=seedance-2.0` 是错的。
  前几轮把「403/404」当成「没授权」，少问了这一步。
- **200 不是能力**：未知字段会被静默忽略，必须用产物验证。
- **把「我们配错了」和「供应商坏了」分开记**，否则同一个阻塞会反复浪费时间。
