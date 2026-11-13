/**
 * 转场与调色（E4 / ADR-0169）。
 *
 * 两件事都只在**导出**时发生：时间线与项目里的字段是事实，这里把它们编译成
 * ffmpeg 滤镜。编译是纯函数，所以能在测试里逐字断言，也能在界面里当场预览
 * 「会送出去什么」。
 *
 * 为什么不用 `xfade`：`xfade` 让两段画面重叠，成片会比时间线短一个转场时长，
 * 后面的字幕与配音整体错位。时长由音轨定（准则 P5），不为一个转场让步。
 * 这里做的是**不改变时长**的过渡：上一段末尾淡到黑（或白），下一段开头再淡回来。
 */

import {
  DEFAULT_GRADE,
  type Grade,
  type TimelineItem,
  type Transition,
  type TransitionKind,
} from "@loomina/ir";

/* ------------------------------------------------------------------ */
/* 转场                                                                 */
/* ------------------------------------------------------------------ */

export const TRANSITION_LABEL: Record<TransitionKind, string> = {
  black: "淡到黑",
  white: "淡到白",
};

/** ffmpeg `fade` 滤镜的 color 参数 */
const FADE_COLOR: Record<TransitionKind, string> = {
  black: "black",
  white: "white",
};

export const TRANSITION_MIN_MS = 100;
export const TRANSITION_MAX_MS = 600;
export const TRANSITION_DEFAULT_MS = 300;

/** 一段在接缝上的淡入淡出计划；单位毫秒，0 表示这一侧不淡 */
export type ClipFades = {
  fadeInMs: number;
  fadeInKind: TransitionKind;
  fadeOutMs: number;
  fadeOutKind: TransitionKind;
};

/**
 * 一条时间线上每一段的淡入淡出。
 *
 * 转场挂在**后一段**上：第 N 段的 `transitionIn` 同时决定第 N-1 段的淡出与
 * 第 N 段的淡入。第一段没有上一段，它的 `transitionIn` 被忽略。
 *
 * 单侧时长夹在「这一段的一半」以内：300ms 的转场接在 400ms 的短镜上，
 * 淡出还没完就要淡入，画面会一直黑着。夹完不足 100ms 就不做——
 * 一个 40ms 的闪黑不是转场，是故障。
 */
export function clipFades(items: Pick<TimelineItem, "durationMs" | "transitionIn">[]): ClipFades[] {
  return items.map((item, index) => {
    const next = items[index + 1]?.transitionIn;
    const fadeIn = index === 0 ? undefined : item.transitionIn;
    const inMs = fadeMs(item.durationMs, fadeIn);
    const outMs = fadeMs(item.durationMs, next);
    return {
      fadeInMs: inMs,
      fadeInKind: fadeIn?.kind ?? "black",
      fadeOutMs: outMs,
      fadeOutKind: next?.kind ?? "black",
    };
  });
}

/** 单侧淡多久：不超过这一段的一半，夹完不足 100ms 就不做 */
function fadeMs(durationMs: number, transition: Transition | undefined): number {
  const wanted = Math.min(transition?.durationMs ?? 0, Math.floor(durationMs / 2));
  return wanted >= TRANSITION_MIN_MS ? wanted : 0;
}

/**
 * 一段的淡入淡出滤镜。必须排在 `setpts=PTS-STARTPTS` 之后：
 * `fade` 按时间戳算起止，时间戳没归零就会淡在错误的帧上。
 */
export function fadeFilters(fades: ClipFades, durationMs: number): string[] {
  const filters: string[] = [];
  if (fades.fadeInMs > 0) {
    filters.push(
      `fade=t=in:st=0:d=${(fades.fadeInMs / 1000).toFixed(3)}:color=${FADE_COLOR[fades.fadeInKind]}`,
    );
  }
  if (fades.fadeOutMs > 0) {
    const start = Math.max(0, durationMs - fades.fadeOutMs) / 1000;
    filters.push(
      `fade=t=out:st=${start.toFixed(3)}:d=${(fades.fadeOutMs / 1000).toFixed(3)}:color=${FADE_COLOR[fades.fadeOutKind]}`,
    );
  }
  return filters;
}

/* ------------------------------------------------------------------ */
/* 调色                                                                 */
/* ------------------------------------------------------------------ */

export type GradePreset = {
  id: string;
  name: string;
  blurb: string;
  value: Omit<Grade, "presetId">;
};

/**
 * 调色预设：短剧要的是「统一」，不是「创作」。
 *
 * 五个取向覆盖日常、回忆、悬疑、都市与明亮；逐项仍可改。
 * 真正的 LUT（.cube 文件导入）属于 I3，这里不做（ADR-0169「不做」）。
 */
export const GRADE_PRESETS: GradePreset[] = [
  {
    id: "original",
    name: "原样",
    blurb: "不调色：模型给什么就是什么，最不容易出错。",
    value: { contrast: "natural", saturation: "natural", temperature: "neutral", vignette: false },
  },
  {
    id: "cinema",
    name: "电影",
    blurb: "略压饱和、四角压暗：画面收得住，像一条片子。",
    value: { contrast: "natural", saturation: "muted", temperature: "neutral", vignette: true },
  },
  {
    id: "memory",
    name: "暖忆",
    blurb: "低反差、偏暖、轻暗角：回忆、家庭、结尾回望。",
    value: { contrast: "flat", saturation: "natural", temperature: "warm", vignette: true },
  },
  {
    id: "thriller",
    name: "冷峻",
    blurb: "高对比、退色、偏冷：审问、追查、雨夜。",
    value: { contrast: "punchy", saturation: "muted", temperature: "cool", vignette: true },
  },
  {
    id: "bright",
    name: "明亮日常",
    blurb: "低反差、加饱和、偏暖：办公室与生活流。",
    value: { contrast: "flat", saturation: "rich", temperature: "warm", vignette: false },
  },
];

export function gradePresetById(id: string): GradePreset | undefined {
  return GRADE_PRESETS.find((item) => item.id === id);
}

const GRADE_CONTRAST_CN: Record<Grade["contrast"], string> = {
  flat: "压平对比",
  natural: "对比原样",
  punchy: "加对比",
};

const GRADE_SATURATION_CN: Record<Grade["saturation"], string> = {
  muted: "退色",
  natural: "饱和原样",
  rich: "加饱和",
};

const GRADE_TEMPERATURE_CN: Record<Grade["temperature"], string> = {
  cool: "偏冷",
  neutral: "色温原样",
  warm: "偏暖",
};

/** 这一份调色是不是完全默认：界面据此显示「没动过」、渲染时据此跳过整段滤镜 */
export function isDefaultGrade(grade: Grade | undefined): boolean {
  if (!grade) return true;
  return (
    !grade.presetId &&
    grade.contrast === DEFAULT_GRADE.contrast &&
    grade.saturation === DEFAULT_GRADE.saturation &&
    grade.temperature === DEFAULT_GRADE.temperature &&
    grade.vignette === DEFAULT_GRADE.vignette
  );
}

/** 一句人话：面板与提示里都用它，免得两处各写一套 */
export function gradeLine(grade: Grade | undefined): string {
  const value = grade ?? DEFAULT_GRADE;
  const preset = gradePresetById(value.presetId);
  const bits = [
    GRADE_CONTRAST_CN[value.contrast],
    GRADE_SATURATION_CN[value.saturation],
    GRADE_TEMPERATURE_CN[value.temperature],
    ...(value.vignette ? ["四角压暗"] : []),
  ];
  if (isDefaultGrade(value)) return "原样，不调色";
  return preset ? `${preset.name}：${bits.join("，")}` : bits.join("，");
}

/**
 * 调色滤镜：接在拼好的画面之后、字幕与角标之前。
 *
 * 顺序很重要——字幕压完再调色，白字会被调成米黄、角标会跟着变暗，
 * 而这两样都有合规要求（H5）。
 */
export function gradeFilters(grade: Grade | undefined): string[] {
  const value = grade ?? DEFAULT_GRADE;
  if (isDefaultGrade(value)) return [];

  const filters: string[] = [];
  const eq: string[] = [];
  if (value.contrast === "flat") eq.push("contrast=0.92");
  if (value.contrast === "punchy") eq.push("contrast=1.16");
  if (value.saturation === "muted") eq.push("saturation=0.85");
  if (value.saturation === "rich") eq.push("saturation=1.18");
  if (eq.length) filters.push(`eq=${eq.join(":")}`);

  if (value.temperature === "warm") filters.push("colorbalance=rs=0.06:bs=-0.06");
  if (value.temperature === "cool") filters.push("colorbalance=rs=-0.05:bs=0.05");

  if (value.vignette) filters.push("vignette=PI/4");
  return filters;
}

/**
 * 预览用的近似（E4）：CSS `filter` 对上对比 / 饱和 / 色温三档。
 *
 * 不是逐像素等价——ffmpeg 的 `colorbalance` 与 CSS 的 `sepia` 不是同一个公式，
 * 预览只求「看得出调过没有」。真正的画面以导出为准，界面也这么写。
 */
export function gradeCssFilter(grade: Grade | undefined): string {
  const value = grade ?? DEFAULT_GRADE;
  if (isDefaultGrade(value)) return "";
  const bits: string[] = [];
  if (value.contrast === "flat") bits.push("contrast(0.92)");
  if (value.contrast === "punchy") bits.push("contrast(1.16)");
  if (value.saturation === "muted") bits.push("saturate(0.85)");
  if (value.saturation === "rich") bits.push("saturate(1.18)");
  if (value.temperature === "warm") bits.push("sepia(0.16)");
  if (value.temperature === "cool") bits.push("hue-rotate(-8deg) saturate(0.96)");
  return bits.join(" ");
}
