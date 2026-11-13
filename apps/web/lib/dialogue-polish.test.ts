import { describe, expect, it } from "vitest";
import {
  MAX_LINE_CHARS,
  PUNCH_LINE,
  compressLine,
  polishDialogue,
  punchScore,
} from "./dialogue-polish";

/**
 * 台词压缩与金句（A20 / ADR-0163）。
 *
 * 规则只回答「这句能不能更短、像不像金句」，不判断台词写得好不好；
 * 这些用例锁住三件事：删的是废话、不硬截断、分数能解释。
 */

describe("台词压缩（A20 / ADR-0163）", () => {
  it("删填充词就能压进 15 字", () => {
    const result = compressLine("其实我觉得你现在应该先回去把合同签了再走");
    expect(result.text).toBe("你现在先回去把合同签了再走");
    expect([...result.text!].length).toBeLessThanOrEqual(MAX_LINE_CHARS);
    expect(result.reason).toContain("填充词");
  });

  it("删掉解释性从句，留主句", () => {
    const result = compressLine("你先把合同放下，因为签字的人根本不是我");
    expect(result.text).toBe("你先把合同放下");
    expect(result.reason).toContain("因为");
  });

  it("没有解释时留最后半句：响点通常在句尾", () => {
    const result = compressLine("我在这家公司干了十年，今天才知道这张桌子是谁的");
    expect(result.text).toBe("今天才知道这张桌子是谁的");
    expect(result.reason).toContain("最后半句");
  });

  it("压不进去时不硬截断，只给方向", () => {
    const result = compressLine("这一整段话没有任何可以删掉的部分它必须完整说完才成立");
    expect(result.text).toBeUndefined();
    expect(result.reason).toContain("不替你硬截断");
  });

  it("已经够短就不动它", () => {
    const result = compressLine("滚。");
    expect(result.text).toBeUndefined();
    expect(result.reason).toContain("不用压");
  });
});

describe("金句分（A20 / ADR-0163）", () => {
  it("短、有落点词、没有废话的句子分更高", () => {
    const punch = punchScore("凭什么。");
    const fluff = punchScore("其实我觉得你可能应该再考虑一下这件事情");
    expect(punch.score).toBeGreaterThan(fluff.score);
    expect(fluff.notes.some((note) => note.includes("填充词"))).toBe(true);
  });

  it("空台词不给分", () => {
    expect(punchScore("   ").score).toBe(0);
  });
});

describe("整份台词报告（A20 / ADR-0163）", () => {
  const lines = [
    { lineId: "d-1", shotId: "s-1", shotNo: 1, speaker: "甲", text: "其实我觉得这件事可以先放一放再说吧" },
    { lineId: "d-2", shotId: "s-1", shotNo: 1, speaker: "乙", text: "放下。" },
    { lineId: "d-3", shotId: "s-1", shotNo: 1, speaker: "甲", text: "你听我解释" },
    { lineId: "d-4", shotId: "s-2", shotNo: 2, speaker: "乙", text: "凭什么。" },
  ];

  it("标出过长、在解释、有废话与一镜两句以上", () => {
    const report = polishDialogue(lines);
    const first = report.lines.find((line) => line.lineId === "d-1")!;
    expect(first.issues).toContain("long");
    expect(first.issues).toContain("filled");
    expect(first.issues).toContain("crowded");
    expect(report.shots.find((shot) => shot.shotId === "s-1")?.issue).toBe("crowded");
    expect(report.shots.find((shot) => shot.shotId === "s-2")?.issue).toBeUndefined();
  });

  it("金句候选按分数排，短句排在前面", () => {
    const report = polishDialogue(lines);
    expect(report.punches[0]?.lineId).toBe("d-4");
    expect(report.punches.every((line) => line.punch >= PUNCH_LINE)).toBe(true);
  });

  it("汇总给出平均字数与能省下的字数", () => {
    const report = polishDialogue(lines);
    expect(report.totalLines).toBe(4);
    expect(report.averageChars).toBeGreaterThan(0);
    expect(report.savedChars).toBeGreaterThan(0);
    expect(report.problems.map((line) => line.lineId)).toContain("d-1");
  });

  it("纯函数：同一份输入两次结果一致", () => {
    expect(JSON.stringify(polishDialogue(lines))).toBe(JSON.stringify(polishDialogue(lines)));
  });
});
