import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FAILURE_WINDOW_MS,
  MIN_SAMPLES,
  healthEventsPath,
  loadHealthEvents,
  recordHealthEvent,
  summarizeFailures,
  type HealthEvent,
} from "./health-events";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");

function event(overrides: Partial<HealthEvent> = {}): HealthEvent {
  return {
    at: new Date(NOW - 60_000).toISOString(),
    modality: "video",
    ok: true,
    ...overrides,
  };
}

let dir = "";
const previous = process.env.LOOMINA_HEALTH_STATE;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "loomina-health-"));
  process.env.LOOMINA_HEALTH_STATE = path.join(dir, "health-events.json");
});

afterEach(async () => {
  if (previous === undefined) delete process.env.LOOMINA_HEALTH_STATE;
  else process.env.LOOMINA_HEALTH_STATE = previous;
  await rm(dir, { recursive: true, force: true });
});

describe("失败率汇总（H11）", () => {
  it("按模态 + 模型分组，成功失败都进样本数", () => {
    const groups = summarizeFailures(
      [
        event({ ok: false, code: "timeout" }),
        event({ ok: true }),
        event({ ok: false, code: "provider_error" }),
      ],
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      modality: "video",
      samples: 3,
      failures: 2,
      rate: 0.667,
      state: "alarm",
      lastCode: "provider_error",
    });
  });

  it("不同模型分开算：一个挂了不影响另一个", () => {
    const groups = summarizeFailures(
      [
        event({ modelId: "a", ok: false }),
        event({ modelId: "a", ok: false }),
        event({ modelId: "a", ok: false }),
        event({ modelId: "b", ok: true }),
      ],
      NOW,
    );
    expect(groups).toHaveLength(2);
    const a = groups.find((group) => group.modelId === "a")!;
    const b = groups.find((group) => group.modelId === "b")!;
    expect(a.state).toBe("alarm");
    expect(b.state).toBe("ok");
    // 问题组排在前面
    expect(groups[0]!.modelId).toBe("a");
  });

  it("样本太少不下结论", () => {
    const groups = summarizeFailures(
      [event({ ok: false }), event({ ok: false })],
      NOW,
    );
    expect(groups[0]!.samples).toBe(MIN_SAMPLES - 1);
    expect(groups[0]!.state).toBe("ok");
  });

  it("失败率 20%–50% 是「留意」，50% 起才是「告警」", () => {
    const watch = summarizeFailures(
      [event(), event(), event(), event(), event({ ok: false })],
      NOW,
    );
    expect(watch[0]!.rate).toBe(0.2);
    expect(watch[0]!.state).toBe("watch");

    const alarm = summarizeFailures(
      [event(), event(), event({ ok: false }), event({ ok: false })],
      NOW,
    );
    expect(alarm[0]!.state).toBe("alarm");
  });

  it("只算最近 24 小时，更早的失败不该让今天一直红着", () => {
    const stale = event({ ok: false, at: new Date(NOW - FAILURE_WINDOW_MS - 1000).toISOString() });
    const groups = summarizeFailures(
      [stale, stale, stale, event({ ok: true })],
      NOW,
    );
    expect(groups[0]!.samples).toBe(1);
    expect(groups[0]!.failures).toBe(0);
  });

  it("时间戳坏掉的记录跳过", () => {
    const groups = summarizeFailures([event({ at: "不是时间" }), event()], NOW);
    expect(groups[0]!.samples).toBe(1);
  });

  it("没有记录时返回空数组", () => {
    expect(summarizeFailures([], NOW)).toEqual([]);
  });
});

describe("调用小账本（H11）", () => {
  it("文件不存在时当空账本", async () => {
    expect(healthEventsPath()).toContain("health-events.json");
    expect(await loadHealthEvents()).toEqual([]);
  });

  it("记一笔能读回来，失败码与模型都在", async () => {
    await recordHealthEvent(
      event({ modality: "tts", modelId: "seedance-2.0", ok: false, code: "quota" }),
    );
    const events = await loadHealthEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      modality: "tts",
      modelId: "seedance-2.0",
      ok: false,
      code: "quota",
    });
  });

  it("连续写不会互相覆盖", async () => {
    await Promise.all([
      recordHealthEvent(event({ modality: "text" })),
      recordHealthEvent(event({ modality: "image" })),
      recordHealthEvent(event({ modality: "video" })),
    ]);
    const events = await loadHealthEvents();
    expect(events.map((item) => item.modality).sort()).toEqual(["image", "text", "video"]);
  });

  it("文件坏了当空账本，不抛错", async () => {
    await writeFile(healthEventsPath(), "{ 不是 JSON", "utf8");
    expect(await loadHealthEvents()).toEqual([]);
    await recordHealthEvent(event({ modality: "text" }));
    expect(await loadHealthEvents()).toHaveLength(1);
  });

  it("只留最近 400 条，文件权限 0600", async () => {
    const bulk = Array.from({ length: 405 }, (_, index) =>
      event({ modality: "text", at: new Date(NOW - (500 - index) * 1000).toISOString() }),
    );
    await writeFile(healthEventsPath(), JSON.stringify(bulk), "utf8");
    const events = await loadHealthEvents();
    expect(events).toHaveLength(400);

    await recordHealthEvent(event({ modality: "image" }));
    const kept = JSON.parse(await readFile(healthEventsPath(), "utf8")) as HealthEvent[];
    expect(kept).toHaveLength(400);
    expect(kept.at(-1)!.modality).toBe("image");

    if (process.platform !== "win32") {
      const mode = (await stat(healthEventsPath())).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
