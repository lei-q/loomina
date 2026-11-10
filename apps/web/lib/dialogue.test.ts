import { describe, expect, it } from "vitest";
import { estimateDialogueMs } from "./dialogue";

describe("台词时长估算（ADR-0044）", () => {
  it("按 0.3 秒 / 字，四舍五入到 0.1 秒", () => {
    expect(estimateDialogueMs("灯是我关的。")).toBe(1800); // 6 字
    expect(estimateDialogueMs("知道了又怎样。")).toBe(2100); // 7 字
    expect(estimateDialogueMs("你早就知道，对吧。")).toBe(2700); // 9 字
  });

  it("空白不算字，空台词给下限", () => {
    expect(estimateDialogueMs(" 灯 是 我 关 的 。 ")).toBe(1800);
    expect(estimateDialogueMs("   ")).toBe(800);
  });

  it("再长也按 0.1 秒对齐", () => {
    const text = "一".repeat(33); // 33 字 → 9900ms
    expect(estimateDialogueMs(text)).toBe(9900);
    expect(estimateDialogueMs(text) % 100).toBe(0);
  });
});
