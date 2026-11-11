import { describe, expect, it } from "vitest";
import { PromptBlockedError, assertPromptAllowed, moderatePrompt } from "./moderation";

describe("提示词审核（H6）", () => {
  it("干净提示词直接通过", () => {
    const result = moderatePrompt("中景，夜班护士站在走廊尽头，冷白色顶光", "image");
    expect(result.status).toBe("pass");
    expect(result.findings).toEqual([]);
    expect(result.summary).toContain("没有命中");
  });

  it("硬阻断命中时拦住，不把提示词发出去", () => {
    const result = moderatePrompt("特写，桌上摆着制毒用的玻璃器皿", "image");
    expect(result.status).toBe("block");
    expect(result.blocked).toBeGreaterThan(0);
    expect(result.categories).toContain("违法");
    expect(() => assertPromptAllowed("特写，桌上摆着制毒用的玻璃器皿", "image")).toThrow(
      PromptBlockedError,
    );
  });

  it("只有待确认项时照常生成，只回报数量", () => {
    const result = moderatePrompt("他站在门口，说要杀人", "video");
    expect(result.status).toBe("review");
    expect(result.review).toBeGreaterThan(0);
    expect(result.blocked).toBe(0);
    expect(assertPromptAllowed("他站在门口，说要杀人", "video")).toEqual(result);
  });

  it("空提示词不命中任何规则", () => {
    expect(moderatePrompt("   ", "image").status).toBe("pass");
  });

  it("图片与视频分别标注来源", () => {
    expect(moderatePrompt("算命", "image").summary).toContain("图片提示词");
    expect(moderatePrompt("算命", "video").summary).toContain("视频提示词");
  });
});
