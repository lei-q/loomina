import { describe, expect, it } from "vitest";
import { matchQuery, paginate } from "./library-filters";

describe("版本库筛选（C14 / ADR-0205）", () => {
  it("空搜索放行；多词全部命中才算，大小写无关", () => {
    expect(matchQuery(["走廊尽头", "灯管闪了一下"], "")).toBe(true);
    expect(matchQuery(["走廊尽头", "灯管闪了一下"], "  走廊 灯管 ")).toBe(true);
    expect(matchQuery(["走廊尽头", "灯管闪了一下"], "走廊 桌子")).toBe(false);
    expect(matchQuery(["Take MINIMAX-H3"], "minimax")).toBe(true);
  });

  it("分页：页码从 0 数，越界收回最后一页", () => {
    const items = [1, 2, 3, 4, 5];
    expect(paginate(items, 0, 2)).toEqual({ rows: [1, 2], page: 0, pageCount: 3, total: 5 });
    expect(paginate(items, 2, 2)).toEqual({ rows: [5], page: 2, pageCount: 3, total: 5 });
    expect(paginate(items, 99, 2)).toEqual({ rows: [5], page: 2, pageCount: 3, total: 5 });
    expect(paginate([], 0, 20)).toEqual({ rows: [], page: 0, pageCount: 1, total: 0 });
  });
});
