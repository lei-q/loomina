# ADR-0236：工作台 store 的纯辅助函数先抽出去（拆分第一步）

- 状态：已采纳
- 日期：2026-11-14
- 决策者：用户 + Claude
- 关联：H 组底座、ADR-0188、ADR-0219

## 背景

`apps/web/lib/workbench-store.ts` 是 7956 行、161 个 action、215 个接口项的单文件，
也是所有子模块的依赖枢纽。它是 M4 类问题的根源：任何模块想读一个状态字段，
都要把整个 store 拉进来。

拆分前先量了内部结构：

| 区段 | 行数 |
| --- | --- |
| imports + 模块注释 | 335 |
| 接口定义（`type WorkbenchState`） | 1420 |
| 顶层辅助函数 | 约 560 |
| **`create` 回调（全部 action 实现）** | **约 6000** |
| 持久化 `subscribe` | 29 |

## 决定

**第一步只抽纯函数，不动 action。**

抽到 `apps/web/lib/workbench-helpers.ts` 的六个函数：

| 函数 | 为什么是纯的 |
| --- | --- |
| `restack` | 吃 `TimelineItem[]`，吐重排后的数组 |
| `canonicalSpeakerColors` | 吃配色对象，吐规范形状 |
| `nextOpenShotId` | 吃 `Project` 与当前 id，吐下一个待定镜 |
| `isLocked` | 吃 `Project` 与目标，吐布尔 |
| `appendOnly` | 吃两个事件数组，吐布尔 |
| `removalUndoEvents` | 吃删除前后两份 `Project`，吐补偿事件 |

它们都不碰 `get` / `set`、不读盘、不调模型。

**没有抽的（明确留下）**：

- `generateOne` / `commitDialogue` / `lockedStage` 等吃 `Store`（`get` / `set`）的函数——
  抽出去要连带搬 `WorkbenchState` 与一堆本地类型，会形成循环导入；
- 161 个 action 本身。

## 理由

- **纯函数是最安全的第一刀**：行为只依赖参数，抽出去后原有测试全部照跑，
  新增 11 条直接测这些函数（以前只能通过 store 间接覆盖）。
- **先量再拆**：原本以为 `set` 是 519 行的巨型实现，实际它是接口声明之后的
  辅助函数区。量清楚才知道该从哪里切。
- **不追求一次拆完**：6000 行的 action 区要按领域拆，得先解决「每个 action 都要
  `get()` 读最新状态」这个问题（要么注入、要么改成切片），那是另一个量级的改动。
  这一步先把能安全切的切掉，剩下的留给下一轮。

## 后果

**正面**

- store 从 7956 降到 7802 行，六个纯函数有了独立的测试文件（+11 条）。
- 建立了一个可复用的拆分模式：纯函数先走，副作用后走。
- 顺带暴露了两个隐含约束，写进了测试：
  - `canonicalSpeakerColors` 排序是为了「语义相同的两份输入规范后逐字节相同」；
  - `appendOnly` 按**引用**比较（日志整份换掉时，同位置的新对象也不算追加）。

**负面 / 代价**

- **只减了 154 行**，约占 2%。真正的量在 action 区，这一步不解决它。
- 抽出去的函数仍然依赖 `toStageView`（`web.logic`），所以 `workbench-helpers`
  不能进 `web.logic` 本身——它留在 `web.state`。
- `removalUndoEvents` 依赖 `RemovalKind`（在 `read-model.ts`），跨文件引类型。
- action 区的拆分仍未开始，`workbench-store.ts` 依然是枢纽。
