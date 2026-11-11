# ADR-0126：灰盒场景板先做「俯视走位板」，depth 导出等确认依赖

- 日期：2026-11-11
- 状态：已采纳
- 关联：B13、B11、B15、B17、A13、E7、ADR-0013、ADR-0016、ADR-0103、R41

## 背景

ADR-0013 决定引入 3D 灰盒场景板，ADR-0016 把它放进 MVP，但限定「最小版」：模板、自动摆位、机位视锥、轴线检查、depth 导出。SCENE-TEMPLATES.md §六 给了 6 条验收标准。

实际落地的是 B15 的**轻量预设**（ADR-0103）：10 个模板提供尺寸、可读锚点、默认机位名与光线描述，全部只进提示词。没有坐标、没有几何、没有视锥、没有越轴检测、没有 depth 导出。

于是 A13 的 V3「轴线」只能用 B17 的左右调度做近似，ADR-0108 与 R41 都如实写着「只提示『像』越轴」。

现在的关键问题是：**最小版到底最小到什么程度，以及要不要引入 3D 库。**

CLAUDE.md 有一条硬约束：**未经确认，不引入重型依赖或自建基础设施**。Three.js（约 600 KB）或 Babylon.js 都属于重型依赖，不能在设计里默认带上。

## 决策

### 1. B13 分三刀，第一刀不引入任何 3D 依赖

| 刀 | 内容 | 依赖 |
| --- | --- | --- |
| **B13.1 俯视走位板** | 真实坐标进 IR、自动摆位、平面视锥、轴线检查 | 无（SVG） |
| **B13.2 立面与遮挡** | 相机高度、人物朝向、前后景遮挡关系 | 无（仍是 2D 投影） |
| **B13.3 depth / edge 导出** | 渲染结构参考图给关键帧 | **需 WebGL / Three.js，待确认** |

第一刀做完，SCENE-TEMPLATES.md §六 里 6 条验收有 3 条能过（自动摆位 < 1s、3 个合法机位建议、越轴检测）；depth / edge 与「拖动后自动重校验」留到后两刀。

**depth 导出不随第一刀做**，因为它必须真实渲染几何体，而平面 SVG 画不出 depth。这一刀要引入 WebGL 渲染器，按 CLAUDE.md 必须先确认。第一刀把坐标、机位、朝向都准备好，等依赖确认后 depth 只是「读同一份数据、换一个渲染器」。

### 2. 坐标进 IR，单位统一为米、右手系、Y 向上

```ts
export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

/** 场景坐标（B13）：地点自己的局部坐标系，原点在房间中心地面 */
export const LocationSpaceSchema = z.object({
  /** 宽 × 深 × 高（米），来自模板或作者手填 */
  dimensions: Vec3Schema,
  /** 锚点：门、窗、桌…；id 稳定，模板切换时按 id 保留 */
  anchors: z.array(
    z.object({
      id: Id,
      kind: z.enum(["door", "window", "furniture", "prop", "light", "mirror", "wall"]),
      position: Vec3Schema,
      /** 绕 Y 轴朝向，弧度 */
      facingRad: z.number().default(0),
      /** 可站 / 坐人数；0 表示不可承载 */
      capacity: z.number().int().nonnegative().default(0),
    }),
  ).default([]),
});

/** 一镜的走位（B13）：谁在哪、朝哪 */
export const BlockingSchema = z.object({
  /** 这一镜属于哪场；坐标是场地局部坐标 */
  actors: z.array(
    z.object({
      characterId: Id,
      position: Vec3Schema,
      facingRad: z.number(),
    }),
  ).default([]),
  props: z.array(z.object({ propId: Id, position: Vec3Schema })).default([]),
});
```

挂载位置：

- `Location.space?: LocationSpaceSchema`——场景的几何事实，换模板时按 `anchors[].id` 尽量保留作者改过的位置。
- `Shot.blocking?: BlockingSchema`——这一镜的走位，走 `shot.updated { blocking }`。
- `Shot.camera` 已有 `angle` / `movement` / `focalMm`。**新增** `placement?: { position: Vec3, target: Vec3 }`。有了它，`angle` 可以从几何推出（相机高度 vs 目标高度），但**第一版不自动改写 `angle`**：作者设的值是意图，几何只是执行。

事件：`location.updated` 的 patch 白名单要从 `name / templateId / description` 扩到加上 `space`；`Shot.blocking` 与 `Shot.camera.placement` 走既有的 `shot.updated`（它的 patch 是 `Partial<Shot>`，已经能写）。不新增事件类型。校验写在 `applyEvent`：

- 坐标必须落在 `dimensions` 内（留 0.1 m 容差）；越界直接拒绝，不悄悄夹取。
- `blocking.actors[].characterId` 必须是这一镜的出场人物（`shot.characterIds`）；不在场的人不能有走位。
- `placement.position` 与 `target` 不能重合。

### 3. 自动摆位是纯函数，规则直接抄 SCENE-TEMPLATES.md §五

```ts
suggestBlocking(project, sceneId): { blocking, cameras, axis } | { reason: string }
```

规则（§五 原文）：

1. 双人对白 → 对面或 90°；
2. 权力关系 → 桌后 / 桌前（读 `story.relationships` 的 tension 与角色的 `role`）；
3. 亲密 → 同侧或相邻；
4. 独处 → 偏一侧留负空间；
5. 入场走 `door` 锚点；
6. 主光方向优先取 `window`；
7. 给出 master / OTS A / OTS B 三个机位建议，默认全部在轴线同侧。

**只建议，不写事件。** 作者点「用这个摆位」才写 `shot.updated { blocking, camera: { placement } }`。理由与 ADR-0123 / 0125 一致：推断结果不能悄悄落进事实。

模板匹配靠 `Location.templateId`；没有模板或模板没有坐标时返回 `reason`，界面写「这个地点还没有几何，先在定妆页选一个场景模板」。

### 4. 轴线检查用真实坐标，替换 V3 的近似版

```ts
checkAxis(project, sceneId): { violations: { shotIds, axisId, message }[] }
```

- 轴线 = 本场**最主要一对角色**的连线（出场次数最多的两个人；平手时取首次出场顺序）。
- 每个机位在轴线的哪一侧，由 `placement.position` 相对轴线做叉积符号得出。
- 同场相邻两镜符号相反 = 越轴；换轴线（主要一对变了）不算。
- 与 ADR-0108 的 V3 并存：**有坐标时用精确版，没有坐标时退回调度近似版**，文案区分「越轴」与「像越轴」。

V3 从「启发式」升级成「有几何依据」，R41 的状态可以部分缓解，但**只有补过坐标的项目才享受**——存量项目仍是近似。

### 5. 界面：定妆页「空间」区 + 分镜页走位抽屉

- **定妆页地点行**：模板选定后，展开「空间」显示一个俯视平面图（SVG）：房间外框、锚点、出场人物（圆点 + 朝向箭头）、轴线（虚线）、三个机位建议（扇形视锥 + 焦段）。可拖人物圆点改位置，拖完写一条 `shot.updated { blocking }`（需要先选一镜）。
- **分镜页顶栏**「走位」抽屉：按场列出，每场一张平面图 + 这一场每一镜的机位标记（选中一镜高亮）。底部列出自动摆位建议与越轴结论，带「用这个摆位」。
- **平面图不是 3D 视图**：它是俯视图 + 视锥。界面上明确写「这是俯视走位图，不是最终画面」。ADR-0013 说过灰盒与成片差距要让人理解，这里同理——不假装它是 previs 渲染。

### 6. depth 导出：设计好接口，实现等依赖确认

```ts
// 接口先定，实现留空
export interface DepthExporter {
  render(space: LocationSpace, placement: CameraPlacement, size: { width; height }): Promise<Uint8Array>;
}
```

调用点设计成「有 exporter 就用，没有就跳过」，与 `videoAcceptsLastFrame` 的降级口径一致：能力不存在时不假装存在。

**不在本次实现。** 引入 Three.js 需要用户确认；ADR-0016 提到的「必要时用 Three.js + 离屏渲染」是当年的预案，不是已批准的依赖。

## 理由

- **第一刀不用 3D 库**：轴线、摆位、视锥在俯视图里全都能算，且都是纯数学。真正需要 3D 的只有 depth 导出与遮挡。先拿到 80% 的价值，不先背 600 KB 的依赖。
- **坐标进 IR**：ADR-0013 的整个承诺是「空间一致性不能靠提示词」，那空间就必须是可校验的数据。只存在组件里，越轴检查没法在服务端或测试里跑。
- **建议不落库**：自动摆位是启发式，落库后就变成「系统认为的正确走位」，作者改过的地方还会被下一次建议覆盖。
- **角度不自动改写**：`camera.angle` 是摄影意图（低机位=权力），从坐标反推只能得到几何事实，两者不等价。

## 后果

**正面**

- V3 越轴第一次有几何依据，不再只能说「像」。
- 空间成为可测试的数据：单测能直接断言「这个机位在轴线右侧」。
- 不引入任何新依赖就能交付第一刀。
- 模板切换时锚点按 id 保留作者改过的位置。

**负面**

- 存量项目没有坐标，仍走近似版 V3；两种口径并存需要文案区分。
- 俯视图看不到遮挡、相机高度与背景关系，作者可能误以为「平面图对了画面就对了」——界面必须写清。
- 自动摆位规则是经验值（对面 / 90° / 桌后），不一定符合每场戏的意图。
- depth 导出没有实现，关键帧仍缺结构条件。

**跟进**

- 引入 WebGL 渲染器前先确认依赖；确认后 B13.3 只做「读同一份数据、换渲染器」。
- B13.2 立面与遮挡：加相机高度、人物朝向、前后景，仍是 2D 投影。
- 坐标一旦稳定，B14 的 `spatial` 维度可以从「未测」变成可测。
- 3D 视图与 E7 实时预览有共用渲染需求，届时一并评估渲染层选型。

## 成本

| 项 | 估计 |
| --- | --- |
| 运行时 | 0 元（纯本地几何计算） |
| B13.1 工程 | schema + 事件 2 天；自动摆位 2 天；俯视 SVG 2 天；越轴精确版 1 天 |
| B13.3 工程 | 依赖确认后 3–5 天（含 depth 编码与关键帧接线） |
| 依赖 | B13.1 / B13.2 为 0；B13.3 待确认 |

## 验证（设计阶段口径）

- 单测：越界坐标被拒；不在场的人不能有走位；`placement` 两点重合被拒；自动摆位在客厅模板 2 人场景下 < 1 ms（纯函数，无 IO）；同一对角色相邻两镜机位分居轴线两侧时判为越轴，同侧不判；换主要角色对后不误报。
- 回归：没有坐标的项目仍走 ADR-0108 的近似 V3，文案是「像越轴」。
- 浏览器：定妆页选「公寓客厅」→ 展开空间图 → 分镜页走位抽屉 → 点「用这个摆位」→ 平面图出现人物与视锥 → 把某镜机位拖到轴线另一侧 → 检查抽屉出现 V3「越轴」。

## 备选方案

| 方案 | 不采用的原因 |
| --- | --- |
| 第一刀就上 Three.js 做真 3D | 重型依赖未经确认；轴线、摆位、视锥在俯视图里已经能算 |
| 坐标只存在组件里 | 服务端与测试都拿不到，「可校验」的承诺落空 |
| 自动摆位直接写事件 | 启发式结果落库后会被当成系统结论，下次建议还会覆盖作者的改动 |
| 从坐标自动改写 `camera.angle` | 角度是摄影意图，几何只能给出事实，两者不等价 |
| 越界坐标悄悄夹取到边界 | 作者以为放对了，实际位置被改过；宁可拒绝并报错 |
| 把俯视图叫「预演」 | 它没有相机高度与遮挡，叫预演会让作者以为看到的就是画面 |
| 先做 depth 导出再做走位 | depth 依赖 3D 渲染器，而走位不依赖任何东西，顺序应该反过来 |
