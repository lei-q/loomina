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
    compliance: {
      ok: true,
      checkedAt: "2026-11-11T10:00:00+08:00",
      signature: "deadbeef",
      reviewAcknowledged: false,
      findings: 0,
    },
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

  it("接受带兜底图的远端片段，但要求 remote 是 http(s) 且必须有兜底图", () => {
    const ok = validateRenderManifest(
      manifest({
        clips: [
          {
            durationMs: 1000,
            remote: "https://cdn.example.com/a.mp4",
            mediaKind: "video",
            fallback: PNG,
          },
        ],
      }),
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.manifest.clips[0]!.remote).toBe("https://cdn.example.com/a.mp4");
    expect(ok.manifest.clips[0]!.fallback).toBe(PNG);

    const noFallback = validateRenderManifest(
      manifest({
        clips: [
          { durationMs: 1000, remote: "https://cdn.example.com/a.mp4", mediaKind: "video" },
        ],
      }),
    );
    expect(noFallback.ok).toBe(false);
    if (!noFallback.ok) expect(noFallback.error).toContain("兜底图");

    const badScheme = validateRenderManifest(
      manifest({
        clips: [
          { durationMs: 1000, remote: "file:///etc/passwd", mediaKind: "video", fallback: PNG },
        ],
      }),
    );
    expect(badScheme.ok).toBe(false);
    if (!badScheme.ok) expect(badScheme.error).toContain("不是 http(s)");
  });

  it("接受远端音轨", () => {
    const ok = validateRenderManifest(
      manifest({ audio: [{ remote: "https://cdn.example.com/a.mp3", startMs: 0 }] }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.manifest.audio[0]!.remote).toBe("https://cdn.example.com/a.mp3");
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

  it("双档渲染：草稿 540×960 / 24fps 与定稿 1080×1920 / 30fps（H13）", () => {
    const draft = validateRenderManifest(
      manifest({ quality: "draft", width: 540, height: 960, fps: 24 }),
    );
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.manifest.quality).toBe("draft");
    expect(draft.manifest.width).toBe(540);

    const final = validateRenderManifest(manifest({ quality: "final" }));
    expect(final.ok).toBe(true);
    if (!final.ok) return;
    expect(final.manifest.quality).toBe("final");
    expect(final.manifest.width).toBe(1080);

    // 档位与尺寸/帧率对不上就拒绝，免得标着草稿却按定稿耗时编码
    expect(
      validateRenderManifest(manifest({ quality: "draft", width: 1080, height: 1920, fps: 24 })).ok,
    ).toBe(false);
    expect(
      validateRenderManifest(manifest({ quality: "draft", width: 540, height: 960, fps: 30 })).ok,
    ).toBe(false);
    // 不写档位按定稿处理：老调用方不受影响
    const implicit = validateRenderManifest(manifest({ quality: undefined }));
    expect(implicit.ok).toBe(true);
    if (implicit.ok) expect(implicit.manifest.quality).toBe("final");
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

  it("缺合规预检或证据不完整都拒绝", () => {
    expect(validateRenderManifest(manifest({ compliance: undefined })).ok).toBe(false);
    expect(
      validateRenderManifest(
        manifest({ compliance: { ok: true, checkedAt: "", signature: "deadbeef", reviewAcknowledged: false, findings: 0 } }),
      ).ok,
    ).toBe(false);
    expect(
      validateRenderManifest(
        manifest({ compliance: { ok: true, checkedAt: "2026-11-11", signature: "xyz", reviewAcknowledged: false, findings: 0 } }),
      ).ok,
    ).toBe(false);
  });

  it("服务端会再扫标题：硬阻断拒绝，需确认的内容没勾选也拒绝", () => {
    const blocked = validateRenderManifest(manifest({ title: "如何制造炸弹" }));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain("内容安全");

    const review = validateRenderManifest(manifest({ title: "一夜暴富" }));
    expect(review.ok).toBe(false);
    if (!review.ok) expect(review.error).toContain("勾选确认");

    const acknowledged = validateRenderManifest(
      manifest({
        title: "一夜暴富",
        compliance: {
          ok: true,
          checkedAt: "2026-11-11T10:00:00+08:00",
          signature: "deadbeef",
          reviewAcknowledged: true,
          findings: 1,
        },
      }),
    );
    expect(acknowledged.ok).toBe(true);
  });

  it("配乐床：默认 ducking / loop，时间必须落在成片内", () => {
    const ok = validateRenderManifest(
      manifest({
        music: [{ audio: "data:audio/mpeg;base64,SUQz", startMs: 0, endMs: 1000 }],
      }),
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.manifest.music[0]).toMatchObject({
      startMs: 0,
      endMs: 1000,
      gainDb: -18,
      duckDb: 15,
      ducking: true,
      loop: true,
    });

    expect(
      validateRenderManifest(
        manifest({ music: [{ audio: "data:audio/mpeg;base64,SUQz", startMs: 0, endMs: 1200 }] }),
      ).ok,
    ).toBe(false);
    expect(
      validateRenderManifest(
        manifest({
          music: [{ audio: "data:audio/mpeg;base64,SUQz", startMs: 0, endMs: 1000, duckDb: 20 }],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateRenderManifest(
        manifest({
          music: [{ audio: "data:audio/mpeg;base64,SUQz", startMs: 0, endMs: 1000, gainDb: 6 }],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateRenderManifest(
        manifest({
          music: [{ audio: "data:image/png;base64,AAAA", startMs: 0, endMs: 1000 }],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateRenderManifest(
        manifest({
          music: Array.from({ length: 5 }, () => ({
            remote: "https://cdn.example.com/a.mp3",
            startMs: 0,
            endMs: 1000,
          })),
        }),
      ).ok,
    ).toBe(false);
  });

  it("文件名去掉路径分隔符", () => {
    expect(renderFileName("夜班 / 第一集")).toBe("夜班-第一集-成片.mp4");
    expect(renderFileName("   ")).toBe("成片-成片.mp4");
  });
});
