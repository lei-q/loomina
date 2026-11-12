import type { Modality } from "./config-types";

/**
 * 按用量计价的两种模态（H4）。
 *
 * 图像按张、视频按秒，价目表里查得到；文本按 token、配音按字，
 * 供应商的价目随模型与渠道变，`/v1/models` 又不给 chat / tts 的价格（R28 / R39）。
 * 所以这两种模态的单价由作者在设置页填，这里只负责把「用量 × 单价」算成钱。
 *
 * 填了就是估算，没填就是不知道：不填时一分钱也不加，只在账上数「未定价」
 * （准则 P21：预估不出来的价格不是价格）。
 */

export const METERED_MODALITIES = ["text", "tts"] as const;
export type MeteredModality = (typeof METERED_MODALITIES)[number];

export function isMetered(modality: Modality): modality is MeteredModality {
  return (METERED_MODALITIES as readonly string[]).includes(modality);
}

/** 单价的口径：写清单位，作者才知道该填哪个数 */
export const METER_LABEL: Record<MeteredModality, string> = {
  text: "元 / 百万 token",
  tts: "元 / 千字",
};

/** 用量除以它再乘单价 */
export const METER_DIVISOR: Record<MeteredModality, number> = {
  text: 1_000_000,
  tts: 1_000,
};

/** 这种模态记的用量单位 */
export const METER_UNIT: Record<MeteredModality, "tokens" | "chars"> = {
  text: "tokens",
  tts: "chars",
};

/**
 * 用量 → 钱。单价没填、用量没有、或用量为 0 都返回 undefined：
 * 缺一个条件就算不出来，算不出来就不写金额。
 */
export function meteredCostCny(
  modality: MeteredModality,
  units: number | undefined,
  unitPriceCny: number | undefined,
): number | undefined {
  if (units === undefined || !Number.isFinite(units) || units <= 0) return undefined;
  if (unitPriceCny === undefined || !Number.isFinite(unitPriceCny) || unitPriceCny < 0) {
    return undefined;
  }
  const cost = (units / METER_DIVISOR[modality]) * unitPriceCny;
  // 一分钱以下留两位；四舍五入到 4 位，免得大量小调用全被抹成 0
  return Math.round(cost * 10_000) / 10_000;
}

/** 账单里怎么念这个数：「12.4k token」「86 字」 */
export function formatUsage(units: number, unit: "tokens" | "chars"): string {
  if (unit === "chars") return `${Math.round(units)} 字`;
  if (units >= 1_000) return `${(units / 1_000).toFixed(1)}k token`;
  return `${Math.round(units)} token`;
}
