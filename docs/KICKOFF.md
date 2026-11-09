# 第一行代码：从契约开始

> 核心判断：第一行代码不是界面，不是生成，是**契约**。
> 先把 Project IR 写成可编译、可校验、可回放的东西；其余一切都是它的派生物。

---

## 一、为什么先写契约

1. **IR 是唯一事实来源（P2）**。它错了，后面全错；它稳了，换模型、换 UI 都不伤筋动骨。
2. **单人开发，返工最贵。** 先写 UI 再改数据模型，等于把前端重写一遍。
3. **模型会换（P8）**，契约不会。今天接 Seedance，明天接别家，业务代码不该动。
4. **第一天就能测试。** 不需要 API key、不需要账号、不需要花钱。
5. **先跑通"数据形状"，再跑通"调用"。** 这两件事的失败原因完全不同，混在一起查不动。

---

## 二、第一个仓库结构

```text
loomina/
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── packages/
│   ├── ir/                  # 纯数据：schema + types + invariants
│   │   ├── src/
│   │   │   ├── schema.ts    # zod schema
│   │   │   ├── types.ts     # z.infer 导出
│   │   │   ├── invariants.ts
│   │   │   └── index.ts
│   │   ├── test/
│   │   └── package.json
│   ├── gateway/             # 模型适配器（先 Fake）
│   └── pipeline/            # 编排与状态机
├── examples/
│   └── minimal.json
└── docs/
```

**依赖方向是单向的：**

```
ir  ←  gateway  ←  pipeline
```

- `ir` 不依赖任何东西，没有 IO、没有网络、没有数据库。
- `gateway` 只依赖 `ir`。
- `pipeline` 依赖两者。

这条线破了，后面一定会乱。

---

## 三、第一天写的五个文件

不多不少，就这五个：

1. `pnpm-workspace.yaml`
2. `tsconfig.base.json`
3. `packages/ir/src/schema.ts` —— 先定义 5 个实体
4. `packages/ir/src/invariants.ts` —— 先实现 10 条不变量
5. `packages/ir/test/schema.test.ts` —— 3 个测试

**为什么用 zod**：同语言、运行时校验、类型自动推导、无聊技术（TECH-SELECTION 的选型原则）。不引入 ORM、不引入 GraphQL、不引入状态库。

---

## 四、第一批 schema 只做 5 个实体

```ts
// packages/ir/src/schema.ts
import { z } from "zod";

export const Id = z.string().min(1);

export const CharacterSchema = z.object({
  id: Id,
  name: z.string(),
  appearance: z.string(),
  voiceProfileId: Id.optional(),
});

export const DialogueLineSchema = z.object({
  id: Id,
  characterId: Id,
  text: z.string(),
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
});

export const ShotSchema = z.object({
  id: Id,
  sceneId: Id,
  index: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  shotSize: z.enum(["wide", "medium", "close", "extreme-close"]),
  camera: z.object({
    angle: z.enum(["eye", "low", "high", "top"]),
    movement: z.enum(["static", "push", "pull", "pan", "tilt", "handheld"]),
    focalMm: z.number().positive(),
  }),
  characterIds: z.array(Id),
  dialogueIds: z.array(Id),
});

export const SceneSchema = z.object({
  id: Id,
  index: z.number().int().nonnegative(),
  locationId: Id,
  shotIds: z.array(Id),
});

export const ProjectSchema = z.object({
  id: Id,
  title: z.string(),
  version: z.number().int().nonnegative(),
  characters: z.array(CharacterSchema),
  scenes: z.array(SceneSchema),
  shots: z.array(ShotSchema),
  dialogue: z.array(DialogueLineSchema),
});

export type Project = z.infer<typeof ProjectSchema>;
```

**先不做全部实体。** 等这条链路跑通，再按需加 Beat、CameraPlacement、PerformanceSpec、PublishPackage。

判断标准：**没有它，最小链路跑不起来，才加。**

---

## 五、不变量先做 10 条

从 DATA-MODEL 的 40 条里挑"错了会静默产生废片"的 10 条：

| # | 不变量 |
| --- | --- |
| 1 | 所有生成物都有 provenance |
| 2 | Shot 引用的 characterIds 必须存在于 characters |
| 3 | Shot 时长与对白音频一致（超阈值警告） |
| 4 | 用户改过的字幕不被自动流程覆盖 |
| 5 | Timeline 引用的 take 必须属于该 shot |
| 6 | 发布包必须携带 AILabel |
| 7 | 被引用的资产只能软删除 |
| 8 | 单镜时长不得超过模型上限 |
| 9 | SceneState 与同场镜头走位一致 |
| 10 | 锁定资产不得被自动流程覆盖 |

不变量不是"校验函数"，是**产品规则的可执行形式**。每一条都要有对应的失败测试。

---

## 六、Fake Adapter：让链路先跑起来

在接真模型之前，先写假适配器：

```ts
// packages/gateway/src/types.ts
export interface ImageAdapter {
  generate(input: ImageInput): Promise<ImageOutput>;
}

export interface VideoAdapter {
  submit(input: VideoInput): Promise<{ jobId: string }>;
  poll(jobId: string): Promise<VideoJob>;
  fetch(jobId: string): Promise<VideoOutput>;
}
```

`FakeImageAdapter` 返回 `examples/fixtures/frame.png`，`FakeVideoAdapter` 返回一段 2 秒本地样片。

**为什么这一步不能省：**

- 不烧钱就能测完整链路；
- 没有网络抖动、限流、排队，测试稳定；
- 接口先定下来，之后接真模型只是换实现，业务代码不动（P8 的落地）；
- 能提前发现"契约不够用"——这是 S0 唯一要验证的东西。

### S0 的验收动作

一条命令，从 `examples/minimal.json` 出发：

```
读 IR → 校验不变量 → 调 Fake 生成 2 张关键帧 → 调 Fake 生成 2 段视频
→ 写回 IR（带 provenance）→ 写成本记账 → 输出结果
```

跑通它，就证明契约能承载一条最小生产链路。

---

## 七、事件日志第一版

按 ADR-0011，IR 用"事件日志 + 定期快照"。第一版只需要：

```
events.jsonl    ← append-only，每行一个事件
rebuild.ts      ← 从事件重放出 Project
snapshot.json   ← 每 N 个事件写一次
```

不做 CRDT、不做 OTIO、不做多人协作。**先把"可回放"这件事做对**，因为它决定了撤销、审计、并发的地基。

---

## 八、S0 完成的定义

缺一不可：

- [ ] `pnpm test` 全绿
- [ ] `examples/minimal.json` 通过全部不变量
- [ ] 篡改任意一条不变量，测试必须失败（反向测试）
- [ ] Fake 链路能产出 2 张图 + 2 段视频，并写回 IR
- [ ] `rebuild(events)` 的结果与快照一致
- [ ] 没有 UI、没有数据库、没有真模型、没有 API key

---

## 九、第一周日程（示意）

| 天 | 做什么 |
| --- | --- |
| D1 | workspace + tsconfig + 空包 |
| D2 | 5 个 schema + 类型导出 |
| D3 | 10 条不变量 + 正向测试 |
| D4 | minimal.json + 反向测试 |
| D5 | Fake 网关 + 最小链路 |
| D6 | 事件日志 + rebuild |
| D7 | 复盘：契约哪里不够用，记进 docs |

---

## 十、明确不做

第一周严格不碰：

- ❌ UI / 设计系统
- ❌ 登录 / 支付 / 用户系统
- ❌ 真模型 API
- ❌ Postgres / Redis
- ❌ 3D / Three.js
- ❌ OTIO / 时间线
- ❌ 部署 / CI/CD

**每加一个依赖，都要能说出"为什么是现在"。** 说不出来，就不加。

---

## 十一、什么时候引入下一层

| 层 | 时机 | 触发条件 |
| --- | --- | --- |
| Postgres + Drizzle | S1 | 项目数 > 1，或需要并发 |
| 真模型适配器 | S1 | 契约稳定，Fake 链路跑通 |
| 3D 灰盒 | S1.5 | 分镜需要空间校验 |
| Web 前端 | S4 | Animatic 闭环在脚本里跑通 |
| OTIO | S5 | 需要与外部工具交换时间线 |

**顺序不能反。** 每一层都是被下一层的真实需求"拉"出来的，不是提前"推"进去的。

---

## 十二、第一条命令

```bash
pnpm install
pnpm --filter @loomina/ir test
```

期望输出：`3 passed`。

这就是项目的第一个可验证状态。

---

## 十三、与 AI 协作的约定

- 每次实质性改动，先改 `docs/`，再改代码（P12）。
- 每个提交对应一个 Feature ID（如 `A11: Beat 分析`）。
- 先写失败的测试，再写实现。
- `packages/ir` 保持纯函数、无副作用、无 IO。
- 任何"为了快先这样"的临时方案，必须写进代码注释并登记为待办。

---

## 十四、一句话

**第一行代码不是 `npm create next-app`，是 `export const ProjectSchema = z.object({...})`。**

先把"一条片子长什么样"定义清楚，再让它动起来。
