import { rebuild, type Project, type ProjectEvent } from "@loomina/ir";
import { shotLedger, spendByStage, spendOf, type Spend } from "./read-model";

/**
 * 跨项目账单（H4）。
 *
 * 本地事件日志是一条只追加的流水：开新项目 = 在末尾再写一条 `project.created`
 * （ADR-0088）。所以「这个设备上一共花了多少」不需要另一张表——
 * 按 `project.created` 把日志切段，每段回放成一个项目，各自记账再相加。
 *
 * 只读日志、不写事件：账单是日志的函数，存下来就要配失效机制。
 */

export type ProjectSpendRow = {
  /** 项目 id；同一份日志里可能重名，所以另带起始序号 */
  id: string;
  title: string;
  /** 这一段从日志第几条开始（0 数） */
  fromEvent: number;
  /** 这一段到第几条结束（不含） */
  toEvent: number;
  startedAt: string;
  /** 这段项目结束时是第几版 */
  version: number;
  shots: number;
  /** 这一段日志里写的事件条数（含 project.created） */
  events: number;
  spend: Spend;
  /** 最后一条带 AI 标识的发布记录的时间；没发布过就没有 */
  lastPublishAt?: string;
};

export type SpendReport = {
  rows: ProjectSpendRow[];
  /** 合计：所有项目加起来的已花 */
  total: number;
  /** 合计：没单价的生成调用次数 */
  unpricedCalls: number;
  /** 合计：没单价的生成资产张数 */
  unpriced: number;
};

/**
 * 把一条日志按 `project.created` 切段，每段回放成一个项目。
 *
 * 回放失败的那一段跳过而不是整份放弃：账单少算一个项目，比一个数都给不出来好。
 * 跳过了几段写在返回值里，界面要如实说。
 */
export function projectSegments(events: ProjectEvent[]): {
  segments: { project: Project; fromEvent: number; toEvent: number }[];
  skipped: number;
} {
  const starts = events
    .map((event, index) => (event.type === "project.created" ? index : -1))
    .filter((index) => index >= 0);
  const segments: { project: Project; fromEvent: number; toEvent: number }[] = [];
  let skipped = 0;
  for (const [position, from] of starts.entries()) {
    const to = starts[position + 1] ?? events.length;
    try {
      segments.push({ project: rebuild(events.slice(from, to)), fromEvent: from, toEvent: to });
    } catch {
      skipped += 1;
    }
  }
  return { segments, skipped };
}

/** 跨项目汇总：每段一行，末尾给合计。 */
export function spendReport(events: ProjectEvent[]): SpendReport & { skipped: number } {
  const { segments, skipped } = projectSegments(events);
  const rows: ProjectSpendRow[] = segments.map(({ project, fromEvent, toEvent }) => {
    const publish = project.publishPackages.at(-1);
    return {
      id: project.id,
      title: project.title,
      fromEvent,
      toEvent,
      startedAt: events[fromEvent]?.at ?? project.story.provenance?.createdAt ?? "",
      version: project.version,
      shots: project.shots.length,
      events: toEvent - fromEvent,
      spend: spendOf(project),
      ...(publish?.recordedAt ? { lastPublishAt: publish.recordedAt } : {}),
    };
  });
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    rows,
    total: round(rows.reduce((sum, row) => sum + row.spend.spent, 0)),
    unpricedCalls: rows.reduce((sum, row) => sum + row.spend.unpricedCalls, 0),
    unpriced: rows.reduce((sum, row) => sum + row.spend.unpriced, 0),
    skipped,
  };
}

/**
 * 账单导出成 CSV（H4）。
 *
 * 两段拼在一张表里，中间空一行：上面是项目合计，下面是逐镜明细。
 * 用 CSV 而不是 Excel / JSON：表格软件双击就能开，脚本也好读；
 * 中文用带 BOM 的 UTF-8，Excel 才不会把「夜班」显示成乱码。
 */
export function billCsv(events: ProjectEvent[]): string {
  const report = spendReport(events);
  // 逐镜与按阶段都要回放一遍项目：同一次切段只做一次
  const { segments } = projectSegments(events);
  const cells = (values: (string | number | undefined)[]) =>
    values
      .map((value) => {
        const text = value === undefined ? "" : String(value);
        // 逗号、引号、换行都要包起来；这是 CSV 的唯一硬规矩
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      })
      .join(",");

  const lines: string[] = [];
  lines.push(
    cells(["项目", "项目 id", "起始事件", "事件数", "镜数", "版本", "已花", "文本", "配音", "未定价张数", "未定价调用", "最后发布"]),
  );
  for (const row of report.rows) {
    lines.push(
      cells([
        row.title,
        row.id,
        row.fromEvent,
        row.events,
        row.shots,
        row.version,
        row.spend.spent.toFixed(2),
        row.spend.text.toFixed(2),
        row.spend.voice.toFixed(2),
        row.spend.unpriced,
        row.spend.unpricedCalls,
        row.lastPublishAt ?? "",
      ]),
    );
  }
  lines.push(
    cells(["合计", "", "", "", "", "", report.total.toFixed(2), "", "", report.unpriced, report.unpricedCalls, ""]),
  );

  lines.push("");
  lines.push(
    cells(["项目", "镜号", "场景", "时长(s)", "take 数", "这一镜已花", "其中淘汰", "未定价张数"]),
  );
  for (const { project } of segments) {
    for (const shot of shotLedger(project)) {
      lines.push(
        cells([
          project.title,
          shot.label,
          shot.scene,
          (shot.durationMs / 1000).toFixed(1),
          shot.takes,
          shot.spent.toFixed(2),
          shot.rejected.toFixed(2),
          shot.unpriced,
        ]),
      );
    }
  }

  lines.push("");
  lines.push(cells(["项目", "阶段", "已花", "未定价张数", "未定价调用", "说明"]));
  for (const { project } of segments) {
    for (const stage of spendByStage(project)) {
      lines.push(
        cells([
          project.title,
          stage.label,
          stage.spent.toFixed(2),
          stage.unpriced,
          stage.unpricedCalls,
          stage.detail,
        ]),
      );
    }
  }

  // 带 BOM 的 UTF-8：Excel 双击打开时才知道这是 UTF-8，中文才不是乱码
  return `﻿${lines.join("\n")}\n`;
}
