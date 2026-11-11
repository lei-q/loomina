"use client";

import { useMemo, useState } from "react";
import type { Project } from "@loomina/ir";
import { preflightCheckpoints, type CheckpointReport } from "@/lib/compliance";
import { cn } from "@/lib/utils";

/**
 * G8 四检查点（ADR-0105）。
 *
 * 剧本 / 关键帧 / 成片 / 发布文案各扫一遍，用同一套规则；
 * 有问题就在当前阶段改，不把风险留到导出前才暴露。
 */

const STATUS_LABEL: Record<CheckpointReport["status"], string> = {
  pass: "通过",
  review: "待确认",
  block: "阻断",
};

function toneOf(status: CheckpointReport["status"]): string {
  return status === "block" ? "text-pick" : status === "review" ? "text-muted" : "text-muted-2";
}

function CheckpointRow({ report }: { report: CheckpointReport }) {
  const [open, setOpen] = useState(false);
  const expandable = report.findings.length > 0;
  return (
    <li className="border-t border-line first:border-t-0">
      <button
        type="button"
        onClick={() => expandable && setOpen((value) => !value)}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          "flex w-full items-start gap-2.5 py-1.5 text-left",
          expandable ? "cursor-pointer" : "cursor-default",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full",
            report.status === "pass"
              ? "bg-line-2"
              : report.status === "review"
                ? "bg-muted"
                : "bg-pick",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[10px] text-text">{report.label}</span>
            <span className={cn("text-[8.5px] tracking-[.08em]", toneOf(report.status))}>
              {STATUS_LABEL[report.status]}
            </span>
            {report.findings.length > 0 && (
              <span className="text-[8.5px] text-muted-2">
                {report.findings.length} 处 · {open ? "收起" : "展开"}
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-[9px] leading-[1.6] text-muted-2">
            {report.detail}
          </span>
          <span className="mt-0.5 block text-[8.5px] leading-[1.5] text-muted-2">
            范围：{report.scope}
          </span>
        </span>
      </button>
      {open && expandable && (
        <ul className="mb-1.5 ml-4 space-y-1.5 border-l border-line pl-2.5">
          {report.findings.slice(0, 6).map((finding, index) => (
            <li
              key={`${finding.ruleId}-${finding.path}-${index}`}
              className="text-[9px] leading-[1.6]"
            >
              <span
                className={cn(
                  "mr-1.5 text-[8.5px] tracking-[.06em]",
                  finding.severity === "block" ? "text-pick" : "text-muted-2",
                )}
              >
                {finding.severity === "block" ? "阻断" : "确认"}
              </span>
              <span className="text-muted">{finding.path}</span>
              <span className="text-muted-2"> · 「{finding.term}」{finding.message}</span>
              <span className="mt-0.5 block text-muted-2">{finding.excerpt}</span>
            </li>
          ))}
          {report.findings.length > 6 && (
            <li className="text-[8.5px] text-muted-2">
              还有 {report.findings.length - 6} 处没有列出。
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

export function ComplianceCheckpoints({
  project,
  title,
  description,
  topics,
}: {
  project: Project;
  title?: string;
  description?: string;
  topics?: string;
}) {
  const reports = useMemo(
    () => preflightCheckpoints(project, { title, description, topics }),
    [project, title, description, topics],
  );
  const blocked = reports.filter((report) => report.status === "block").length;
  const review = reports.filter((report) => report.status === "review").length;

  return (
    <div className="mt-3 rounded-token border border-line bg-surface/60 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[10.5px] tracking-[.06em] text-text">阶段检查点</h3>
        <span
          className={cn(
            "tnum text-[9px]",
            blocked > 0 ? "text-pick" : "text-muted-2",
          )}
        >
          {blocked > 0
            ? `${blocked} 个阶段有阻断`
            : review > 0
              ? `${review} 个阶段待确认`
              : "四段都通过"}
        </span>
      </div>
      <p className="mt-1 text-[9px] leading-[1.6] text-muted-2">
        每个阶段只扫自己会产出的文本；规则与导出前检查完全一致。
      </p>
      <ul className="mt-1.5">
        {reports.map((report) => (
          <CheckpointRow key={report.id} report={report} />
        ))}
      </ul>
    </div>
  );
}
