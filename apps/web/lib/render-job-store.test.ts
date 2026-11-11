import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RenderManifest } from "./render-manifest";
import { loadRenderJobs, renderJobStatePath, saveRenderJobs, type PersistedRenderJob } from "./render-job-store";

const manifest = {
  title: "夜班",
  width: 540,
  height: 960,
  fps: 24,
  quality: "draft",
  totalMs: 3000,
  clips: [],
  overlays: [],
  audio: [],
  music: [],
  aiLabel: { explicit: true, implicit: true, standard: "AI生成" },
} as unknown as RenderManifest;

function job(overrides: Partial<PersistedRenderJob> = {}): PersistedRenderJob {
  return {
    id: "job-1",
    manifest,
    status: "queued",
    stage: "排队中",
    progress: 0,
    attempts: 0,
    createdAt: 1_760_000_000_000,
    fileName: "夜班-成片.mp4",
    remoteSkipped: 0,
    placeholders: 0,
    ...overrides,
  };
}

let dir = "";
const previous = process.env.LOOMINA_RENDER_STATE;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "loomina-jobs-"));
  process.env.LOOMINA_RENDER_STATE = path.join(dir, "jobs.json");
});

afterEach(async () => {
  if (previous === undefined) delete process.env.LOOMINA_RENDER_STATE;
  else process.env.LOOMINA_RENDER_STATE = previous;
  await rm(dir, { recursive: true, force: true });
});

describe("渲染队列落盘（H2）", () => {
  it("文件不存在时返回空队列", async () => {
    expect(renderJobStatePath()).toContain("jobs.json");
    expect(await loadRenderJobs()).toEqual([]);
  });

  it("写进去能原样读回来，清单与结果字段都在", async () => {
    const done = job({
      id: "job-2",
      status: "done",
      progress: 100,
      filePath: "/tmp/out.mp4",
      bytes: 1234,
      finishedAt: 1_760_000_030_000,
      loudness: {
        integratedLufs: -14,
        truePeakDb: -1.2,
        rangeLu: 8,
        outOfPhaseMs: 0,
        monoMs: 0,
        checkedAt: "2026-11-11T10:00:00+08:00",
        verdict: "pass",
        detail: "达标",
      },
    });
    await saveRenderJobs([job(), done]);
    const loaded = await loadRenderJobs();
    expect(loaded).toHaveLength(2);
    expect(loaded[1]).toMatchObject({
      id: "job-2",
      status: "done",
      bytes: 1234,
      filePath: "/tmp/out.mp4",
      loudness: { verdict: "pass" },
    });
    expect(loaded[0]?.manifest.title).toBe("夜班");
  });

  it("文件权限 0600，内容不是空对象", async () => {
    await saveRenderJobs([job()]);
    const info = await stat(renderJobStatePath());
    expect(info.mode & 0o777).toBe(0o600);
    const raw = await readFile(renderJobStatePath(), "utf8");
    expect(JSON.parse(raw)).toHaveLength(1);
  });

  it("坏文件与不认识的形状都被忽略，不抛错", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(renderJobStatePath()), { recursive: true });
    await writeFile(renderJobStatePath(), "{ broken", "utf8");
    expect(await loadRenderJobs()).toEqual([]);

    await writeFile(
      renderJobStatePath(),
      JSON.stringify([{ id: "nope" }, job({ id: "job-3" })]),
      "utf8",
    );
    const loaded = await loadRenderJobs();
    expect(loaded.map((item) => item.id)).toEqual(["job-3"]);
  });
});
