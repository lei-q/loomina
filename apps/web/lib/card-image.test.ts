import { describe, expect, it } from "vitest";
import {
  brandArtOf,
  cardImage,
  drawBrandCard,
  luminanceOf,
  textColorsOf,
  wrapText,
  type BrandCardArt,
} from "./card-image";
import { DEFAULT_BRAND } from "@loomina/ir";

/** 只记事儿的假画布：测的是「画了什么」，不是像素 */
function fakeCtx(charWidth = 10) {
  const texts: { text: string; y: number; fill: string }[] = [];
  const rects: { x: number; y: number; w: number; h: number; fill: string }[] = [];
  let fill = "";
  const ctx = {
    set fillStyle(value: string) {
      fill = value;
    },
    get fillStyle() {
      return fill;
    },
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    measureText: (text: string) => ({ width: [...text].length * charWidth }),
    fillRect: (x: number, y: number, w: number, h: number) => {
      rects.push({ x, y, w, h, fill });
    },
    fillText: (text: string, _x: number, y: number) => {
      texts.push({ text, y, fill });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, rects };
}

const art: BrandCardArt = {
  role: "intro",
  color: "#121215",
  title: "夜班",
  subtitle: "第一集",
  name: "织光机",
  handle: "@zhiguang",
};

describe("头尾卡画法（E9 / ADR-0174）", () => {
  it("亮度分深浅，字色跟着底色走", () => {
    expect(luminanceOf("#000000")).toBe(0);
    expect(luminanceOf("#FFFFFF")).toBeCloseTo(1, 5);
    expect(textColorsOf("#121215").text).toBe("#F4F4F5");
    expect(textColorsOf("#F2EFE8").text).toBe("#17171A");
  });

  it("折行按宽度断，中文逐字、空行丢掉", () => {
    const measure = (text: string) => [...text].length * 10;
    expect(wrapText(measure, "一二三四五六", 30)).toEqual(["一二三", "四五六"]);
    expect(wrapText(measure, "短", 30)).toEqual(["短"]);
    expect(wrapText(measure, "\n  \n", 30)).toEqual([]);
  });

  it("铺满底色，标题与副标题居中，落款在左下", () => {
    const { ctx, texts, rects } = fakeCtx();
    drawBrandCard(ctx, art, { width: 1080, height: 1920 });
    const background = rects[0]!;
    expect(background.fill).toBe("#121215");
    expect(background).toMatchObject({ x: 0, y: 0, w: 1080, h: 1920 });
    const drawn = texts.map((item) => item.text);
    expect(drawn).toContain("夜班");
    expect(drawn).toContain("第一集");
    expect(drawn).toContain("织光机");
    expect(drawn).toContain("@zhiguang");
    // 标题在画面中部偏上，落款在下三分之一
    const title = texts.find((item) => item.text === "夜班")!;
    expect(title.y).toBeGreaterThan(1920 * 0.35);
    expect(title.y).toBeLessThan(1920 * 0.62);
    const foot = texts.find((item) => item.text === "织光机")!;
    expect(foot.y).toBeGreaterThan(1920 * 0.8);
  });

  it("没有字的时候只铺底色，不画空行", () => {
    const { ctx, texts } = fakeCtx();
    drawBrandCard(ctx, { ...art, title: "  ", subtitle: "", name: "", handle: "" }, {
      width: 540,
      height: 960,
    });
    expect(texts).toEqual([]);
  });

  it("长标题会折成两行，不会一条长字跑出画面", () => {
    const { ctx, texts } = fakeCtx(10);
    drawBrandCard(
      ctx,
      { ...art, title: "这是一个很长很长很长的片名", subtitle: "" },
      { width: 540, height: 960 },
    );
    const titleLines = texts.filter((item) => item.text.length > 0);
    expect(titleLines.length).toBeGreaterThan(1);
  });

  it("从品牌里取素材：开关不在这里判", () => {
    const art2 = brandArtOf(
      { ...DEFAULT_BRAND, name: "织光机", intro: { ...DEFAULT_BRAND.intro, title: "夜班" } },
      "intro",
      { title: "夜班", subtitle: "第一集" },
    );
    expect(art2).toMatchObject({ role: "intro", title: "夜班", name: "织光机" });
  });

  it("没有 DOM 时不画图（服务端渲染与 Node 测试），调用方退回占位", () => {
    expect(cardImage(art, { width: 540, height: 960 })).toBeUndefined();
  });
});
