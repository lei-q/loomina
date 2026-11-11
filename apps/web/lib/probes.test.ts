import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProbeReports, summarizeProbe } from "./probes";

const RAW = {
  startedAt: "2026-11-09T14:06:39.503Z",
  config: {
    baseUrl: "https://api.example.com",
    videoModel: "seedance-2.0",
    imageModel: "gpt-image-2",
    videoApi: "litellm",
    resolution: "720p",
    imageSize: "1024x1536",
  },
  summary: {
    attempts: 2,
    passed: 1,
    passRate: 0.5,
    totalCny: 2.12,
    failureCodes: { "429": 1 },
  },
  shots: [{ shotId: "probe-sh-1", ok: false }],
};

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "loomina-probe-"));
  dirs.push(dir);
  return dir;
}

describe("summarizeProbe", () => {
  it("只留汇总字段，不返回 Base URL 与逐镜原始报错", () => {
    const report = summarizeProbe(RAW, "probe-2026-11-09T14-06-39-503Z.json");
    expect(report).toEqual({
      file: "probe-2026-11-09T14-06-39-503Z.json",
      startedAt: "2026-11-09T14:06:39.503Z",
      videoModel: "seedance-2.0",
      imageModel: "gpt-image-2",
      videoApi: "litellm",
      resolution: "720p",
      attempts: 2,
      passed: 1,
      passRate: 0.5,
      totalCny: 2.12,
      avgCnyPerShot: 2.12,
      failureCodes: { "429": 1 },
    });
    expect(report && "baseUrl" in report).toBe(false);
    expect(report && "shots" in report).toBe(false);
  });

  it("passed 不会超过 attempts，缺失通过数按 0 算", () => {
    const report = summarizeProbe(
      {
        startedAt: "2026-11-09T14:06:39.503Z",
        config: {},
        summary: { attempts: 2, passed: 9, totalCny: 1 },
      },
      "probe-x.json",
    );
    expect(report?.passed).toBe(2);
    expect(report?.passRate).toBe(1);
    expect(report?.avgCnyPerShot).toBe(0.5);
  });

  it("结构不对就跳过，不猜", () => {
    expect(summarizeProbe(null, "probe-x.json")).toBeNull();
    expect(summarizeProbe({}, "probe-x.json")).toBeNull();
    expect(
      summarizeProbe({ startedAt: "2026-11-09T14:06:39.503Z" }, "probe-x.json"),
    ).toBeNull();
    expect(
      summarizeProbe(
        { startedAt: "", summary: { attempts: 1, passed: 0 } },
        "probe-x.json",
      ),
    ).toBeNull();
  });
});

describe("readProbeReports", () => {
  it("读最近的报告，跳过坏文件与非 probe 文件，按时间倒序", async () => {
    const dir = await tempDir();
    const reports = [
      ["probe-2026-11-09T10-00-00-000Z.json", "2026-11-09T10:00:00.000Z"],
      ["probe-2026-11-09T12-00-00-000Z.json", "2026-11-09T12:00:00.000Z"],
      ["probe-2026-11-09T11-00-00-000Z.json", "2026-11-09T11:00:00.000Z"],
    ] as const;
    for (const [file, startedAt] of reports) {
      await writeFile(
        path.join(dir, file),
        JSON.stringify({ ...RAW, startedAt }),
        "utf8",
      );
    }
    await writeFile(path.join(dir, "probe-broken.json"), "{not json", "utf8");
    await writeFile(path.join(dir, "notes.json"), JSON.stringify(RAW), "utf8");

    const result = await readProbeReports(dir);
    expect(result.map((item) => item.startedAt)).toEqual([
      "2026-11-09T12:00:00.000Z",
      "2026-11-09T11:00:00.000Z",
      "2026-11-09T10:00:00.000Z",
    ]);
    expect(result.every((item) => item.file.startsWith("probe-"))).toBe(true);
  });

  it("只取前 limit 份", async () => {
    const dir = await tempDir();
    for (let hour = 0; hour < 7; hour += 1) {
      const hh = String(hour).padStart(2, "0");
      const startedAt = `2026-11-09T${hh}:00:00.000Z`;
      await writeFile(
        path.join(dir, `probe-2026-11-09T${hh}-00-00-000Z.json`),
        JSON.stringify({ ...RAW, startedAt }),
        "utf8",
      );
    }
    const result = await readProbeReports(dir, 5);
    expect(result).toHaveLength(5);
    expect(result[0]!.startedAt).toBe("2026-11-09T06:00:00.000Z");
  });

  it("目录不存在时返回空数组", async () => {
    await expect(readProbeReports(path.join(tmpdir(), "loomina-no-such-dir"))).resolves.toEqual(
      [],
    );
  });
});
