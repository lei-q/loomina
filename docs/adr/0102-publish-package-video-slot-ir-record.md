# ADR-0102：发布包带上成片信息，并记进 IR 的 `publishPackages`

- 状态：已采纳
- 日期：2026-11-11
- 关联：G1、H13、G7、G8、ADR-0086、ADR-0095、ADR-0101、R38

## 背景

G1 第一版把发布包做成了纯清单：平台、标题、简介、话题、封面、字幕、镜头清单、`warnings` 与合规证据都在，唯独视频位固定写 `null`——因为当时还没有可靠的成片文件可引用。`FEATURES` 也如实写着「还不写回 IR 的 `publishPackages`」。

H13 之后成片有了明确的草稿 / 定稿文件，成片页也拿到了文件名与字节数。继续把视频位写死为 `null`，发布包就无法回答「这一包对应哪一版成片」；不写回 IR，发布历史只存在于下载到磁盘的 JSON 里，换浏览器或回放事件日志就查不到。

约束：

- 视频二进制不进事件日志：几分钟的 MP4 可以是几十 MB，塞进 JSON 会让 IndexedDB 与回放都难受（H3 对象存储暂缓）。
- IR 里的发布记录要能解释「发了什么、哪一版、什么时候」，但不能冒充一个不存在的资产 id。
- 发布记录只追加，不覆盖：同一版改过标题再发一次，是两条历史。
- AI 标识仍是发布包的硬字段，缺了就不能写进 IR。

## 决策

### 1. 发布包 JSON 的 `video` 槽：有就写，没有就 `null`

```ts
video: {
  fileName: string;
  bytes: number;
  quality: "draft" | "final";
  renderedAt: string;
} | null;
```

成片页记住最近一次成功导出的结果（`lastRender`），打发布包时传进去。没导出过就仍是 `null`，`videoNote` 写明「先在成片页导出一次 MP4」，并在 `warnings` 里加一条「还没有导出过成片 MP4：发布包的视频位是空的」。`kind` 取最近一次成片的档位，而不是当前下拉选中的档位——包与文件必须对得上。

发布包仍然不内嵌二进制：它描述文件，不搬运文件。

### 2. IR：`PublishPackageSchema` 放宽视频引用，补发布元数据

```ts
interface PublishPackage {
  id: ID;
  platform: string;
  videoAssetId?: ID;       // 只有真的存成资产时才写
  quality?: "draft" | "final";
  fileName?: string;
  bytes?: number;          // 非负整数
  recordedAt?: string;
  aiLabel?: AILabel;
}
```

`videoAssetId` 从必填改为可选：当前渲染结果直接下载到本机，没有落成 `Asset`，编一个 id 会让 IR 指向不存在的东西。等 H3 对象存储落地再接资产引用。

### 3. 事件 `publish.recorded`：只追加

```ts
{ type: "publish.recorded"; at: string; package: PublishPackage }
```

applyEvent 校验：必须已有项目、发布包 id 唯一、`platform` 非空、`aiLabel.explicit` 与 `aiLabel.implicit` 都为 true、`bytes` 是非负整数；通过后追加到 `publishPackages`，不覆盖旧记录。事件类型同时登记进 `apps/web/lib/event-log.ts` 的 `EVENT_TYPES`，否则回读时整份日志会判废（`dialogue.updated` 的旧教训）。

### 4. 写回时机：点「导出发布包」时

成片页的 `exportPackage` 先构建 JSON 并下载，再调用 `recordPublish({ platform, quality, fileName, bytes })` 写一条事件；只读标签页返回 false，提示「项目是只读的，这次没有记进发布记录」。

发布记录只存元数据（平台、档位、文件名、字节数、时间、AI 标识），不存字幕全文、标题、简介或话题——这些已经在下载的 JSON 里，进 IR 只会让事件日志膨胀。

导出区下方显示「这一版成片：文件名 · 大小 · 档位」与「项目发布记录（已有 n 份）」，让写回结果当场可见。

### 5. 明确不做的部分

- 不把 MP4 二进制存进 IndexedDB / 事件日志（H3 对象存储暂缓）。
- 不自动在每次 MP4 导出时写发布记录：发布包是「准备发出去」的动作，导出素材不等于发布。
- 不做发布记录删除 / 撤回；发现记错只能追加一条新的。
- 不校验平台规格后再记录：规格问题写进下载 JSON 的 `warnings`，记录本身只回答「什么时候发了什么」。

## 理由

- 发布记录属于作品历史，不是界面状态：写进事件日志才能跨浏览器回放、审计、导出项目。
- 视频位用「文件信息」而不是资产 id：当前没有对象存储，硬编 id 会制造失效引用；文件信息至少能让人找回交付物。
- 只追加：发布是发生过的事实，修正应该留下痕迹，而不是让历史消失。
- 让 `kind` 跟随实际成片档位：包里的档位与视频信息必须自洽，不能因为下拉切了定稿就把草稿标成定稿。
- 在下载 JSON 之后再写 IR：下载失败时不该留下一条「发过」的记录。

## 后果

**正面**

- 发布包 JSON 的视频位现在会写文件名、字节数、档位与渲染时间，`videoNote` 说清二进制在哪；没渲染时仍是 `null` 并有明确警告。
- 每次打发布包都会追加一条 `publish.recorded`；实测 IndexedDB 里出现 `{ platform: "youtube-shorts", quality: "draft", fileName: "夜班-成片.mp4", bytes: 111951, aiLabel: {...} }`，界面同步显示「已有 1 份」。
- 刷新后发布记录仍在（事件回放），旧项目没有该字段也不受影响。
- 测试：IR 132 + gateway 28 + pipeline 30 + web 420 = 610 全过；`pnpm typecheck` 与 `next build` 全过。

**负面**

- 渲染结果没有落成资产，`publishPackages` 里的 `videoAssetId` 暂时为空；发布包与成片文件的关联只靠文件名，改名或移动文件后会断。
- 发布历史只存元数据：想回看当时发布包的完整 JSON，只能翻下载目录。
- 记录写的是客户端本机时间，不是服务端时间；单人本地应用可以接受，多设备后再统一。
- 只读标签页打发布包仍会下载 JSON，只是不写记录；提示会说明这一点。

## 备选方案

| 方案 | 不采用的原因 |
| --- | --- |
| 把 MP4 base64 写进事件 | 事件日志与回放体积爆炸；IndexedDB 事务也会被几十 MB 的字符串拖垮 |
| 用临时文件路径当 `videoAssetId` | 路径重启即失效，IR 会指向不存在的东西；比留空更糟 |
| 每次 MP4 导出自动记一条发布 | 导出素材不等于发布；会让记录里混进大量「只是看了眼草稿」的条目 |
| 发布记录存在 localStorage | 换浏览器 / 导出项目丢失，且与其他 IR 数据分家 |
| 发布记录覆盖同一平台的最新一条 | 丢失发布历史；同一版改标题重发是正常操作，应各留一条 |
| 记录时一并存字幕全文与标题简介 | 内容已在下载 JSON 与项目 IR 里；重复存只会让日志膨胀 |
| 等 H3 对象存储做完再写回 | G1 会一直停在「视频位为 null」，发布历史无从追溯；先记元数据，后续补资产引用 |
