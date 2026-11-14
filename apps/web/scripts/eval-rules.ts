/**
 * 规则评测集自检（I9 / DIRECTOR-GRAMMAR.md §十一）。
 *
 * 跑一遍 `EVAL_CASES`，逐条比对期望，打印指标与缺口。
 * 有失败时退出码为 1——可以直接挂进 CI 或 pre-commit。
 *
 * 用法：`pnpm eval:rules`
 *
 * 这一档验的是「判定方向没写反」：该报的报了、不该报的没报。
 * 阈值标定要 30 个真实短剧片段，不在这里。
 */

import { EVAL_CASES, evalText, runEvalSuite } from "../lib/rule-eval";

const report = runEvalSuite(EVAL_CASES);
console.log(evalText(report));
console.log("");

const failed = report.results.filter((result) => !result.passed);
if (failed.length > 0) {
  console.log("失败用例：");
  for (const result of failed) {
    console.log(`  ✗ ${result.id}（${result.rule} / ${result.kind}）`);
    console.log(`    ${result.reason}`);
  }
  process.exitCode = 1;
} else {
  console.log(`全部 ${report.summary.cases} 条用例通过。`);
}

if (report.summary.rulesMissing.length > 0) {
  console.log("");
  console.log("还没有用例的 must 规则：");
  for (const rule of report.summary.rulesMissing) console.log(`  - ${rule}`);
}
