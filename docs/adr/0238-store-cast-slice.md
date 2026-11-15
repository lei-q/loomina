# ADR-0238：抽出生成核心与定妆台切片（store 拆分第三步）

- 状态：已采纳
- 日期：2026-11-15
- 决策者：用户 + Claude
- 关联：H 组底座、ADR-0236、ADR-0237

## 背景

ADR-0237 验证了「类型文件 + 工厂切片 + Pick 返回类型」的模式，拆掉了 workspace 组七个动作。
下一个目标是 cast 组，但它比 workspace 组复杂：**会花钱**。

cast 组的动作要经过两道闸：`lockedStage`（阶段硬锁的第二道闸，花钱前先问）
与 `generateOne`（出一张图并落 `asset.updated`）。这两个函数原来都在 store 里，
切片拿不到。

## 决定

1. **先把生成核心抽成 `workbench-generate.ts`**：`lockedStage` + `generateOne`。
   它们只用到 5 个 store 字段（`project` / `events` / `jobs` / `imageCny` / `reuseCache`），
   收 `Store`（get / set）参数即可，不需要别的。
2. **`generateOne` 多收一个 `stamp` 参数**：时间戳必须严格递增（同一毫秒里的两次操作
   不能被当成一组），而 `stamp` 的计数器状态在 store 里。传进来而不是复制一份。
3. **顺带把五个纯辅助函数移到 helpers**：`withPromptOverride` / `promptKeyOf` /
   `referenceImagesOf` / `clipReason` / `referenceNotice`——它们只吃参数。
4. **cast 切片只收四个动作**：`lockCast` / `unlockCast` / `generateSheet` / `generateMaster`。
   `restoreSheetAsset` 与 `generateKeyframe` 等留在 store——它们属于关键帧域，
   与「定妆」不是同一件事。
5. **切片共用同一份闸口**：`castActions` 里调的是 `workbench-generate.ts` 导出的
   `lockedStage` / `generateOne`，与主 store 完全同一份实现——不会出现「切片绕过硬锁」。

## 理由

- **先抽被依赖的，再抽依赖它的**：cast 切片依赖生成核心，所以生成核心先走。
  反过来做就要在切片里临时复制一份 `generateOne`，那正是要避免的分叉。
- **`stamp` 传参而不是导出**：时间戳的严格递增靠一个模块级计数器，
  复制一份会让切片与主 store 各自计数、同毫秒的两条事件被分成两组，
  撤销时就不能整组退。
- **只收四个动作**：切片的边界按**领域**划，不按「相邻代码」划。
  `restoreSheetAsset` 虽然紧挨着 `generateMaster`，但它做的是「把定妆照换回旧版」，
  属于关键帧 / 版本域。

## 后果

**正面**

- `workbench-store.ts` 从 6690 降到 **6248** 行（本轮累计 7956 → 6248，−21%）。
- 生成核心第一次独立成文件，`lockedStage` 与 `generateOne` 有了明确归属。
- cast 切片的动作与主 store 共用同一份闸口与生成实现，没有分叉风险。
- 测试全过（IR 260 / gateway 32 / pipeline 158 / web 1465），行为零变化。

**负面 / 代价**

- store 相关现在六个文件（store / types / helpers / generate / 两个切片）。
- 拆分过程中切错两次边界（`restoreSheetAsset`、`generateMaster` 先后被误切），
  靠类型检查发现并纠正——说明「按相邻代码切」很容易错，必须按领域核。
- 还剩约 150 个 action 在 store 里。
- **发现一个既有的测试隔离缺陷**：`workbench-store.test.ts` 里有几个用例依赖
  前面用例留下的状态，单独用 `-t` 过滤跑会失败。已在改动前后各验一次，
  确认与本次拆分无关。
