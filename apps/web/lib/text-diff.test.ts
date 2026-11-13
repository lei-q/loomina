import { describe, expect, it } from "vitest";
import { textDiff } from "./text-diff";

describe("版本对比（C2 / C14）", () => {
  it("改一个字同时出现在多 / 少两栏，重复行只算一次差额", () => {
    expect(textDiff("甲\n乙\n丙", "甲\n乙改\n丁")).toEqual({
      added: ["乙改", "丁"],
      removed: ["乙", "丙"],
    });
    expect(textDiff("重复\n重复", "重复")).toEqual({ added: [], removed: ["重复"] });
  });

  it("空行不算差异；完全一样两栏都空", () => {
    expect(textDiff("甲\n\n乙\n", "甲\n乙")).toEqual({ added: [], removed: [] });
  });
});
