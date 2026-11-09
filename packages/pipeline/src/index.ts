import {
  assertValidProject,
  type Id,
  type Project,
  type Shot,
  type Take,
} from "@loomina/ir";
import type { ImageAdapter, VideoAdapter } from "@loomina/gateway";

export interface PriceTable {
  imageCny: number;
  videoPerSecondCny: number;
}

export const DEFAULT_PRICES: PriceTable = {
  imageCny: 0.3,
  videoPerSecondCny: 1.5,
};

export interface LedgerEntry {
  shotId: Id;
  modelId: string;
  cny: number;
}

export interface RunResult {
  project: Project;
  ledger: LedgerEntry[];
  totalCny: number;
}

export interface RunOptions {
  image: ImageAdapter;
  video: VideoAdapter;
  prices?: PriceTable;
  now?: () => string;
}

/**
 * S0 最小链路：校验 → 关键帧 → 视频 → 写回 Take + 记账。
 * 用来证明“契约能承载一条最小生产链路”，不追求质量。
 */
export async function runMinimalChain(
  project: Project,
  options: RunOptions,
): Promise<RunResult> {
  assertValidProject(project);

  const prices = options.prices ?? DEFAULT_PRICES;
  const now = options.now ?? (() => new Date().toISOString());

  const newTakes: Take[] = [];
  const ledger: LedgerEntry[] = [];

  for (const shot of project.shots) {
    const prompt = describeShot(shot);

    const frame = await options.image.generate({
      shotId: shot.id,
      prompt,
      referenceAssetIds: shot.characterIds,
    });

    const { jobId } = await options.video.submit({
      shotId: shot.id,
      imageAssetId: frame.assetId,
      durationMs: shot.durationMs,
      prompt,
    });

    const job = await options.video.poll(jobId);
    if (job.status !== "succeeded") {
      throw new Error(`镜头 ${shot.id} 生成失败：${job.error ?? job.status}`);
    }
    const video = job.output ?? (await options.video.fetch(jobId));

    const videoCny = (shot.durationMs / 1000) * prices.videoPerSecondCny;
    const costCny = round2(prices.imageCny + videoCny);

    newTakes.push({
      id: `take-${shot.id}-${video.assetId}`,
      shotId: shot.id,
      assetId: video.assetId,
      provenance: video.provenance,
      status: "draft",
      costCny,
    });

    ledger.push(
      { shotId: shot.id, modelId: "fake-image", cny: prices.imageCny },
      { shotId: shot.id, modelId: "fake-video", cny: round2(videoCny) },
    );
  }

  const takeByShot = new Map(newTakes.map((take) => [take.shotId, take]));
  const shots = project.shots.map((shot) => {
    const take = takeByShot.get(shot.id);
    return take ? { ...shot, takeIds: [...shot.takeIds, take.id] } : shot;
  });

  const updated: Project = {
    ...project,
    version: project.version + 1,
    shots,
    takes: [...project.takes, ...newTakes],
  };

  assertValidProject(updated);

  return {
    project: updated,
    ledger,
    totalCny: round2(ledger.reduce((sum, entry) => sum + entry.cny, 0)),
  };
}

function describeShot(shot: Shot): string {
  const { shotSize, camera } = shot;
  return `${shotSize} shot, ${camera.angle} angle, ${camera.focalMm}mm, ${camera.movement}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
