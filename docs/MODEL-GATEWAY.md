# 模型网关：中转站实况与适配策略

> 本文件记录**实测**得到的供应商契约，不是推测。
> 最后一次实测：2026-11-09（`GET /v1/models`、`POST /v1/images/generations`、`POST /v1/videos/generations`）。
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
