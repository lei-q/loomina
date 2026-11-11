import { describe, expect, it } from "vitest";
import type { VoicePerformance } from "@loomina/ir";
import {
  DEFAULT_PERFORMANCE,
  ENDING_LABEL,
  emphasisText,
  inputOf,
  instructionsOf,
  isDefaultPerformance,
  performanceOf,
  summarizePerformance,
  voiceTakesOf,
} from "./voice-performance";

function perf(patch: Partial<VoicePerformance> = {}): VoicePerformance {
  return { ...DEFAULT_PERFORMANCE, ...patch };
}

describe("逐句表演参数（C2 / ADR-0124）", () => {
  it("默认值就是原速、平、没有重音与停顿", () => {
    expect(isDefaultPerformance(DEFAULT_PERFORMANCE)).toBe(true);
    expect(summarizePerformance(DEFAULT_PERFORMANCE)).toBe("默认");
    expect(instructionsOf(DEFAULT_PERFORMANCE)).toBeUndefined();
  });

  it("摘要只写改过的项", () => {
    expect(summarizePerformance(perf({ rate: 1.25 }))).toBe("1.25×");
    expect(summarizePerformance(perf({ pitch: -2 }))).toBe("-2 半音");
    expect(summarizePerformance(perf({ pitch: 3 }))).toBe("+3 半音");
    expect(summarizePerformance(perf({ breathiness: 0.3 }))).toBe("气声 30%");
    expect(
      summarizePerformance(
        perf({
          rate: 1.2,
          pitch: -2,
          breathiness: 0.3,
          emphasis: [{ start: 0, end: 2, strength: 2 }],
          pauses: [{ afterChar: 3, ms: 400 }],
          emotion: "克制",
          ending: "fall",
        }),
      ),
    ).toBe("1.2× · -2 半音 · 气声 30% · 重读 1 处 · 停 1 处 · 克制 · 下沉");
  });

  it("instructions 只写怎么念，不改字", () => {
    const text = instructionsOf(
      perf({ emotion: "克制", ending: "fall", breathiness: 0.3, pauses: [{ afterChar: 3, ms: 300 }] }),
    );
    expect(text).toContain("情绪：克制");
    expect(text).toContain("句尾下沉");
    expect(text).toContain("气声比例约 30%");
    expect(text).toContain("不要改动文字");
    // 停顿走标点，不在这里重复一遍
    expect(text).not.toContain("停顿");
  });

  it("停顿插标点，一个字都不改；短停逗号、长停省略号", () => {
    const text = "你早就知道了对吧";
    expect(inputOf(text, perf())).toBe(text);
    expect(inputOf(text, perf({ pauses: [{ afterChar: 2, ms: 300 }] }))).toBe("你早，就知道了对吧");
    expect(inputOf(text, perf({ pauses: [{ afterChar: 2, ms: 900 }] }))).toBe(
      "你早……就知道了对吧",
    );
    // 已有标点 / 句首 / 句尾都不插
    expect(inputOf("你早，就知道了", perf({ pauses: [{ afterChar: 2, ms: 300 }] }))).toBe(
      "你早，就知道了",
    );
    expect(inputOf(text, perf({ pauses: [{ afterChar: 0, ms: 300 }] }))).toBe(text);
    expect(inputOf(text, perf({ pauses: [{ afterChar: 99, ms: 300 }] }))).toBe(text);
    // 多处分隔符：从后往前插，前面的下标不会错位
    expect(
      inputOf(text, perf({ pauses: [{ afterChar: 1, ms: 300 }, { afterChar: 4, ms: 300 }] })),
    ).toBe("你，早就知，道了对吧");
    // 去掉标点后与原文一致：只加了标点，没改字
    expect(inputOf(text, perf({ pauses: [{ afterChar: 2, ms: 300 }] })).replace(/[，…]/g, "")).toBe(
      text,
    );
  });

  it("没有写过的句子按默认值处理，不写回 IR", () => {
    const line = { id: "d1", characterId: "c1", text: "走", durationMs: 1000 };
    expect(performanceOf(line)).toBe(DEFAULT_PERFORMANCE);
  });

  it("重音按字符区间取字，越界返回空", () => {
    expect(emphasisText("你早就知道了", 0, 2)).toBe("你早");
    expect(emphasisText("你早就知道了", 3, 99)).toBe("知道了");
    expect(emphasisText("你", 2, 4)).toBe("");
  });

  it("试听台按台词筛", () => {
    const takes = [
      { id: "t1", lineId: "d1" },
      { id: "t2", lineId: "d2" },
      { id: "t3", lineId: "d1" },
    ] as never;
    expect(voiceTakesOf(takes, "d1").map((take: { id: string }) => take.id)).toEqual(["t1", "t3"]);
    expect(voiceTakesOf(takes, "d9")).toEqual([]);
  });

  it("句尾三档都有中文名", () => {
    expect(Object.keys(ENDING_LABEL)).toEqual(["rise", "flat", "fall"]);
    expect(ENDING_LABEL.rise).toBe("上扬");
  });
});
