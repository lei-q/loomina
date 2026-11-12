import { describe, expect, it } from "vitest";
import { formatUsage, meteredCostCny } from "./metered-price";

describe("按用量计价（H4）", () => {
  it("文本按百万 token 折算", () => {
    // 12.4k token × ¥2 / 百万 = ¥0.0248
    expect(meteredCostCny("text", 12_400, 2)).toBeCloseTo(0.0248, 6);
    expect(meteredCostCny("text", 1_000_000, 2)).toBe(2);
  });

  it("配音按千字折算", () => {
    // 86 字 × ¥0.15 / 千字 = ¥0.0129
    expect(meteredCostCny("tts", 86, 0.15)).toBeCloseTo(0.0129, 6);
    expect(meteredCostCny("tts", 1_000, 0.15)).toBe(0.15);
  });

  it("单价没填就不算钱：未知不是免费", () => {
    expect(meteredCostCny("text", 12_400, undefined)).toBeUndefined();
    expect(meteredCostCny("tts", 86, undefined)).toBeUndefined();
  });

  it("用量没有或为 0 也算不出钱", () => {
    expect(meteredCostCny("text", undefined, 2)).toBeUndefined();
    expect(meteredCostCny("tts", 0, 0.15)).toBeUndefined();
    expect(meteredCostCny("text", Number.NaN, 2)).toBeUndefined();
  });

  it("单价为 0 是合法的：免费模型照样算得出来", () => {
    expect(meteredCostCny("text", 12_400, 0)).toBe(0);
  });

  it("小调用不被抹成 0：留四位小数", () => {
    // 1 字 × ¥0.15 / 千字 = ¥0.00015；两位小数会变成 0，四位小数还看得见
    expect(meteredCostCny("tts", 1, 0.15)).toBe(0.0001);
    expect(meteredCostCny("tts", 1, 0.15)).toBeGreaterThan(0);
  });

  it("用量念成一句人话", () => {
    expect(formatUsage(12_400, "tokens")).toBe("12.4k token");
    expect(formatUsage(320, "tokens")).toBe("320 token");
    expect(formatUsage(86, "chars")).toBe("86 字");
  });
});
