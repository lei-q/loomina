"use client";

import { useCallback, useEffect, useState } from "react";
import { MODALITY_LABEL, type Modality } from "@/lib/config-types";
import { cn } from "@/lib/utils";

/**
 * 健康检查（H11）。
 *
 * 三件事放在一起看：供应商现在通不通、最近 24 小时这一路生成失败得多不多、
 * 渲染队列有没有卡住的。探测只读 `GET /v1/models`，不触发生成、不花钱。
 *
 * 「定时」的边界：没有常驻调度器，只有这一块开着的时候每分钟来问一次，
 * 服务端 5 分钟内复用上次探测结果；点「立即检查」才会真的再探。
 */

type ProviderState = "ok" | "degraded" | "down";

type ProviderHealth = {
  id: string;
  name: string;
  state: ProviderState;
  latencyMs: number;
  modelCount?: number;
  message: string;
  checkedAt: string;
};

type FailureGroup = {
  modality: Modality;
  modelId?: string;
  samples: number;
  failures: number;
  rate: number;
  state: "ok" | "watch" | "alarm";
  lastAt?: string;
  lastCode?: string;
};

type HealthReport = {
  checkedAt: string;
  probedAt?: string;
  cached: boolean;
  providers: ProviderHealth[];
  failures: FailureGroup[];
  render: { queued: number; running: number; error: number; done: number };
  /** 同一条长任务队列（H2 / ADR-0135）；旧服务端没有这个字段，按空闲处理 */
  longJobs?: {
    active: { kind: string; kindLabel: string; label: string; seconds: number } | null;
    waiting: { kind: string; kindLabel: string; label: string; seconds: number }[];
  };
  alarms: string[];
};

const PROVIDER_STATE: Record<ProviderState, { label: string; tone: string }> = {
  ok: { label: "正常", tone: "border-line text-muted" },
  degraded: { label: "不稳定", tone: "border-line-2 text-text" },
  down: { label: "不可用", tone: "border-pick text-pick" },
};

const FAILURE_STATE: Record<FailureGroup["state"], { label: string; tone: string }> = {
  ok: { label: "正常", tone: "border-line text-muted-2" },
  watch: { label: "留意", tone: "border-line-2 text-text" },
  alarm: { label: "告警", tone: "border-pick text-pick" },
};

function clockOf(value?: string): string {
  if (!value) return "—";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleTimeString("zh-CN", { hour12: false });
}

function rateOf(group: FailureGroup): string {
  return `${Math.round(group.rate * 100)}%`;
}

export function HealthPanel() {
  const [report, setReport] = useState<HealthReport>();
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async (force: boolean) => {
    if (force) setProbing(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/health${force ? "?probe=1" : ""}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as HealthReport & { error?: string };
      if (!response.ok) throw new Error(payload.error || `健康检查失败（${response.status}）`);
      setReport(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "健康检查失败");
    } finally {
      setLoading(false);
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    // 页面开着时每分钟问一次；服务端 5 分钟内的结果直接复用
    const timer = setInterval(() => void load(false), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const alarming = Boolean(report && report.alarms.length > 0);
  const leader = report?.failures.find((group) => group.state !== "ok");

  return (
    <section className="mt-9 border-t border-line pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[12px] tracking-[.04em]">健康检查</h2>
          <span className="tnum text-[9px] text-muted-2">H11</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="tnum text-[9px] text-muted-2">
            {loading
              ? "检查中…"
              : report
                ? `最近一次探测 ${clockOf(report.probedAt)}${report.cached ? " · 缓存" : ""}`
                : "还没检查"}
          </span>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={probing}
            title="只读 GET /v1/models，不触发生成、不花钱"
            className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
          >
            {probing ? "检查中…" : "立即检查"}
          </button>
        </div>
      </div>

      <p className="mt-1 max-w-[640px] text-[9.5px] leading-[1.7] text-muted-2">
        供应商这一段只探测连通性和权限，不生成、不花钱；失败率来自这几次真实调用，
        少于 3 次不下结论。没有常驻定时任务：这一块开着时每分钟刷新一次，
        服务端 5 分钟内复用上次探测，点「立即检查」才会重新探。
      </p>

      {error && <p className="mt-2 text-[10px] leading-5 text-pick">{error}</p>}

      {report && (
        <>
          {alarming && (
            <div className="mt-3 rounded-token border border-pick px-3 py-2">
              <p className="text-[9px] tracking-[.06em] text-pick">现在有问题</p>
              <ul className="mt-1 space-y-0.5">
                {report.alarms.map((alarm, index) => (
                  <li key={index} className="text-[10px] leading-5 text-text">
                    {alarm}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {report.providers.length === 0 && (
              <p className="rounded-token border border-dashed border-line px-3 py-3 text-[10px] text-muted-2">
                还没有供应商。到上面「供应商」里加一个，再回来点「立即检查」。
              </p>
            )}
            {report.providers.map((provider) => {
              const tone = PROVIDER_STATE[provider.state];
              return (
                <div
                  key={provider.id}
                  className="rounded-token border border-line bg-surface px-2.5 py-2"
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[10.5px] text-text">{provider.name}</span>
                    <span
                      className={cn(
                        "rounded-token border px-1.5 py-px text-[8.5px]",
                        tone.tone,
                      )}
                    >
                      {tone.label}
                    </span>
                    <span className="tnum ml-auto text-[9px] text-muted-2">
                      {provider.latencyMs} ms
                      {provider.modelCount !== undefined
                        ? ` · ${provider.modelCount} 个模型`
                        : ""}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-[9px] leading-4 text-muted-2">
                    {provider.message}
                  </p>
                </div>
              );
            })}
          </div>

          <div className="mt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-1">
              <h3 className="text-[10.5px] text-text">最近 24 小时失败率</h3>
              <span className="tnum text-[9px] text-muted-2">
                {report.failures.length === 0
                  ? "还没有调用记录"
                  : `${report.failures.length} 组 · 至少 3 次才有结论`}
              </span>
            </div>
            {report.failures.length === 0 ? (
              <p className="mt-1.5 text-[9.5px] leading-[1.7] text-muted-2">
                这段时间没有文本、图像、视频、配音、识别的调用。出过一次之后，
                这里会按「模态 + 模型」分组显示成败。
              </p>
            ) : (
              <ul className="mt-1.5 divide-y divide-line">
                {report.failures.map((group) => {
                  const tone = FAILURE_STATE[group.state];
                  return (
                    <li
                      key={`${group.modality}:${group.modelId ?? "*"}`}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 text-[9.5px]"
                    >
                      <span className="min-w-[150px] flex-1 truncate text-muted">
                        <span className="text-text">{MODALITY_LABEL[group.modality]}</span>
                        <span className="text-muted-2"> · {group.modelId ?? "默认模型"}</span>
                      </span>
                      <span className="tnum shrink-0 text-muted-2">
                        失败 {group.failures}/{group.samples} · {rateOf(group)}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 rounded-token border px-1.5 py-px text-[8.5px]",
                          tone.tone,
                        )}
                      >
                        {tone.label}
                      </span>
                      <span className="tnum shrink-0 text-[8.5px] text-muted-2">
                        {clockOf(group.lastAt)}
                        {group.lastCode ? ` · ${group.lastCode}` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="tnum mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2 text-[9px] text-muted-2">
            <span className="text-muted">长任务</span>
            {report.longJobs?.active ? (
              <span className="text-text">
                {report.longJobs.active.kindLabel} · {report.longJobs.active.label}
                <span className="ml-1 text-muted-2">{report.longJobs.active.seconds}s</span>
              </span>
            ) : (
              <span>空闲</span>
            )}
            {(report.longJobs?.waiting.length ?? 0) > 0 && (
              <span>排队 {report.longJobs!.waiting.length}</span>
            )}
            {(report.longJobs?.waiting ?? []).slice(0, 3).map((entry, index) => (
              <span key={`${entry.kind}-${entry.label}-${index}`}>
                {entry.kindLabel}：{entry.label}
              </span>
            ))}
          </div>

          <div className="tnum mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2 text-[9px] text-muted-2">
            <span className="text-muted">渲染队列</span>
            <span>排队 {report.render.queued}</span>
            <span>渲染中 {report.render.running}</span>
            <span className={report.render.error > 0 ? "text-pick" : undefined}>
              失败 {report.render.error}
            </span>
            <span>已完成 {report.render.done}</span>
            {leader && leader.lastCode && (
              <span className="text-muted-2">
                最近一次失败码：<span className="text-text">{leader.lastCode}</span>
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
