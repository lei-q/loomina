import type { Project, ProjectEvent } from "@loomina/ir";
import { costDashboard } from "./cost-dashboard";
import { spendOf } from "./read-model";
import { projectSegments } from "./spend-report";

/**
 * 告警（H8 / ADR-0157）。
 *
 * 三类告警共用一个形状：供应商通不通、最近 24 小时失败率、成本突增 / 超预算。
 * 供应与失败率由服务端 `GET /api/health` 给出；成本告警在浏览器里按本机事件日志现算——
 * 日志只在浏览器，服务端不该为了告警去读用户的项目。
 *
 * 告警只是提示，不阻断生成：预算上限与失败重试仍各由 H10 / 各生成入口负责。
 */

export type HealthAlert = {
  id: string;
  level: "watch" | "alarm";
  kind: "provider" | "failure" | "cost";
  title: string;
  detail: string;
  at?: string;
};

export const ALERT_KIND_LABEL: Record<HealthAlert["kind"], string> = {
  provider: "供应商",
  failure: "失败率",
  cost: "成本",
};

export const ALERT_LEVEL_LABEL: Record<HealthAlert["level"], string> = {
  watch: "留意",
  alarm: "告警",
};

const MAX_ALERTS = 20;

/**
 * 本机项目里的成本告警。
 *
 * - 某镜花费贵过有花费镜中位数的 3 倍，且多花至少 ¥1 → 留意；
 * - 项目已花超过自己的预算 → 告警（预算是作者自己设的硬线，超了就该看见）。
 *
 * 当前项目单独传：日志按 `project.created` 切段时，一次跨项目的「回到这里」
 * 会让最后一段的恢复目标落在段外、回放失败；当前项目不该因此漏掉告警。
 * 只读事件日志，不写任何东西；回放失败的日志段跳过，和账单口径一致。
 */
export function costAlerts(events: ProjectEvent[], current?: Project): HealthAlert[] {
  const { segments } = projectSegments(events);
  const lastAt = events.at(-1)?.at;
  const entries: { project: Project; at?: string }[] = [
    ...(current ? [{ project: current, ...(lastAt ? { at: lastAt } : {}) }] : []),
    ...segments.map(({ project, fromEvent }) => ({
      project,
      ...(events[fromEvent]?.at ? { at: events[fromEvent]!.at } : {}),
    })),
  ];
  const alerts: HealthAlert[] = [];

  for (const { project, at } of entries) {
    const board = costDashboard(project);
    for (const item of board.anomalies) {
      alerts.push({
        id: `cost:${project.id}:${item.shotId}`,
        level: "watch",
        kind: "cost",
        title: `${project.title} · ${item.label} 成本突增`,
        detail: `${item.scene || "—"}：${item.reason}。先看这一镜是不是重拍多了。`,
        ...(at ? { at } : {}),
      });
    }

    const spend = spendOf(project);
    if (project.budgetCny > 0 && spend.spent > project.budgetCny) {
      alerts.push({
        id: `budget:${project.id}`,
        level: "alarm",
        kind: "cost",
        title: `${project.title} 已超预算`,
        detail: `已花 ¥${spend.spent.toFixed(2)} / 预算 ¥${project.budgetCny.toFixed(2)}；超限后的生成按 H10 的设置阻断或保留。`,
        ...(at ? { at } : {}),
      });
    }
  }

  return rankAlerts(alerts);
}

/** 告警排序：告警在前、留意在后，同级按时间新 → 旧；最多留 20 条 */
export function rankAlerts(alerts: HealthAlert[]): HealthAlert[] {
  const seen = new Set<string>();
  return [...alerts]
    .filter((alert) => {
      if (seen.has(alert.id)) return false;
      seen.add(alert.id);
      return true;
    })
    .sort((a, b) => {
      const rank = { alarm: 0, watch: 1 } as const;
      return rank[a.level] - rank[b.level] || (b.at ?? "").localeCompare(a.at ?? "");
    })
    .slice(0, MAX_ALERTS);
}

/** 合并服务端与本地告警：同 id 只留一条，统一排序 */
export function mergeAlerts(...lists: HealthAlert[][]): HealthAlert[] {
  return rankAlerts(lists.flat());
}
