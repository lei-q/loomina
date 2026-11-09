# 剧本 → 分镜：把"导演"做成约束求解

> 本文回答：剧本如何变成可生成、可剪辑、可验收的分镜。
> 核心判断：**分镜不是一次 LLM 调用，而是"创意选择 + 规则校验"的约束求解过程。**

---

## 一、本质：三层输出

一段剧本要变成分镜，必须同时产出三层信息：

| 层 | 内容 | 谁负责 |
| --- | --- | --- |
| **叙事层** | 这场戏在讲什么、每个镜头承担什么功能 | LLM（理解与选择） |
| **空间层** | 人在哪、朝哪、机位在哪、轴线在哪 | 3D 场景板 + 规则引擎 |
| **生成层** | 景别/焦段/运镜/光/时长/参考图/提示词 | 规则引擎 + 提示词编译器 |

只做生成层，会得到"画面漂亮但叙事混乱"；只做叙事层，会得到"故事对但没法拍"。

---

## 二、七步管线

```
① 场次与 Beat 分析
      │  把剧本拆成"情绪/信息发生变化"的最小单元
      ▼
② 覆盖率规划（Coverage）
      │  每个 Beat 选镜头组合：master / OTS / 特写 / 反应 / 插入
      ▼
③ 3D 走位（Blocking）
      │  人物位置、朝向、移动路径；确定动作轴线
      ▼
④ 机位与镜头（Camera）
      │  由走位和叙事意图推导机位、景别、焦段、运镜
      ▼
⑤ 时长与节奏（Timing）
      │  对白按音频时长；动作按复杂度；整体切率曲线
      ▼
⑥ 台词分配（Dialogue Mapping）
      │  每句台词落到具体镜头；长台词拆分
      ▼
⑦ 校验（Validation）
      │  轴线、覆盖率、时长、预算、模型能力
      ▼
   关键帧 → Animatic → 视频
```

每一步都可人工修改，修改后自动重跑下游校验（准则 P7）。

---

## 三、第 ① 步：Beat 分析

**Beat = 一次"信息或情绪的变化"**，不是按段落切。

短剧常用 Beat 类型：

| Beat | 作用 | 典型时长 |
| --- | --- | --- |
| hook | 3 秒内制造疑问/冲突 | 2–4s |
| setup | 交代人物/关系/空间 | 3–6s |
| inciting | 打破平衡的事件 | 4–8s |
| escalation | 冲突升级 | 5–15s |
| turn | 认知反转/权力翻转 | 3–6s |
| climax | 情绪最高点 | 5–10s |
| resolution | 收束 | 3–5s |
| endHook | 留钩子（下集/完播） | 2–4s |

输出：

```ts
interface Beat {
  id: ID;
  sceneId: ID;
  type: "hook" | "setup" | "inciting" | "escalation" | "turn" | "climax" | "resolution" | "endHook";
  summary: string;
  information: string;   // 观众必须知道什么
  emotion: string;       // 观众应该感到什么
  powerShift?: string;   // 权力关系如何变化
  startMs: number;
  endMs: number;
}
```

> 这一步最容易偷懒：直接把剧本按行切。必须让模型回答"这个 Beat 改变了什么"，否则分镜会变成"把台词配画面"。

---

## 四、第 ② 步：覆盖率规划

同一个 Beat 有多种拍法。覆盖率规划决定"用哪几个镜头把这个 Beat 讲清楚"。

### 常用覆盖率模板

| 场景类型 | 镜头序列 |
| --- | --- |
| 双人对话 | master → OTS A → OTS B → CU A → CU B → reaction → insert |
| 对峙/冲突 | CU A ↔ CU B 交替，时长递减 |
| 信息揭示 | wide → detail insert → reaction CU → push-in |
| 单人情绪 | medium → CU → ECU detail → wide（拉远收尾） |
| 动作 | wide → tracking → impact CU → reaction |
| 蒙太奇 | 4–8 个 insert，按音乐节拍切 |

### 规划原则

1. **每个 Beat 至少有一个"信息镜头"和一个"情绪镜头"**。
2. **先 master 后特写**：观众需要先知道空间，才能理解特写。
3. **反应镜头是短剧的灵魂**：观众看的是"另一个人怎么反应"。
4. **镜头数量服从预算**：规划时就估算成本，不是生成完才发现超支。
5. **不要连续三个同景别**：会显得平。

输出：

```ts
interface CoveragePlan {
  beatId: ID;
  pattern: string;          // "dialogue_2person" 等
  shots: PlannedShot[];
  estimatedCostCny: number;
}

interface PlannedShot {
  purpose: "establish" | "information" | "emotion" | "reaction" | "transition" | "hook";
  shotSize: CameraSpec["shotSize"];
  subject: ID[];            // 角色/道具
  estimatedDurationMs: number;
}
```

---

## 五、第 ③④ 步：3D 走位与机位

### 走位（Blocking）

在 3D 灰盒里确定：

- 人物位置（左/中/右、前景/背景）；
- 朝向（面向谁、面向镜头还是背向）；
- 移动路径（从哪到哪）；
- 道具位置；
- **动作轴线**（两人之间的假想连线）。

```ts
interface Blocking {
  sceneId: ID;
  beatId?: ID;
  actors: {
    characterId: ID;
    position: [number, number, number];
    facingRad: number;
    path?: [number, number, number][];
  }[];
  props: { propId: ID; position: [number, number, number] }[];
  axis: { from: [number, number, number]; to: [number, number, number] };
}
```

### 机位（Camera）

由走位 + 叙事意图推导：

- 机位必须在轴线同一侧（180 度规则）；
- 焦段决定"压缩感/空间感"：广角强调空间与不安，长焦强调人物与隔离；
- 机位高度决定权力关系：低机位压制，高机位脆弱；
- 运镜必须**在模型能力范围内**（能力矩阵里的 `cameraControl`）。

```ts
interface CameraPlacement {
  position: [number, number, number];
  target: [number, number, number];
  focalLengthMm: number;
  // 与 CameraSpec 合并后编译为提示词
}
```

> **3D 的价值不是好看，是把"轴线、空间、机位"变成可计算的东西。** 它让"越轴"从审美问题变成校验错误。

---

## 六、第 ⑤ 步：时长与节奏

### 对白镜头：音频先行

1. TTS 生成台词，得到精确时长；
2. 镜头时长 = 台词时长 + 呼吸空间（200–500ms）；
3. 长台词拆成多个镜头，不要一个镜头硬撑。

### 动作/空镜：按复杂度估

| 内容 | 默认时长 |
| --- | --- |
| 静态反应 | 1.5–2.5s |
| 普通动作 | 2–4s |
| 复杂动作/走位 | 3–5s |
| 空镜/氛围 | 2–4s |
| 片头钩子 | 2–3s |

### 节奏曲线

- 整体切率随 Beat 强度上升：铺垫慢、冲突快、高潮最快、结尾留白。
- 短剧不是"越快越好"：**该慢的地方慢下来，钩子才有力**。
- 单镜不超过模型安全上限（ADR-0012）。

---

## 七、第 ⑥ 步：台词分配

规则：

1. 每句台词必须有承载镜头（说话人在画内，或故意画外）。
2. 对话优先用 **OTS / 双人** 建立关系；情绪转折用 **CU / 反应**。
3. 长台词按语义断句拆镜，不要按字数机械切。
4. 关键台词给"干净"的镜头（少运镜、少遮挡）。
5. 画外音/旁白单独标记，不占画面表演。

---

## 八、第 ⑦ 步：校验规则

分镜生成后，必须通过一组**硬规则**，不通过则自动修正或提示：

| 编号 | 规则 | 处理 |
| --- | --- | --- |
| V1 | 每场至少一个 establishing/master | 自动补 |
| V2 | 每句台词有承载镜头 | 自动补反应镜 |
| V3 | 180 度轴线一致 | 标红，建议换机位或加过渡镜 |
| V4 | 单镜时长在模型安全区间 | 自动拆分/合并 |
| V5 | 每个 Beat 有信息镜头 + 情绪镜头 | 提示补镜 |
| V6 | 连续同景别 ≤ 2 | 建议替换 |
| V7 | 切率曲线与 Beat 强度相关 | 提示调整 |
| V8 | 总成本在预算内 | 降级或删减 |
| V9 | 运镜在模型能力内 | 替换为支持的能力 |
| V10 | 角色/道具引用存在且已锁定 | 阻断 |

输出：

```ts
interface ValidationReport {
  shotPlanId: ID;
  violations: {
    rule: string;
    severity: "error" | "warning";
    shotIds: ID[];
    message: string;
    suggestion?: string;
  }[];
  estimatedCostCny: number;
  estimatedDurationMs: number;
}
```

---

## 九、导演语法库（产品 IP）

这是"分镜好不好"的核心资产。它不是提示词，而是**可测试的规则 + 样例**。

### 叙事意图 → 镜头

| 意图 | 景别 | 机位 | 运镜 | 光 |
| --- | --- | --- | --- | --- |
| 建立空间 | wide / extreme-wide | eye | static / pan | 环境光，低对比 |
| 信息揭示 | close / insert | eye / high | push-in | 局部光，高对比 |
| 权力压制 | medium-close | low | static / slow push | 硬光、顶光 |
| 脆弱 | close | high | slow push | 柔光、冷调 |
| 对峙 | close（交替） | eye | static | 侧光、高光比 |
| 疏离 | wide | eye | static | 负空间、冷调 |
| 记忆 | medium | eye | slow motion | 暖调、柔焦 |
| 紧迫 | medium | eye / handheld | handheld / track | 高对比、动态光 |

### 景别语义

- **大远景/远景**：空间、孤立、规模；人物渺小。
- **全景**：交代人物与环境关系。
- **中景**：对话、关系、动作。
- **近景**：情绪、亲密。
- **特写/大特写**：细节、强度、心理。

### 运镜语义

- **推**：发现、逼近、压力。
- **拉**：抽离、揭示环境、孤独。
- **摇/移**：跟随、连接空间。
- **手持**：紧迫、真实、不安。
- **固定**：控制、形式感、压迫。

> 这张表要版本化、可扩展、可被用户覆盖。它是"摄影语言可量化"（P11）的落地。

---

## 十、一个 30 秒的例子

**场景**：电梯里，她遇到前男友。她手里拿着一把旧伞——他当年送的。

| # | Beat | 景别 | 机位 | 运镜 | 时长 | 内容 | 目的 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | hook | 大特写 | eye | 固定 | 2s | 手指攥紧伞柄 | 悬念 |
| 2 | hook | 中景 | eye | 固定 | 3s | 她抬头，电梯门合上 | 建立 |
| 3 | turn | 过肩 | eye | 固定 | 3s | 他走进来，站在她侧后 | 信息 |
| 4 | escalation | 近景 | eye | 缓推 | 2s | 她的眼睛 | 情绪 |
| 5 | information | 大特写 | 俯 | 固定 | 2s | 两只手：她空着的无名指，他的婚戒 | 信息 |
| 6 | escalation | 中近景 | 低 | 固定 | 5s | 他："好久不见。" | 权力 |
| 7 | turn | 近景 | eye | 固定 | 3s | 她别过脸 | 情绪 |
| 8 | endHook | 全景 | eye | 固定 | 4s | 门开，她走出去，伞留在电梯里 | 余味 |

**3D 板**：电梯 2×2m；她在左前，他在右后；轴线从她指向他；所有机位在轴线同一侧（第 6 镜低机位也不越轴）。

**校验**：V1 有 establish（#2）；V2 台词 #6 有承载；V3 轴线一致；V4 时长在区间；V5 每 Beat 有信息+情绪；V8 预算 8 镜可接受。

---

## 十一、失败模式

| 失败 | 表现 | 原因 | 对策 |
| --- | --- | --- | --- |
| 全是中景 | 画面单调、没有节奏 | LLM 倾向安全选项 | 覆盖率模板 + 景别轮换校验 |
| 过度切碎 | 观众看不懂空间 | 每句台词都切 | master 优先 + 轴线校验 |
| 轴线乱 | 人物左右关系跳变 | 没有空间模型 | 3D 板 + V3 |
| 长台词硬撑 | 镜头过长、模型漂移 | 没做音频先行 | 按音频时长拆镜 |
| 运镜做不到 | 生成结果与分镜不符 | 没查模型能力 | 能力矩阵 + V9 |
| 预算爆炸 | 镜头数过多 | 规划不算成本 | CoveragePlan 带成本估算 |
| 分镜没有目的 | 漂亮但没用 | 没有 Beat 分析 | 每镜必须有 purpose |
| 台词画面不对位 | 说话人不在画内/反应错 | 台词分配随意 | V2 + 对话模板 |

---

## 十二、与 IR 的映射

| 概念 | IR |
| --- | --- |
| Beat | `Beat`（新增） |
| 覆盖率方案 | `CoveragePlan`（新增） |
| 走位 | `Blocking`（新增） |
| 机位 | `CameraPlacement`（新增） |
| 校验结果 | `ValidationReport`（新增） |
| 镜头目的 | `Shot.purpose`（新增） |
| 镜头 | `Shot` / `CameraSpec` / `LightingSpec` |
| 连续性 | `SceneState` / `ContinuityEntry` |

> 这些结构都进 Project IR，意味着"分镜方案"是可保存、可对比、可回滚的，而不是一次性的 LLM 输出。
