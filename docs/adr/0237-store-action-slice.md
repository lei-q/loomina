# ADR-0237：工作台 store 按领域抽 action 切片（拆分第二步）

- 状态：已采纳
- 日期：2026-11-15
- 决策者：用户 + Claude
- 关联：H 组底座、ADR-0236、ADR-0188、ADR-0219

## 背景

ADR-0236 抽走了六个纯辅助函数，只减了 154 行（约 2%）。真正的量在 6000 行的
`create` 回调里——161 个 action 全部挤在同一个对象字面量里。

拆 action 的难点不在切分，在**每个 action 都要 `get()` 读最新状态、用 store 的 `set`
（它带阶段硬锁闸口）**。简单地把对象拆成几个文件，每个文件都得拿到同一份 `get` / `set`。

## 决定

1. **类型先行**：把 `WorkbenchState`（含 `Decision` / `StoryPatch` / `GenerateJob`）
   移到 `workbench-types.ts`。切片文件只 import 类型，不 import store 实现——
   否则形成循环。`workbench-store.ts` 用 `import type` + `export type` 转出去，
   保持对外的导入路径不变（30 个文件引它）。
2. **切片写成工厂函数**：`workspaceActions({ get, set }, stamp)` 返回该领域的动作对象，
   store 在 `return ({ ...workspaceActions(...), ... })` 里展开。
   这样切片拿到的是**同一份** `get` / `set`，阶段硬锁闸口不会被绕过。
3. **切片自带返回类型**：`WorkspaceActions = Pick<WorkbenchState, ...>`，
   签名与主接口逐字一致；少写一个 action 或多写一个都会在类型层报错。
4. **第一批只拆 workspace 组**：`refreshWorkspaces` / `createWorkspace` /
   `renameWorkspace` / `archiveWorkspace` / `deleteWorkspace` / `exportWorkspace` /
   `deleteArchivedWorkspaces` 七个。它们只碰「本机登记表 + 各空间日志」，
   与项目内容无关，是最独立的一组。
5. **`bootstrap` 与 `registerWorkspace` 一并移到 helpers**：
   两者都被切片与主 store 共用，留在 store 里会让切片反向依赖。

## 理由

- **工厂函数是这个规模的正确形状**：不用引入 zustand 的 slice 模式（那要改
  `create` 的调用方式与所有 action 的签名），工厂函数只是「把一段对象字面量挪出去」，
  行为零变化、测试全绿。
- **类型先行是必须的**：没有独立的 `WorkbenchState`，切片文件只能 `import` store，
  而 store 又要 `import` 切片——循环。先把类型摘出去，循环就不存在了。
- **先拆最独立的一组**：workspace 组不读项目内容、不写事件、不调模型，
  拆错的代价最小。验证模式可行之后再拆更大的组。

## 后果

**正面**

- `workbench-store.ts` 从 7956 降到 **6690** 行（−1266，约 16%）。
- 建立了可复用的拆分模式：类型文件 + 工厂切片 + Pick 返回类型。
- 七个工作空间动作第一次有了独立文件，职责边界清楚。
- 测试全过（IR 260 / gateway 32 / pipeline 158 / web 1465），行为零变化。

**负面 / 代价**

- **文件总数增加了**：现在 store 相关有四个文件（store / types / helpers / 一个切片），
  跳转比单文件多一次。
- 切片仍依赖 store 的 `stamp`（时间戳严格递增），通过参数传进来而不是自己造。
- **还有 154 个 action 在 store 里**，最大的几块（keyframe / script / cast）还没拆。
  它们读项目内容、写事件，耦合比 workspace 组深得多。
- `workbench-types.ts` 948 行，本身也是个不小的文件；将来可能还要按领域再分。
