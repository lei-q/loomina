import { describe, expect, it } from "vitest";
import {
  AI_LABEL,
  AI_LABEL_TEXT,
  aiContentHashOf,
  aiLabelRecordFor,
  badgeCornerLabel,
  badgeOffsets,
  badgePlacementOf,
  materialOfManifest,
  materialOfView,
} from "./ai-label";
import { PLATFORM_SPECS } from "./platforms";

describe("AI 标识的角标位置（H5 / ADR-0138）", () => {
  it("每份平台规格都写了角标位置，且落在安全区内", () => {
    for (const spec of PLATFORM_SPECS) {
      expect(spec.badge, `${spec.name} 缺角标位置`).toBeDefined();
      expect(spec.badge!.insetPct).toBeGreaterThanOrEqual(4);
      expect(spec.badge!.insetPct).toBeLessThanOrEqual(10);
    }
  });

  it("抖音的角标不摆右下角：那里是点赞与评论栏", () => {
    expect(badgePlacementOf("douyin").corner).toBe("tl");
    expect(badgeCornerLabel(badgePlacementOf("douyin").corner)).toBe("左上角");
  });

  it("未知平台退回默认位置，而不是抛错", () => {
    expect(badgePlacementOf("no-such-platform").corner).toBe("br");
  });

  it("四角偏移换算成 CSS 边距", () => {
    expect(badgeOffsets({ corner: "tl", insetPct: 8 })).toEqual({ top: "8%", left: "8%" });
    expect(badgeOffsets({ corner: "br", insetPct: 4 })).toEqual({ bottom: "4%", right: "4%" });
    expect(badgeOffsets({ corner: "tr", insetPct: 6 })).toEqual({ top: "6%", right: "6%" });
    expect(badgeOffsets({ corner: "bl", insetPct: 5 })).toEqual({ bottom: "5%", left: "5%" });
  });
});

describe("AI 标识的内容指纹（H5 / ADR-0138）", () => {
  const view = {
    title: "夜班",
    totalMs: 12_000,
    clips: [
      { durationMs: 6_000, uri: "loomina://assets/aaaa.mp4" },
      { durationMs: 6_000, stillUri: "data:image/png;base64,AAAA" },
    ],
  };

  it("同一份剪辑总得到同一个 8 位十六进制", () => {
    expect(aiContentHashOf(materialOfView(view))).toBe(aiContentHashOf(materialOfView(view)));
    expect(aiContentHashOf(materialOfView(view))).toMatch(/^[0-9a-f]{8}$/);
  });

  it("换一条 take、改时长、增删一镜都会改指纹", () => {
    const base = aiContentHashOf(materialOfView(view));
    expect(
      aiContentHashOf(
        materialOfView({ ...view, clips: [{ durationMs: 6_000, uri: "loomina://assets/bbbb.mp4" }, view.clips[1]!] }),
      ),
    ).not.toBe(base);
    expect(aiContentHashOf(materialOfView({ ...view, totalMs: 13_000 }))).not.toBe(base);
    expect(aiContentHashOf(materialOfView({ ...view, clips: [view.clips[0]!] }))).not.toBe(base);
  });

  it("只改标题也会改指纹：发布出去的标题是这一份产物的一部分", () => {
    expect(aiContentHashOf(materialOfView({ ...view, title: "白班" }))).not.toBe(
      aiContentHashOf(materialOfView(view)),
    );
  });

  it("标题超长按清单的 80 字裁切后再算，两端才对得上", () => {
    const long = "夜".repeat(120);
    const clipped = "夜".repeat(80);
    expect(aiContentHashOf(materialOfView({ ...view, title: long }))).toBe(
      aiContentHashOf(materialOfView({ ...view, title: clipped })),
    );
  });

  it("清单取材与剪辑层取材用同一套规则", () => {
    const viewHash = aiContentHashOf(materialOfView(view));
    const manifestHash = aiContentHashOf(
      materialOfManifest({
        title: "夜班",
        totalMs: 12_000,
        clips: [
          { durationMs: 6_000, media: "loomina://assets/aaaa.mp4" },
          { durationMs: 6_000, media: "data:image/png;base64,AAAA" },
        ],
      }),
    );
    expect(manifestHash).toBe(viewHash);
  });

  it("占位图在两端都记空串：服务端画的图没有地址", () => {
    const placeholder = aiContentHashOf(
      materialOfManifest({
        title: "夜班",
        totalMs: 6_000,
        clips: [{ durationMs: 6_000, media: "data:image/png;base64,PLACEHOLDER", placeholder: true }],
      }),
    );
    expect(placeholder).toBe(
      aiContentHashOf({ title: "夜班", totalMs: 6_000, clips: [{ durationMs: 6_000, mediaHash: "" }] }),
    );
  });

  it("标识记录带版本与指纹，显式 / 隐式都在", () => {
    const record = aiLabelRecordFor(view);
    expect(record).toMatchObject({ explicit: true, implicit: true, standard: AI_LABEL_TEXT, version: 1 });
    expect(record.contentHash).toBe(aiContentHashOf(materialOfView(view)));
    expect(AI_LABEL.standard).toBe(AI_LABEL_TEXT);
  });
});
