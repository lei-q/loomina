import type { Id } from "@loomina/ir";
import type {
  ImageAdapter,
  ImageInput,
  ImageOutput,
  VideoAdapter,
  VideoInput,
  VideoJob,
  VideoOutput,
} from "./types";

/**
 * 假适配器：不烧钱、无网络、可测试。
 * 用来验证契约是否够用（S0 的唯一目标）。
 */
export class FakeImageAdapter implements ImageAdapter {
  private counter = 0;

  constructor(private readonly now: () => string = defaultNow) {}

  async generate(input: ImageInput): Promise<ImageOutput> {
    this.counter += 1;
    return {
      assetId: `fake-img-${this.counter}` as Id,
      uri: `fixtures://frames/${input.shotId}.png`,
      provenance: {
        modelId: "fake-image",
        prompt: input.prompt,
        referenceAssetIds: input.referenceAssetIds ?? [],
        createdAt: this.now(),
      },
    };
  }
}

export class FakeVideoAdapter implements VideoAdapter {
  private counter = 0;
  private jobs = new Map<string, VideoOutput>();

  constructor(private readonly now: () => string = defaultNow) {}

  async submit(input: VideoInput): Promise<{ jobId: string }> {
    this.counter += 1;
    const jobId = `fake-job-${this.counter}`;
    this.jobs.set(jobId, {
      assetId: `fake-vid-${this.counter}`,
      uri: `fixtures://clips/${input.shotId}.mp4`,
      durationMs: input.durationMs,
      provenance: {
        modelId: "fake-video",
        prompt: input.prompt,
        referenceAssetIds: input.imageAssetId ? [input.imageAssetId] : [],
        createdAt: this.now(),
      },
    });
    return { jobId };
  }

  async poll(jobId: string): Promise<VideoJob> {
    const output = this.jobs.get(jobId);
    if (!output) return { jobId, status: "failed", error: "unknown job" };
    return { jobId, status: "succeeded", output };
  }

  async fetch(jobId: string): Promise<VideoOutput> {
    const output = this.jobs.get(jobId);
    if (!output) throw new Error(`未知任务 ${jobId}`);
    return output;
  }
}

function defaultNow(): string {
  return new Date().toISOString();
}
