/**
 * 音乐情绪曲线（C10 / ADR-0125）。
 *
 * 曲线是拍（A11 的 `BeatSpan`）的函数：每一拍按 SOUND.md 第五节查一个建议状态
 * （进 / 铺 / 推 / 落 / 峰 / 收 / 未解决），再看当前配乐床有没有盖到它。
 * 报告不进 IR，每次现算——beat 改了曲线就该变。
 *
 * 建议不是指令：它只是把 SOUND.md 的表格变成一排色块，作者可以完全不理。
 */

import type { BeatKind, Motif, MusicCue, Project } from "@loomina/ir";
import { groupBeats, planShots, type BeatSpan } from "./storyboard";

/** 一拍的音乐状态：只做「进 / 转 / 出」三件事里的一个 */
export type MusicState =
  | "enter"
  | "bed"
  | "build"
  | "drop"
  | "peak"
  | "resolve"
  | "unresolved";

export const MUSIC_STATE_LABEL: Record<MusicState, string> = {
  enter: "进",
  bed: "铺",
  build: "推",
  drop: "落",
  peak: "峰",
  resolve: "收",
  unresolved: "未解决",
};

/** 一句话说清这个状态要音乐做什么 */
export const MUSIC_STATE_TASK: Record<MusicState, string> = {
  enter: "进来就要有；或故意留白制造不安",
  bed: "低存在感铺底，不抢台词",
  build: "加层或加节奏，压力上升",
  drop: "突变或抽空，让观众注意不到音乐",
  peak: "全片最强点，情绪兑现",
  resolve: "收住，给这一集一个落点",
  unresolved: "留一个未解决的和声，接下一集",
};

/** SOUND.md 第五节的表：Beat → 建议状态 */
export const MUSIC_STATE_OF_BEAT: Record<BeatKind, MusicState> = {
  hook: "enter",
  setup: "bed",
  escalation: "build",
  turn: "drop",
  climax: "peak",
  resolution: "resolve",
  endHook: "unresolved",
};

export type MusicBeatLine = {
  beatId: string;
  kind: BeatKind;
  sceneLabel: string;
  shotNos: number[];
  startMs: number;
  durationMs: number;
  /** 建议状态 */
  state: MusicState;
  /** 盖到这一拍的 cue；空 = 留白 */
  cues: { id: string; title: string; role: MusicCue["role"]; motifLabel?: string }[];
  /** 这一段是留白（没有 cue 覆盖） */
  silent: boolean;
  /** 这一拍落在成片时间线里；false = 分镜比成片长，铺不了 */
  inCut: boolean;
};

export type MusicCurve = {
  lines: MusicBeatLine[];
  /** 拍数 */
  beats: number;
  /** 有 cue 覆盖的拍数 */
  covered: number;
  coveragePct: number;
  /** 留白总时长（毫秒） */
  silenceMs: number;
  /** 全片时长（毫秒） */
  totalMs: number;
  /** cue 起止没有落在拍边界上的，列出来；不拦，只提示 */
  misaligned: { cueId: string; title: string; startMs: number; nearestBeatMs: number }[];
  /** 有没有可用的音频资产（没有就没法铺） */
  hasAudio: boolean;
};

function overlaps(startMs: number, durationMs: number, cue: MusicCue): boolean {
  return cue.startMs < startMs + durationMs && cue.startMs + cue.durationMs > startMs;
}

/**
 * 拍 → 曲线。纯函数：不写事件、不改项目。
 *
 * 拍与 cue 的对应按时间重叠判断，不按 cue 的 role：role 是作者写的意图，
 * 重叠是事实，曲线显示事实。
 */
export function analyzeMusicCurve(project: Project): MusicCurve {
  const plans = planShots(project);
  const beats = groupBeats(plans);
  const motifs = new Map(project.motifs.map((motif) => [motif.id, motif]));
  const cues = project.timeline.music;
  const cutMs = project.timeline.items.reduce(
    (end, item) => Math.max(end, item.startMs + item.durationMs),
    0,
  );

  const lines: MusicBeatLine[] = beats.map((beat: BeatSpan) => {
    const covering = cues.filter((cue) => overlaps(beat.startMs, beat.durationMs, cue));
    return {
      beatId: beat.id,
      kind: beat.kind,
      sceneLabel: beat.sceneLabel,
      shotNos: beat.shotNos,
      startMs: beat.startMs,
      durationMs: beat.durationMs,
      state: MUSIC_STATE_OF_BEAT[beat.kind],
      cues: covering.map((cue) => ({
        id: cue.id,
        title: cue.title,
        role: cue.role,
        ...(cue.motifId && motifs.has(cue.motifId)
          ? { motifLabel: motifs.get(cue.motifId)!.label }
          : {}),
      })),
      silent: covering.length === 0,
      inCut: cutMs === 0 || beat.startMs < cutMs,
    };
  });

  const totalMs = beats.reduce((end, beat) => Math.max(end, beat.startMs + beat.durationMs), 0);
  const covered = lines.filter((line) => !line.silent).length;
  const silenceMs = lines
    .filter((line) => line.silent)
    .reduce((sum, line) => sum + line.durationMs, 0);

  // cue 边界对齐：起点离最近的拍起点超过 250ms 才算「没对齐」——
  // 这个容差是给人手拖的，不是给自动铺的（自动铺的边界是精确的）。
  const boundaries = beats.map((beat) => beat.startMs);
  const misaligned = cues.flatMap((cue) => {
    const nearest = boundaries.reduce(
      (best, value) => (Math.abs(value - cue.startMs) < Math.abs(best - cue.startMs) ? value : best),
      boundaries[0] ?? 0,
    );
    return Math.abs(nearest - cue.startMs) > 250
      ? [{ cueId: cue.id, title: cue.title, startMs: cue.startMs, nearestBeatMs: nearest }]
      : [];
  });

  return {
    lines,
    beats: lines.length,
    covered,
    coveragePct: lines.length === 0 ? 0 : Math.round((covered / lines.length) * 100),
    silenceMs,
    totalMs,
    misaligned,
    hasAudio: project.assets.some((asset) => asset.kind === "audio"),
  };
}

/** 一条动机用在哪几处：cue 数 + 总时长；界面显示「已用 2 处 · 12.0s」 */
export type MotifUsage = { cues: number; durationMs: number };

export function motifUsage(project: Project, motifId: string): MotifUsage {
  const used = project.timeline.music.filter((cue) => cue.motifId === motifId);
  return {
    cues: used.length,
    durationMs: used.reduce((sum, cue) => sum + cue.durationMs, 0),
  };
}

/** 动机指向的对象现在叫什么；对象没了就返回 undefined（界面标「目标已删」） */
export function motifTargetLabel(project: Project, motif: Motif): string | undefined {
  if (motif.targetKind === "character") {
    return project.characters.find((item) => item.id === motif.targetId)?.name;
  }
  if (motif.targetKind === "location") {
    return project.locations.find((item) => item.id === motif.targetId)?.name;
  }
  const [from, to] = motif.targetId.split("->");
  const a = project.characters.find((item) => item.id === from)?.name;
  const b = project.characters.find((item) => item.id === to)?.name;
  return a && b ? `${a} ↔ ${b}` : undefined;
}

export const MOTIF_TARGET_LABEL: Record<Motif["targetKind"], string> = {
  character: "人物",
  relationship: "关系",
  location: "地点",
};

/**
 * 「按曲线铺一遍」的补 cue 计划（ADR-0125 §5）。
 *
 * 只给**没有 cue 覆盖**的拍，边界对齐拍的起止；同一条素材、连续且状态相同的拍
 * 合并成一条，免得 7 拍铺出 7 条（渲染清单上限 4 条）。
 * 返回的是计划，不写事件——作者点确认才落 `timeline.music.updated`。
 */
export type MusicFillPlan = {
  cues: MusicCue[];
  /** 超出了渲染清单的 4 条上限：需要合并相邻的拍 */
  overflow: boolean;
  /** 因为上限没排进去的拍数 */
  skipped: number;
  /** 留白但在成片之外的拍数：分镜比时间线长，铺不了 */
  outOfCut: number;
};

export function planMusicFill(
  project: Project,
  source: Pick<MusicCue, "assetId" | "title" | "mood" | "licenseRef" | "gainDb" | "duckDb" | "ducking" | "loop">,
  limit = 4,
): MusicFillPlan {
  const curve = analyzeMusicCurve(project);
  // 曲线按分镜的拍算，成片时间线可能还没排满：铺到时间线之外的 cue 会被
  // `timeline.music.updated` 拒（起点在成片之外），所以只铺 inCut 的拍。
  const outOfCut = curve.lines.filter((line) => line.silent && !line.inCut).length;
  const silent = curve.lines.filter((line) => line.silent && line.inCut);
  if (silent.length === 0) return { cues: [], overflow: false, skipped: 0, outOfCut };

  // 连续且状态相同的留白拍合并
  const groups: { startMs: number; endMs: number; state: MusicState }[] = [];
  for (const line of silent) {
    const last = groups.at(-1);
    const endMs = line.startMs + line.durationMs;
    if (last && last.state === line.state && last.endMs === line.startMs) {
      last.endMs = endMs;
    } else {
      groups.push({ startMs: line.startMs, endMs, state: line.state });
    }
  }

  const kept = groups.slice(0, limit);
  const cues: MusicCue[] = kept.map((group, index) => ({
    id: `music-fill-${index + 1}`,
    assetId: source.assetId,
    title: source.title,
    mood: source.mood,
    startMs: group.startMs,
    durationMs: group.endMs - group.startMs,
    gainDb: source.gainDb,
    duckDb: source.duckDb,
    ducking: source.ducking,
    loop: source.loop,
    role: group.state === "peak" || group.state === "drop" ? "hit" : "bed",
    licenseRef: source.licenseRef,
  }));

  return {
    cues,
    overflow: groups.length > limit,
    skipped: groups.length - kept.length,
    outOfCut,
  };
}
