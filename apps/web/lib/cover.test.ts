import { describe, expect, it } from "vitest";
import {
  COVER_BADGE_TEXT,
  COVER_HEIGHT,
  COVER_STYLES,
  COVER_WIDTH,
  coverArtOf,
  coverFileNameOf,
  coverFontSizeOf,
  coverFrameUrlOf,
  coverHookOf,
  coverSizeOf,
  coverStyleById,
  coverTitleLines,
  coverTitleOf,
  dataUrlBytes,
  drawCover,
} from "./cover";

type Call = { type: string; args: unknown[] };

/** 记录调用顺序的假 2D 上下文：出图不能单测，排版画了什么都看得见 */
function recordingContext() {
  const calls: Call[] = [];
  const gradient = {
    stops: [] as { offset: number; color: string }[],
    addColorStop(offset: number, color: string) {
      this.stops.push({ offset, color });
    },
  };
  const ctx = {
    fillStyle: "" as unknown,
    strokeStyle: "" as unknown as string,
    lineWidth: 0,
    font: "",
    textAlign: "",
    textBaseline: "",
    shadowColor: "",
    shadowBlur: 0,
    save() {
      calls.push({ type: "save", args: [] });
    },
    restore() {
      calls.push({ type: "restore", args: [] });
    },
    fillRect(...args: number[]) {
      calls.push({ type: "fillRect", args });
    },
    createLinearGradient(...args: number[]) {
      calls.push({ type: "gradient", args });
      return gradient;
    },
    drawImage(...args: unknown[]) {
      calls.push({ type: "drawImage", args });
    },
    measureText(text: string) {
      return { width: [...text].length * 24 };
    },
    fillText(...args: unknown[]) {
      calls.push({ type: "fillText", args });
    },
    beginPath() {
      calls.push({ type: "beginPath", args: [] });
    },
    roundRect(...args: number[]) {
      calls.push({ type: "roundRect", args });
    },
    fill() {
      calls.push({ type: "fill", args: [] });
    },
    stroke() {
      calls.push({ type: "stroke", args: [] });
    },
    moveTo() {},
    lineTo() {},
    closePath() {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("封面标题排版（G6）", () => {
  it("短标题一行，不去动它", () => {
    expect(coverTitleLines("夜班走廊")).toEqual(["夜班走廊"]);
    expect(coverTitleLines("  夜班   走廊 ")).toEqual(["夜班 走廊"]);
  });

  it("长标题折两行，第二行放不下就省掉尾巴", () => {
    const lines = coverTitleLines("凌晨三点的便利店来了一个不该出现在这里的人");
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith("…")).toBe(true);
    expect([...lines[0]!].length).toBeLessThanOrEqual(9);
  });

  it("优先切在标点后面，不在词中间断", () => {
    const lines = coverTitleLines("表面上是加班，其实是谋杀");
    expect(lines).toEqual(["表面上是加班，", "其实是谋杀"]);
  });

  it("字号随最长一行缩小，并夹在上下限之间", () => {
    const short = coverFontSizeOf(["夜班"]);
    const long = coverFontSizeOf(["凌晨三点的便利店来"]);
    expect(long).toBeLessThan(short);
    expect(short).toBeLessThanOrEqual(140);
    expect(coverFontSizeOf(["一个字没完没了".repeat(20)])).toBeGreaterThanOrEqual(56);
  });

  it("行高跟着字号走", () => {
    const title = coverTitleOf("夜班走廊");
    expect(title.lineHeightPx).toBeGreaterThan(title.fontPx);
    expect(title.lineHeightPx).toBeLessThan(title.fontPx * 1.4);
  });
});

describe("封面钩子与文件名（G6）", () => {
  it("钩子取简介第一行，太长截断加省略号", () => {
    expect(coverHookOf("\n\n 你加过的班，都算在了别人头上 \n第二行")).toBe(
      "你加过的班，都算在了别人头上",
    );
    expect(coverHookOf("")).toBeUndefined();
    expect(coverHookOf("一".repeat(30))).toBe("一".repeat(18) + "…");
  });

  it("文件名按项目标题清洗，带「封面」后缀", () => {
    expect(coverFileNameOf("夜班 走廊/第一集")).toBe("夜班-走廊-第一集-封面.png");
    expect(coverFileNameOf("   ")).toBe("loomina-封面.png");
  });

  it("data URL 的字节数按 base64 算", () => {
    const payload = Buffer.from("hello").toString("base64");
    expect(dataUrlBytes(`data:image/png;base64,${payload}`)).toBe(5);
    expect(dataUrlBytes("not-a-data-url")).toBe(0);
  });

  it("封面记录写清用哪一镜、哪一个时刻", () => {
    const art = coverArtOf({
      title: "夜班走廊",
      shotNo: 3,
      atMs: 1234.6,
      bytes: 880_000.4,
      platform: "douyin",
      generatedAt: "2026-11-12T10:00:00.000Z",
    });
    expect(art).toEqual({
      fileName: "夜班走廊-封面.png",
      bytes: 880_000,
      shotNo: 3,
      atMs: 1235,
      width: COVER_WIDTH,
      height: COVER_HEIGHT,
      title: "夜班走廊",
      platform: "douyin",
      styleId: "classic",
      generatedAt: "2026-11-12T10:00:00.000Z",
    });
  });

  it("封面尺寸跟着平台：小红书 3:4，B 站 16:9", () => {
    expect(coverSizeOf("douyin")).toEqual({ width: 1080, height: 1920, ratio: "9:16" });
    expect(coverSizeOf("xiaohongshu")).toEqual({ width: 1080, height: 1440, ratio: "3:4" });
    expect(coverSizeOf("bilibili")).toEqual({ width: 1920, height: 1080, ratio: "16:9" });
    // 非 9:16 的文件名带上比例，几张封面不会互相覆盖
    expect(coverFileNameOf("夜班", "3:4")).toBe("夜班-封面-3x4.png");
    expect(coverFileNameOf("夜班")).toBe("夜班-封面.png");
  });

  it("四种版式都有自己的名字与配色；认不出的退回剧照", () => {
    expect(COVER_STYLES).toHaveLength(4);
    for (const style of COVER_STYLES) {
      expect(style.name.trim()).not.toBe("");
      expect(style.accent).toMatch(/^#[0-9A-F]{6}$/i);
    }
    expect(coverStyleById("noir").align).toBe("center");
    expect(coverStyleById(undefined).id).toBe("classic");
  });

  it("切帧地址带上素材、时刻与 1080 宽度", () => {
    const url = coverFrameUrlOf("loomina://assets/abc", 900);
    expect(url).toBe(
      `/api/preview/frame?asset=${encodeURIComponent("loomina://assets/abc")}&at=900&w=1080`,
    );
    expect(coverFrameUrlOf(undefined, 0)).toBeUndefined();
  });
});

describe("封面绘制（G6）", () => {
  it("有画面时按 cover 铺满并居中裁切", () => {
    const { ctx, calls } = recordingContext();
    drawCover(ctx, {
      title: "夜班走廊",
      platform: "douyin",
      image: {} as CanvasImageSource,
      imageWidth: 1000,
      imageHeight: 1000,
    });
    const draw = calls.find((call) => call.type === "drawImage");
    expect(draw?.args.slice(1)).toEqual([-420, 0, 1920, 1920]);
  });

  it("没有画面时画一层渐变底，不冒充画面", () => {
    const { ctx, calls } = recordingContext();
    drawCover(ctx, { title: "夜班走廊", platform: "generic" });
    expect(calls.some((call) => call.type === "drawImage")).toBe(false);
    expect(calls.filter((call) => call.type === "gradient").length).toBeGreaterThanOrEqual(2);
  });

  it("标题按行画出来，钩子排在标题上方", () => {
    const { ctx, calls } = recordingContext();
    drawCover(ctx, {
      title: "表面上是加班，其实是谋杀",
      hook: "凌晨三点的便利店",
      platform: "douyin",
    });
    const texts = calls.filter((call) => call.type === "fillText").map((call) => call.args[0]);
    expect(texts).toContain("表面上是加班，");
    expect(texts).toContain("其实是谋杀");
    const hook = calls.find((call) => call.type === "fillText" && call.args[0] === "凌晨三点的便利店");
    const firstLine = calls.find((call) => call.type === "fillText" && call.args[0] === "表面上是加班，");
    expect(Number(hook?.args[2])).toBeLessThan(Number(firstLine?.args[2]));
  });

  it("标题为空时仍出角标", () => {
    const { ctx, calls } = recordingContext();
    drawCover(ctx, { title: "   ", platform: "douyin" });
    const texts = calls.filter((call) => call.type === "fillText").map((call) => call.args[0]);
    expect(texts).toEqual([COVER_BADGE_TEXT]);
  });

  it("角标跟着平台走：抖音左上、通用右下", () => {
    const douyin = recordingContext();
    drawCover(douyin.ctx, { title: "夜班走廊", platform: "douyin" });
    const douyinBadge = douyin.calls.find((call) => call.type === "roundRect")!;
    expect(douyinBadge.args[0]).toBeCloseTo(86.4, 0);
    expect(douyinBadge.args[1]).toBeCloseTo(86.4, 0);

    const generic = recordingContext();
    drawCover(generic.ctx, { title: "夜班走廊", platform: "generic" });
    const genericBadge = generic.calls.find((call) => call.type === "roundRect")!;
    expect(genericBadge.args[0]).toBeGreaterThan(COVER_WIDTH / 2);
    expect(genericBadge.args[1]).toBeGreaterThan(COVER_HEIGHT / 2);
  });
});
