/**
 * 画面风格与摄影参数（B7 / I5，ADR-0165）。
 *
 * 一条片子的画面风格必须**只有一处定义**：每个提示词各写一句「实拍电影质感、
 * 自然光、轻微胶片颗粒」，改风格就得挨个改，而且很容易漏掉某一格。
 * 这里把风格收敛成项目上的一组参数（`Project.look`），再编译成提示词的最后一句。
 *
 * 编译是纯函数：同样的参数永远得到同一句话，所以提示词可以随时重算，
 * 不需要把编译结果存进 IR。
 */

import type { Look } from "@loomina/ir";

/** 风格预设：一条片子的整体质感取向 */
export type LookPreset = {
  id: string;
  name: string;
  /** 一句人话，作者选的时候看这个 */
  blurb: string;
  /** 进提示词的质感描述 */
  phrase: string;
  /** 预设自带的默认参数：选中时一起填进表单，作者仍可逐项改 */
  defaults: Pick<Look, "contrast" | "temperature" | "texture">;
};

export const LOOK_PRESETS: LookPreset[] = [
  {
    id: "cinema",
    name: "实拍电影",
    blurb: "自然光、标准光比、轻微颗粒：默认档，最不容易出错",
    phrase: "实拍电影质感，自然光，轻微胶片颗粒",
    defaults: { contrast: "balanced", temperature: "neutral", texture: "grain" },
  },
  {
    id: "drama",
    name: "冷调都市",
    blurb: "硬光比、偏冷、干净：办公室与雨夜的冲突戏",
    phrase: "都市剧情质感，冷调，硬光，高反差，画面干净",
    defaults: { contrast: "hard", temperature: "cool", texture: "clean" },
  },
  {
    id: "warm",
    name: "暖调家庭",
    blurb: "柔光、偏暖、颗粒：客厅、饭桌、回忆",
    phrase: "家庭剧质感，暖调，柔光，低反差，轻微颗粒",
    defaults: { contrast: "soft", temperature: "warm", texture: "grain" },
  },
  {
    id: "dream",
    name: "梦境柔焦",
    blurb: "柔光、中性、柔焦：闪回、想象、结尾升华",
    phrase: "梦境质感，柔焦，柔光，轻微光晕，低反差",
    defaults: { contrast: "soft", temperature: "neutral", texture: "dream" },
  },
  {
    id: "noir",
    name: "黑色电影",
    blurb: "硬光比、偏冷、颗粒：悬疑与审问",
    phrase: "黑色电影质感，硬光，深阴影，冷调，颗粒明显",
    defaults: { contrast: "hard", temperature: "cool", texture: "grain" },
  },
];

export function lookPresetById(id: string): LookPreset | undefined {
  return LOOK_PRESETS.find((preset) => preset.id === id);
}

const CONTRAST_CN: Record<Look["contrast"], string> = {
  soft: "柔光，低反差",
  balanced: "",
  hard: "硬光，高反差",
};

const TEMPERATURE_CN: Record<Look["temperature"], string> = {
  warm: "暖调",
  neutral: "",
  cool: "冷调",
};

const TEXTURE_CN: Record<Look["texture"], string> = {
  clean: "画面干净，无颗粒",
  grain: "轻微胶片颗粒",
  dream: "柔焦，轻微光晕",
};

/** 没有选预设时的兜底：与 ADR-0029 以来每一份提示词的最后一句一致 */
export const DEFAULT_LOOK_LINE = "竖屏 9:16，实拍电影质感，自然光，轻微胶片颗粒";

/** 一项都没改的 look：`ProjectSchema` 的默认值就是它 */
const DEFAULT_LOOK: Look = {
  presetId: "",
  contrast: "balanced",
  temperature: "neutral",
  texture: "grain",
  aspect: "9:16",
  note: "",
};

/**
 * 参数 → 提示词最后一句。
 *
 * 规则：
 * - 选了预设，就用预设的整句，再按逐项参数**补齐**预设没说的那部分；
 * - 没选预设且三项都是默认值时，原样返回 `DEFAULT_LOOK_LINE`——
 *   旧项目重算出来的提示词与以前逐字一致；
 * - 没选预设但改过项时，按逐项参数拼；
 * - 作者手写的补充句放在最后。
 */
export function compileLook(look: Look | undefined): string {
  const value = look ?? DEFAULT_LOOK;
  const preset = lookPresetById(value.presetId);
  const note = value.note.trim();

  // 预设与逐项参数一致时用预设的整句（写得比逐项拼接更像人话）。
  // 只选了预设、三项还是全局默认值时也算一致：界面会把预设的默认值一起填进来，
  // 但手写的日志或旧数据可能只带了一个 `presetId`。
  const untouched =
    value.contrast === DEFAULT_LOOK.contrast &&
    value.temperature === DEFAULT_LOOK.temperature &&
    value.texture === DEFAULT_LOOK.texture;
  const matchesPreset =
    preset !== undefined &&
    (untouched ||
      (value.contrast === preset.defaults.contrast &&
        value.temperature === preset.defaults.temperature &&
        value.texture === preset.defaults.texture));

  if (preset && matchesPreset) {
    const parts = [`竖屏 ${value.aspect}`, preset.phrase];
    if (note) parts.push(note);
    return parts.join("，");
  }

  if (!preset && isDefaultLook(value)) return DEFAULT_LOOK_LINE;

  // 参数和预设不一致时整句按参数重编：把「冷调」和「暖调」拼在一句里，
  // 模型拿到的是自相矛盾的指令。预设只保留它那一句的**质感名词**
  // （「黑色电影质感」），技术项一律以参数为准。
  const character = preset ? preset.phrase.split("，")[0] : "实拍电影质感";
  const bits = [
    character,
    CONTRAST_CN[value.contrast],
    TEMPERATURE_CN[value.temperature],
    TEXTURE_CN[value.texture],
  ].filter(Boolean);
  const parts = [`竖屏 ${value.aspect}`, bits.join("，")];
  if (note) parts.push(note);
  return parts.join("，");
}

/** 定妆照与道具参考图的默认句：棚拍，不跟项目风格走 */
export const DEFAULT_STUDIO_LOOK_LINE = "竖屏 9:16，实拍电影质感，柔光棚拍";

/**
 * 定妆 / 道具用的风格句：默认档保持原来的棚拍口径，
 * 作者选过风格或改过参数时才接上项目的质感（B7 / ADR-0165）。
 */
export function compileStudioLook(look: Look | undefined): string {
  if (isDefaultLook(look)) return DEFAULT_STUDIO_LOOK_LINE;
  return `${compileLook(look)}，柔光棚拍`;
}

/** 这一份 look 是不是完全默认：界面据此显示「没动过」 */
export function isDefaultLook(look: Look | undefined): boolean {
  if (!look) return true;
  return (
    !look.presetId &&
    look.contrast === "balanced" &&
    look.temperature === "neutral" &&
    look.texture === "grain" &&
    look.aspect === "9:16" &&
    !look.note.trim()
  );
}
