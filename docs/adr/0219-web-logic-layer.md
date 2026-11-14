# ADR-0219：纯计算层下沉为 web.logic，清掉六模块循环依赖

- 状态：已采纳
- 日期：2026-11-14
- 决策者：用户 + Claude
- 关联：H 组底座、ARCHITECTURE.md、`.scout/modules.yaml`、ADR-0188

## 背景

nest-scout 接入时记了 10 条基线：1 条 M4（`web.assets ⇄ governance ⇄ models ⇄ render ⇄ review ⇄ state`
六模块循环）与 9 条 M6（跨包重复定义业务概念）。这些是「地图说得清、代码做不到」的存量。

M4 的根因不是某一处写错了，而是**分层缺失**：`platforms`（平台规格）、`ai-label`（AI 标识）、
`compliance`（合规规则）、`pricing`（价目）、`read-model`（各页读模型）这些**纯计算、无 I/O**
的模块被随手分散在 governance / render / state / review / assets 五个子模块里，
于是「合规要用平台规格」「读模型要用价目」这种完全正常的引用，在地图上变成了模块互依。

scout 的 M4 只统计非 type-only 的边（`import type` 不算耦合），所以问题比看上去小：
实际是 4 个二元环，不是 6 节点强连通。

## 决定

1. **新建 `web.logic` 子模块**，承载纯计算层，`depends_on: []`：
   - 平台规格 `platforms`、AI 标识 `ai-label`、合规规则 `compliance`、内容安全 `moderation`
   - 价目 `pricing`、报价 `image-price`、成本看板 `cost-dashboard`、账单 `spend-report`
   - 读模型 `read-model`、覆盖率 `coverage-plan`、剧本诊断 `storyboard`
   - 授权留档 `rights`、素材复核 `asset-review`
   - 资产地址 `asset-uri`、路径 `project-root`、环境变量 `server-env`、存储配置 `storage-config`
   - 模型选择 `model-choice`、按量计价 `metered-price`、哈希 `fnv`
2. **其余子模块只允许依赖 logic，不允许 logic 反向依赖**。logic 的 `depends_on` 为空。
3. **两处改为依赖注入**（真需要运行时数据的，不该反向依赖）：
   - `generateCastImage` 的 `readBytes` 由路由传入（models 不再引 assets）
   - `buildHealthReport` 的 `loadJobs` 由路由传入（models 不再引 render）
4. **`S3Config` 类型移到 `config-types`**：`storage-config` 属于纯计算层，只为构造一个类型
   反向依赖 assets 不值得。
5. **同名不同物的两处改名**，而不是强行合并：
   - `MOVE_CN`（story-screen）→ `MOVE_SHORT_CN`：表格短词，与 pipeline 的提示词长说法不同
   - `ImagePrice` / `imagePrice`（generate-image）→ `ImageQuote` / `imageQuoteOf`：
     web 侧是读配置后的异步报价，与 gateway 的纯查表不是同一件事

## 理由

- **分层比逐个拆环可靠**：4 个二元环逐个切会留下「下次再加一个纯函数模块，环又回来」的隐患。
  按「纯计算 / 有 I/O」分层后，新模块放对位置就不会再造环。
- **logic 无依赖是可验证的不变量**：`depends_on: []` 一旦被违反，M2 立刻报错。
- **注入优于隐藏依赖**：`generateCastImage` 只关心「拿到字节」，从哪读是资产库的事；
  用参数表达这层关系，比 import 一个具体实现更诚实。
- **改名而非合并**：两处同名符号语义不同，合并会丢失信息。改名后 scout 的 M6 也不再误报。

## 后果

**正面**

- **基线归零**：10 条存量全部清掉，`scout check` 不再有「已知问题」这一档。
- 六模块环消失，`web.logic` 成为可依赖的地基层，后续新纯函数模块有明确去处。
- `web.governance` 从 1717 行降到 83 行——它本来大部分是纯计算。

**负面 / 代价**

- **web 现在有 9 个子模块**，超过 nest-scout 建议的 8 个（`scout status` 会提示）。
  这是为了分层付出的代价，比留着 6 模块环更值得。
- `web.governance` 只剩 83 行，名不副实；将来要么合并进别处，要么补回真正的 I/O 逻辑。
- 依赖注入让两个函数的签名多了一个参数，调用方必须记得传——不传时 `readBytes`
  默认返回 null（参考图全部记为 missing），是安全的降级但会静默。
- 这次没有新增任何业务能力，纯结构调整；测试数不变（IR 260 / gateway 32 /
  pipeline 150 / web 1352）。
