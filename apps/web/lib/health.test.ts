import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 健康检查报告（H11）。
 *
 * 供应商探测换成假的：这里要验的是「状态怎么读、告警怎么说、缓存怎么复用」，
 * 不是再测一遍 `GET /v1/models`。
 */

const state = vi.hoisted(() => ({
  probes: new Map<string, { ok: boolean; status?: number; message: string; modelCount?: number }>(),
  calls: [] as string[],
  providers: [
    { id: "good", name: "好供应商", baseUrl: "https://a.example.com" },
    { id: "bad", name: "坏供应商", baseUrl: "https://b.example.com" },
  ],
}));

vi.mock("./app-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app-config")>();
  return {
    ...actual,
    loadConfig: async () => ({
      saved: true,
      path: "/tmp/loomina-config.json",
      config: { version: 1, providers: state.providers, models: [], defaults: {} },
    }),
    probeProvider: async (id: string) => {
      state.calls.push(id);
      return (
        state.probes.get(id) ?? { ok: true, message: "连通 · 2 个模型", modelCount: 2 }
      );
    },
  };
});

import { buildHealthReport, providerStateOf, PROBE_TTL_MS, resetHealthCacheForTests } from "./health";

let dir = "";
const previousHealth = process.env.LOOMINA_HEALTH_STATE;
const previousRender = process.env.LOOMINA_RENDER_STATE;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "loomina-health-report-"));
  process.env.LOOMINA_HEALTH_STATE = path.join(dir, "health-events.json");
  process.env.LOOMINA_RENDER_STATE = path.join(dir, "jobs.json");
  state.calls.length = 0;
  state.probes.clear();
  resetHealthCacheForTests();
});

afterEach(async () => {
  if (previousHealth === undefined) delete process.env.LOOMINA_HEALTH_STATE;
  else process.env.LOOMINA_HEALTH_STATE = previousHealth;
  if (previousRender === undefined) delete process.env.LOOMINA_RENDER_STATE;
  else process.env.LOOMINA_RENDER_STATE = previousRender;
  resetHealthCacheForTests();
  await rm(dir, { recursive: true, force: true });
});

describe("探测状态（H11）", () => {
  it("401 / 403 / 404 算配置或权限不对，其余失败算不稳定", () => {
    expect(providerStateOf({ ok: true, message: "通" })).toBe("ok");
    expect(providerStateOf({ ok: false, status: 401, message: "未授权" })).toBe("down");
    expect(providerStateOf({ ok: false, status: 403, message: "无权限" })).toBe("down");
    expect(providerStateOf({ ok: false, status: 404, message: "路径不对" })).toBe("down");
    expect(providerStateOf({ ok: false, status: 429, message: "限流" })).toBe("degraded");
    expect(providerStateOf({ ok: false, message: "连不上" })).toBe("degraded");
  });
});

describe("健康报告（H11）", () => {
  it("每个供应商一行，连不上的进告警", async () => {
    state.probes.set("bad", { ok: false, status: 401, message: "密钥不对" });
    const report = await buildHealthReport();
    expect(report.providers.map((provider) => provider.state)).toEqual(["ok", "down"]);
    expect(report.alarms).toHaveLength(1);
    expect(report.alarms[0]).toContain("坏供应商");
    expect(report.alarms[0]).toContain("密钥不对");
    expect(report.cached).toBe(false);
  });

  it("5 分钟内再问一次用缓存，不再探测；强制刷新才重新探", async () => {
    const first = await buildHealthReport();
    expect(first.cached).toBe(false);
    expect(state.calls).toHaveLength(2);

    const second = await buildHealthReport();
    expect(second.cached).toBe(true);
    expect(state.calls).toHaveLength(2);
    expect(PROBE_TTL_MS).toBe(5 * 60 * 1000);

    await buildHealthReport(true);
    expect(state.calls).toHaveLength(4);
  });

  it("报告里没有 Base URL，也没有密钥", async () => {
    const report = await buildHealthReport();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("example.com");
    expect(serialized).not.toContain("apiKey");
  });

  it("渲染队列按状态计数，没任务时都是 0", async () => {
    const report = await buildHealthReport();
    expect(report.render).toEqual({ queued: 0, running: 0, error: 0, done: 0 });
    expect(report.failures).toEqual([]);
  });
});
