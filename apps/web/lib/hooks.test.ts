import { describe, expect, it } from "vitest";
import { HOOK_TYPES, hookTypesFor, hookTypesOf, scoreHook } from "./hooks";

/**
 * 钩子设计器（A19 / ADR-0160）。
 *
 * 打分是规则不是审美：这些用例只保证分项能解释、套话会扣分、
 * 具体物件与时间压力会加分，空字符串不硬给分。
 */

describe("钩子设计器（A19 / ADR-0160）", () => {
  it("具体动作 + 物件的钩子胜过只有套话的钩子", () => {
    const concrete = scoreHook("被叫破身份的下一秒，他先把外卖递了过去。");
    const cliche = scoreHook("总裁车祸失忆后，竟然重生了。");
    expect(concrete.total).toBeGreaterThan(cliche.total);
    expect(concrete.visual).toBeGreaterThan(cliche.visual);
    expect(cliche.notes.some((note) => note.includes("套话"))).toBe(true);
  });

  it("时间压力与具体数字会抬高紧迫度与新鲜度", () => {
    const score = scoreHook("距离发布会开始只剩三分钟，大屏上还挂着假数据。");
    expect(score.urgency).toBeGreaterThan(50);
    expect(score.notes.join("")).toContain("时间压力");
    expect(score.notes.join("")).toContain("具体数字");
  });

  it("能认出命中的钩子类型：秘密 / 危机 + 倒计时", () => {
    expect(hookTypesOf("母亲去世后，账本里每个月都有一笔钱。").map((type) => type.id)).toContain(
      "secret",
    );
    expect(hookTypesOf("还有三分钟，他就死了。").map((type) => type.id)).toEqual(
      expect.arrayContaining(["danger", "deadline"]),
    );
    expect(hookTypesOf("")).toEqual([]);
  });

  it("空钩子不给分，只给一句提醒", () => {
    const score = scoreHook("   ");
    expect(score.total).toBe(0);
    expect(score.notes[0]).toContain("还没写");
  });

  it("分项与总分都封在 0–100；类型库的开场 / 结尾落点可用", () => {
    const long = scoreHook("门口。".repeat(40));
    for (const value of [long.total, long.curiosity, long.urgency, long.visual, long.novelty]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(hookTypesFor("opening").length).toBeGreaterThan(0);
    expect(hookTypesFor("ending").length).toBeGreaterThan(0);
    expect(HOOK_TYPES).toHaveLength(8);
  });
});
