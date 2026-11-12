import { loadConfig, probeProvider, type ProbeResult } from "./app-config";
import { summarizeFailures, loadHealthEvents, type FailureGroup } from "./health-events";
import { loadRenderJobs } from "./render-job-store";
import { longJobSnapshot, LONG_JOB_LABEL, type LongJobKind } from "./long-job";

/**
 * 健康检查（H11）：供应商连通性 + 最近失败率 + 渲染队列。
 *
 * 探测只读 `GET /v1/models`，不触发生成、不花钱、不返回密钥。
 * 没有常驻调度器：结果在进程里缓存 5 分钟，设置页开着时每分钟来问一次，
 * 缓存过期才会真的再去探测——这就是「定时」的实现边界，写在报告里。
 */

export type ProviderState = "ok" | "degraded" | "down";

export type ProviderHealth = {
  id: string;
  name: string;
  state: ProviderState;
  latencyMs: number;
  modelCount?: number;
  message: string;
  checkedAt: string;
};

export type HealthReport = {
  checkedAt: string;
  /** 这一份探测结果是哪一刻的；没探测过就没有 */
  probedAt?: string;
  /** 这次返回用的是缓存，还是刚刚探测的 */
  cached: boolean;
  providers: ProviderHealth[];
  failures: FailureGroup[];
  render: { queued: number; running: number; error: number; done: number };
  /**
   * 同一条长任务队列现在在跑什么、后面还排着谁（H2 / ADR-0135）。
   * 渲染 / 出图 / 出视频共用这一个位置，所以它是「机器现在在忙什么」的唯一答案。
   */
  longJobs: {
    active: { kind: LongJobKind; kindLabel: string; label: string; seconds: number } | null;
    waiting: { kind: LongJobKind; kindLabel: string; label: string; seconds: number }[];
  };
  alarms: string[];
};

export const PROBE_TTL_MS = 5 * 60 * 1000;

/** 401 / 403 / 404 是「配置或权限不对」，别的失败多算「暂时连不上」 */
export function providerStateOf(probe: ProbeResult): ProviderState {
  if (probe.ok) return "ok";
  if (probe.status === 401 || probe.status === 403 || probe.status === 404) return "down";
  return "degraded";
}

type ProbeCache = { at: number; providers: ProviderHealth[] };
let cache: ProbeCache | undefined;

/** 测试用：清掉进程内缓存 */
export function resetHealthCacheForTests(): void {
  cache = undefined;
}

async function probeAll(
  providers: { id: string; name: string }[],
  checkedAt: string,
): Promise<ProviderHealth[]> {
  return Promise.all(
    providers.map(async (provider) => {
      const started = Date.now();
      const probe = await probeProvider(provider.id);
      return {
        id: provider.id,
        name: provider.name,
        state: providerStateOf(probe),
        latencyMs: Date.now() - started,
        ...(probe.modelCount !== undefined ? { modelCount: probe.modelCount } : {}),
        message: probe.message,
        checkedAt,
      } satisfies ProviderHealth;
    }),
  );
}

function alarmsOf(providers: ProviderHealth[], failures: FailureGroup[]): string[] {
  const alarms: string[] = [];
  for (const provider of providers) {
    if (provider.state === "ok") continue;
    alarms.push(
      `供应商「${provider.name}」${provider.state === "down" ? "连不上或权限不对" : "暂时不可用"}：${provider.message}`,
    );
  }
  for (const group of failures) {
    if (group.state !== "alarm") continue;
    const who = group.modelId ? `${group.modality} · ${group.modelId}` : group.modality;
    alarms.push(
      `最近 24 小时 ${who} 失败 ${group.failures}/${group.samples} 次${group.lastCode ? `（最后一次：${group.lastCode}）` : ""}`,
    );
  }
  return alarms;
}

export async function buildHealthReport(force = false): Promise<HealthReport> {
  const loaded = await loadConfig();
  const providers = loaded.config.providers.map((provider) => ({ id: provider.id, name: provider.name }));
  const now = Date.now();
  const fresh = cache && now - cache.at < PROBE_TTL_MS;
  const useCache = !force && Boolean(fresh);
  const checkedAt = new Date(now).toISOString();

  const probed = useCache
    ? cache!.providers
    : await probeAll(providers, checkedAt);
  if (!useCache) cache = { at: now, providers: probed };

  const failures = summarizeFailures(await loadHealthEvents(), now);
  const jobs = await loadRenderJobs();
  const render = { queued: 0, running: 0, error: 0, done: 0 };
  for (const job of jobs) render[job.status] += 1;
  const long = longJobSnapshot(now);

  return {
    checkedAt,
    ...(cache ? { probedAt: new Date(cache.at).toISOString() } : {}),
    cached: useCache,
    providers: probed,
    failures,
    render,
    longJobs: {
      active: long.active
        ? { ...long.active, kindLabel: LONG_JOB_LABEL[long.active.kind] }
        : null,
      waiting: long.waiting.map((entry) => ({
        ...entry,
        kindLabel: LONG_JOB_LABEL[entry.kind],
      })),
    },
    alarms: alarmsOf(probed, failures),
  };
}
