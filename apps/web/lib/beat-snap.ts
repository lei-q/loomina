/**
 * 节拍卡点自动剪辑（C5 / SOUND.md 三条纪律之三）。
 *
 * 输入是「这一版配乐多快（BPM）」与「现在的切点在哪」，
 * 输出是**建议切点**：落在节拍网格上的位置，以及每个现有切点离最近网格差多少。
 *
 * 三条克制（来自 SOUND.md）：
 * 1. **卡点服务剪辑**：只给建议，不改时间线、不写事件；
 * 2. **不为了卡点破坏表演节奏**：偏差在容忍范围内就不建议动——
 *    强行对齐会把表演切碎，比「差 40 毫秒」难看得多；
 * 3. **留白**：不是每一秒都要踩点，重音之间允许不踩。
 *
 * 纯函数：不读盘、不调模型、不碰 store。
 */

/** 一拍的细分：整拍 / 半拍 / 四分之一拍 */
export type BeatDivision = 1 | 2 | 4;

export const DIVISION_LABEL: Record<BeatDivision, string> = {
  1: "整拍",
  2: "半拍",
  4: "四分之一拍",
};

/**
 * 偏差容忍（毫秒）。
 *
 * 这是「多近才算已经踩上」的门槛：小于它就不必动。
 * 40 ms 是听觉上「几乎同时」的量级；超过它观众能感觉到拖拍。
 * 没有用样片标定过，先按经验值，将来按实际剪辑反馈调。
 */
export const BEAT_TOLERANCE_MS = 40;

export type CutPoint = {
  /** 切点位置（毫秒，从片子开头算） */
  atMs: number;
  /** 这个切点属于哪一镜（用于在界面上点回去） */
  shotId?: string;
  label?: string;
};

export type BeatGrid = {
  bpm: number;
  /** 一拍的时长（毫秒） */
  beatMs: number;
  /** 网格起点偏移：音乐不一定从第 0 毫秒开始 */
  offsetMs: number;
  division: BeatDivision;
  /** 细分后的间隔（毫秒） */
  stepMs: number;
};

export type CutAlignment = {
  cut: CutPoint;
  /** 离最近网格点差多少毫秒（正数表示切晚了） */
  offsetMs: number;
  /** 最近的网格点位置 */
  nearestMs: number;
  /** 是否已经落在容忍范围内 */
  aligned: boolean;
};

export type BeatSnapPlan = {
  grid: BeatGrid;
  /** 每个现有切点的对齐情况 */
  alignments: CutAlignment[];
  /** 需要挪的切点（偏差超过容忍） */
  drifting: CutAlignment[];
  /** 建议切点：网格上、且离现有切点较远的空位，供「补切」参考 */
  suggestions: number[];
  summary: {
    cuts: number;
    aligned: number;
    drifting: number;
    /** 平均偏差（毫秒），只看在漂的那些 */
    averageDriftMs: number;
  };
};

/** BPM 合法区间：太慢不像短剧配乐，太快切点会碎到看不清 */
export const BPM_MIN = 40;
export const BPM_MAX = 220;

/** 一拍多长（毫秒）。BPM 越界时夹到区间里，不抛错——界面已经先校验过 */
export function beatMsOf(bpm: number, division: BeatDivision = 1): number {
  const safe = Math.min(BPM_MAX, Math.max(BPM_MIN, bpm));
  return 60_000 / safe / division;
}

export function beatGridOf(input: {
  bpm: number;
  offsetMs?: number;
  division?: BeatDivision;
}): BeatGrid {
  const division = input.division ?? 1;
  const beatMs = 60_000 / Math.min(BPM_MAX, Math.max(BPM_MIN, input.bpm));
  return {
    bpm: Math.min(BPM_MAX, Math.max(BPM_MIN, input.bpm)),
    beatMs,
    offsetMs: Math.max(0, input.offsetMs ?? 0),
    division,
    stepMs: beatMs / division,
  };
}

/** 离 `atMs` 最近的网格点 */
export function nearestBeat(grid: BeatGrid, atMs: number): number {
  if (grid.stepMs <= 0) return atMs;
  const index = Math.round((atMs - grid.offsetMs) / grid.stepMs);
  return grid.offsetMs + index * grid.stepMs;
}

/**
 * 把现有切点对到节拍网格上。
 *
 * 只给建议：`aligned` 为 true 的切点不必动；`drifting` 里的才是可以考虑挪的。
 * 挪不挪由作者决定——SOUND.md 说得很清楚，不要为了卡点破坏表演节奏。
 */
export function snapCuts(
  cuts: CutPoint[],
  grid: BeatGrid,
  toleranceMs = BEAT_TOLERANCE_MS,
): BeatSnapPlan {
  const alignments: CutAlignment[] = cuts
    .filter((cut) => Number.isFinite(cut.atMs) && cut.atMs >= 0)
    .sort((a, b) => a.atMs - b.atMs)
    .map((cut) => {
      const nearestMs = nearestBeat(grid, cut.atMs);
      const offsetMs = Math.round(cut.atMs - nearestMs);
      return {
        cut,
        offsetMs,
        nearestMs: Math.round(nearestMs),
        aligned: Math.abs(offsetMs) <= toleranceMs,
      };
    });

  const drifting = alignments.filter((item) => !item.aligned);
  const averageDriftMs =
    drifting.length === 0
      ? 0
      : Math.round(
          drifting.reduce((sum, item) => sum + Math.abs(item.offsetMs), 0) / drifting.length,
        );

  return {
    grid,
    alignments,
    drifting,
    suggestions: suggestionsOf(alignments, grid),
    summary: {
      cuts: alignments.length,
      aligned: alignments.length - drifting.length,
      drifting: drifting.length,
      averageDriftMs,
    },
  };
}

/**
 * 建议切点：网格上、离任何现有切点都至少一格的位置。
 *
 * 只在**已有的两个切点之间跨度足够大**的地方给：跨度小于两格的不建议补，
 * 那会把一个镜头切成两半而观众看不出为什么。
 */
function suggestionsOf(alignments: CutAlignment[], grid: BeatGrid): number[] {
  if (alignments.length < 2 || grid.stepMs <= 0) return [];
  const out: number[] = [];
  for (let index = 1; index < alignments.length; index += 1) {
    const before = alignments[index - 1]!.cut.atMs;
    const after = alignments[index]!.cut.atMs;
    const span = after - before;
    // 跨度不到三格就不建议补：中间那一格离两边都太近
    if (span < grid.stepMs * 3) continue;
    const middle = nearestBeat(grid, before + span / 2);
    if (middle > before + grid.stepMs && middle < after - grid.stepMs) {
      out.push(Math.round(middle));
    }
  }
  return out;
}

/** 一句话说清这一版卡得怎么样，给界面直接用 */
export function beatSnapText(plan: BeatSnapPlan): string {
  const { summary, grid } = plan;
  if (summary.cuts === 0) return "时间线上还没有切点：先排一版初剪。";
  const basis = `${grid.bpm} BPM · ${DIVISION_LABEL[grid.division]}`;
  if (summary.drifting === 0) {
    return `${basis}：${summary.cuts} 个切点都踩在拍上（±${BEAT_TOLERANCE_MS} 毫秒内）。`;
  }
  return `${basis}：${summary.cuts} 个切点里 ${summary.aligned} 个踩上，${summary.drifting} 个偏了（平均 ${summary.averageDriftMs} 毫秒）。挪不挪由你定——不要为了卡点把表演切碎。`;
}

/** 从时间线片段里取切点：每个片段起点都是一个切点，开头那个不算 */
export function cutsOfClips(
  items: { startMs: number; shotId?: string; label?: string }[],
): CutPoint[] {
  return items
    .filter((item) => Number.isFinite(item.startMs) && item.startMs > 0)
    .map((item) => ({ atMs: item.startMs, shotId: item.shotId, label: item.label }))
    .sort((a, b) => a.atMs - b.atMs);
}
