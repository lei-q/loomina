# ADR-0103：表演设计、视线与调度进 IR；场景模板做成轻量预设

- 状态：已采纳
- 日期：2026-11-11
- 关联：B15、B16、B17、B18、B13、ADR-0016、ADR-0019、ADR-0063、ADR-0096、ADR-0100

## 背景

PERFORMANCE.md 已经把表演拆成可检查的结构：一镜一个 objective、一个情绪转折、起转落三段微动作、显式 `GazeTarget`。SCENE-TEMPLATES.md 也列出了 6 个 MVP 场景与 4 个 v1 场景。但 IR 里一直没有这些字段：

- 提示词只能写"她很难过"，模型回一个模糊的中性脸；
- 没有人知道角色在看谁，视线在画面里飘；
- 同一场戏每镜重新想象空间与光线，剪辑点上接不上；
- 分镜检查无法回答"哪些镜头还没设计表演"。

原计划依赖 3D 灰盒（B13）做自动摆位与越轴检测，但 B13 已明确留到 Phase 1。这一轮不引入几何引擎，只把**结构化的表演与调度、以及能进提示词的场景预设**落进 IR 与 UI。

## 决策

### 1. `Shot.performance`：可选的 `PerformanceSpec`

```ts
interface PerformanceSpec {
  objective: string;               // 一镜只能一个
  emotion: { surface: string; subtext: string };
  beats: ActionBeat[];             // 最多 3 条：起 / 转 / 落
  gaze: GazeTarget;                // 有 performance 就必填
  intensity: 1 | 2 | 3 | 4 | 5;    // 默认 3
  avoid: string[];
}

interface ActionBeat {
  phase: "before" | "during" | "after";
  micro: string;                   // 微表情
  body: string;                    // 姿态 / 手
  action?: string;
  startMs: number;
  endMs: number;                   // 不早于 startMs
}

interface GazeTarget {
  target: "character" | "prop" | "camera" | "off-screen";
  targetId?: ID;                   // 看人 / 看道具必填，看镜头 / 画外禁止
  direction: "left" | "right" | "up" | "down" | "center";
}
```

`PerformanceSpec` 嵌在 `Shot` 上，不再重复 `shotId`——镜头本身就是它的宿主。schema 里是可选字段，而不是必填：

- 存量项目没有表演设计，回放不能被判废；
- 提示词在没有设计时保持原样，不凭空补情绪；
- 新建 / 编辑通过 UI 写入，落库前由 zod 补默认值并校验。

### 2. 起转落与首尾帧对齐

- `before` 对应首帧（起势），`after` 对应尾帧（收势），`during` 是镜头中段；
- 生成首帧时提示词只写 `before` 那一拍，生成尾帧只写 `after`；视频提示词写全部三拍；
- 没有对应 phase 时退到数组第一条 / 最后一条；三拍都空就完全不写。

这条把 PERFORMANCE.md 不变量 24（首尾帧与起止一致）变成可执行行为，而不是只写在文档里。

### 3. `Shot.staging`：镜头内调度

```ts
interface StagingMark {
  characterId?: ID;                // 与 propId 二选一
  propId?: ID;
  side: "left" | "center" | "right";
  depth: "foreground" | "midground" | "background";
  note: string;                    // 背对门、手攥着杯子……
}
```

默认空数组。提示词写成人话：`调度：林晚在画面左（前景），背对门；搪瓷杯在画面右（后景）`。左右与前后就是关系，比"面对面坐着"这种形容词稳定。

### 4. 一次保存，两条（或一条）事件

- `setShotPerformance(shotId, performance | undefined)` → `shot.updated { performance }`；
- `setShotStaging(shotId, staging)` → `shot.updated { staging }`；
- 值没变不写；锁定 / 只读拒绝；视线指向不在这部片里的角色或道具时拒绝；
- 调度只能挂当前镜出场名单里的角色 / 道具，同一对象只能一条；
- `applyEvent` 对两个字段做 zod 校验并把默认值补进事件结果，保证回放与实时状态一致。

UI 一次「保存到这一镜」可能写两条事件（表演 + 调度），这是有意的：两者是独立的可编辑对象，回放时也各自可读。

### 5. 场景模板：10 个轻量预设，不做几何

`packages/pipeline/src/scene-templates.ts` 落下 SCENE-TEMPLATES.md 的清单：

```ts
interface SceneTemplate {
  id: string;
  name: string;
  category: "interior" | "exterior";
  dimensions: [number, number, number];
  anchors: string[];
  cameras: { label: string; focalMm: number }[];
  lighting: string;
  tags: string[];
  plots: string[];
}
```

- MVP 6 个：`living-room`、`bedroom`、`office`、`elevator`、`street`、`cafe`；
- v1 4 个：`hospital-corridor`、`car-interior`、`rooftop`、`classroom`；
- 模板通过 `Location.templateId` 挂载，主镜与镜头提示词追加一句 `场景：走廊（公寓客厅模板（窗光 + 顶灯；4300K；光比 3:1；关键位置：…））`；
- 旧 id（`corridor` / `doorway` / `table` / `door`）继续可用，只是没有模板提示；`apartment-living` 作为别名映射到 `living-room`；
- 定妆台的地点编辑表单分两组列出模板，并在选模板 / 展示地点时显示尺寸、光线与默认机位。

不做 3D 位置、自动摆位、越轴检测与 depth 导出——这些仍归 B13。

### 6. 分镜检查新增 V10，但**不阻断生成**

V10 把「没有 performance 或 objective 为空」的镜头列成 warning，并数给顶栏「表演」按钮。明确取舍：

- PERFORMANCE.md 原写「每个 Shot 必须有 PerformanceSpec，GazeTarget 缺失不得进入生成」；
- 这一轮不硬拦：存量项目（包括示例片与真实生成片）没有该字段，硬拦会让整条片子无法续做；单人 MVP 的闸门一直是"提示而不锁死"；
- 因此不变量 21 / 22 当前落在**结构校验 + 检查提示**，而不是生成守卫。等新项目全部经由表演面板创建、或补一轮迁移后，再把生成守卫打开。

这是对 PERFORMANCE.md 不变量的一次有意降级，理由与恢复条件都写在这里。

### 7. UI

- 顶栏新增「表演」按钮（带未设计镜头数），打开右侧「表演与调度」抽屉；
- 抽屉内：objective、表面情绪 / 潜台词、视线对象 + 对象 + 方向、强度、起转落（微表情 / 姿态）、避讳、每个出场人物 / 道具的左右 × 前后 + 备注；
- 保存后底部立即显示更新过的视频提示词，方便当场核对；
- 定妆台地点行与编辑表单显示模板说明。

## 理由

- 表演与调度是**创作数据**，不是界面状态：必须进 IR 与事件日志，才能回放、导出、被下游提示词读取。
- 结构化字段比形容词稳定：`gaze = 看人 + 周野 + 向右` 不会每镜重新理解。
- 首尾帧各取一拍，把"表演"拆成模型能稳定生成的单元（ADR-0019 的路线）。
- 场景模板先做"提示词预设"：不引入 3D 几何也能让空间、主光、锚点跨镜头一致，且不用等 B13。
- 模板数据放在 pipeline，UI 与提示词共用一份，避免两处定义漂移。
- 事件校验 + 默认值归一，保证实时状态与回放状态逐字段一致。

## 后果

**正面**

- 表演设计、视线、调度都能在 UI 里写，写入后视频 / 首帧 / 尾帧提示词当场变化；浏览器实测 s-03 保存后提示词出现「调度：…」「表演：目的：…；视线：看人林，向右」「这一帧的表演：起：…」。
- 首帧只带起、尾帧只带落，起转落不再混在一句里。
- 10 个场景模板可在定妆台选择，选择后地点行显示尺寸 / 光线 / 机位；提示词带模板说明。
- 分镜检查能点出未设计的镜头；顶栏「表演」显示 12 个待补。
- 测试 629 全过（IR 137 + gateway 28 + pipeline 36 + web 428），`pnpm typecheck` 与 `next build` 全过。

**负面**

- 不变量 21 / 22 暂未硬拦生成，未设计的镜头仍能出片；V10 只是提示。
- 调度只有左右 × 前后 + 一句话，没有真实坐标、轴线与遮挡判断，越轴仍要人眼。
- 场景模板的默认机位只显示在说明里，不会自动改 `Shot.camera` 或生成机位建议。
- 一次保存可能写两条事件；撤销需要两条一起回退（F2 多步撤销仍待做）。
- 模板 `dimensions` 目前只用于说明与提示词，不参与任何几何计算。

## 备选方案

| 方案 | 不采用的原因 |
| --- | --- |
| 把 `PerformanceSpec` 设为 Shot 必填 | 存量项目与示例回放全部判废；生成链路会被直接锁死 |
| `GazeTarget` 缺失时直接拒绝生成 | 同上；等迁移与全量补设计后再开（见决策 6） |
| 用一段自由文本 `performanceDescription` | 不可校验、不可检查，也拼不出首尾帧差异 |
| 把演出节拍存进 DialogueLine | 表演属于镜头，不属于某一句台词；多人同镜时更说不清 |
| 等 B13 3D 做完再落这些字段 | 表演与视线不依赖几何，先落结构能立刻改善提示词与检查 |
| 场景模板做成 3D 灰盒 + 自动摆位 | B13 明确留到 Phase 1，这一轮引入几何引擎会拖慢主线 |
| 模板数据放在 web 组件里 | 提示词在 pipeline 侧也要用，两份数据必然漂移 |
| 每次编辑立即写事件（无保存按钮） | 逐字输入会刷出大量事件；显式保存更适合这类多字段表单 |
