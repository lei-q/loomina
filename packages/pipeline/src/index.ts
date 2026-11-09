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
  imageSize?: string;
  videoResolution?: string;
  /**
   * 纯文生视频：跳过关键帧。
   * 只在关键帧接口不可用时用来单独验证视频通路，不是常规生产方式（P4 关键帧先行）。
   */
  textOnly?: boolean;
}

export interface ShotRunResult {
  shotId: Id;
  take: Take;
  ledger: LedgerEntry[];
  costCny: number;
  imageUri?: string;
  videoUri: string;
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

  const newTakes: Take[] = [];
  const ledger: LedgerEntry[] = [];

  for (const shot of project.shots) {
    const result = await runShot(shot, options);
    newTakes.push(result.take);
    ledger.push(...result.ledger);
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

/**
 * 单个镜头：关键帧 → 视频 → Take。
 *
 * 单独抽出来，是因为探针（S1 能力测绘）需要“一次失败不影响其他镜头”，
 * 而链路函数应该“一失败就停”。两种语义不该混在一个函数里。
 */
export async function runShot(
  shot: Shot,
  options: RunOptions,
): Promise<ShotRunResult> {
  const prices = options.prices ?? DEFAULT_PRICES;
  const prompt = buildShotPrompt(shot);

  const frame = options.textOnly
    ? undefined
    : await options.image.generate({
        shotId: shot.id,
        prompt,
        referenceAssetIds: shot.characterIds,
        ...(options.imageSize ? { size: options.imageSize } : {}),
      });

  const { jobId } = await options.video.submit({
    shotId: shot.id,
    ...(frame ? { imageAssetId: frame.assetId, imageUri: frame.uri } : {}),
    durationMs: shot.durationMs,
    prompt,
    ...(options.videoResolution ? { resolution: options.videoResolution } : {}),
  });

  const job = await options.video.poll(jobId);
  if (job.status !== "succeeded") {
    throw new Error(`镜头 ${shot.id} 生成失败：${job.error ?? job.status}`);
  }
  const video = job.output ?? (await options.video.fetch(jobId));

  const imageCny = frame ? round2(frame.costCny ?? prices.imageCny) : 0;
  const videoCny = round2(
    video.costCny ?? (shot.durationMs / 1000) * prices.videoPerSecondCny,
  );

  const take: Take = {
    id: `take-${shot.id}-${video.assetId}`,
    shotId: shot.id,
    assetId: video.assetId,
    provenance: video.provenance,
    status: "draft",
    costCny: round2(imageCny + videoCny),
  };

  return {
    shotId: shot.id,
    take,
    ledger: [
      ...(frame
        ? [{ shotId: shot.id, modelId: frame.provenance.modelId, cny: imageCny }]
        : []),
      { shotId: shot.id, modelId: video.provenance.modelId, cny: videoCny },
    ],
    costCny: take.costCny ?? 0,
    ...(frame ? { imageUri: frame.uri } : {}),
    videoUri: video.uri,
  };
}

const SIZE_CN: Record<Shot["shotSize"], string> = {
  wide: "全景",
  medium: "中景",
  close: "特写",
  "extreme-close": "大特写",
};

const ANGLE_CN: Record<Shot["camera"]["angle"], string> = {
  eye: "平视",
  low: "仰拍",
  high: "俯拍",
  top: "顶拍",
};

const MOVE_CN: Record<Shot["camera"]["movement"], string> = {
  static: "固定机位",
  push: "缓缓推近",
  pull: "缓缓拉远",
  pan: "横移",
  tilt: "升降",
  handheld: "手持轻微晃动",
};

/**
 * 镜头提示词：先写“看到什么”，再写技术参数。
 * 技术参数放前面会让模型先学会“这是一个镜头任务”，画面就死了。
 */
export function buildShotPrompt(shot: Shot): string {
  const parts: string[] = [];
  if (shot.description) parts.push(shot.description);

  const { shotSize, camera } = shot;
  parts.push(
    `${SIZE_CN[shotSize]}，${ANGLE_CN[camera.angle]}，${MOVE_CN[camera.movement]}，${camera.focalMm}mm`,
  );
  parts.push("竖屏 9:16，实拍电影质感，自然光，轻微胶片颗粒");

  return parts.join("。");
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
