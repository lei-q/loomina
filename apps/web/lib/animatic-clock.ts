/**
 * 预演时间轴（E7.1 / ADR-0127）。
 *
 * 预演原来只能「从某一镜开头播」；这一层把「整条片子的第几毫秒」换算成
 * 「第几镜 + 镜内偏移」，反过来也一样。三个函数都是纯的，拖动找点与
 * 播放进度共用同一套换算，不会出现「拖到的地方与播到的地方差一镜」。
 *
 * 精度是刻意的：镜内偏移只是数字，能不能精确落到那一帧由播放器决定
 * （`<video>` 只能从最近的关键帧之后解码），所以界面写「到镜准确，镜内近似」。
 */

export type TimelineSegment = { dur: number };

/** 全长（毫秒）；没有镜头时是 0 */
export function totalMsOf(segments: TimelineSegment[]): number {
  return segments.reduce((sum, item) => sum + Math.max(0, item.dur) * 1000, 0);
}

/**
 * 整条片子的第 `ms` 毫秒落在哪一镜、镜内偏移多少。
 *
 * 边界取左闭右开：正好落在切点上算**后一镜的第 0 毫秒**，
 * 与播放推进时的判断一致（偏移达到时长就切下一镜）。
 * 超出两端时夹到首尾，不返回 -1 或越界下标。
 */
export function locateInTimeline(
  segments: TimelineSegment[],
  ms: number,
): { index: number; offsetMs: number } {
  if (segments.length === 0) return { index: 0, offsetMs: 0 };
  const total = totalMsOf(segments);
  const clamped = Math.min(Math.max(0, ms), Math.max(0, total - 1));
  let acc = 0;
  for (const [index, item] of segments.entries()) {
    const span = Math.max(0, item.dur) * 1000;
    if (clamped < acc + span || index === segments.length - 1) {
      return { index, offsetMs: Math.max(0, clamped - acc) };
    }
    acc += span;
  }
  return { index: segments.length - 1, offsetMs: 0 };
}

/** 第 `index` 镜镜内 `offsetMs` 毫秒，对应整条片子的第几毫秒 */
export function elapsedMsOf(
  segments: TimelineSegment[],
  index: number,
  offsetMs: number,
): number {
  const before = segments
    .slice(0, Math.max(0, Math.min(index, segments.length)))
    .reduce((sum, item) => sum + Math.max(0, item.dur) * 1000, 0);
  return before + Math.max(0, offsetMs);
}
