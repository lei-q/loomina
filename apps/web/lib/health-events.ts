import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./project-root";
import type { HealthAlert } from "./alerts";
import { MODALITIES, MODALITY_LABEL, type Modality } from "./config-types";

/**
 * 生成调用的小账本（H11）。
 *
 * 只记「哪一类、哪个模型、成没成、失败码」，不记提示词、不记密钥、不记素材。
 * 用来回答「最近这一路是不是在连续失败」——失败率告警需要的是趋势，
 * 不是某一次的原始报错。文件落在本机 `.loomina/health-events.json`，权限 0600。
 */

export type HealthEvent = {
  at: string;
  modality: Modality;
  /** 请求指定的模型 id；没指定就是该模态的默认（记成 *） */
  modelId?: string;
  ok: boolean;
  /** 失败的短码（provider_error / timeout / 429 …），成功不写 */
  code?: string;
};

export type FailureGroup = {
  modality: Modality;
  modelId?: string;
  samples: number;
  failures: number;
  rate: number;
  state: "ok" | "watch" | "alarm";
  lastAt?: string;
  lastCode?: string;
};

const MAX_EVENTS = 400;
/** 失败率只看最近 24 小时：上周的一次故障不该让今天一直红着 */
export const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 少于这个次数不下结论：一次失败说明不了什么 */
export const MIN_SAMPLES = 3;

export function healthEventsPath(): string {
  const override = process.env.LOOMINA_HEALTH_STATE?.trim();
  if (override) return path.resolve(/* turbopackIgnore: true */ process.cwd(), override);
  return path.join(/* turbopackIgnore: true */ projectRoot(), ".loomina", "health-events.json");
}

function isModality(value: unknown): value is Modality {
  return typeof value === "string" && (MODALITIES as readonly string[]).includes(value);
}

function looksLikeEvent(value: unknown): value is HealthEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.at === "string" &&
    isModality(event.modality) &&
    typeof event.ok === "boolean" &&
    (event.modelId === undefined || typeof event.modelId === "string") &&
    (event.code === undefined || typeof event.code === "string")
  );
}

/** 读不到或文件坏了都当空账本：健康检查不能因为自己的记录坏了就打不开。 */
export async function loadHealthEvents(): Promise<HealthEvent[]> {
  try {
    const raw = await readFile(healthEventsPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(looksLikeEvent).slice(-MAX_EVENTS);
  } catch {
    return [];
  }
}

async function writeHealthEvents(events: HealthEvent[]): Promise<void> {
  const file = healthEventsPath();
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(events.slice(-MAX_EVENTS), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, file);
}

// 同一进程里串行写：几个生成请求同时结束时，不是最后一次覆盖前一次
let queue: Promise<void> = Promise.resolve();

/**
 * 记一笔生成调用。调用方不用等、也不用兜：写失败只影响趋势，不该影响生成。
 */
export function recordHealthEvent(event: HealthEvent): Promise<void> {
  queue = queue
    .then(async () => {
      const events = await loadHealthEvents();
      await writeHealthEvents([...events, event]);
    })
    .catch(() => undefined);
  return queue;
}

/** 把事件按「模态 + 模型」归组，算最近 24 小时的失败率与状态 */
export function summarizeFailures(
  events: HealthEvent[],
  now: number = Date.now(),
  windowMs: number = FAILURE_WINDOW_MS,
): FailureGroup[] {
  const groups = new Map<
    string,
    {
      modality: Modality;
      modelId?: string;
      samples: number;
      failures: number;
      lastAt?: string;
      lastCode?: string;
    }
  >();

  for (const event of events) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || now - at > windowMs || at > now) continue;
    const modelId = event.modelId?.trim() || undefined;
    const key = `${event.modality}:${modelId ?? "*"}`;
    const group =
      groups.get(key) ?? { modality: event.modality, ...(modelId ? { modelId } : {}), samples: 0, failures: 0 };
    group.samples += 1;
    if (!event.ok) {
      group.failures += 1;
      group.lastCode = event.code?.slice(0, 80) ?? group.lastCode;
    }
    if (!group.lastAt || event.at > group.lastAt) group.lastAt = event.at;
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const rate = group.samples ? group.failures / group.samples : 0;
      const state: FailureGroup["state"] =
        group.samples >= MIN_SAMPLES && rate >= 0.5
          ? "alarm"
          : group.samples >= MIN_SAMPLES && rate >= 0.2
            ? "watch"
            : "ok";
      return {
        ...group,
        rate: Math.round(rate * 1000) / 1000,
        state,
      };
    })
    .sort((a, b) => {
      const rank = { alarm: 0, watch: 1, ok: 2 } as const;
      return rank[a.state] - rank[b.state] || b.samples - a.samples;
    });
}

/**
 * 把失败率分组翻成告警（H8）。
 *
 * 只给「有结论」的组：少于 3 次、或不到 20% 的组不出现。
 * 阈值与 `summarizeFailures` 同一处，避免界面上写 20% / 50%、实际算另一套。
 */
export function failureAlerts(groups: FailureGroup[]): HealthAlert[] {
  return groups.flatMap((group) => {
    if (group.state !== "watch" && group.state !== "alarm") return [];
    const who = `${MODALITY_LABEL[group.modality]}${group.modelId ? ` · ${group.modelId}` : ""}`;
    return [
      {
        id: `failure:${group.modality}:${group.modelId ?? "*"}`,
        level: group.state,
        kind: "failure" as const,
        title: `${who} 失败率 ${Math.round(group.rate * 100)}%`,
        detail: `最近 24 小时 ${group.failures}/${group.samples} 次失败${
          group.lastCode ? `，最后一次：${group.lastCode}` : ""
        }；${group.state === "alarm" ? "达到 50% 告警线" : "达到 20% 留意线"}。`,
        ...(group.lastAt ? { at: group.lastAt } : {}),
      },
    ];
  });
}
