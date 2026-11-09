# 项目工作约定（给 AI 助手）

本项目是《织光机 Loomina》——一个 AI 短剧创作平台。单人（C 端、国内首发）开发。

## 开始任何工作前先读

1. [`docs/README.md`](docs/README.md) —— 文档协议与索引
2. [`docs/PRINCIPLES.md`](docs/PRINCIPLES.md) —— 准则（不变量）

## 记录优先（硬性要求）

这个项目把"讨论留痕"当作准则。任何一次实质性讨论结束后，必须把结论落到文档：

| 变更类型 | 写到哪 |
| --- | --- |
| 架构 / 技术选型 / 重大产品决策 | `docs/adr/` 新建一条 ADR（编号递增，不删不改历史） |
| 准则（不变量）变化 | 先改 `docs/PRINCIPLES.md`，并补一条 ADR |
| 功能增删、优先级调整 | `docs/FEATURES.md` |
| 风险识别 / 缓解 | `docs/RISKS.md` |
| 每次讨论本身 | `docs/DISCUSSIONS.md` 追加一条（绝对日期） |
| 路线 / 阶段调整 | `docs/ROADMAP.md` |
| 数据模型变化 | `docs/DATA-MODEL.md` |

## 约束

- 不得违反 `docs/PRINCIPLES.md`；确需违背时，先开 ADR 说明理由。
- 文档用中文，代码标识符用英文；日期一律用绝对日期（如 2026-11-09）。
- ADR 不删除、不重写历史；状态改为「已废弃 / 被 ADR-XXXX 取代」。
- 未经确认，不引入重型依赖或自建基础设施。
- 功能实现前，先在 `docs/FEATURES.md` 有对应条目（有 ID、优先级、状态）。
