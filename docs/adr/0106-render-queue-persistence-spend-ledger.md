# ADR-0106：渲染队列落盘与按阶段 / 按镜记账

- 状态：已采纳
- 日期：2026-11-11
- 关联：H2、H4、R15、R39、ADR-0036、ADR-0093、ADR-0101

## 背景

渲染队列（ADR-0093）一直只在内存里：进程一重启，排队的任务消失，已经花了十几分钟编码的那条也只剩半份临时文件；用户以为点了导出就交给机器了，回来却要从头再点一次。H4 的成本计量也只有项目总数与金额面板里的三行（分镜 / 定妆 / 已淘汰），回答不了"钱花在哪个阶段、哪一镜最贵"。

这一轮补两件事，都不改 IR、不新增事件：

1. **队列状态落本机**：重启后排队任务继续跑，正在跑的任务如实标成中断，已完成的成品在保留期内仍可下载；
2. **记账拆到阶段与镜头**：金额抽屉按「定妆 / 分镜 / 配音 / 成片」与逐镜列出花费，并修掉 take 视频资产被重复计价的问题。

## 决策

### 1. 队列状态写 `.loomina/render-jobs.json`

新增 `apps/web/lib/render-job-store.ts`：

```ts
type PersistedRenderJob = {
  id: string;
  manifest: RenderManifest;
  status: "queued" | "running" | "done" | "error";
  stage: string;
  progress: number;
  attempts: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  fileName: string;
  dir?: string;
  filePath?: string;
  bytes?: number;
  remoteSkipped: number;
  placeholders: number;
  loudness?: LoudnessReport;
};
```

- 路径默认 `项目根/.loomina/render-jobs.json`，可用 `LOOMINA_RENDER_STATE` 覆盖（测试与多实例部署用）；`.loomina/` 已在 `.gitignore` 里；
- 写盘走「临时文件 + rename」，目录 `0700`、文件 `0600`。清单里可能含 data URI（用户自己的素材），不能给同机其他人读；
- **只在状态变化时写**（创建、开始、完成、失败、清理），进度每秒变，写它没有恢复价值；
- 写盘串行化：慢磁盘或并发请求下，两次快照不会交错写坏文件；
- 写失败**不影响渲染本身**，错误被吞掉。这一轮的目标是「尽量活过重启」，不是强一致存储；
- 读回时逐条校验形状（`looksLikeJob`）：缺文件、坏 JSON、不认识的记录都当作空，不抛错，队列照常可用；
- 最多保留 32 条，按创建时间取最近的。

### 2. 重启后的三种任务各有明确结局

`restoreJobs()` 在进程内第一次访问 `POST` / `GET /api/render` 时执行：

| 落盘状态 | 重启后 | 用户看到 |
| --- | --- | --- |
| `queued` | 重新入队，阶段写「重启后恢复排队」，随后正常执行 | 排队位置照旧，不用重提 |
| `running` | ffmpeg 已随进程消失，删除半成品目录，状态改 `error` | 「服务重启，这次渲染中断了：没有交付半成品。重新点导出即可。」 |
| `done` | 文件还在且未过 30 分钟保留期才恢复，否则连目录一起清 | 仍可 `&download=1` 取回 |
| `error` | 保留到原保留期结束，方便回看失败原因 | 原错误信息 |

- 恢复后立即 `pump()`，排队任务接着跑；
- 清理定时器按**剩余**保留期重排（`scheduleCleanup(job, remain)`），不是重新给 30 分钟；
- 明确不做：断点续渲（ffmpeg 没有跨进程恢复）、多实例共享队列、优先级、取消接口、出图 / 视频接入同一队列。

### 3. 记账按引用关系分阶段

`read-model.ts` 新增：

```ts
type StageSpend = {
  id: "cast" | "storyboard" | "voice" | "edit";
  label: string;
  spent: number;
  unpriced: number;
  detail: string;
};

type ShotLedgerRow = {
  shotId: string;
  label: string;      // SH-01
  scene: string;
  durationMs: number;
  spent: number;
  unpriced: number;
  takes: number;
  rejected: number;
};
```

- `spendByStage(project)` 只按**引用关系**分类，不按资产类型猜：take 的视频 → 分镜（资产本身跳过，钱记在 take 上）；首尾帧 → 分镜；台词音轨与其余音频 → 配音；配乐 → 成片；剩下没人引用的图 / 视频 → 定妆；
- `shotLedger(project)` 逐镜汇总：这一镜的 take（含被淘汰的）+ 首尾帧资产；定妆、场景主镜、道具参考是项目级成本，**不摊进镜头**，否则「单镜上限」就说不清限制的是重拍还是定妆；
- 没有价目的生成资产一律计入 `unpriced`，不当 0 算（准则 P21）。界面上「未定价」用 `pick` 色单独数出来；
- `spendOf` 修了一个真实 bug：既算 `take.costCny`、又把同一 take 引用的视频资产按 `asset.costCny` 再算一次。现在跳过所有被 take 引用的资产。示例项目因此从 ¥20.08 校正为 ¥19.58，与按阶段合计一致。

### 4. 顶栏「记账」抽屉

`components/spend-ledger.tsx`，从顶栏「设置」左侧的「记账」按钮打开：

- 顶部四格：已花 / 预算 / 未定价 / 已淘汰；
- 「按阶段」四行：定妆 / 分镜 / 配音 / 成片，各写金额与一句说明（「12 条 take · 14 个关键帧资产」），合计与「已花」相等；
- 「按镜」逐行：`SH-xx`、场景名、时长、take 数、淘汰金额、这一镜合计；
- 底部如实写边界：文本模型调用与本机 ffmpeg 渲染没有落进 IR 的费用，剧本与成片显示 ¥0.00 表示「未记账」，不是「免费」。

抽屉只读：不写事件、不改预算、不影响任何生成。

## 后果

**好的一面**

- 进程重启不再等于任务消失；用户能分清"还在跑""被重启打断""还能下载"；
- 记账能回答"哪一镜最贵"，重拍决策有依据；
- 修掉了一处真实重复计费，金额面板与阶段合计对得上；
- 状态文件权限收紧到 `0600`，清单里的素材不会漏给同机其他用户。

**代价与风险**

- `.loomina/render-jobs.json` 会包含完整渲染清单，素材是 data URI 时会比较大；文件本身已忽略提交；
- 多实例部署时各进程各写一份，会互相覆盖——当前是单进程本地服务，暂不处理；`LOOMINA_RENDER_STATE` 只是为测试与部署留的出口；
- 重启时正在编码的任务只能失败，没有断点续渲；
- 文本调用、ffmpeg 本机渲染没有计价，按阶段合计只覆盖"有单价的图 / 视频 / 音频 / 配乐"，不代表真实总成本；文本单价（R28）与配音单价（R39）解决前，界面继续标「未记账」。

## 验证

- 状态文件：真实跑两条任务（一条 running、一条 queued），`.loomina/render-jobs.json` 权限 `-rw-------`，内容含两条记录与阶段文字；
- 重启：停进程再起，第一条 `GET ?job=` 返回 `error` + 重启中断文案，第二条从 `queued` 恢复为 `running`，证明落盘与恢复都生效；
- 记账：示例项目抽屉显示 12 镜、已花 ¥19.58，按阶段合计 ¥19.58（定妆 0 / 分镜 19.58 / 配音 0 / 成片 0），逐镜行有金额与淘汰数；修 dedupe 前两者差 ¥0.50，正是被重复计价的 take 视频资产；
- 测试 662 全过（IR 137 + gateway 28 + pipeline 50 + web 447），`pnpm typecheck` 与 `next build` 全过。
