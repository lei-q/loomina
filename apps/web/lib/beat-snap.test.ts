import { describe, expect, it } from "vitest";
import {
  BEAT_TOLERANCE_MS,
  BPM_MAX,
  BPM_MIN,
  beatGridOf,
  beatMsOf,
  beatSnapText,
  cutsOfClips,
  nearestBeat,
  snapCuts,
} from "./beat-snap";

describe("节拍卡点（C5 / ADR-0221）", () => {
  it("一拍时长 = 60000 / BPM，细分按除数", () => {
    expect(beatMsOf(120)).toBe(500);
    expect(beatMsOf(120, 2)).toBe(250);
    expect(beatMsOf(120, 4)).toBe(125);
  });

  it("BPM 越界夹到区间里，不抛错", () => {
    expect(beatMsOf(10)).toBe(60_000 / BPM_MIN);
    expect(beatMsOf(1000)).toBe(60_000 / BPM_MAX);
    expect(beatGridOf({ bpm: 9999 }).bpm).toBe(BPM_MAX);
  });

  it("最近网格点按 offset 起算", () => {
    const grid = beatGridOf({ bpm: 120, offsetMs: 100 });
    expect(nearestBeat(grid, 100)).toBe(100);
    // step = 500：网格是 100 / 600 / 1100 …
    expect(nearestBeat(grid, 340)).toBe(100);
    expect(nearestBeat(grid, 620)).toBe(600);
  });

  it("落在容忍范围内算踩上，超了算漂移", () => {
    const grid = beatGridOf({ bpm: 120 });
    const plan = snapCuts(
      [
        { atMs: 0, shotId: "s-1" },
        { atMs: 520, shotId: "s-2" },
        { atMs: 1_300, shotId: "s-3" },
      ],
      grid,
    );
    // 网格 0 / 500 / 1000 / 1500：0 踩上、520 差 20 踩上、1300 差 200 漂移
    expect(plan.summary.cuts).toBe(3);
    expect(plan.summary.aligned).toBe(2);
    expect(plan.summary.drifting).toBe(1);
    expect(plan.drifting[0]!.cut.shotId).toBe("s-3");
    expect(plan.drifting[0]!.offsetMs).toBe(-200);
  });

  it("偏差写清正负：正数表示切晚了", () => {
    const grid = beatGridOf({ bpm: 120 });
    const plan = snapCuts([{ atMs: 500 }], grid);
    expect(plan.alignments[0]!.offsetMs).toBe(0);
    // 700 最近的是 500（差 200），不是 1000（差 300）
    const late = snapCuts([{ atMs: 700 }], grid);
    expect(late.alignments[0]!.offsetMs).toBe(200);
    const early = snapCuts([{ atMs: 400 }], grid);
    expect(early.alignments[0]!.offsetMs).toBe(-100);
  });

  it("容忍边界正好算踩上", () => {
    const grid = beatGridOf({ bpm: 120 });
    expect(snapCuts([{ atMs: 500 + BEAT_TOLERANCE_MS }], grid).drifting).toHaveLength(0);
    expect(snapCuts([{ atMs: 500 + BEAT_TOLERANCE_MS + 1 }], grid).drifting).toHaveLength(1);
  });

  it("只在大跨度之间给补切建议", () => {
    const grid = beatGridOf({ bpm: 120 }); // 500ms 一格
    // 0 → 2000：跨 4 格，中间可以补
    const wide = snapCuts([{ atMs: 0 }, { atMs: 2_000 }], grid);
    expect(wide.suggestions).toHaveLength(1);
    expect(wide.suggestions[0]).toBe(1_000);
    // 0 → 700：跨 1.4 格，不建议补
    const narrow = snapCuts([{ atMs: 0 }, { atMs: 700 }], grid);
    expect(narrow.suggestions).toEqual([]);
  });

  it("没有切点时如实说，不编", () => {
    const plan = snapCuts([], beatGridOf({ bpm: 120 }));
    expect(plan.summary.cuts).toBe(0);
    expect(beatSnapText(plan)).toContain("还没有切点");
  });

  it("全踩上 / 有漂移两种话术都写清，并提醒不要为卡点切碎表演", () => {
    const grid = beatGridOf({ bpm: 120 });
    expect(beatSnapText(snapCuts([{ atMs: 500 }, { atMs: 1_000 }], grid))).toContain("都踩在拍上");
    const text = beatSnapText(snapCuts([{ atMs: 500 }, { atMs: 1_300 }], grid));
    expect(text).toContain("1 个偏了");
    expect(text).toContain("不要为了卡点把表演切碎");
  });

  it("非法切点（负数 / 非有限）被丢掉", () => {
    const plan = snapCuts(
      [{ atMs: -100 }, { atMs: Number.NaN }, { atMs: 500 }],
      beatGridOf({ bpm: 120 }),
    );
    expect(plan.summary.cuts).toBe(1);
  });

  it("从片段起点取切点：开头那个不算，按时间排好", () => {
    const cuts = cutsOfClips([
      { startMs: 2_000, shotId: "s-3" },
      { startMs: 0, shotId: "s-1" },
      { startMs: 1_000, shotId: "s-2" },
    ]);
    expect(cuts.map((cut) => cut.shotId)).toEqual(["s-2", "s-3"]);
  });
});
