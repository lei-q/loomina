# ADR-0005 模型无关的网关层

- 状态：已接受
- 日期：2026-11-09
- 决策者：工程
- 关联：P8、H1、R14

## 背景

生成模型迭代极快（视频、图像、语音、音乐、ASR），供应商的接口、能力、价格、稳定性每月都在变。若业务直接依赖某家 SDK：

- 换模型要改业务代码；
- 某家故障/下线会导致产品不可用；
- 无法按成本/质量动态路由。

## 决策

所有模型调用经过**统一网关**，业务只依赖网关接口：

```ts
interface ModelGateway {
  submit(job: GenerationJob): Promise<JobHandle>;
  poll(handle: JobHandle): Promise<JobStatus>;
  cancel(handle: JobHandle): Promise<void>;
  estimateCost(job: GenerationJob): Promise<CostEstimate>;
  capabilities(): CapabilityMatrix;   // 首尾帧、时长、分辨率、并发
}
```

- 适配器按供应商实现，新增模型不改业务。
- 网关负责：路由（质量/成本/可用性）、降级、限流、重试、计量、结果缓存。
- `GenerationJob` 是**能力导向**的（"生成 5 秒、带首尾帧的视频"），不是供应商参数。

## 理由

- 模型是易耗品，产品能力是资产；不能让资产依赖易耗品。
- 多供应商是成本与稳定性的保险（R14）。
- 统一计量（H4）是商业化的前提。

## 后果

**正面**
- 换模型成本低，可以做 A/B 与灰度。
- 单点故障可降级。

**负面 / 代价**
- 抽象层会损失部分供应商特有能力；需要"透传参数"逃生口。
- 能力差异需要显式建模（如 `supportsLastFrame: boolean`）。

**跟进**
- 定义能力矩阵与"最低能力集"。
- 缓存键包含模型与参数，避免串味。

## 替代方案

- **直接用各家 SDK**：短期快，长期负债，否决。
- **只选一家、深度绑定**：稳定性与议价风险高，否决。
