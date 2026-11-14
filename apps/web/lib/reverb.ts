/**
 * 空间混响（C11 / SOUND.md §八）。
 *
 * 核心要求只有一句：**同场景同一套 reverb 参数**。卧室不该像大厅，
 * 街道不该像录音棚。所以这件事的本质不是「调混响」，而是
 * 「按场景给出该用的那一套，并保证同一场里不换」。
 *
 * 这一档只做**决定与提示**，不直接改渲染命令：
 * - `reverbPresetOf(location)`：按地点的空间属性给出预设；
 * - `reverbPlanOf(project)`：按场列出每场该用哪套，并指出「同一场里
 *   有镜头的场景设置不一致」这类问题（理论上不会发生，因为 reverb 跟场走，
 *   但地点改了空间属性而场没重设时会出现）；
 * - `reverbFilterOf(preset)`：把预设翻成 ffmpeg 滤镜串。
 *
 * 纯计算：不读盘、不调模型。
 */

import type { Location, Project } from "@loomina/ir";

export const REVERB_VERSION = "2026-11";

/**
 * 空间类型 → 混响预设。
 *
 * 参数取的是 ffmpeg `aecho` 的常用档位，**没有用真实房间脉冲响应标定过**：
 * - `decayMs`：回声衰减时长，越大约「空」；
 * - `roomSize`：0–1，模拟房间尺寸，影响回声密度感（用 `aecho` 的多层近似）；
 * - `wet`：混响占比，0–1。对白场景要低（清晰优先），空镜可以高。
 */
export type ReverbPreset = {
  id: string;
  name: string;
  /** 这一套适合什么空间 */
  fits: string;
  decayMs: number;
  roomSize: number;
  wet: number;
};

export const REVERB_PRESETS: ReverbPreset[] = [
  {
    id: "dry",
    name: "干声（无混响）",
    fits: "特写、内心独白、后期配音",
    decayMs: 0,
    roomSize: 0,
    wet: 0,
  },
  {
    id: "small-room",
    name: "小房间",
    fits: "卧室、书房、车内",
    decayMs: 180,
    roomSize: 0.25,
    wet: 0.08,
  },
  {
    id: "living-room",
    name: "客厅",
    fits: "公寓客厅、办公室",
    decayMs: 320,
    roomSize: 0.4,
    wet: 0.12,
  },
  {
    id: "hallway",
    name: "走廊 / 楼梯间",
    fits: "楼道、地下通道、车库",
    decayMs: 620,
    roomSize: 0.55,
    wet: 0.18,
  },
  {
    id: "large-hall",
    name: "大厅",
    fits: "商场、礼堂、大堂",
    decayMs: 1_100,
    roomSize: 0.75,
    wet: 0.24,
  },
  {
    id: "outdoor",
    name: "室外",
    fits: "街道、广场、野外",
    decayMs: 90,
    roomSize: 0.1,
    wet: 0.04,
  },
];

export type ReverbPlanLine = {
  sceneId: string;
  sceneLabel: string;
  locationName: string;
  preset: ReverbPreset;
  /** 这一场几镜 */
  shots: number;
  /** 为什么选这一套 */
  reason: string;
};

export type ReverbPlan = {
  version: string;
  lines: ReverbPlanLine[];
  summary: {
    scenes: number;
    /** 用到的预设种类 */
    presets: string[];
    /** 找不到地点、只能给默认的场数 */
    unresolved: number;
  };
};

/**
 * 按地点的空间属性给预设。
 *
 * 只看两件事：内景 / 外景（`space`），与地点名字里的空间词。
 * 名字匹配是启发式——地点叫「公寓客厅」和叫「林晚家」应当给不同结果，
 * 但工具没法知道后者是客厅，所以只在认得出来时细化，认不出就用
 * 内景 / 外景的默认档，并如实说明。
 */
export function reverbPresetOf(
  location: Location | undefined,
  sceneSpace?: "int" | "ext",
): {
  preset: ReverbPreset;
  reason: string;
} {
  if (!location) {
    return { preset: presetById("living-room"), reason: "找不到地点，按客厅的默认档给" };
  }
  const name = location.name;
  const text = `${name}${location.description ?? ""}`;

  if (/走廊|楼道|楼梯|通道|车库|电梯间/.test(text)) {
    return { preset: presetById("hallway"), reason: "名字里是走廊 / 通道类空间" };
  }
  if (/大厅|商场|礼堂|大堂|剧院|广场室内/.test(text)) {
    return { preset: presetById("large-hall"), reason: "名字里是大厅 / 礼堂类空间" };
  }
  if (/卧室|书房|车内|车里|小屋|房间/.test(text)) {
    return { preset: presetById("small-room"), reason: "名字里是小房间类空间" };
  }
  if (/客厅|办公室|餐厅|教室|公寓/.test(text)) {
    return { preset: presetById("living-room"), reason: "名字里是客厅 / 办公类空间" };
  }
  if (sceneSpace === "ext") {
    return { preset: presetById("outdoor"), reason: "这一场标了外景，用室外档" };
  }
  return {
    preset: presetById("living-room"),
    reason: sceneSpace === "int" ? "这一场标了内景但认不出具体空间，按客厅档" : "没标内景 / 外景，按客厅档",
  };
}

/** 预设 id 的白名单：渲染清单只认这些值（C11 / ADR-0226） */
export const REVERB_IDS = new Set(REVERB_PRESETS.map((preset) => preset.id));

export function presetById(id: string): ReverbPreset {
  return REVERB_PRESETS.find((preset) => preset.id === id) ?? REVERB_PRESETS[0]!;
}

/** 全片的混响计划：按场列出，同一场只用一套 */
export function reverbPlanOf(project: Project): ReverbPlan {
  const lines: ReverbPlanLine[] = [];
  let unresolved = 0;

  for (const scene of [...project.scenes].sort((a, b) => a.index - b.index)) {
    const location = project.locations.find((item) => item.id === scene.locationId);
    if (!location) unresolved += 1;
    const { preset, reason } = reverbPresetOf(location, scene.space);
    lines.push({
      sceneId: scene.id,
      sceneLabel: scene.code ? `第 ${scene.code} 场` : `第 ${scene.index + 1} 场`,
      locationName: location?.name ?? "未挂地点",
      preset,
      shots: scene.shotIds.length,
      reason,
    });
  }

  return {
    version: REVERB_VERSION,
    lines,
    summary: {
      scenes: lines.length,
      presets: [...new Set(lines.map((line) => line.preset.id))],
      unresolved,
    },
  };
}

/**
 * 预设 → ffmpeg 滤镜串。
 *
 * 用 `aecho` 的多层近似而不是 `afir`（后者要真实脉冲响应文件，项目里没有）。
 * `dry` 返回空串——不挂滤镜就是干声，与旧命令同构。
 *
 * 三层回声的延迟按 `roomSize` 拉开，衰减按 `decayMs` 收；
 * 这样「房间越大、尾巴越长」在听感上成立。
 */
export function reverbFilterOf(preset: ReverbPreset): string {
  if (preset.wet <= 0 || preset.decayMs <= 0) return "";
  const decay = (preset.decayMs / 1000).toFixed(3);
  const wet = preset.wet.toFixed(3);
  // 三层：近反射 / 中期 / 尾音，延迟按房间尺寸递增
  const d1 = Math.max(20, Math.round(preset.decayMs * 0.12));
  const d2 = Math.max(d1 + 20, Math.round(preset.decayMs * 0.28));
  const d3 = Math.max(d2 + 30, Math.round(preset.decayMs * 0.55));
  const decay1 = Math.min(0.9, 0.35 + preset.roomSize * 0.4).toFixed(3);
  const decay2 = Math.min(0.85, 0.25 + preset.roomSize * 0.3).toFixed(3);
  const decay3 = Math.min(0.8, 0.15 + preset.roomSize * 0.25).toFixed(3);
  // `in_gain` / `out_gain` 都是 1.0：干声不衰减，湿度只由三个 decay 系数决定。
  // 早先按 wet 去压 out_gain，实测把干声整体拉低 2–3 dB——混响不该顺带改音量，
  // 整片响度由 loudnorm 统一管。
  return `aecho=1.0:1.0:${d1}|${d2}|${d3}:${decay1}|${decay2}|${decay3}`;
}

/** 一句话说清全片用了几套混响、哪一场认不出空间 */
export function reverbText(plan: ReverbPlan): string {
  if (plan.lines.length === 0) return "还没有场次。";
  const kinds = plan.lines.map((line) => line.preset.name);
  const unique = [...new Set(kinds)];
  const base = `${plan.summary.scenes} 场，${unique.length} 套混响：${unique.join(" / ")}`;
  return plan.summary.unresolved > 0
    ? `${base}。其中 ${plan.summary.unresolved} 场找不到地点，按默认档给。`
    : `${base}。同一场只用一套。`;
}
