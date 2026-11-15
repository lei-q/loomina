# ADR-0249：图生视频打通——multipart 的 `input_reference` 才是首帧

- 状态：已采纳
- 日期：2026-11-15
- 决策者：用户 + Claude
- 关联：B3、B2、P4、ADR-0243、ADR-0245、ADR-0247

## 背景

ADR-0245 / ADR-0247 把「客户端能试的请求形状」穷举完了，结论是没有任何一条真的用图。
用户随后提供两份供应商文档（UHub AI 视频生成接口文档、console.jtreecloud.com 的
`video-generations`），里面写清了字段语义：

| 形态 | 语义 |
| --- | --- |
| `input_reference` 为 JSON 数组 | **参考图**（有序：图1、图2……） |
| `input_reference` 为单个 JSON 对象 | **首帧** |
| `input_reference` 为单个文件（multipart） | **首帧** |
| 省略整个字段 | 纯文生视频 |

另外：`seconds` 用整秒字符串、`size` 用 `宽x高`、`resolution` 支持 `720P` / `1080P`、
首帧模式的输出比例**可能跟随输入图片**。这些之前都没按文档写，缺的不是「模型不行」。

## 诊断

用同一张纯洋红 720×1280 PNG 判定（产物第 0 帧是不是洋红）：

| 形态 | 结果 |
| --- | --- |
| JSON 对象 `{"image_url": dataURI}` | 400 `'dict' object has no attribute 'read'`——litellm 把它当文件流读 |
| JSON 数组 `[{"image_url": dataURI}]` | 400 同上 |
| **multipart 文件 part `input_reference`** | **200；产物 720×1280；第 0 帧 RGB (253,1,252)** |

结论：这条路必须走 **multipart**，JSON 形态在这个代理上根本到不了模型。

## 决策

1. **网关按 data URI 与否分流**（`TreecloudVideoAdapter.submit`）：
   - `imageUri` 是 data URI → `FormData`：`model` / `prompt` / `seconds`（字符串）/
     `size`（竖屏）/ `input_reference`（Blob，带 MIME 与文件名）；
   - 不是 data URI（http / 资产库地址）→ 退回旧的 `content[].image_url` JSON 形态，
     网关不替远端下载图片。
2. **`size` 由分辨率映射竖屏**：480p → 480×854、720p → 720×1280、1080p → 1080×1920；
   文档明确「不给 size 时 480p 会出横屏」，而本项目是竖屏短剧。
3. **能力矩阵措辞同步**：首帧 = 「multipart 的 `input_reference` 文件 part（单文件 = 首帧）」。
4. **不再用 `content[].image_url` 传首帧**：它会被接受但被忽略（ADR-0245），
   是最容易让人误判「已经通了」的形态。

## 验证

1. **洋红判定**：multipart 上传纯洋红 720×1280 → 产物 720×1280，第 0 帧 RGB (253,1,252)。
2. **端到端探针**：`pnpm probe:s1 --shots 1 --budget 5` → 出图 1024×1536 → 视频
   **782×1174、4.04 秒、¥2.52、通过 1/1**；视频第 0 帧与参考键帧**同人、同构图、同服装**，
   逐像素平均差 42.9（差异来自缩放与轻微重绘）。
3. **单测**：gateway 36 条全过，新增一条断言 multipart 的 `seconds` / `size` / `input_reference`。

## 后果

**正面**

- B3 的「关键帧 → 视频」主路径打通，P4「先图后视频」第一次真正落地。
- 首帧比例跟随输入图，意味着「关键帧怎么出」直接决定成片画幅。

**负面 / 跟进**

- **关键帧尺寸要跟目标画幅对齐**：现在出图是 1024×1536（2:3），视频就出 782×1174（2:3）；
  竖屏 9:16 需要 720×1280 / 1080×1920 的键帧，否则成片要额外裁切。属 B2 的后续项。
- **尾帧仍不支持**：网关只发首帧，`videoAcceptsLastFrame` 仍为 false。
- `480p` 不给 `size` 会横屏；现在用 `size` 钉死竖屏，但自定义画幅（16:9 / 1:1）尚未接进视频请求。
- http / 资产库地址仍走旧 JSON 形态；若那条路也被忽略，需要改成「服务端先取字节再 multipart」。

## 替代方案

1. **JSON `content[].image_url`**：200 但不生效（ADR-0245）——已否决。
2. **JSON `input_reference` 对象 / 数组**：litellm 直接 500（`'dict' object has no attribute 'read'`）——不可用。
3. **只改配置不改网关**：没有任何配置能绕开请求体形状，否决。
