/**
 * 按角色给字幕着色（D3）。
 *
 * 多人对话里，「这句是谁说的」比字号更影响理解；加名字前缀会把字幕撑长，
 * 颜色不会。色板是固定的六个亮色：深色描边之下都比纯白更容易区分，
 * 也不会和画面里的肤色 / 灯光抢眼。
 *
 * 颜色不进 IR：按 `project.characters` 的顺序取色，角色顺序不变颜色就不变。
 * 超过六个角色从头轮回——再多就没人分得清了，那是剧本的问题。
 */

export const SPEAKER_COLORS = [
  "#FFD666",
  "#7FD8FF",
  "#FFA6C9",
  "#A8F0A0",
  "#C9B6FF",
  "#FFB27A",
] as const;

/** 没有说话人（旁白 / 没标角色）时回到白色 */
export const SPEAKER_DEFAULT_COLOR = "#FFFFFF";

/** 第 `index` 个角色的颜色；负数和越界都轮回 */
export function speakerColorAt(index: number): string {
  if (!Number.isFinite(index)) return SPEAKER_DEFAULT_COLOR;
  const length = SPEAKER_COLORS.length;
  const seat = ((Math.trunc(index) % length) + length) % length;
  return SPEAKER_COLORS[seat]!;
}

/** 角色 id → 颜色：按项目里的角色顺序排，不按哈希（避免两个角色撞色） */
export function speakerPaletteOf(characterIds: string[]): Map<string, string> {
  const palette = new Map<string, string>();
  characterIds.forEach((id, index) => {
    palette.set(id, speakerColorAt(index));
  });
  return palette;
}

/** 把 `#RRGGBB` 转成 ASS 的行内颜色覆盖；格式不合法就返回空串 */
export function assColorOf(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return "";
  const rgb = match[1]!.toUpperCase();
  const bgr = `${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`;
  return `{\\c&H${bgr}&}`;
}
