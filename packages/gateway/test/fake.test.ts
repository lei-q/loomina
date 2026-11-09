import { describe, expect, it } from "vitest";
import { FakeImageAdapter, FakeVideoAdapter } from "../src/fake";

const NOW = () => "2026-11-09T12:00:00Z";

describe("Fake 适配器", () => {
  it("图片适配器返回带 provenance 的输出", async () => {
    const adapter = new FakeImageAdapter(NOW);
    const output = await adapter.generate({
      shotId: "sh-1",
      prompt: "close shot",
    });

    expect(output.uri).toContain("sh-1");
    expect(output.provenance.modelId).toBe("fake-image");
    expect(output.provenance.createdAt).toBe(NOW());
  });

  it("视频适配器提交后可轮询到成功", async () => {
    const adapter = new FakeVideoAdapter(NOW);
    const { jobId } = await adapter.submit({
      shotId: "sh-1",
      imageAssetId: "img-1",
      durationMs: 2500,
    });

    const job = await adapter.poll(jobId);
    expect(job.status).toBe("succeeded");
    expect(job.output?.durationMs).toBe(2500);
    expect(job.output?.provenance.referenceAssetIds).toEqual(["img-1"]);
  });

  it("未知任务返回 failed", async () => {
    const adapter = new FakeVideoAdapter(NOW);
    const job = await adapter.poll("nope");
    expect(job.status).toBe("failed");
  });
});
