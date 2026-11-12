import { describe, expect, it } from "vitest";
import {
  SPEAKER_COLORS,
  SPEAKER_DEFAULT_COLOR,
  assColorOf,
  speakerColorAt,
  speakerPaletteOf,
} from "./speaker-color";

describe("按角色着色（D3）", () => {
  it("按角色顺序取色：两个角色一定不同色", () => {
    const palette = speakerPaletteOf(["c-lin", "c-zhou"]);
    expect(palette.get("c-lin")).toBe(SPEAKER_COLORS[0]);
    expect(palette.get("c-zhou")).toBe(SPEAKER_COLORS[1]);
    expect(palette.get("c-lin")).not.toBe(palette.get("c-zhou"));
  });

  it("超过色板长度从头轮回，不越界", () => {
    expect(speakerColorAt(SPEAKER_COLORS.length)).toBe(SPEAKER_COLORS[0]);
    expect(speakerColorAt(SPEAKER_COLORS.length + 1)).toBe(SPEAKER_COLORS[1]);
    expect(speakerColorAt(-1)).toBe(SPEAKER_COLORS.at(-1));
    expect(speakerColorAt(Number.NaN)).toBe(SPEAKER_DEFAULT_COLOR);
  });

  it("同一组角色 id 每次都得到同一组颜色", () => {
    const first = speakerPaletteOf(["a", "b", "c"]);
    const second = speakerPaletteOf(["a", "b", "c"]);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it("ASS 颜色是 BGR 顺序，格式不对就不覆盖", () => {
    expect(assColorOf("#FFD666")).toBe("{\\c&H66D6FF&}");
    expect(assColorOf("#7fd8ff")).toBe("{\\c&HFFD87F&}");
    expect(assColorOf("red")).toBe("");
    expect(assColorOf("#FFF")).toBe("");
  });
});
