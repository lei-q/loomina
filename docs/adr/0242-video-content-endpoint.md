# ADR-0242：视频任务成功后从 content 端点取成片

- 状态：已采纳
- 日期：2026-11-15
- 决策者：用户 + Claude
- 关联：B3、H1、S1、ADR-0025、ADR-0128

## 背景

「供应商授权」这条阻塞在 RISKS.md 里记了很久：B3 图生视频只吃首帧、视频配额耗尽、
TTS / ASR 403。这次去查实际状态，发现**视频通路其实是通的**——阻塞的一半是工具自己的 bug。

三个问题串在一起：

1. **`runShot` 只 `poll` 一次就判失败**。供应商的视频是异步任务，刚提交时状态是
   `queued`；只查一次就把「还在排队」当成「生成失败」。探测脚本因此报 0/8 通过，
   看上去像供应商不可用。
2. **修了轮询后仍失败**，报「已成功但没有返回视频地址」。直连供应商才发现：
   `status: "completed"` 的响应体里**根本没有 url 字段**。
3. **成片在 `GET /v1/videos/{id}/content`**。直连验证返回 200、`video/mp4`、
   4.6 MB、前 8 字节是 mp4 的 `ftyp` 头。适配器从来没走过这个端点。

## 决定

1. **`runShot` 等到终态**：新增 `waitForVideo`，按 `videoPollIntervalMs`（默认 3 秒）
   轮询到 `succeeded` / `failed`，`videoTimeoutMs`（默认 5 分钟）超时后如实报
   「等了 N 秒还没出片（最后状态 X）」。探测脚本给到 8 分钟 / 5 秒。
2. **`VideoEndpoints` 加可选 `content`**：litellm 路由填 `/v1/videos/{id}/content`，
   treecloud 路由不填（它没有这个端点）。
3. **`outputOf` 先看响应体、再问 content**：拿不到 url 就调 `downloadContent`，
   字节包成 `data:video/mp4;base64,...`。两边都拿不到才报
   `video_response_invalid`，文案写明「content 端点也没拿到字节」。
4. **`TreecloudClient.binary(path)`**：取原始字节，与按 JSON 解析的 `request` 分开；
   非 2xx 或空字节返回 `undefined`，由调用方决定怎么报。

## 验证

```
pnpm probe:s1 -- --shots 1 --budget 5 --text-only
  · GET /v1/videos/{id} -> 200   （多次，轮询到 completed）
  · GET /v1/videos/{id}/content -> 200
✓ probe-sh-1  44.0s  ¥0.00
通过 1/1（100.0%）
```

直连验证 content 端点：`200`、`video/mp4`、4641442 字节、`00000020 66747970`（mp4 头）。

`treecloud.test.ts` +3 条：content 回退成功并包成 data URI、content 也失败时如实报错、
treecloud 路由不去试不存在的端点。

IR 260 / gateway 35 / pipeline 158 / web 1469（4 skipped）全过。

## 理由

- **「供应商不可用」要先排除工具自己的问题**。这次两个 bug（只 poll 一次、不走 content）
  叠加起来，让一条本来能跑的通路看起来完全不可用，并且这个结论被写进了 RISKS.md
  与多份 ADR。**先复现再归因**，比读历史记录可靠。
- **content 端点只在拿不到 url 时才试**：多数代理直接回 url，那条路径不变；
  只有真的缺地址时才多一次请求。
- **不把「没拿到」说成成功**：两边都失败时仍然报错，只是把尝试过的两条路径都写出来。

## 后果

**正面**

- **视频通路可用**：探测 0/8 → 1/1 通过，44 秒出片，返回真实 mp4。
- 异步任务的轮询有了统一的超时与间隔，不再依赖调用方自己写循环。
- RISKS.md 里 B3 的「配额耗尽」需要更新——至少在纯文生视频这条路径上已经能出片。

**负面 / 代价**

- **图像接口仍然 503**（`The upstream image response could not be validated`），
  所以「关键帧 → 图生视频」这条主路径还不通，只有 `--text-only` 能出片。
  这是供应商侧的计费 / 转发配置问题，用户侧绕不过。
- `data:` URI 装 4.6 MB 视频会让内存与日志变大；对象存储（H3）可用时应改存资产。
- 轮询循环在 CLI 里是阻塞的；业务链路（`/api/video`）有自己的队列，这次没动。
- 只验证了 `minimax-h3 @ 720p` 一条组合。
