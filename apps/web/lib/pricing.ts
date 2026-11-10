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
