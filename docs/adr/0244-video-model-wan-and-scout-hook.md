# ADR-0244：视频模型换成 wan3.0-video-unfiltered，并把地图注入每轮会话

- 状态：已采纳
- 日期：2026-11-15
- 决策者：用户 + Claude
- 关联：B3、H6、G8、ADR-0242、ADR-0243

## 一、视频模型：wan3.0-video 不可用，同系列 unfiltered 可用

用户指定默认视频模型用 `wan3.0-video`。实测结果：

| 模型 | 结果 |
| --- | --- |
| `wan3.0-video` | **403** `GROUP_ROUTING_FAILED`（未授权分组） |
| `wan3.0-video-prime` | 403 同上 |
| `wan3.0-video-unfiltered` | **200**，正常建立任务 |
| `wan3.0-video-prime-unfiltered` | 200 |
| `seedance-2.0` / `seedance-2-5` | 200 |
| `minimax-h3` | 200（原先在用） |
| `seedance-unfiltered` | 400 |

用户确认改用 `wan3.0-video-unfiltered`。

### 决定

1. `VIDEO_MODEL=wan3.0-video-unfiltered`，`SEED_MODELS.video` 同步。
2. 价目表补上 `wan3.0-video-unfiltered` 的三档分辨率，价格按同系列 `wan3.0-video` 取
   （480p ¥0.3/s、720p ¥0.6/s、1080p ¥1.2/s）。
3. **`unfiltered` 的含义要说清楚**：供应商侧不做内容过滤。项目的 H6 内容安全
   （17 条规则）与 G8 合规预检仍在**生成前**拦提示词，不依赖供应商兜底——
   但供应商不再有一道额外过滤，这一点写进 RISKS。

### 验证

`pnpm probe:s1 --shots 1 --budget 5 --text-only` → **通过 1/1，100.8 秒，¥2.40**。
价目表能算出价格（原先 `minimax-h3 @ 720p` 不在表里，只能记「未知成本」）。

## 二、scout 地图注入每轮会话

### 问题

此前地图**不会**自动进入上下文。查清了四条路径：

1. SessionStart hook 只说「本项目有地图」，**不注入内容**；
2. `/scout:scout` 注入的是 skill 说明，不是地图；
3. 手动跑 `scout check` / `status` / `context` 只打印摘要；
4. 直接 Read `.scout/modules.yaml`。

而 git 的 `post-commit` 钩子（`scout hook install` 装的）只在**提交后**跑检查，
与会话无关。所以「每轮带地图」一直没有实现。

### 决定

在 `.claude/settings.json` 加 **`UserPromptSubmit`** hook：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command",
        "command": "cd /Users/lay/VscodeProject/loomina && /Users/lay/.nvm/versions/node/v24.12.0/bin/scout context --brief 2>/dev/null || true" }] }
    ]
  }
}
```

- 用 `--brief`：28 行，模块 / 概念归属 / 关键流程三块，够用且不占太多上下文；
- **绝对路径**：hook 的工作目录不保证是仓库根；
- `|| true`：scout 不在 PATH 时不让 hook 失败挡住对话。

### 验证

模拟 hook 执行（`sh -c` 跑同一条命令）：输出 28 行，含模块树、业务概念归属与三条关键流程。

### 代价

- 每轮多 28 行上下文（约 1.5k token）。
- 地图改动后，下一轮才生效（hook 在用户提交 prompt 时读文件，不缓存）。
