import { IMAGE_PRICES, videoPrice } from "@loomina/gateway/pricing";

/**
 * 重做一次要多少钱（准则 P21 / COST.md 不变量 39）。
 *
 * 价目表只有一份，在 `@loomina/gateway/pricing`；这里只做"这个镜头重做一次"的换算：
 *   时长 × 每秒单价 + 一张首帧。
 * 拿不到价目就返回 undefined —— 预估不出来的价格不是价格，是猜测。
 */

/** 当前价位：草稿档用 minimax-h3 @ 768p，首帧用最便宜的一档。 */
export const DRAFT_MODEL = "minimax-h3";
export const DRAFT_RESOLUTION = "768p";
export const KEYFRAME_MODEL = "gpt-image-2-c";

export type Requote = {
  /** 元；拿不到价目时为 undefined */
  totalCny?: number;
  videoCny?: number;
  keyframeCny?: number;
  /** 给界面看的一句话依据，比如 "2.4s × ¥0.50/s + 首帧 ¥0.12" */
  basis: string;
};

/** 整片重做一遍的报价。镜数写进来，因为它决定这个数怎么来的。 */
export type ProjectRequote = Requote & { shots: number };

const round2 = (value: number) => Math.round(value * 100) / 100;

export function requoteShot(
  durationMs: number,
  options: { model?: string; resolution?: string; keyframeModel?: string } = {},
): Requote {
  const model = options.model ?? DRAFT_MODEL;
  const resolution = options.resolution ?? DRAFT_RESOLUTION;
  const keyframeModel = options.keyframeModel ?? KEYFRAME_MODEL;

  const quote = videoPrice(model, resolution);
  if (!quote) {
    return {
      basis: `${model} @ ${resolution} 不在价目表里，无法报价`,
    };
  }

  const seconds = round2(durationMs / 1000);
  const videoCny = round2(seconds * quote.cnyPerSecond);
  const keyframeCny = IMAGE_PRICES.find((p) => p.model === keyframeModel)?.cnyPerImage;

  if (keyframeCny === undefined) {
    return {
      videoCny,
      basis: `${seconds.toFixed(1)}s × ¥${quote.cnyPerSecond.toFixed(2)}/s（首帧 ${keyframeModel} 无价目）`,
    };
  }

  return {
    totalCny: round2(videoCny + keyframeCny),
    videoCny,
    keyframeCny,
    basis: `${seconds.toFixed(1)}s × ¥${quote.cnyPerSecond.toFixed(2)}/s + 首帧 ¥${keyframeCny.toFixed(2)}`,
  };
}

/**
 * 整片重做一遍要多少钱：每一镜各算一次，再相加。
 *
 * 逐镜取整再求和，因为实际是按镜下单，账要对得上；有一镜报不出价，
 * 整片就不给总数——少算一镜的价格比不给更糟。
 */
export function requoteProject(
  durationsMs: number[],
  options: { model?: string; resolution?: string; keyframeModel?: string } = {},
): ProjectRequote {
  const shots = durationsMs.length;
  const model = options.model ?? DRAFT_MODEL;
  const resolution = options.resolution ?? DRAFT_RESOLUTION;
  const keyframeModel = options.keyframeModel ?? KEYFRAME_MODEL;
  const basisPrefix = `${shots} 镜，${model} @ ${resolution} + 首帧 ${keyframeModel}`;

  let total = 0;
  let video = 0;
  let keyframe = 0;
  for (const durationMs of durationsMs) {
    const quote = requoteShot(durationMs, options);
    if (quote.totalCny === undefined) {
      return { shots, basis: `${basisPrefix}：有镜头报不出价，整片不给总数` };
    }
    total += quote.totalCny;
    video += quote.videoCny ?? 0;
    keyframe += quote.keyframeCny ?? 0;
  }

  return {
    totalCny: round2(total),
    videoCny: round2(video),
    keyframeCny: round2(keyframe),
    shots,
    basis: basisPrefix,
  };
}
