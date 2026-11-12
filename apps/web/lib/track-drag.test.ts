import { describe, expect, it } from "vitest";
import { DRAG_SNAP_MS, clampedDeltaMs, dragDeltaMs } from "./track-drag";

describe("字幕条拖动（E1）", () => {
  it("按轨道宽度线性换算，取整到 10ms", () => {
    // 300px 轨道装 10s：30px = 1s
    expect(dragDeltaMs(30, 300, 10_000)).toBe(1000);
    expect(dragDeltaMs(-15, 300, 10_000)).toBe(-500);
    // 3px = 100ms，再取整
    expect(dragDeltaMs(3, 300, 10_000)).toBe(100);
    // 1px ≈ 33ms → 30ms；1.5px ≈ 50ms
    expect(dragDeltaMs(1, 300, 10_000)).toBe(DRAG_SNAP_MS * 3);
    expect(dragDeltaMs(0.1, 300, 10_000)).toBe(0);
    expect(dragDeltaMs(1.5, 300, 10_000)).toBe(DRAG_SNAP_MS * 5);
  });

  it("轨道宽度或时长无效时不动", () => {
    expect(dragDeltaMs(10, 0, 10_000)).toBe(0);
    expect(dragDeltaMs(10, 300, 0)).toBe(0);
    expect(dragDeltaMs(Number.NaN, 300, 10_000)).toBe(0);
  });

  it("目标值夹在 ±30 秒：贴边同向拖不再产生增量", () => {
    expect(clampedDeltaMs(29_500, 5_000)).toBe(500);
    expect(clampedDeltaMs(30_000, 5_000)).toBe(0);
    expect(clampedDeltaMs(-29_500, -5_000)).toBe(-500);
    expect(clampedDeltaMs(-30_000, -5_000)).toBe(0);
  });

  it("从中间往回拖能一次拉回另一侧", () => {
    expect(clampedDeltaMs(0, -40_000)).toBe(-30_000);
    expect(clampedDeltaMs(10_000, -20_000)).toBe(-20_000);
  });
});
