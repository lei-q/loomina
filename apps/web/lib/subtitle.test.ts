import { describe, expect, it } from "vitest";
import { normalizeSubtitleText, splitSubtitleText, subtitleCues } from "./subtitle";

describe("字幕标点整理（ADR-0087）", () => {
  it("中文里的半角标点与字间空格收干净", () => {
    expect(normalizeSubtitleText(" 你 早 就 知 道 ,对 吧? ")).toBe("你早就知道，对吧？");
  });

  it("多余的标点折叠，重复的省略号保留成一组", () => {
    expect(normalizeSubtitleText("等一下！！！")).toBe("等一下！");
    expect(normalizeSubtitleText("他走了......")).toBe("他走了……");
  });

  it("英文台词不动它的标点", () => {
    expect(normalizeSubtitleText("Wait, what?")).toBe("Wait, what?");
  });
});

describe("中文字幕断句（ADR-0087）", () => {
  it("短句不硬断", () => {
    expect(splitSubtitleText("你早就知道，对吧。", 16)).toEqual(["你早就知道，对吧。"]);
  });

  it("按停顿切，不让一行超过字数", () => {
    const chunks = splitSubtitleText(
      "你早就知道，对吧。知道了又怎样。那就当没看见。",
      10,
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.replace(/[\s\p{P}]/gu, "").length).toBeLessThanOrEqual(10);
    }
  });

  it("引号里的停顿不切，整句引语留在同一行", () => {
    const chunks = splitSubtitleText("他说：“走吧，别回头。”然后他没再说话。", 8);
    expect(chunks[0]).toContain("“");
    expect(chunks[0]).toContain("”");
    expect(chunks[0]).not.toContain("然后");
  });

  it("超长无标点的一句按字数硬切，但也尽量停在停顿后", () => {
    const chunks = splitSubtitleText("你真的以为那天晚上我什么都没有看见吗", 9);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.replace(/[\s\p{P}]/gu, "").length).toBeLessThanOrEqual(9);
    expect(chunks.join("")).toBe("你真的以为那天晚上我什么都没有看见吗");
  });

  it("空台词没有字幕", () => {
    expect(splitSubtitleText("   ", 16)).toEqual([]);
  });
});

describe("字幕时间分配（ADR-0087）", () => {
  it("每条时间加起来正好是整句，起点首尾相接", () => {
    const cues = subtitleCues("你早就知道，对吧。知道了又怎样。", 4200, {
      maxChars: 8,
      minCueMs: 600,
    });
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0]!.startMs).toBe(0);
    expect(cues.at(-1)!.startMs + cues.at(-1)!.durationMs).toBe(4200);
    for (let index = 1; index < cues.length; index += 1) {
      expect(cues[index]!.startMs).toBe(
        cues[index - 1]!.startMs + cues[index - 1]!.durationMs,
      );
    }
    for (const cue of cues) expect(cue.durationMs).toBeGreaterThanOrEqual(600);
  });

  it("字多的那条分到更多时间", () => {
    const cues = subtitleCues("你早就知道，对吧。知道了又怎样。", 4200, {
      maxChars: 8,
      minCueMs: 200,
    });
    expect(cues[0]!.durationMs).toBeGreaterThanOrEqual(cues[1]!.durationMs);
  });

  it("时间太短就合并，不让一行一闪而过", () => {
    const cues = subtitleCues("你早就知道，对吧。知道了又怎样。", 1000, {
      maxChars: 8,
      minCueMs: 600,
    });
    expect(cues).toHaveLength(1);
    expect(cues[0]!.durationMs).toBe(1000);
  });
});
