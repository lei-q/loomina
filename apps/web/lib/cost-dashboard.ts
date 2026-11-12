import type { Project } from "@loomina/ir";
import { shotLedger } from "./read-model";

/**
 * 成本看板（H15 / ADR-0156）。
 *
 * 全部从当前项目的 IR 派生：单镜花了多少（`shotLedger`）、
 * 第一版 take 有没有被采纳、淘汰的 take 占多少、哪一镜明显贵过其他镜。
 * 不写事件、不调模型、不新增持久化——看板只是记账抽屉的一种读法。
 */

/** 少于这么多「有花钱的镜」就不谈异常：样本太少，中位数没有意义 */
export const MIN_SPIKE_SAMPLES = 4;
/** 贵过中位数这么多倍，并且至少多花这么多钱，才叫突增 */
export const SPIKE_RATIO = 3;
export const SPIKE_FLOOR_CNY = 1;

export type CostShotRow = {
  shotId: string;
  label: string;
  scene: string;
  spent: number;
  /** 这一镜生成过、但没有单价的图 / 视频张数 */
  unpriced: number;
  takes: number;
  rejectedTakes: number;
  rejectedCny: number;
  /** 第一版 take 被采纳为 true、被淘汰为 false、还没判为 undefined */
  firstPass?: boolean;
};

export type CostAnomaly = {
  shotId: string;
  label: string;
  scene: string;
  spent: number;
  /** 这一镜是有花钱镜头的成本中位数 */
  medianCny: number;
  /** 贵过中位数的倍数，保留一位小数 */
  times: number;
  reason: string;
};

export type CostDashboard = {
  shots: number;
  /** 有花钱的镜数：均值与中位数只按这些镜算，零花费的镜不把成本摊薄 */
  pricedShots: number;
  spent: number;
  unpriced: number;
  avgCnyPerShot?: number;
  medianCnyPerShot?: number;
  takes: number;
  rejectedTakes: number;
  /** 淘汰 take 占全部 take 的比例（0–1） */
  retryShare?: number;
  /** 淘汰 take 花掉的钱 */
  retryCny: number;
  /** 第一版 take 已有结论的镜数 */
  judgedShots: number;
  firstPassShots: number;
  /** 第一版就被采纳的比例（0–1）；没有已判定的镜就不给 */
  firstPassRate?: number;
  topShots: CostShotRow[];
  anomalies: CostAnomaly[];
};

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : sorted[middle]!;
  return Math.round(value * 100) / 100;
}

function ratio(part: number, whole: number): number | undefined {
  if (whole === 0) return undefined;
  return Math.round((part / whole) * 1000) / 1000;
}

/**
 * 一镜的第一版是否被采纳。
 *
 * 只看这一镜按拍摄顺序的第一条 take：approved 算通过，rejected 算没通过，
 * draft 说明作者还没表态——不计入分母，免得把「还没看」算成失败。
 */
export function firstPassOf(takes: Project["takes"]): boolean | undefined {
  const first = takes[0];
  if (!first) return undefined;
  if (first.status === "approved") return true;
  if (first.status === "rejected") return false;
  return undefined;
}

export function costDashboard(project: Project): CostDashboard {
  const ledger = shotLedger(project);
  const takesOf = (shotId: string) => project.takes.filter((take) => take.shotId === shotId);

  const rows: CostShotRow[] = ledger.map((shot) => {
    const takes = takesOf(shot.shotId);
    const firstPass = firstPassOf(takes);
    return {
      shotId: shot.shotId,
      label: shot.label,
      scene: shot.scene,
      spent: shot.spent,
      unpriced: shot.unpriced,
      takes: takes.length,
      rejectedTakes: takes.filter((take) => take.status === "rejected").length,
      rejectedCny: shot.rejected,
      ...(firstPass !== undefined ? { firstPass } : {}),
    };
  });

  const priced = rows.filter((row) => row.spent > 0);
  const spent = Math.round(rows.reduce((sum, row) => sum + row.spent, 0) * 100) / 100;
  const medianCny = median(priced.map((row) => row.spent));
  const avgCny =
    priced.length > 0 ? Math.round((spent / priced.length) * 100) / 100 : undefined;

  const takes = rows.reduce((sum, row) => sum + row.takes, 0);
  const rejectedTakes = rows.reduce((sum, row) => sum + row.rejectedTakes, 0);
  const retryCny =
    Math.round(rows.reduce((sum, row) => sum + row.rejectedCny, 0) * 100) / 100;
  const judged = rows.filter((row) => row.firstPass !== undefined);

  const anomalies: CostAnomaly[] =
    priced.length >= MIN_SPIKE_SAMPLES && medianCny !== undefined && medianCny > 0
      ? priced
          .filter(
            (row) => row.spent >= medianCny * SPIKE_RATIO && row.spent - medianCny >= SPIKE_FLOOR_CNY,
          )
          .sort((a, b) => b.spent - a.spent)
          .map((row) => {
            const times = Math.round((row.spent / medianCny) * 10) / 10;
            return {
              shotId: row.shotId,
              label: row.label,
              scene: row.scene,
              spent: row.spent,
              medianCny,
              times,
              reason: `¥${row.spent.toFixed(2)}，是单镜中位数 ¥${medianCny.toFixed(2)} 的 ${times.toFixed(1)} 倍`,
            };
          })
      : [];

  return {
    shots: rows.length,
    pricedShots: priced.length,
    spent,
    unpriced: rows.reduce((sum, row) => sum + row.unpriced, 0),
    ...(avgCny !== undefined ? { avgCnyPerShot: avgCny } : {}),
    ...(medianCny !== undefined ? { medianCnyPerShot: medianCny } : {}),
    takes,
    rejectedTakes,
    ...(ratio(rejectedTakes, takes) !== undefined
      ? { retryShare: ratio(rejectedTakes, takes)! }
      : {}),
    retryCny,
    judgedShots: judged.length,
    firstPassShots: judged.filter((row) => row.firstPass).length,
    ...(ratio(judged.filter((row) => row.firstPass).length, judged.length) !== undefined
      ? { firstPassRate: ratio(judged.filter((row) => row.firstPass).length, judged.length)! }
      : {}),
    topShots: [...priced].sort((a, b) => b.spent - a.spent).slice(0, 5),
    anomalies,
  };
}
