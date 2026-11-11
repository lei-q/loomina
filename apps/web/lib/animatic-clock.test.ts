import { describe, expect, it } from "vitest";
import { elapsedMsOf, locateInTimeline, totalMsOf } from "./animatic-clock";

/**
 * 预演时间轴的换算（E7.1 / ADR-0127）。
 *
 * 三条不变量：全长是各镜之和；任意毫秒都能落到唯一一镜；来回换算不漂移。
 */
const SEGMENTS = [{ dur: 3.1 }, { dur: 2.4 }, { dur: 5 }, { dur: 1.5 }];

describe("totalMsOf", () => {
  it("各镜时长相加（秒 → 毫秒）", () => {
    expect(totalMsOf(SEGMENTS)).toBe(12_000);
  });

  it("空片子是 0，负数时长按 0 算", () => {
    expect(totalMsOf([])).toBe(0);
    expect(totalMsOf([{ dur: -2 }, { dur: 1 }])).toBe(1000);
  });
});

describe("locateInTimeline", () => {
  it("第 0 毫秒在第一镜开头", () => {
    expect(locateInTimeline(SEGMENTS, 0)).toEqual({ index: 0, offsetMs: 0 });
  });

  it("镜内偏移按累计时长算", () => {
    expect(locateInTimeline(SEGMENTS, 1500)).toEqual({ index: 0, offsetMs: 1500 });
    expect(locateInTimeline(SEGMENTS, 3100)).toEqual({ index: 1, offsetMs: 0 });
    expect(locateInTimeline(SEGMENTS, 4000)).toEqual({ index: 1, offsetMs: 900 });
  });

  it("正好落在切点上算后一镜的第 0 毫秒", () => {
    expect(locateInTimeline(SEGMENTS, 5500)).toEqual({ index: 2, offsetMs: 0 });
  });

  it("超出两端夹到首尾，不返回越界下标", () => {
    expect(locateInTimeline(SEGMENTS, -100)).toEqual({ index: 0, offsetMs: 0 });
    const end = locateInTimeline(SEGMENTS, 99_999);
    expect(end.index).toBe(3);
    expect(end.offsetMs).toBeLessThanOrEqual(1500);
  });

  it("空片子返回第一镜第 0 毫秒", () => {
    expect(locateInTimeline([], 500)).toEqual({ index: 0, offsetMs: 0 });
  });

  it("零时长镜头不占时间：那一毫秒落到下一个有长度的镜头", () => {
    const withZero = [{ dur: 1 }, { dur: 0 }, { dur: 2 }];
    expect(locateInTimeline(withZero, 999)).toEqual({ index: 0, offsetMs: 999 });
    // 第 2 镜长度为 0，任何时刻都不会「停」在它上面
    expect(locateInTimeline(withZero, 1000)).toEqual({ index: 2, offsetMs: 0 });
    expect(locateInTimeline(withZero, 1001)).toEqual({ index: 2, offsetMs: 1 });
  });
});

describe("elapsedMsOf", () => {
  it("是 locateInTimeline 的逆运算", () => {
    for (const ms of [0, 900, 3100, 5499, 5500, 9000, 11_999]) {
      const at = locateInTimeline(SEGMENTS, ms);
      expect(elapsedMsOf(SEGMENTS, at.index, at.offsetMs)).toBe(ms);
    }
  });

  it("越界的镜号与偏移都被夹住", () => {
    expect(elapsedMsOf(SEGMENTS, 99, 0)).toBe(12_000);
    expect(elapsedMsOf(SEGMENTS, -3, 0)).toBe(0);
    expect(elapsedMsOf(SEGMENTS, 0, -50)).toBe(0);
  });
});
