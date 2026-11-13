import { describe, expect, it } from "vitest";
import {
  GAP_MS,
  READ_CPS_HARD,
  SILENT_ISSUE_LABEL,
  silentWatch,
  type SilentCueInput,
  type SilentShotInput,
} from "./silent-watch";

/**
 * 静音可懂度（C13 / ADR-0164）。
 *
 * 这些用例锁住三件事：读不完 / 一闪而过按字数与时间算；信息断点按空档算；
 * 指代不清只在前面真的没提过人时才报。
 */

function cue(over: Partial<SilentCueInput> & { cueId: string; text: string }): SilentCueInput {
  return {
    lineId: `l-${over.cueId}`,
    shotId: "s-1",
    shotNo: 1,
    speaker: "甲",
    startMs: 0,
    durationMs: 2000,
    ...over,
  };
}

function shot(over: Partial<SilentShotInput> & { shotId: string }): SilentShotInput {
  return { shotNo: 1, startMs: 0, durationMs: 5000, characters: [], ...over };
}

describe("静音可懂度（C13 / ADR-0164）", () => {
  it("字数 ÷ 秒数超过硬线就标读不完，并给出该压到几个字", () => {
    const report = silentWatch({
      cues: [cue({ cueId: "c-1", text: "你现在先回去把合同签了再走", startMs: 0, durationMs: 1000 })],
      shots: [shot({ shotId: "s-1" })],
      totalMs: 5000,
    });
    const first = report.cues[0]!;
    expect(first.cps).toBeGreaterThan(READ_CPS_HARD);
    expect(first.issue).toBe("unreadable");
    expect(first.suggestedChars).toBeGreaterThan(0);
    expect(first.suggestedChars!).toBeLessThan(first.chars);
    expect(report.summary.unreadable).toBe(1);
  });

  it("停留太短的一条算一闪而过", () => {
    const report = silentWatch({
      cues: [cue({ cueId: "c-1", text: "放下。", durationMs: 400 })],
      shots: [shot({ shotId: "s-1" })],
      totalMs: 3000,
    });
    expect(report.cues[0]?.issue).toBe("flash");
    expect(report.summary.flash).toBe(1);
  });

  it("长空档算信息断点，前后各算一段", () => {
    const report = silentWatch({
      cues: [
        cue({ cueId: "c-1", text: "你来了。", startMs: 1000, durationMs: 1500 }),
        cue({ cueId: "c-2", text: "我来了。", startMs: 20_000, durationMs: 1500 }),
      ],
      shots: [
        shot({ shotId: "s-1", shotNo: 1, startMs: 0, durationMs: 5000 }),
        shot({ shotId: "s-2", shotNo: 2, startMs: 5000, durationMs: 20_000 }),
      ],
      totalMs: 30_000,
    });
    // 0 → 1000 不够 GAP_MS；2500 → 20000 够；21500 → 30000 也够
    expect(report.gaps).toHaveLength(2);
    expect(report.gaps[0]!.durationMs).toBeGreaterThanOrEqual(GAP_MS);
    expect(report.summary.gap).toBe(2);
  });

  it("前面提过人名时，指代词不算不清", () => {
    const report = silentWatch({
      cues: [
        cue({ cueId: "c-1", text: "周衡，合同在你手上。", speaker: "林", startMs: 0, durationMs: 2000 }),
        cue({ cueId: "c-2", text: "他把字签了。", speaker: "林", startMs: 2000, durationMs: 2000 }),
      ],
      shots: [shot({ shotId: "s-1", durationMs: 5000, characters: ["林", "周衡"] })],
      totalMs: 5000,
    });
    expect(report.pronouns).toHaveLength(0);
  });

  it("前面没提过人时，指代词算指代不清", () => {
    const report = silentWatch({
      cues: [
        cue({ cueId: "c-1", text: "把门关上。", speaker: "林", startMs: 0, durationMs: 2000 }),
        cue({ cueId: "c-2", text: "那个人不会来了。", speaker: "林", startMs: 2000, durationMs: 2000 }),
      ],
      shots: [shot({ shotId: "s-1", durationMs: 5000 })],
      totalMs: 5000,
    });
    expect(report.pronouns).toHaveLength(1);
    expect(report.pronouns[0]!.lead).toBe("那个");
  });

  it("一镜里两个人换着说话，标出分不清谁在说", () => {
    const report = silentWatch({
      cues: [
        cue({ cueId: "c-1", text: "放下。", speaker: "甲", startMs: 0, durationMs: 1500 }),
        cue({ cueId: "c-2", text: "凭什么。", speaker: "乙", startMs: 1500, durationMs: 1500 }),
      ],
      shots: [shot({ shotId: "s-1", durationMs: 5000 })],
      totalMs: 5000,
    });
    expect(report.speakers).toHaveLength(1);
    expect(report.speakers[0]!.speakers).toEqual(["甲", "乙"]);
  });

  it("按角色着色时说话人不清扣得更少", () => {
    const input = {
      cues: [
        cue({ cueId: "c-1", text: "放下。", speaker: "甲", startMs: 0, durationMs: 1500 }),
        cue({ cueId: "c-2", text: "凭什么。", speaker: "乙", startMs: 1500, durationMs: 1500 }),
      ],
      shots: [shot({ shotId: "s-1", durationMs: 5000 })],
      totalMs: 5000,
    };
    const plain = silentWatch(input);
    const colored = silentWatch({ ...input, speakerColors: true });
    expect(colored.score).toBeGreaterThanOrEqual(plain.score);
  });

  it("干净的片子给高分，并说清哪些测不了", () => {
    const report = silentWatch({
      cues: [
        cue({ cueId: "c-1", text: "周衡，合同在你手上。", speaker: "林", startMs: 0, durationMs: 3000 }),
        cue({ cueId: "c-2", text: "我知道。", speaker: "林", startMs: 3000, durationMs: 2000 }),
      ],
      shots: [shot({ shotId: "s-1", durationMs: 5000, characters: ["林", "周衡"] })],
      totalMs: 5000,
    });
    expect(report.grade).toBe("good");
    expect(report.verdict).toContain("静音也跟得上");
    expect(report.untested).toContain("只查字幕");
  });

  it("没有字幕时不崩，覆盖率是 0", () => {
    const report = silentWatch({ cues: [], shots: [], totalMs: 0 });
    expect(report.cues).toHaveLength(0);
    expect(report.coverage.ratio).toBe(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });

  it("纯函数：同一份输入两次结果一致", () => {
    const input = {
      cues: [cue({ cueId: "c-1", text: "你现在先回去把合同签了再走" })],
      shots: [shot({ shotId: "s-1" })],
      totalMs: 5000,
    };
    expect(JSON.stringify(silentWatch(input))).toBe(JSON.stringify(silentWatch(input)));
  });

  it("每种问题都有中文标签", () => {
    for (const label of Object.values(SILENT_ISSUE_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
