import { describe, expect, it } from "vitest";
import { DIRECTOR_RULES } from "./director-grammar";
import {
  EVAL_CASES,
  EVAL_SET_VERSION,
  evalText,
  runCase,
  runEvalSuite,
  shotSizeEntropy,
  type EvalCase,
} from "./rule-eval";

describe("规则评测集（I9 / ADR-0224）", () => {
  it("版本号可追溯，与语法库同一写法", () => {
    expect(EVAL_SET_VERSION).toMatch(/^\d{4}-\d{2}$/);
  });

  it("每条用例都有 id / what / rule / kind，id 唯一", () => {
    const ids = EVAL_CASES.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const testCase of EVAL_CASES) {
      expect(testCase.what.length).toBeGreaterThan(4);
      expect(testCase.project.shots.length).toBeGreaterThan(0);
    }
  });

  it("整套用例全过：规则判定方向没有写反", () => {
    const report = runEvalSuite(EVAL_CASES);
    const failed = report.results.filter((result) => !result.passed);
    expect(failed.map((result) => `${result.id}: ${result.reason}`)).toEqual([]);
    expect(report.summary.failed).toBe(0);
  });

  it("反例真的报、正例真的不报（逐条核，不只看总数）", () => {
    for (const testCase of EVAL_CASES) {
      const result = runCase(testCase);
      if (testCase.kind === "negative") {
        expect(result.hit, testCase.id).toContain(testCase.rule);
      } else {
        expect(result.hit, testCase.id).not.toContain(testCase.rule);
      }
    }
  });

  it("12 条规则（must + should）全部有用例", () => {
    const report = runEvalSuite(EVAL_CASES);
    const allRules = DIRECTOR_RULES.map((rule) => rule.id);
    expect(report.summary.rulesCovered).toBe(allRules.length);
    expect(report.summary.rulesMissing).toEqual([]);
    // should / may 也不再缺席
    expect(report.summary.optionalMissing).toEqual([]);
  });

  it("指标算得出来：违规率、景别熵、镜头总数", () => {
    const report = runEvalSuite(EVAL_CASES);
    expect(report.metrics.shots).toBe(
      EVAL_CASES.reduce((sum, testCase) => sum + testCase.project.shots.length, 0),
    );
    expect(report.metrics.violationRatePer100).toBeGreaterThan(0);
    expect(report.metrics.shotSizeEntropy).toBeGreaterThan(0);
  });

  it("景别熵：全同一种景别是 0，越均匀越高", () => {
    // 用 EVAL_CASES 里现成的项目：V6 正例是 four kinds、V6 反例有重复
    const v6Positive = EVAL_CASES.find((item) => item.id === "V6-positive")!.project;
    const v1Positive = EVAL_CASES.find((item) => item.id === "V1-positive")!.project;
    expect(shotSizeEntropy([v1Positive])).toBeGreaterThan(0);
    expect(shotSizeEntropy([v6Positive])).toBeGreaterThan(1);
    expect(shotSizeEntropy([])).toBe(0);
  });

  it("失败时写清是哪条用例、期望什么、实际什么", () => {
    const healthy = EVAL_CASES.find((item) => item.id === "V6-positive")!;
    const broken: EvalCase = {
      ...healthy,
      id: "broken",
      what: "故意写反的期望",
      kind: "negative",
    };
    const result = runCase(broken);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("V6");
    expect(result.reason).toContain("期望");
  });

  it("一句话摘要说清用例数、覆盖与缺口", () => {
    const text = evalText(runEvalSuite(EVAL_CASES));
    expect(text).toContain("评测集");
    expect(text).toContain("条用例");
    // 全覆盖时不写缺口那句
    expect(text).not.toContain("还没有用例");
    expect(text).toContain("景别熵");
  });
});
