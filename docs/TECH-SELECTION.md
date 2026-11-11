# 技术选型

> 本文回答：选型按什么标准、推荐什么、为什么、备选是什么、什么时候该换。
> 状态：**建议稿**。定稿需补 ADR；当前只有 ADR-0010（工作流引擎分阶段）是已定决策。

---

## 一、选型原则（按优先级）

1. **一个人能维护**。运维面越小越好；能托管就不自建。
2. **无聊技术优先**。Postgres、Redis、FFmpeg、S3、Docker 这种"十年不变"的东西。
3. **同语言优先**。以 TypeScript 为主，Python 只用于 ML，避免第三种语言。
4. **接口隔离，可替换**。模型、队列、存储都通过接口访问，框架可换、数据不丢。
5. **数据模型稳定 > 框架先进**。IR 是资产，框架是耗材。
6. **先单体，后拆分**。模块化单体起步，边界清晰即可，不为了"架构感"上微服务。
7. **可逆决策快做，不可逆决策慢做**（见下节）。

## 二、可逆 vs 不可逆（把时间花对地方）

| 类型 | 决策 | 特点 | 投入 |
| --- | --- | --- | --- |
| **不可逆** | IR 数据模型、存储格式、租户模型、认证体系、模型输出的资产归属 | 改一次要迁移全量数据 | 慢、慎重、写 ADR |
| **较难逆** | 渲染链路（FFmpeg filter graph）、工作流引擎、发布包格式 | 改一次要重写管线 | 中 |
| **可逆** | UI 框架、状态库、ORM、队列实现、CSS 方案 | 换掉即可 | 快、别纠结 |

> 当前最该花时间的是 **IR**（[DATA-MODEL.md](DATA-MODEL.md)）。

## 三、推荐仓库结构（pnpm workspace）

```
loomina/
├─ apps/
│  ├─ web/            # Next.js：编辑器 + 营销页
│  ├─ api/            # Fastify：REST + SSE
│  ├─ worker/         # Node：任务执行、渲染调度
│  └─ ml/             # FastAPI：TTS / 对齐 / 视觉 QA
├─ packages/
│  ├─ ir/             # Zod schema、迁移、类型
│  ├─ prompt/         # 摄影参数 → 提示词编译器
│  ├─ gateway/        # 模型适配器 + 能力矩阵
│  ├─ workflow/       # 状态机、任务定义、预算护栏
│  └─ ui/             # 共享组件
└─ infra/             # docker-compose、部署脚本
```

**三个进程 + 一个 ML 服务**是上限。不要再拆。

## 四、技术栈总表

| 层 | 推荐 | 理由 | 备选 | 置信度 |
| --- | --- | --- | --- | --- |
| 前端框架 | Next.js（App Router）+ React + TS | 路由/构建/SSR 一体，生态最大 | Vite + React Router | 高 |
| UI | Tailwind CSS + shadcn/ui | 快、可改、无障碍基础好 | Ant Design（更"后台"） | 高 |
| 客户端状态 | Zustand + TanStack Query | 简单、无模板代码 | Redux Toolkit | 高 |
| 表单/校验 | React Hook Form + Zod | 与 IR 共用 schema | — | 高 |
| 时间线画布 | PixiJS v8 | 2D 合成性能好，WebGPU 支持 | Konva / 原生 Canvas | 中高 |
| 视频预览 | WebCodecs + mp4box.js + Web Audio | 帧级控制、低延迟 | `<video>` 多轨（不精确） | 中高 |
| 拖拽 | dnd-kit | 现代、可访问 | react-dnd | 高 |
| 后端 | Node + Fastify + TS | 轻、快、插件模型清晰 | NestJS（更重结构） | 高 |
| ORM | Drizzle + Postgres | 类型安全、贴近 SQL、迁移可控 | Prisma（更易用） | 中高 |
| 任务队列 | pg-boss（Postgres） | 事务内入队、少一个中间件 | BullMQ（Redis） | 中 |
| 工作流 | 显式状态机 + 任务表 | 单人可控、可调试 | Temporal / Restate | 中 |
| 实时进度 | SSE | 单向推送足够、比 WS 简单 | WebSocket | 高 |
| 认证 | Better Auth + 手机 OTP / 微信 | 框架无关、可自托管 | Auth.js / 自建 JWT | 中 |
| ML 服务 | FastAPI + Python | TTS/对齐/视觉生态在 Python | Node 调 CLI（不推荐） | 高 |
| 视频处理 | FFmpeg CLI | 成熟、可脚本化、可集群 | GStreamer / MLT | 高 |
| 字幕渲染 | libass（服务端）+ Canvas（预览） | 样式能力强、行业标准 | 纯 FFmpeg drawtext | 高 |
| 图片处理 | sharp | 快、稳定 | ImageMagick | 高 |
| 对象存储 | S3 兼容（OSS / COS） | 国内合规、CDN 成熟 | MinIO（本地） | 高 |

> **落地口径（H3 / ADR-0128，2026-11-11）**：先定边界再换实现。`AssetStore` 接口 + `LOOMINA_ASSET_STORE=local|s3`；第一刀 `LocalAssetStore` 零依赖（`.loomina/assets/`，内容寻址，单文件 200 MB），立刻把素材从事件日志里拿出来。S3 适配器只做 SigV4 预签名 PUT / GET，**不引 `@aws-sdk/client-s3`**；签名自写（约 100 行）还是用 `aws4`（约 3 KB）需单独确认。
>
> **H3.1 已落地（2026-11-12）**：`apps/web/lib/asset-uri.ts`（纯函数，浏览器与 Node 共用）+ `apps/web/lib/asset-store.ts`（`LocalAssetStore`，`LOOMINA_ASSET_DIR` 可覆盖目录，测试用）。`audio/webm` 落 `.weba`，让扩展名能唯一反推 mime。生成路径按 128 KB 分流，导出前 `hydrateView()` 读回字节。S3 仍未做。
| 数据库 | Postgres（托管） | JSONB 适合 IR，生态成熟 | — | 高 |
| 缓存 | Redis（托管） | 限流/会话/缓存 | — | 高 |
| 日志/追踪 | Pino + OpenTelemetry | 结构化、可观测 | — | 中高 |
| 错误监控 | Sentry（或自托管 GlitchTip） | 定位快 | 阿里云 ARMS | 中 |
| 测试 | Vitest + Playwright | 快、前端生态 | Jest | 高 |
| 部署 | Docker Compose + 单台 ECS | 单人可运维 | K8s（暂不） | 高 |
| CI | GitHub Actions / GitLab CI | 托管、够用 | Gitee CI | 中高 |

## 五、六个关键取舍

### 1. Web 优先，还是桌面客户端？

**选 Web 优先，架构预留 Tauri 外壳。**

- C 端获客不能有安装门槛；Web 更新即时。
- 重活（渲染、视频生成）本来就在云端，浏览器只做预览与编辑。
- 风险：WebCodecs/WebGPU 兼容性与大文件处理。用 540p 代理 + 降级到 `<video>` 兜底。

> **落地口径（E7 / ADR-0127，2026-11-11）**：分三级。**E7.1 时间轴预览零依赖**（`<video>` + Canvas，到镜准确、镜内近似）；**E7.2 帧级找点需要 mp4box.js（约 100 KB，MIT，依赖待确认）**，WebCodecs 是平台 API 不算依赖；**E7.3 WebGPU 合成暂不做**——当前时间线只有硬切，Canvas 2D 够用，等 E1 支持转场时再与 B13.3 的 depth 渲染一起选型。上表「WebCodecs + WebGPU」的选型意向仍然成立，只是分阶段落地。
>
> **落地口径（B13.1 / ADR-0126，2026-11-12）**：俯视走位板**没有引入任何 3D 依赖**——平面图是手写 SVG（`apps/web/components/blocking-board.tsx`，约 330 行），几何运算全是 `Math.hypot` / 叉积级别的纯函数（`packages/ir/src/geometry.ts`），视锥按焦段算水平视角（9:16 竖幅、短边 9.6 mm 估）。Three.js / WebGL 只在 **B13.3 depth / edge 导出**时才需要，仍待确认（R48）；那之前不引入。
- 若后期预览性能不够，用 **Tauri** 包一层（复用同一套 Web 代码）；不选 Electron（体积/内存大）。

### 2. 单体还是微服务？

**模块化单体。** 三个进程（web/api/worker）+ 一个 ML 服务已经是上限。

- 单人维护不起服务网格、消息总线、分布式追踪的复杂度。
- 边界靠包（packages/*）而不是网络。

### 3. Temporal 还是 pg-boss？

**Phase 1 用 pg-boss + 显式状态机；Phase 2 再评估 Temporal / Restate。**

- Temporal 能力最强，但自托管重（Cassandra/Postgres + 多服务），Cloud 在国内可用性不确定；单人运维成本高。
- pg-boss 与 Postgres 同库，**可以在业务事务里原子入队**，这对"创建镜头 + 派发任务"很关键。
- 用 `JobRunner` 接口隔离，未来可迁移（ADR-0010）。
- 若流程复杂到状态机难以维护，再上 Restate（单二进制、持久化执行）或 Temporal。

### 4. Project IR 存 JSONB 还是关系表？

**JSONB 文档 + 事件日志 + 周期快照。**

- IR 会频繁演进，关系表每次加字段都要迁移，成本高。
- JSONB 便于整棵树读写、版本回滚；事件日志天然支持撤销。
- 查询用投影表/索引（如按 user_id、project_id、status）。
- 边界用 Zod 校验，防止脏数据（ADR-0011）。

### 5. 客户端预览还是服务端渲染？

**混合：预览在端（代理分辨率），定稿在云（全质量）。**

- 端侧实时性 + 云端一致性，兼顾体验与成片质量。
- 必须统一色彩管理（Rec.709），否则"预览好看、导出发灰"（L7）。

### 6. Next.js 全栈还是独立 API？

**独立 API。** Next 只做前端与营销页。

- 长任务、SSE、Webhook、文件上传更适合独立服务。
- 未来移动端/第三方接入直接复用 API。
- 避免 Next 的 API 路由承担业务核心。

## 六、框架清单（按层）

**前端**：Next.js、React、TypeScript、Tailwind、shadcn/ui、Zustand、TanStack Query、Zod、React Hook Form、dnd-kit、PixiJS、mp4box.js、WebCodecs、Web Audio API。

**后端**：Node、Fastify、Drizzle、pg-boss、Pino、OpenTelemetry、Better Auth、SSE。

**ML**：FastAPI、WhisperX（对齐）、Paraformer（中文 ASR 备选）、CosyVoice/IndexTTS（TTS 自托管备选）、InsightFace（人脸一致性）、Pydantic。

**媒体**：FFmpeg、libass、sharp、OpenTimelineIO（Python）、LUT (.cube)。

**基础设施**：Postgres、Redis、OSS/COS、CDN、Docker Compose、Caddy/Nginx、GitHub Actions。

**可选（不是核心）**：Remotion（片头/字幕动效）、pgvector（素材相似度）、Three.js（走位板 3D 化）。

## 七、明确暂不引入

| 技术 | 暂不引入的原因 |
| --- | --- |
| Kubernetes | 单人运维不划算，Docker Compose 足够 |
| Kafka / 消息总线 | 没有高吞吐事件场景，pg-boss 够 |
| GraphQL | REST + 类型化客户端足够，增加复杂度 |
| 微服务拆分 | 模块化单体优先 |
| 纯事件溯源（完整 CQRS） | 只做事件日志，不做完整 CQRS |
| 向量数据库 | 早期用 pgvector 即可 |
| ffmpeg.wasm（客户端转码） | 慢且内存高，预览不需要转码 |

## 八、一步一步落地（按风险退休，不按功能堆叠）

> 原则：**先验证假设，再写 UI**。每一步都有明确的退出条件。

| 步骤 | 周期 | 做什么 | 验证什么假设 | 退出条件 |
| --- | --- | --- | --- | --- |
| S0 契约层 | 1–2 周 | Zod IR、迁移框架、网关接口、状态机、提示词编译器契约 | 数据模型是否够用、边界是否清楚 | 项目 JSON 可往返、单测全绿 |
| S1 能力测绘 | 1 周 | 逐个模型测：时长/分辨率/首尾帧/参考图/运镜/并发/延迟/单价/**商用条款** | 模型真实边界与成本 | 能力矩阵文档 |
| S1.5 3D 最小版 | 2–3 周 | 灰盒场景板：场景模板、自动摆位、机位视锥、轴线检查、depth 导出 | 3D 能否支撑空间一致性 | 一个场景的可视化机位 |
| S2 Animatic 闭环 | 2–3 周 | 硬编码剧本 → TTS → 关键帧 → 静态图+音频合成 animatic | 低成本能否看出故事/节奏问题 | 一条 60s animatic |
| S3 单镜质量 | 3–4 周 | 关键帧 → 图生视频 → 多 Take → QA（人脸 embedding + VLM）→ 重试 | 一致性阈值与重试成本 | 5 个镜头验收通过 + 指标 |
| S4 前端骨架 | 3–4 周 | 登录、项目、剧本编辑、故事圣经、资产库、闸门 1 | C 端是否能在 UI 内完成到 animatic | UI 产出 animatic |
| S5 时间线与渲染 | 3–4 周 | 时间线、自动初剪、字幕、混音、导出 | 预览与成片的差距 | 导出 MP4 |
| S6 发布包 | 1–2 周 | 封面、标题、话题、规格校验、分享 | 发布流程是否顺畅 | 发布包可用 |
| S7 自动化与打磨 | 持续 | 剧本医生、摄影面板、语义编辑、模板 | 留存与效率 | 指标改善 |

合计约 **16–22 周**（单人全职）。比原来的 12–16 周更保守，因为补了能力测绘、Animatic 与 3D 最小版。

### 这里有个反直觉的建议

**S0–S3 不要在 UI 上投入。** 先用脚本和命令行把契约、能力、Animatic、单镜质量跑通。

理由：这四步验证的是**不可逆或高成本**的东西（IR、一致性、成本）。如果先做 UI，一旦数据模型或一致性方案要改，前端全部返工。

## 九、待验证清单

- [ ] 视频模型的首尾帧能力、最大时长、运镜参数化的真实差异
- [ ] 各模型的**商用授权条款**（能否用于商业短剧）
- [ ] 人脸 embedding 作为一致性指标的准确率与阈值
- [ ] WebCodecs 在目标浏览器（Chrome/Safari/Edge）的多轨预览性能
- [ ] pg-boss 在生成任务量下的可靠性（重试、幂等、积压）
- [ ] FFmpeg filter graph 对 9:16/字幕/LUT/混音的组合能力
- [ ] 单条 60s 的真实成本区间（含重试与 QA）
