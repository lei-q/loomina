import { TRACK_OFFSET_MAX_MS } from "@loomina/ir";

/**
 * 在字幕条上直接拖动一句（E1 / ADR-0145）。
 *
 * 拖动只负责「粗定位」：像素位移按轨道宽度线性换算成毫秒，取整到 10ms。
 * 几十毫秒的精调仍走那句旁边的 `‹ ›` 按钮——拖动与按钮是同一份
 * `subtitleOffsetMs`，只是两种手感。
 */
export const DRAG_SNAP_MS = 10;

/** 轨道上横向拖了多少像素 → 时间位移（毫秒，10ms 取整）。 */
export function dragDeltaMs(
  dxPx: number,
  laneWidthPx: number,
  totalMs: number,
): number {
  if (
    !Number.isFinite(dxPx) ||
    !Number.isFinite(laneWidthPx) ||
    !Number.isFinite(totalMs) ||
    laneWidthPx <= 0 ||
    totalMs <= 0
  ) {
    return 0;
  }
  return Math.round(((dxPx / laneWidthPx) * totalMs) / DRAG_SNAP_MS) * DRAG_SNAP_MS;
}

/**
 * 把「当前偏移 + 拖动位移」夹进 ±30 秒，再折回成本次要写的增量。
 * 夹取发生在目标值上：已经贴着上限时往同方向拖，增量是 0，不会越界。
 */
export function clampedDeltaMs(
  currentMs: number,
  deltaMs: number,
  maxMs: number = TRACK_OFFSET_MAX_MS,
): number {
  const start = Number.isFinite(currentMs) ? currentMs : 0;
  const delta = Number.isFinite(deltaMs) ? deltaMs : 0;
  const target = start + delta;
  const clamped = Math.max(-maxMs, Math.min(maxMs, target));
  const snapped = Math.round(clamped / DRAG_SNAP_MS) * DRAG_SNAP_MS;
  return snapped - start;
}
