/**
 * 台词时长估算（ADR-0044）。
 *
 * P5 说镜头时长服从配音，但配音（TTS）还没有。改台词时不能把旧时长留在
 * 那里装作还对得上——按中文口播的速度估一个，配音落地后再以音频为准。
 * 口径跟示例项目一致：约 0.3 秒 / 字，不含空白，四舍五入到 0.1 秒。
 */
const MS_PER_CHAR = 300;
const MIN_MS = 800;

export function estimateDialogueMs(text: string): number {
  const chars = [...text.replace(/\s+/g, "")].length;
  if (chars === 0) return MIN_MS;
  return Math.max(MIN_MS, Math.round((chars * MS_PER_CHAR) / 100) * 100);
}
