# ADR-0228：评测集补齐 should 规则，12 条全覆盖（I9 第二档）

- 状态：已采纳
- 日期：2026-11-14
- 决策者：用户 + Claude
- 关联：I9、I8、ADR-0216、ADR-0224、DIRECTOR-GRAMMAR.md §十一

## 背景

ADR-0224 的评测集只覆盖 6 条 must 规则。should 规则虽然不拦导出，但方向写反会让
作者被误报淹没——「狼来了」几次之后，整张检查表就没人看了。

缺的六条是 V5（每拍信息 + 情绪）、V7（切率曲线）、V8（预算）、V9（尾帧能力）、
V10（表演设计）、V12（立面与遮挡）。其中 V8 / V9 需要 `analyzeStoryboard` 的外部参数
（报价、模型是否收尾帧），原来的 `EvalCase` 没有传 options 的口子。

## 决定

1. **`EvalCase` 增加 `options?: StoryboardOptions`**，`runCase` 透传。
   V8 用 `requoteCny` / `budgetCny`，V9 用 `videoAcceptsLastFrame`。
2. **六条 should 规则各配一正一反**，合计 12 条新用例。
3. **报告增加 `optionalMissing`**：should / may 里还没有用例的规则单独列，
   不阻塞（`rulesMissing` 只管 must），但会在 CLI 输出里点名。
4. **用例构造要避开无关规则**：`V5-positive` 第一次写就失败了，原因是
   **首镜恒为 `purpose: "hook"`**，钩子拍因此缺信息镜——补一个非首镜的全景
   （推断为 `establish` → information）才凑出「信息 + 情绪」。

## 理由

- **should 也要验方向**：误报的代价不是「拦错了」，是「作者不再相信检查结果」。
- **options 进用例而不是另开一个套件**：V8 / V9 的判定逻辑与其他规则在同一个函数里，
  分开写会让「一次跑全」这个性质消失。
- **`optionalMissing` 与 `rulesMissing` 分开**：must 缺用例是缺陷，should 缺用例
  只是覆盖不足。混在一起会让「必须补」和「有空再补」失去区分。

## 后果

**正面**

- **12 条规则全覆盖**：`rulesMissing` 与 `optionalMissing` 都是空。
- CLI 输出从「覆盖 6 条」变成「覆盖 12 条」，违规率与景别熵可在全规则口径下对比。
- 补用例过程中发现「首镜目的恒为 hook」这个隐含约束，记在 ADR 里供以后写用例参考。

**负面 / 代价**

- 用例从 12 条涨到 24 条，`pnpm eval:rules` 稍慢（仍在秒级）。
- 每个用例仍只验「方向」，不验阈值；V7 的「3.5 秒」「1.6 倍」这类数字没有标定。
- 用例项目都是构造的小样本，V12 的几何用例只覆盖「书架正好挡在视线上」这一种情形。
