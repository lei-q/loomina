import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./app-config";

/**
 * S1 能力测绘报告（H16）。
 *
 * `pnpm probe:s1` 把每次测绘写到 `artifacts/s1/probe-*.json`。这里只做读取与脱敏：
 * 不返回 Base URL、密钥、逐镜提示词与原始报错，只留下能回答
 * 「跑了几次、过了几次、花了多少、失败码分布」的字段。
 *
 * 文件按名字倒序读（`probe-<ISO 时间>.json` 天然按时间排序），
 * 解析失败的文件跳过——报告坏了不能让整个页面打不开。
 */

export type ProbeReportView = {
  /** 文件名，不含目录 */
  file: string;
  startedAt: string;
  videoModel?: string;
  imageModel?: string;
  videoApi?: string;
  resolution?: string;
  attempts: number;
  passed: number;
  passRate: number;
  totalCny: number;
  avgCnyPerShot?: number;
  failureCodes: Record<string, number>;
};

const FILE_PATTERN = /^probe-[A-Za-z0-9._-]+\.json$/;
const MAX_REPORTS = 5;

export function probeDir(): string {
  const override = process.env.LOOMINA_PROBE_DIR?.trim();
  if (override) return path.resolve(/* turbopackIgnore: true */ process.cwd(), override);
  return path.join(/* turbopackIgnore: true */ projectRoot(), "artifacts", "s1");
}

/** 把一个 probe JSON 收敛成页面能用的摘要；结构不对就返回 null。 */
export function summarizeProbe(raw: unknown, file: string): ProbeReportView | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const startedAt = typeof record.startedAt === "string" ? record.startedAt.trim() : "";
  if (!startedAt) return null;

  const summary =
    record.summary && typeof record.summary === "object"
      ? (record.summary as Record<string, unknown>)
      : null;
  if (!summary) return null;

  const attempts = count(summary.attempts);
  if (attempts === undefined || attempts < 0) return null;
  const passed = Math.min(count(summary.passed) ?? 0, attempts);
  const totalCny = money(summary.totalCny);

  const config =
    record.config && typeof record.config === "object"
      ? (record.config as Record<string, unknown>)
      : {};
  const text = (value: unknown, max: number) =>
    typeof value === "string" ? value.trim().slice(0, max) || undefined : undefined;
  const videoModel = text(config.videoModel, 120);
  const imageModel = text(config.imageModel, 120);
  const videoApi = text(config.videoApi, 20);
  const resolution = text(config.resolution, 20);

  const failureCodes: Record<string, number> = {};
  if (summary.failureCodes && typeof summary.failureCodes === "object") {
    for (const [code, value] of Object.entries(summary.failureCodes)) {
      const n = count(value);
      if (n !== undefined && n > 0) failureCodes[code.slice(0, 80)] = n;
    }
  }

  return {
    file,
    startedAt,
    ...(videoModel ? { videoModel } : {}),
    ...(imageModel ? { imageModel } : {}),
    ...(videoApi ? { videoApi } : {}),
    ...(resolution ? { resolution } : {}),
    attempts,
    passed,
    passRate: attempts ? Math.round((passed / attempts) * 1000) / 1000 : 0,
    totalCny,
    ...(passed > 0 ? { avgCnyPerShot: Math.round((totalCny / passed) * 100) / 100 } : {}),
    failureCodes,
  };
}

/**
 * 读最近的测绘报告。
 *
 * `dir` 只在测试或换产出目录时传入；默认 `LOOMINA_PROBE_DIR` 或仓库的 `artifacts/s1`。
 */
export async function readProbeReports(
  dir: string = probeDir(),
  limit = MAX_REPORTS,
): Promise<ProbeReportView[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const files = names.filter((name) => FILE_PATTERN.test(name)).sort().reverse();
  const reports: ProbeReportView[] = [];
  for (const file of files) {
    if (reports.length >= limit) break;
    try {
      const text = await readFile(path.join(dir, file), "utf8");
      const report = summarizeProbe(JSON.parse(text) as unknown, file);
      if (report) reports.push(report);
    } catch {
      // 坏文件跳过：一份旧报告解析不了，不该挡住其它报告
    }
  }

  return reports
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

function count(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function money(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, value) * 100) / 100;
}
