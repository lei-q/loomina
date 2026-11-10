import { describe, expect, it } from "vitest";
import {
  DRAFT_RESOLUTION,
  KEYFRAME_MODEL,
  requoteProject,
  requoteShot,
} from "./pricing";

describe("重做报价", () => {
  it("按镜头时长 × 每秒单价 + 一张首帧算", () => {
    const quote = requoteShot(2400);
    expect(quote.videoCny).toBeCloseTo(1.2, 2);
    expect(quote.keyframeCny).toBeCloseTo(0.12, 2);
    expect(quote.totalCny).toBeCloseTo(1.32, 2);
    expect(quote.basis).toBe("2.4s × ¥0.50/s + 首帧 ¥0.12");
  });

  it("4 秒镜头正好对上 COST.md 的实测 ¥2.12", () => {
    expect(requoteShot(4000).totalCny).toBe(2.12);
  });

  it("换分辨率就换单价，不读死配置", () => {
    // minimax-h3 2k 是 ¥0.8/s
    const quote = requoteShot(4000, { resolution: "2k" });
    expect(quote.totalCny).toBeCloseTo(3.32, 2);
  });

  it("价目表里没有的组合不报价，只说明原因", () => {
    const quote = requoteShot(4000, { resolution: "4k" });
    expect(quote.totalCny).toBeUndefined();
    expect(quote.basis).toContain("不在价目表里");
  });

  it("首帧模型没有价目时，仍给出视频部分并说明缺了什么", () => {
    const quote = requoteShot(4000, { keyframeModel: "no-such-model" });
    expect(quote.videoCny).toBeCloseTo(2, 2);
    expect(quote.totalCny).toBeUndefined();
    expect(quote.basis).toContain("无价目");
  });

  it("默认档位是草稿：minimax-h3 @ 768p", () => {
    expect(DRAFT_RESOLUTION).toBe("768p");
    expect(KEYFRAME_MODEL).toBe("gpt-image-2-c");
  });
});

describe("整片报价", () => {
  it("逐镜算再相加，镜数写进依据", () => {
    const quote = requoteProject([3100, 2400, 2400]);
    expect(quote.shots).toBe(3);
    expect(quote.videoCny).toBeCloseTo(3.95, 2); // 7.9s × 0.5
    expect(quote.keyframeCny).toBeCloseTo(0.36, 2); // 3 张首帧
    expect(quote.totalCny).toBeCloseTo(4.31, 2);
    expect(quote.basis).toContain("3 镜");
  });

  it("有一镜报不出价，整片就不给总数", () => {
    const quote = requoteProject([2400], { resolution: "4k" });
    expect(quote.totalCny).toBeUndefined();
    expect(quote.basis).toContain("不给总数");
  });

  it("没有镜头时是 0 元，不是空", () => {
    expect(requoteProject([]).totalCny).toBe(0);
  });
});
