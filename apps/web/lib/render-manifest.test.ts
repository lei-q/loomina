import { describe, expect, it } from "vitest";
import {
  RENDER_FPS,
  RENDER_HEIGHT,
  RENDER_WIDTH,
  parseDataUri,
  renderFileName,
  validateRenderManifest,
} from "./render-manifest";

// 1×1 透明 PNG：只验清单与字节数，不解码
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    title: "夜班",
    width: RENDER_WIDTH,
    height: RENDER_HEIGHT,
    fps: RENDER_FPS,
    totalMs: 1000,
    clips: [{ durationMs: 1000, media: PNG, mediaKind: "image" }],
    overlays: [{ image: PNG, startMs: 0, endMs: 1000 }],
    audio: [],
    aiLabel: { explicit: true, implicit: true, standard: "AI生成" },
    ...overrides,
  };
}

describe("成片渲染清单（E6）", () => {
  it("data URI 的 MIME 与解码后字节数", () => {
    const parts = parseDataUri(PNG);
    expect(parts?.mime).toBe("image/png");
    expect(parts?.bytes).toBe(70);
    expect(parseDataUri("https://example.com/a.png")).toBeNull();
  });

  it("合法清单通过，片段总时长必须等于全长", () => {
    const ok = validateRenderManifest(manifest());
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.manifest.totalMs).toBe(1000);
    expect(ok.manifest.clips).toHaveLength(1);
    expect(ok.manifest.aiLabel.standard).toBe("AI生成");
  });

  it("拒绝远端媒体，不悄悄跳过", () => {
    const bad = validateRenderManifest(
      manifest({
        clips: [
          { durationMs: 1000, media: "https://example.com/a.mp4", mediaKind: "video" },
        ],
      }),
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toContain("远端视频暂不渲染");
  });

  it("拒绝有缺口的片段，也拒绝总时长对不上", () => {
    const gap = validateRenderManifest(
      manifest({
        clips: [
          { durationMs: 400, media: PNG, mediaKind: "image" },
          { durationMs: 300, media: PNG, mediaKind: "image" },
        ],
      }),
    );
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.error).toContain("对不上");

    const over = validateRenderManifest(manifest({ totalMs: 1200 }));
    expect(over.ok).toBe(false);
  });

  it("缺 AI 标注、超出上限、叠加层时间越界都拒绝", () => {
    expect(validateRenderManifest(manifest({ aiLabel: undefined })).ok).toBe(false);
    expect(validateRenderManifest(manifest({ totalMs: 180_001 })).ok).toBe(false);
    expect(
      validateRenderManifest(
        manifest({ overlays: [{ image: PNG, startMs: 900, endMs: 1200 }] }),
      ).ok,
    ).toBe(false);
  });

  it("文件名去掉路径分隔符", () => {
    expect(renderFileName("夜班 / 第一集")).toBe("夜班-第一集-成片.mp4");
    expect(renderFileName("   ")).toBe("成片-成片.mp4");
  });
});
