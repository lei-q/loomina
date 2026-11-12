import { describe, expect, it } from "vitest";
import {
  PROMPT_OVERRIDE_MAX,
  STORY_PROMPT_OVERRIDE_MAX,
  readPromptOverride,
} from "./prompt-override";

describe("手改提示词（ADR-0148）", () => {
  it("缺省、空串与纯空白都按「没改」处理", () => {
    expect(readPromptOverride(undefined)).toEqual({});
    expect(readPromptOverride(null)).toEqual({});
    expect(readPromptOverride("")).toEqual({});
    expect(readPromptOverride("  \n ")).toEqual({});
  });

  it("非字符串直接说清哪里不对", () => {
    expect(readPromptOverride(42)).toEqual({ error: "提示词只能是文本" });
    expect(readPromptOverride({ text: "x" })).toEqual({ error: "提示词只能是文本" });
  });

  it("去掉首尾空白后原样返回", () => {
    expect(readPromptOverride("  雨夜，巷口  ")).toEqual({ prompt: "雨夜，巷口" });
  });

  it("超过上限拒绝，不为一次生成偷偷截断", () => {
    expect(readPromptOverride("雨".repeat(PROMPT_OVERRIDE_MAX))).toEqual({
      prompt: "雨".repeat(PROMPT_OVERRIDE_MAX),
    });
    expect(readPromptOverride("雨".repeat(PROMPT_OVERRIDE_MAX + 1)).error).toContain(
      String(PROMPT_OVERRIDE_MAX),
    );
  });

  it("故事阶段可以单独放宽上限", () => {
    const text = "雨".repeat(PROMPT_OVERRIDE_MAX + 1);
    expect(readPromptOverride(text).error).toBeDefined();
    expect(readPromptOverride(text, STORY_PROMPT_OVERRIDE_MAX)).toEqual({ prompt: text });
  });
});
