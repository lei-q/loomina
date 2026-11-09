/**
 * 中转站公开价目表（2026-11-09 从 GET /v1/models 抓取，人民币）。
 *
 * 只收录“能换算成每秒/每张”的模型。按 token 计价的模型
 * （seedance 系列）没有公开 token 公式，无法离线预估，故意不进来——
 * 预估不出来的价格不是价格，是猜测（准则 P21）。
 */
export type PriceUnit = "per_second" | "per_image";

export interface VideoPriceQuote {
  model: string;
  resolution: string;
  cnyPerSecond: number;
}

export interface ImagePriceQuote {
  model: string;
  cnyPerImage: number;
}

export const VIDEO_PRICES: VideoPriceQuote[] = [
  { model: "minimax-h3", resolution: "768p", cnyPerSecond: 0.5 },
  { model: "minimax-h3", resolution: "2k", cnyPerSecond: 0.8 },
  { model: "wan3.0-video", resolution: "480p", cnyPerSecond: 0.3 },
  { model: "wan3.0-video", resolution: "720p", cnyPerSecond: 0.6 },
  { model: "wan3.0-video", resolution: "1080p", cnyPerSecond: 1.2 },
  { model: "wan3.0-video-prime", resolution: "480p", cnyPerSecond: 0.45 },
  { model: "wan3.0-video-prime", resolution: "720p", cnyPerSecond: 0.9 },
  { model: "wan3.0-video-prime", resolution: "1080p", cnyPerSecond: 1.8 },
];

export const IMAGE_PRICES: ImagePriceQuote[] = [
  { model: "gpt-image-2-c", cnyPerImage: 0.12 },
  { model: "gpt-image-2.5-flare-c", cnyPerImage: 0.12 },
  { model: "gpt-image-2.5-sunburst-c", cnyPerImage: 0.12 },
  { model: "gpt-image-2.6-flare-c", cnyPerImage: 0.12 },
  { model: "gpt-image-2.6-sunburst-c", cnyPerImage: 0.12 },
];

/** 首帧图超额部分：minimax-h3 每张 ¥0.2（免费额度之外）。 */
export const IMAGE_INPUT_CNY = 0.2;

export function videoPrice(
  model: string,
  resolution: string,
): VideoPriceQuote | undefined {
  return VIDEO_PRICES.find(
    (p) => p.model === model && p.resolution === resolution,
  );
}

export function imagePrice(model: string): ImagePriceQuote | undefined {
  return IMAGE_PRICES.find((p) => p.model === model);
}

/** 拿不到价目就返回 undefined，让调用方显式处理“不知道多少钱”。 */
export function videoCostCny(
  model: string,
  resolution: string,
  durationMs: number,
): number | undefined {
  const quote = videoPrice(model, resolution);
  if (!quote) return undefined;
  return round2((durationMs / 1000) * quote.cnyPerSecond);
}

export function imageCostCny(model: string): number | undefined {
  return imagePrice(model)?.cnyPerImage;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
