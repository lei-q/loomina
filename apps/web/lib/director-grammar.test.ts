import { describe, expect, it } from "vitest";
import {
  DIRECTOR_RULES,
  GRAMMAR_VERSION,
  UNIMPLEMENTED,
  grammarCoverage,
  ruleOf,
  rulesByCategory,
} from "./director-grammar";

describe("导演语法库目录（I8 / ADR-0216）", () => {
  it("版本号可追溯，与平台规格表同一写法", () => {
    expect(GRAMMAR_VERSION).toMatch(/^\d{4}-\d{2}$/);
  });

  it("规则编号唯一，查不到的返回 undefined 而不是第一条", () => {
    const ids = DIRECTOR_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ruleOf("V1")?.name).toBe("建立镜头");
    expect(ruleOf("V99")).toBeUndefined();
  });

  it("每条规则都写清了判什么、怎么修", () => {
    for (const rule of DIRECTOR_RULES) {
      expect(rule.name.length, rule.id).toBeGreaterThan(1);
      expect(rule.checks.length, rule.id).toBeGreaterThan(4);
      expect(rule.fix.length, rule.id).toBeGreaterThan(4);
      expect(["must", "should", "may"]).toContain(rule.priority);
    }
  });

  it("已上线与待落地的文档编号不重复：一条规则不会既查不了又已经在查", () => {
    const implemented = new Set(
      DIRECTOR_RULES.map((rule) => rule.docId).filter((id): id is string => Boolean(id)),
    );
    for (const item of UNIMPLEMENTED) {
      expect(implemented.has(item.docId), `${item.docId} 同时出现在两处`).toBe(false);
    }
  });

  it("待落地的每条都写了原因，不空着", () => {
    for (const item of UNIMPLEMENTED) {
      expect(item.name.length).toBeGreaterThan(1);
      expect(item.reason.length).toBeGreaterThan(4);
    }
  });

  it("按类别分组：顺序固定，空类别也占位", () => {
    const groups = rulesByCategory();
    expect(groups.map((group) => group.category)).toEqual([
      "shot-size",
      "angle",
      "movement",
      "axis",
      "rhythm",
      "lighting",
      "feasibility",
    ]);
    expect(groups.reduce((sum, group) => sum + group.rules.length, 0)).toBe(
      DIRECTOR_RULES.length,
    );
  });

  it("覆盖率如实说：已查 13 条、待落地 24 条", () => {
    const coverage = grammarCoverage();
    expect(coverage.implemented).toBe(13);
    expect(coverage.pending).toBe(24);
    expect(coverage.total).toBe(37);
  });
});
