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
  DEFAULT_FRAME,
  DEFAULT_GRADE,
  type Frame,
  type FrameAspect,
  type FrameFit,
  type Grade,
  type ShotFocus,
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
  /**
   * 只改对比 / 饱和 / 色温 / 暗角四档。
   *
   * 胶片质感与导入的 LUT 属于另一层（I3）：选一个调色预设不该把作者导入的
   * 调色表关掉，也不该把颗粒清零。
   */
  value: Pick<Grade, "contrast" | "saturation" | "temperature" | "vignette">;
};

/**
 * 调色预设：短剧要的是「统一」，不是「创作」。
 *
 * 五个取向覆盖日常、回忆、悬疑、都市与明亮；逐项仍可改。
 * 胶片质感与导入的 .cube 是另一层（I3），换预设不会动它们。
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

/* ------------------------------------------------------------------ */
/* 胶片质感与 LUT（I3 / ADR-0181）                                       */
/* ------------------------------------------------------------------ */

export type FilmPreset = {
  id: Grade["film"];
  name: string;
  blurb: string;
};

/**
 * 内置胶片质感：不引入第三方 LUT 文件，全部用 ffmpeg 的曲线组合拼出来。
 *
 * 这样 `package.json` 不用多一个包、库里也不用带一堆来路不明的 `.cube`；
 * 作者要更精确的胶片表，就导入自己的 `.cube`（同一条滤镜链的 `lut3d`）。
 */
export const FILM_PRESETS: FilmPreset[] = [
  { id: "none", name: "不叠", blurb: "只用上面的逐项调色。" },
  { id: "warm-film", name: "暖胶片", blurb: "高光偏暖、复古曲线：回忆、家庭、结尾回望。" },
  { id: "cool-film", name: "冷胶片", blurb: "阴影偏青蓝、中对比：雨夜、审讯、追查。" },
  { id: "faded", name: "褪色", blurb: "抬黑位、退饱和：旧照片、过期胶片。" },
  { id: "mono", name: "黑白", blurb: "去色后加中对比：闪回与纪录感。" },
];

export function filmPresetById(id: Grade["film"]): FilmPreset | undefined {
  return FILM_PRESETS.find((item) => item.id === id);
}

/**
 * 胶片质感 + 颗粒的滤镜。
 *
 * 顺序：曲线在前、颗粒在后。颗粒先加会被后面的对比 / 饱和一起放大，
 * 出来的噪点比作者给的值重得多。
 */
export function filmFilters(film: Grade["film"], grain: number): string[] {
  const filters: string[] = [];
  if (film === "warm-film") {
    filters.push("curves=preset=vintage", "colorbalance=rs=0.03:gs=0.01:bs=-0.04");
  } else if (film === "cool-film") {
    filters.push("curves=preset=medium_contrast", "colorbalance=rs=-0.04:bs=0.05");
  } else if (film === "faded") {
    filters.push("curves=preset=lighter", "eq=saturation=0.82:contrast=0.9");
  } else if (film === "mono") {
    filters.push("hue=s=0", "curves=preset=medium_contrast");
  }
  if (grain > 0) {
    // `noise` 的 alls 上限是 100：作者的 0–100 按 0.6 折过去，满格也不糊成雪花
    filters.push(`noise=alls=${Math.round(grain * 0.6)}:allf=t+u`);
  }
  return filters;
}

/** 滤镜选项里的路径：`\`、`:`、`'`、`,` 在 ffmpeg 的滤镜图里都是特殊字符 */
function escapeFilterPath(filePath: string): string {
  return filePath.replace(/([\\:'[\],;])/g, "\\$1");
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
    grade.vignette === DEFAULT_GRADE.vignette &&
    grade.film === DEFAULT_GRADE.film &&
    grade.grain === DEFAULT_GRADE.grain &&
    !grade.lutAssetId
  );
}

/** 一句人话：面板与提示里都用它，免得两处各写一套 */
export function gradeLine(grade: Grade | undefined): string {
  const value = grade ?? DEFAULT_GRADE;
  const preset = gradePresetById(value.presetId);
  const film = filmPresetById(value.film);
  const bits = [
    GRADE_CONTRAST_CN[value.contrast],
    GRADE_SATURATION_CN[value.saturation],
    GRADE_TEMPERATURE_CN[value.temperature],
    ...(value.vignette ? ["四角压暗"] : []),
    ...(film && film.id !== "none" ? [film.name] : []),
    ...(value.grain > 0 ? [`颗粒 ${value.grain}`] : []),
    ...(value.lutAssetId ? ["自定义 LUT"] : []),
  ];
  if (isDefaultGrade(value)) return "原样，不调色";
  return preset ? `${preset.name}：${bits.join("，")}` : bits.join("，");
}

export type GradeRenderOptions = {
  /** 导入的 .cube 在本机的绝对路径；没给就跳过 LUT，其余调色照常 */
  lutPath?: string;
};

/**
 * 调色滤镜：接在拼好的画面之后、字幕与角标之前。
 *
 * 顺序很重要——字幕压完再调色，白字会被调成米黄、角标会跟着变暗，
 * 而这两样都有合规要求（H5）。
 */
export function gradeFilters(grade: Grade | undefined, options: GradeRenderOptions = {}): string[] {
  const value = grade ?? DEFAULT_GRADE;
  // LUT 文件不在（资产被清掉、换机器渲染）时，只跳过这一段：其余调色照常，
  // 不因为一个文件缺失就让整条片子退回原样
  const lut = value.lutAssetId && options.lutPath ? options.lutPath : undefined;
  if (isDefaultGrade(value) && !lut) return [];

  const filters: string[] = [];
  if (lut) filters.push(`lut3d=filename=${escapeFilterPath(lut)}:interp=trilinear`);

  const eq: string[] = [];
  if (value.contrast === "flat") eq.push("contrast=0.92");
  if (value.contrast === "punchy") eq.push("contrast=1.16");
  if (value.saturation === "muted") eq.push("saturation=0.85");
  if (value.saturation === "rich") eq.push("saturation=1.18");
  if (eq.length) filters.push(`eq=${eq.join(":")}`);

  if (value.temperature === "warm") filters.push("colorbalance=rs=0.06:bs=-0.06");
  if (value.temperature === "cool") filters.push("colorbalance=rs=-0.05:bs=0.05");

  filters.push(...filmFilters(value.film, value.grain));

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
  // 胶片质感只近似：预览用 CSS 对得上「偏暖 / 去色 / 褪色」的大方向，
  // 曲线与颗粒以导出为准。导入的 LUT 预览里没有——CSS 没有 lut3d。
  if (value.film === "mono") bits.push("grayscale(1) contrast(1.08)");
  else if (value.film === "faded") bits.push("contrast(0.9) saturate(0.82)");
  else if (value.film === "warm-film") bits.push("sepia(0.12)");
  else if (value.film === "cool-film") bits.push("hue-rotate(6deg) contrast(1.06)");
  return bits.join(" ");
}

/* ------------------------------------------------------------------ */
/* 画幅（E5 / ADR-0170）                                                */
/* ------------------------------------------------------------------ */

export const FRAME_ASPECT_LABEL: Record<FrameAspect, string> = {
  "9:16": "竖屏 9:16",
  "16:9": "横屏 16:9",
  "1:1": "方形 1:1",
};

export const FRAME_FIT_LABEL: Record<FrameFit, string> = {
  pad: "留边",
  crop: "裁切",
  blur: "模糊填充",
};

export const FRAME_FIT_BLURB: Record<FrameFit, string> = {
  pad: "整幅画面缩到放得下，空出来的地方填深色。最稳，什么都不切。",
  crop: "铺满画幅，多出来的部分切掉。主体靠「留住哪一块」定，切得狠但满屏。",
  blur: "画面缩到放得下，空出来的地方用同一帧放大模糊填满。保住构图又不留黑边。",
};

/** 留边的底色：与预览播放器的底色一致，换画幅时看不出拼缝 */
const PAD_COLOR = "0x0C0C0D";

/** 这一份画幅设置是不是默认：界面据此显示「没动过」，渲染时据此走老路径 */
export function isDefaultFrame(frame: Frame | undefined): boolean {
  const value = frame ?? DEFAULT_FRAME;
  return value.aspect === DEFAULT_FRAME.aspect && value.fit === DEFAULT_FRAME.fit;
}

/** 一句人话：面板、导出提示与历史都用它 */
export function frameLine(frame: Frame | undefined): string {
  const value = frame ?? DEFAULT_FRAME;
  if (isDefaultFrame(value)) return "竖屏 9:16，留边";
  return `${FRAME_ASPECT_LABEL[value.aspect]}，${FRAME_FIT_LABEL[value.fit]}`;
}

/** 一句人话说明焦点在哪儿：`focus` 缺省是居中 */
export function focusLine(focus: ShotFocus | undefined): string {
  if (!focus) return "居中";
  const horizontal = focus.x < 0.4 ? "偏左" : focus.x > 0.6 ? "偏右" : "";
  const vertical = focus.y < 0.4 ? "偏上" : focus.y > 0.6 ? "偏下" : "";
  if (!horizontal && !vertical) return "居中";
  return `${vertical}${horizontal}`;
}

/**
 * 一段的取景链（E5 / ADR-0170）：把任意尺寸的素材规整成成片画幅。
 *
 * 三种适配方式各是一条链，出口统一叫 `frame{i}`：
 * - `pad`：缩到放得下，留边填深色；
 * - `crop`：放大到铺满，按 `focus` 决定留住哪一块；
 * - `blur`：同一帧拆成两路——放大模糊的当底，缩小的放中间。
 *
 * 出口统一带 `setsar=1`：像素形状在这里定死，后面的 fps / trim / 淡变不再管它。
 */
export function frameChain(
  frame: Frame | undefined,
  size: { width: number; height: number },
  focus: ShotFocus | undefined,
  index: number,
): { statements: string[]; out: string } {
  const value = frame ?? DEFAULT_FRAME;
  const { width, height } = size;
  const out = `frame${index}`;
  const input = `${index}:v`;

  if (value.fit === "crop") {
    const fx = (focus?.x ?? 0.5).toFixed(3);
    const fy = (focus?.y ?? 0.5).toFixed(3);
    return {
      statements: [
        `[${input}]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
          `crop=${width}:${height}:(iw-${width})*${fx}:(ih-${height})*${fy},` +
          `setsar=1[${out}]`,
      ],
      out,
    };
  }

  if (value.fit === "blur") {
    // 模糊半径跟着画幅走：短边越窄，半径越小，否则整个底会糊成一块色
    const sigma = Math.max(8, Math.round(Math.min(width, height) / 20));
    return {
      statements: [
        `[${input}]split=2[bgIn${index}][fgIn${index}]`,
        `[bgIn${index}]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
          `crop=${width}:${height},gblur=sigma=${sigma},setsar=1[bg${index}]`,
        `[fgIn${index}]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `setsar=1[fg${index}]`,
        `[bg${index}][fg${index}]overlay=(W-w)/2:(H-h)/2[${out}]`,
      ],
      out,
    };
  }

  return {
    statements: [
      `[${input}]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${PAD_COLOR},setsar=1[${out}]`,
    ],
    out,
  };
}
