import { describe, expect, it } from "vitest";
import {
  INTENSITY_ACTION_SCALE,
  PERFORMANCE_GRAMMAR_VERSION,
  PERFORMANCE_INTENTS,
  intentOf,
  performanceAdvice,
  performanceCoverage,
} from "./performance-grammar";

describe("表演语法库（I11 / ADR-0220）", () => {
  it("版本号可追溯，与导演语法库同一写法", () => {
    expect(PERFORMANCE_GRAMMAR_VERSION).toMatch(/^\d{4}-\d{2}$/);
  });

  it("七组意图与 PERFORMANCE.md §五 一一对应，id 唯一", () => {
    expect(PERFORMANCE_INTENTS).toHaveLength(7);
    const ids = PERFORMANCE_INTENTS.map((intent) => intent.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PERFORMANCE_INTENTS.map((intent) => intent.name)).toEqual([
      "压抑的愤怒",
      "心虚",
      "震惊",
      "亲密",
      "决绝",
      "轻蔑",
      "崩溃",
    ]);
  });

  it("每组都写了可生成的手段与要避开的东西", () => {
    for (const intent of PERFORMANCE_INTENTS) {
      expect(intent.micro.length, intent.id).toBeGreaterThan(0);
      expect(intent.body.length, intent.id).toBeGreaterThan(0);
      expect(intent.avoid.length, intent.id).toBeGreaterThan(0);
      expect(intent.intensityHint).toBeGreaterThanOrEqual(1);
      expect(intent.intensityHint).toBeLessThanOrEqual(5);
    }
  });

  it("强度五档都有动作幅度说明，且越强越受限", () => {
    for (const level of [1, 2, 3, 4, 5] as const) {
      expect(INTENSITY_ACTION_SCALE[level].length).toBeGreaterThan(4);
    }
    expect(INTENSITY_ACTION_SCALE[5]).toContain("几乎不动");
  });

  it("按意图名与常见同义词都能认出来", () => {
    expect(intentOf("压抑的愤怒")?.id).toBe("suppressed-anger");
    expect(intentOf("她很生气")?.id).toBe("suppressed-anger");
    expect(intentOf("显得心虚")?.id).toBe("guilty");
    expect(intentOf("震惊")?.id).toBe("shock");
    expect(intentOf("下定决心")?.id).toBe("resolve");
    expect(intentOf("崩溃")?.id).toBe("collapse");
  });

  it("认不出的不猜", () => {
    expect(intentOf("")).toBeUndefined();
    expect(intentOf("随便看看")).toBeUndefined();
  });

  it("强度 4–5 写了大幅动作就提醒：情绪越强动作越小", () => {
    const advice = performanceAdvice({
      objective: "压抑的愤怒",
      intensity: 5,
      beats: [{ body: "她突然大喊着扑过去" }],
      avoid: ["大吼"],
    });
    expect(advice.problems.some((line) => line.includes("大喊") || line.includes("扑"))).toBe(
      true,
    );
  });

  it("强度低时写大动作不算问题", () => {
    const advice = performanceAdvice({
      objective: "日常",
      intensity: 2,
      beats: [{ body: "她跑过去" }],
      avoid: ["大吼"],
    });
    expect(advice.problems).toEqual([]);
  });

  it("认出意图但没写 avoid 要提醒，并给出建议的 avoid", () => {
    const advice = performanceAdvice({
      objective: "心虚",
      intensity: 3,
      beats: [{ micro: "视线下移" }],
      avoid: [],
    });
    expect(advice.intent?.id).toBe("guilty");
    expect(advice.problems.some((line) => line.includes("没写"))).toBe(true);
    expect(advice.avoid).toContain("复杂手部动作");
  });

  it("写了 avoid 就不再提醒", () => {
    const advice = performanceAdvice({
      objective: "心虚",
      intensity: 3,
      beats: [{ micro: "视线下移" }],
      avoid: ["复杂手部动作"],
    });
    expect(advice.problems).toEqual([]);
  });

  it("覆盖率如实说：七组、按哪一版", () => {
    expect(performanceCoverage()).toEqual({
      intents: 7,
      version: PERFORMANCE_GRAMMAR_VERSION,
    });
  });
});
