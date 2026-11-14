# ADR-0203：`project.created` 的快照一律按 ProjectSchema 解析

- 状态：已采纳
- 日期：2026-11-14
- 决策者：用户 + Claude
- 关联：P2、F1、F6、F3、ADR-0011、ADR-0034、ADR-0088、ADR-0154、ADR-0180

## 背景

定妆页报 `Cannot read properties of undefined (reading 'filter')`：
`rightsReport` 里 `project.authorizations` 是 `undefined`（`apps/web/lib/rights.ts:69`）。

`ProjectSchema` 给 `authorizations` / `skills` / `timeline.sfx` / `timeline.mix` 等
都配了 zod 默认值，但它们只在 **parse 的时候**生效。而回放路径上：

1. `applyEvent` 对 `project.created` 只做深拷贝（`clone(event.project)`），
   快照里缺什么，回放出来的 Project 就缺什么；
2. `parseEvents` 读日志时只补**第一条** `project.created` 的快照；
3. 日志里完全可能有第二条 `project.created`——「从故事草稿开工」（ADR-0088）、
   「逐字导入开工」（ADR-0154）、「用模板开工」（ADR-0180）都是在日志**末尾**
   再写一条引导事件，旧日志不删。

于是任何一条末尾快照少写字段（早期代码写的、手工修的、外部导入的），
都会把半份 Project 原样送进读模型，页面上第一个 `.authorizations.filter`
就白屏。缺的还不止这一个字段——`skills`、`timeline.sfx`、`timeline.mix`、
`publishPackages`、`voiceTakes` 都是同一批「后加进 schema、靠 default 补」的字段。

## 决定

1. **`applyEvent` 的 `project.created` 分支改用 `ProjectSchema.parse(clone(event.project))`**：
   回放结果永远是完整 Project；default 字段补齐、坏字段当场抛错。
   `applyEvent` 不改写内存里的事件对象；是否有 `parseEvents` 把补齐后的快照
   写回事件数组，取决于调用方（读日志时写回，内存里直接回放时不写回）。
   无论哪条路径，写回 IndexedDB 的都只有新追加的事件，历史行不被重写。
2. **`parseEvents` 读日志时对每一条 `project.created` 都过 `ProjectSchema.parse`**
   （不只第一条），并写回规范快照到事件数组：`storyVersionsOf` 这类直接读事件数组的函数
   拿到的也是规范快照；末尾快照缺**必填**字段时整份日志照旧判废（宁可回示例项目，
   不跑坏项目——既有口径不动）。这个补齐只发生在读进来的副本上，
   `parseEvents` 不往 IndexedDB 写，历史的半份事件行原样保留。
3. **不在读模型里散补 `?.` / `?? []`**：半份 Project 不是合法状态，
   到处兜底会把「schema 漏了」掩盖成「某处少写了一个问号」。修复只落在
   IR 的回放入口与日志读入口两处。
4. 不升 `LOG_VERSION`：不改事件形状，不迁移数据；旧日志缺的 default
   由回放时补齐，读一遍就等于迁移过了。

## 理由

- **P2 的本义**：Project IR 是唯一事实来源，schema 是它的契约；
  「从日志回放出来的东西」却可以不合契约，等于契约只管了一半。
- **入口比出口便宜**：在 `applyEvent` 一处 parse，胜过在每个读模型里问
  「这个字段在吗」；读模型几十处，入口只有两个（回放、读日志）。
- **zod parse 的开销可以忽略**：`project.created` 是引导事件，一条日志里
  至多几条，且 parse 本身就承担了深拷贝（替代原来的 `clone`）。

## 后果

**正面**

- `rightsReport` / 授权面板 / 技能 / 时间线等所有消费方拿到的 Project 一定完整。
- 末尾 `project.created` 的半份快照不再白屏；缺必填字段时日志判废，
  行为与「第一条快照坏了」一致，可预期。
- 旧日志不用迁移，读一遍即补齐；补齐全在内存，磁盘上的历史行不动。

**负面 / 代价**

- `ProjectSchema.parse` 会丢弃 schema 不认识的字段：快照里夹带私货的旧日志，
  回放后私货没了（第一条快照本来就是这个口径，现在统一了）。
- 回放时抛错意味着「缺必填字段的末尾快照」整份日志判废、回示例项目——
  与既有取舍一致（ADR-0034 注释），但作者会看到日志「没了」，需要靠导出兜底。
- 每条 `project.created` 回放多一次 schema 校验；量级可忽略。

## 替代方案

- 在 `rightsReport` 等读模型里逐个 `?? []`：治标，且半份 Project 会继续
  在别处爆（`rights-panel` 的 `.length`、store 的 `.some` 都在等）。
- 读日志时整份重写（把补齐后的快照写回 IndexedDB）：一次迁移到位，
  但写盘副作用大、与「日志只追加」的口径冲突，不做。
