# 文档协议与索引

> 这份文件定义"我们怎么记录讨论"。所有文档都以它为准。

## 一、为什么这样记

长期讨论最大的敌人不是想不出，而是**忘了当初为什么这么定**。所以：

- **准则**（不变量）单独放，改动成本最高；
- **决策**用 ADR 编号管理，历史不可改写；
- **功能**用 ID + 优先级 + 状态管理，避免口头需求蒸发；
- **风险**登记成表，定期回看；
- **每次讨论**追加一条记录，形成时间线。

## 二、文档地图

| 文件 | 作用 | 变更方式 |
| --- | --- | --- |
| [`PRINCIPLES.md`](PRINCIPLES.md) | 准则 / 不变量。违背需 ADR | 改条目需新增 ADR |
| [`PRODUCT.md`](PRODUCT.md) | 定位、用户、市场、差异化、品牌、成功指标 | 直接更新，重大变化补 ADR |
| [`OPERATIONS.md`](OPERATIONS.md) | 端到端运转、闸门、闭环、阻塞、业务/技术难点 | 直接更新 |
| [`FEATURES.md`](FEATURES.md) | 功能清单（ID / 优先级 / 阶段 / 状态） | 直接更新 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 系统架构、分层、技术选型、管线 | 重大变化补 ADR |
| [`TECH-SELECTION.md`](TECH-SELECTION.md) | 选型原则、推荐栈、取舍、落地顺序 | 定稿后补 ADR |
| [`CONSISTENCY.md`](CONSISTENCY.md) | 一致性的 8 个维度、5 层防线、指标与修复 | 直接更新 |
| [`STORY.md`](STORY.md) | 短剧物理定律、题材矩阵、故事引擎 8 步、剧本医生、原创性 | 直接更新 |
| [`STORYBOARD.md`](STORYBOARD.md) | 剧本→分镜的 7 步管线、导演语法库、校验规则 | 直接更新 |
| [`PERFORMANCE.md`](PERFORMANCE.md) | 表演五层次、表演节拍、关键帧表演法、镜头内调度、表演 QA | 直接更新 |
| [`SOUND.md`](SOUND.md) | 声音四层、配音表演参数、音乐情绪曲线、混音与响度、声音 QA | 直接更新 |
| [`PUBLISHING.md`](PUBLISHING.md) | 三层发布能力、平台规格、AI 标识、内容安全、授权链 | 直接更新 |
| [`COST.md`](COST.md) | 成本结构、有效通过率、双档渲染、重试经济学、点数计费 | 直接更新 |
| [`UX.md`](UX.md) | 双形态、六阶段向导、闸门组件、参数四层披露、移动端伴侣 | 直接更新 |
| [`KICKOFF.md`](KICKOFF.md) | 第一行代码：仓库结构、首批 schema、假适配器、S0 验收 | 直接更新 |
| [`DIRECTOR-GRAMMAR.md`](DIRECTOR-GRAMMAR.md) | 首批 37 条导演规则、覆盖率模板、评测方法 | 规则库独立版本化 |
| [`RULE-EVOLUTION.md`](RULE-EVOLUTION.md) | 规则的自动发现、触发阈值、晋升门槛、防膨胀 | 直接更新 |
| [`SCENE-TEMPLATES.md`](SCENE-TEMPLATES.md) | 3D 灰盒场景模板（6 + 4）、数据结构、自动摆位 | 直接更新 |
| [`DATA-MODEL.md`](DATA-MODEL.md) | Project IR 数据结构（唯一事实来源） | 直接更新，破坏性变化补 ADR |
| [`ROADMAP.md`](ROADMAP.md) | 分期路线、验收标准、明确砍掉什么 | 直接更新 |
| [`RISKS.md`](RISKS.md) | 风险登记表 | 直接更新 |
| [`DISCUSSIONS.md`](DISCUSSIONS.md) | 每次讨论的时间线记录 | 只追加 |
| [`adr/`](adr/) | 架构决策记录，一条决策一个文件 | 只新增 / 改状态 |

## 三、ADR 格式

每条 ADR 一个文件：`docs/adr/NNNN-短标题.md`。必含：

```markdown
# ADR-NNNN 标题

- 状态：提议 | 已接受 | 已废弃 | 被 ADR-XXXX 取代
- 日期：YYYY-MM-DD
- 决策者：
- 关联：P1、F1.2 等

## 背景
## 决策
## 理由
## 后果（正面 / 负面 / 跟进）
## 替代方案
```

## 四、功能 ID 规则

- 模块前缀：`A` 故事、`B` 视觉、`C` 音频、`D` 字幕、`E` 剪辑、`F` 项目、`G` 发布、`H` 底座、`I` 摄影语言。
- 形如 `B3`，子项 `B3.1`。
- 优先级：`P0` MVP 必须、`P1` v1 必须、`P2` 后续、`P3` 候选。
- 状态：`待设计` / `设计中` / `开发中` / `已完成` / `暂缓` / `已砍`。

## 五、一次讨论的标准收尾流程

1. 在 `DISCUSSIONS.md` 追加：日期、议题、结论、待定事项。
2. 有新决策 → 新建 ADR；改了旧决策 → 旧 ADR 标"被取代"。
3. 更新 `FEATURES.md` 的条目与优先级。
4. 新风险 → 更新 `RISKS.md`。
5. 只有以上都完成，才开始写代码。

## 六、约定

- 日期一律绝对日期，不用"上周""最近"。
- 不删除历史结论；错了就标"已废弃"并说明原因。
- 文档中的"必须/不得"是准则级要求，"建议/优先"是偏好。
