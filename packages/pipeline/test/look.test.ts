import { DEFAULT_LOOK } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOK_LINE,
  DEFAULT_STUDIO_LOOK_LINE,
  LOOK_PRESETS,
  compileLook,
  compileStudioLook,
  isDefaultLook,
  lookPresetById,
} from "../src/look";

/**
 * 画面风格编译（B7 / I5，ADR-0165）。
 *
 * 锁住三件事：默认档与以前逐字一致、预设能被逐项参数修正、手写补充句排在最后。
 */

describe("风格预设库（B7 / ADR-0165）", () => {
  it("每个预设 id 唯一，且都有名字与提示词句", () => {
    const ids = LOOK_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of LOOK_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.phrase.length).toBeGreaterThan(0);
    }
  });

  it("按 id 找得到，找不到返回 undefined", () => {
    expect(lookPresetById("cinema")?.name).toBe("实拍电影");
    expect(lookPresetById("nope")).toBeUndefined();
  });
});

describe("compileLook（I5 / ADR-0165）", () => {
  it("默认档与旧提示词的最后一字不差", () => {
    expect(compileLook(DEFAULT_LOOK)).toBe(DEFAULT_LOOK_LINE);
    expect(compileLook(undefined)).toBe(DEFAULT_LOOK_LINE);
  });

  it("选预设就用预设的整句", () => {
    const line = compileLook({ ...DEFAULT_LOOK, presetId: "noir" });
    expect(line).toContain("黑色电影质感");
    expect(line.startsWith("竖屏 9:16")).toBe(true);
  });

  it("预设之外改过的项以参数为准，整句重编不留矛盾", () => {
    const line = compileLook({ ...DEFAULT_LOOK, presetId: "noir", temperature: "warm" });
    // 预设的质感名词保留，技术项一律按参数来
    expect(line).toContain("黑色电影质感");
    expect(line).toContain("暖调");
    // 不能同时出现「冷调」与「暖调」这种自相矛盾的指令
    expect(line).not.toContain("冷调");
  });

  it("没选预设但改过项时按逐项参数拼", () => {
    const line = compileLook({ ...DEFAULT_LOOK, contrast: "hard", temperature: "cool", texture: "clean" });
    expect(line).toContain("硬光，高反差");
    expect(line).toContain("冷调");
    expect(line).toContain("画面干净，无颗粒");
    expect(line).not.toBe(DEFAULT_LOOK_LINE);
  });

  it("手写补充句排在最后", () => {
    const line = compileLook({ ...DEFAULT_LOOK, presetId: "cinema", note: "雨夜霓虹" });
    expect(line.endsWith("雨夜霓虹")).toBe(true);
  });

  it("纯函数：同样参数两次结果一致", () => {
    const look = { ...DEFAULT_LOOK, presetId: "drama" };
    expect(compileLook(look)).toBe(compileLook(look));
  });
});

describe("compileStudioLook（定妆与道具）", () => {
  it("默认档保持棚拍口径", () => {
    expect(compileStudioLook(DEFAULT_LOOK)).toBe(DEFAULT_STUDIO_LOOK_LINE);
    expect(compileStudioLook(undefined)).toBe(DEFAULT_STUDIO_LOOK_LINE);
  });

  it("改过风格时接上项目质感，仍保留棚拍", () => {
    const line = compileStudioLook({ ...DEFAULT_LOOK, presetId: "warm" });
    expect(line).toContain("家庭剧质感");
    expect(line.endsWith("柔光棚拍")).toBe(true);
  });
});

describe("isDefaultLook", () => {
  it("没动过返回 true，动过一项就 false", () => {
    expect(isDefaultLook(undefined)).toBe(true);
    expect(isDefaultLook(DEFAULT_LOOK)).toBe(true);
    expect(isDefaultLook({ ...DEFAULT_LOOK, presetId: "cinema" })).toBe(false);
    expect(isDefaultLook({ ...DEFAULT_LOOK, note: "雨夜" })).toBe(false);
  });
});
