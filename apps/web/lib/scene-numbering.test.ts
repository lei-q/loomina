import { describe, expect, it } from "vitest";
import { sceneNumberingOf } from "./scene-numbering";

const scene = (id: string, code: string, no: number) => ({
  id,
  code,
  label: code || String(no),
  no,
});

describe("场号连续性（A21 / ADR-0134）", () => {
  it("全是顺序号：没有提示", () => {
    const result = sceneNumberingOf([scene("a", "", 1), scene("b", "", 2)]);
    expect(result.explicit).toBe(0);
    expect(result.outOfOrder).toEqual([]);
    expect(result.hint).toBeUndefined();
  });

  it("显式场号与位置一致：没有提示", () => {
    const result = sceneNumberingOf([scene("a", "1", 1), scene("b", "2", 2)]);
    expect(result.explicit).toBe(2);
    expect(result.hint).toBeUndefined();
  });

  it("拖动后名字跟着场走：位置对不上就点名说明，但不改场号", () => {
    // 2A 被拖到第 1 位
    const result = sceneNumberingOf([
      scene("b", "2A", 1),
      scene("a", "", 2),
      scene("c", "", 3),
    ]);
    expect(result.outOfOrder).toEqual([{ id: "b", label: "2A", no: 1 }]);
    expect(result.hint).toContain("「第 2A 场」排在第 1 位");
    expect(result.hint).toContain("场号跟着场走");
  });

  it("纯字母场号没有位置含义，不算错位", () => {
    const result = sceneNumberingOf([scene("a", "A", 3), scene("b", "", 1)]);
    expect(result.outOfOrder).toEqual([]);
    expect(result.hint).toBeUndefined();
  });

  it("超过三场只列前三场，并说一共几场", () => {
    const result = sceneNumberingOf([
      scene("a", "5", 1),
      scene("b", "6", 2),
      scene("c", "7", 3),
      scene("d", "8", 4),
    ]);
    expect(result.outOfOrder).toHaveLength(4);
    expect(result.hint).toContain("等 4 场");
  });

  it("跳号（1、3）也照实说：它确实排在第 2 位", () => {
    // 场 2 是被故意删掉的，所以「第 3 场」在第 2 位是对的；
    // 提示帮作者看懂这件事，不是在报错
    const result = sceneNumberingOf([scene("a", "1", 1), scene("b", "3", 2)]);
    expect(result.outOfOrder).toEqual([{ id: "b", label: "3", no: 2 }]);
    expect(result.hint).toContain("「第 3 场」排在第 2 位");
  });
});
