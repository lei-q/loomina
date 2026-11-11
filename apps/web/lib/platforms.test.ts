import { describe, expect, it } from "vitest";
import {
  PLATFORM_SPECS,
  PLATFORM_SPEC_VERSION,
  aspectRatioOf,
  platformCheckDetail,
  platformSpecOf,
  validatePlatform,
} from "./platforms";

function douyin(overrides: Record<string, unknown> = {}) {
  return validatePlatform(platformSpecOf("douyin"), {
    durationMs: 60_000,
    width: 1080,
    height: 1920,
    fps: 30,
    codec: "H.264",
    title: "夜班",
    topics: ["短剧", "夜班"],
    ...overrides,
  });
}

describe("平台规格（G7）", () => {
  it("画幅按最大公约数写成人读的比例", () => {
    expect(aspectRatioOf(1080, 1920)).toBe("9:16");
    expect(aspectRatioOf(1920, 1080)).toBe("16:9");
    expect(aspectRatioOf(1080, 1081)).toBe("1080:1081");
    expect(aspectRatioOf(0, 0)).toBe("未知");
  });

  it("九份规格，id 唯一，版本号可追溯", () => {
    expect(PLATFORM_SPECS).toHaveLength(9);
    expect(new Set(PLATFORM_SPECS.map((spec) => spec.id)).size).toBe(9);
    expect(PLATFORM_SPEC_VERSION).toMatch(/^\d{4}-\d{2}$/);
    expect(platformSpecOf("douyin").name).toBe("抖音");
  });

  it("抖音竖屏 60 秒通过：硬项全过，参考项只提示", () => {
    const validation = douyin();
    expect(validation.ok).toBe(true);
    expect(validation.blocked).toBe(0);
    const aspect = validation.checks.find((check) => check.id === "aspect")!;
    expect(aspect.status).toBe("pass");
    const title = validation.checks.find((check) => check.id === "title")!;
    expect(title.reference).toBe(true);
    expect(validation.checks.find((check) => check.id === "file-size")!.reference).toBe(
      true,
    );
  });

  it("时长低于下限、超过上限都硬拦", () => {
    expect(douyin({ durationMs: 5_500 }).checks.find((c) => c.id === "duration")!.status).toBe(
      "block",
    );
    expect(
      validatePlatform(platformSpecOf("youtube-shorts"), {
        durationMs: 181_000,
        width: 1080,
        height: 1920,
        fps: 30,
        title: "夜班",
        topics: [],
      }).blocked,
    ).toBe(1);
    expect(
      validatePlatform(platformSpecOf("x"), {
        durationMs: 140_000,
        width: 1920,
        height: 1080,
        fps: 30,
        title: "夜班",
        topics: [],
      }).ok,
    ).toBe(true);
  });

  it("画幅、短边与编码不符都硬拦", () => {
    const horizontal = douyin({ width: 1920, height: 1080 });
    expect(horizontal.ok).toBe(false);
    expect(horizontal.checks.find((c) => c.id === "aspect")!.status).toBe("block");
    expect(douyin({ width: 540, height: 960 }).checks.find((c) => c.id === "resolution")!.status).toBe(
      "block",
    );
    expect(douyin({ codec: "HEVC" }).checks.find((c) => c.id === "codec")!.status).toBe("block");
  });

  it("帧率不符只提示复核，不单独拦导出", () => {
    const validation = douyin({ fps: 24 });
    const fps = validation.checks.find((check) => check.id === "fps")!;
    expect(fps.status).toBe("review");
    expect(validation.blocked).toBe(0);
    expect(validation.review).toBe(1);
  });

  it("标题与话题超参考值只提示", () => {
    const longTitle = douyin({ title: "夜".repeat(60) });
    expect(longTitle.checks.find((c) => c.id === "title")!.status).toBe("review");
    const manyTopics = douyin({ topics: ["a", "b", "c", "d", "e", "f"] });
    expect(manyTopics.checks.find((c) => c.id === "hashtags")!.status).toBe("review");
    expect(douyin({ topics: ["a", " ", "b"] }).checks.find((c) => c.id === "hashtags")!.detail).toContain(
      "2 / 5",
    );
  });

  it("通用规格不设时长上下限，字段都标为参考", () => {
    const generic = platformSpecOf("generic");
    const validation = validatePlatform(generic, {
      durationMs: 120_000,
      width: 1080,
      height: 1920,
      fps: 30,
      title: "夜班",
      topics: [],
    });
    expect(validation.ok).toBe(true);
    expect(validation.checks.find((c) => c.id === "duration")!.detail).toContain("未设公开的硬性");
    expect(generic.reference).toContain("所有平台字段");
  });

  it("硬阻断时给一句话说清哪几项没过；全过时点出参考值", () => {
    const blocked = douyin({ durationMs: 5_000, codec: "HEVC" });
    const detail = platformCheckDetail(blocked);
    expect(detail).toContain("抖音");
    expect(detail).toContain(PLATFORM_SPEC_VERSION);
    expect(detail).toContain("5.0 秒");
    expect(detail).toContain("HEVC");
    expect(platformCheckDetail(douyin())).toContain("参考值只提示");
  });
});
