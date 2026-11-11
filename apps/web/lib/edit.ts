import type { Project, Take, TimelineItem } from "@loomina/ir";
import { toStageView, type SceneKind } from "./read-model";
import { subtitleCues } from "./subtitle";

// ── 字幕样式（D3）───────────────────────────────────────────────

export type SubtitleStyleId = "default" | "large";

export type SubtitleStyle = {
  id: SubtitleStyleId;
  label: string;
  /** 字号，相对画面宽度（cqw）：竖屏里按宽度定，换设备比例不乱 */
  fontSizeCqw: number;
  /** 离画面底边的距离（%）：避开平台的底部操作栏 */
  bottomPct: number;
  /** 描边粗细（cqw）：浅色画面上也读得清 */
  strokeCqw: number;
};

export const SUBTITLE_STYLES: Record<SubtitleStyleId, SubtitleStyle> = {
  default: {
    id: "default",
    label: "默认",
    fontSizeCqw: 4.6,
    bottomPct: 14,
    strokeCqw: 0.55,
  },
  large: {
    id: "large",
    label: "大字",
    fontSizeCqw: 5.8,
    bottomPct: 18,
    strokeCqw: 0.7,
  },
};

/** 竖屏安全区：字幕与关键画面别压在这几条线上（D3） */
export const SAFE_AREA = {
  /** 上下各 8% 留给平台界面 */
  topPct: 8,
  bottomPct: 8,
  /** 左右各 6% 留给圆角与手势条 */
  sidePct: 6,
};

// ── 自动初剪（E2）───────────────────────────────────────────────

export type AutoCutSkip = {
  shotId: string;
  /** 镜号，从 1 开始 */
  no: number;
  reason: string;
};

export type AutoCut = {
  items: TimelineItem[];
  /** 没进时间线的镜头：如实数出来，别让人以为初剪已经收全 */
  skipped: AutoCutSkip[];
};

function durationOf(fallbackMs: number): number {
  return Math.max(300, Math.round(fallbackMs));
}

/**
 * 按剧本顺序生成初版时间线（E2）。
 *
 * 选 take 的规则：优先「留用」，没有留用就用最新一条没被淘汰的。
 * 一条可用的都没有的镜头跳过并报出来——静默丢掉一镜，比看得出缺一镜更糟。
 * 同一镜的时长直接读 `shot.durationMs`（已经按台词与音轨校正过，准则 P5）。
 */
export function autoCut(project: Project): AutoCut {
  const stage = toStageView(project);
  const items: TimelineItem[] = [];
  const skipped: AutoCutSkip[] = [];
  let startMs = 0;

  for (const shot of stage.shots) {
    const usable = shot.takes.filter((take) => take.status !== "rejected");
    const approved = usable.filter((take) => take.status === "approved");
    const chosen = approved.at(-1) ?? usable.at(-1);
    if (!chosen) {
      skipped.push({
        shotId: shot.id,
        no: shot.no,
        reason: shot.takes.length > 0 ? "take 全被淘汰了" : "还没有 take",
      });
      continue;
    }
    const durationMs = durationOf(Math.round(shot.dur * 1000));
    items.push({
      id: `tl-${shot.id}`,
      shotId: shot.id,
      takeId: chosen.id,
      startMs,
      durationMs,
    });
    startMs += durationMs;
  }

  return { items, skipped };
}

/** 两条时间线是不是一回事：初剪重复点不该再写一条一样的日志 */
export function timelineEquals(a: TimelineItem[], b: TimelineItem[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x.startMs - y.startMs);
  const right = [...b].sort((x, y) => x.startMs - y.startMs);
  return left.every((item, i) => {
    const other = right[i]!;
    return (
      item.id === other.id &&
      item.shotId === other.shotId &&
      item.takeId === other.takeId &&
      item.startMs === other.startMs &&
      item.durationMs === other.durationMs
    );
  });
}

// ── 成片读模型（E1）─────────────────────────────────────────────

export type EditTakeOption = {
  id: string;
  no: number;
  status: Take["status"];
  hasVideo: boolean;
};

/** 每行字数的几档（D2）：竖屏 12 偏密、16 默认、20 偏疏 */
export const SUBTITLE_CHARS = [12, 16, 20] as const;
export type SubtitleChars = (typeof SUBTITLE_CHARS)[number];
export const DEFAULT_SUBTITLE_CHARS: SubtitleChars = 16;

/** 一条实际显示的字幕：一句台词可能断成几条 */
export type EditCue = {
  id: string;
  lineId: string;
  shotId: string;
  characterName: string;
  text: string;
  /** 绝对时间：从整条片子的 0 点算起 */
  startMs: number;
  durationMs: number;
};

export type EditLine = {
  id: string;
  text: string;
  characterId: string;
  characterName: string;
  /** 绝对时间：从整条片子的 0 点算起 */
  startMs: number;
  durationMs: number;
  /** 这一句的音轨（data URI 或 http(s)） */
  audioUri?: string;
  /** 断句后的显示单元；时间加起来等于整句 */
  cues: EditCue[];
};

export type EditClip = {
  id: string;
  shotId: string;
  shotNo: number;
  takeId: string;
  takeNo: number;
  takeStatus: Take["status"];
  startMs: number;
  durationMs: number;
  /** 可播的视频（data URI 或 http(s)） */
  uri?: string;
  /** 没有视频时用首帧 / 尾帧顶一下 */
  stillUri?: string;
  hasPicture: boolean;
  art: SceneKind;
  sceneCode: string;
  locked: boolean;
  /** 这一镜可选的全部 take：换 take 用 */
  takes: EditTakeOption[];
  /** 这一镜的台词，已换算成整条片子的绝对时间 */
  lines: EditLine[];
};

export type EditMusic = {
  id: string;
  assetId: string;
  title: string;
  mood: string;
  /** 音乐文件地址（data URI 或 http(s)）；资产丢了就没有 */
  uri?: string;
  /** 音乐文件本身的时长；循环铺满时与时间线跨度不同 */
  assetDurationMs?: number;
  startMs: number;
  durationMs: number;
  gainDb: number;
  duckDb: number;
  ducking: boolean;
  loop: boolean;
  licenseRef: string;
};

export type EditView = {
  title: string;
  version: number;
  clips: EditClip[];
  /** 配乐床（C4）：目前一条，按台词自动 ducking */
  music: EditMusic[];
  /** 全部字幕，按时间排好；SRT、预览与导出都用这一份 */
  cues: EditCue[];
  /** 断句用的每行字数 */
  maxChars: number;
  totalMs: number;
  totalSec: number;
  /** 时间线里有几镜完全没有画面 */
  noPicture: number;
  /** 有配音的镜头数 */
  withVoice: number;
  /** 剧本里还没进时间线的镜头数 */
  missing: number;
  /** 单条片段时给个方便的下标 */
  first?: EditClip;
};

/**
 * 时间线 → 成片读模型。
 *
 * 时间线是事实，台词与音轨按片段起点换算成绝对时间；画面先看这一 take 的视频，
 * 没有就看首帧 / 尾帧。三样都没有时仍保留片段，让缺口在时间线上看得见。
 */
export function toEditView(
  project: Project,
  options: { maxChars?: number } = {},
): EditView {
  const maxChars = Math.max(6, Math.round(options.maxChars ?? DEFAULT_SUBTITLE_CHARS));
  const stage = toStageView(project);
  const stageById = new Map(stage.shots.map((shot) => [shot.id, shot]));
  const shotById = new Map(project.shots.map((shot) => [shot.id, shot]));
  const takeById = new Map(project.takes.map((take) => [take.id, take]));
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const lineById = new Map(project.dialogue.map((line) => [line.id, line]));
  const characterById = new Map(
    project.characters.map((character) => [character.id, character]),
  );
  const sceneById = new Map(project.scenes.map((scene) => [scene.id, scene]));

  const clips: EditClip[] = [...project.timeline.items]
    .sort((a, b) => a.startMs - b.startMs)
    .flatMap((item) => {
      const stageShot = stageById.get(item.shotId);
      const shot = shotById.get(item.shotId);
      const take = takeById.get(item.takeId);
      if (!stageShot || !shot || !take) return [];

      const asset = assetById.get(take.assetId);
      const uri = asset?.kind === "video" ? asset.uri : undefined;
      const stillUri =
        asset?.kind !== "video" ? asset?.uri : undefined;
      const keyframe = stageShot.keyframeUri ?? stageShot.lastKeyframeUri;
      const scene = sceneById.get(shot.sceneId);

      let cursor = item.startMs;
      const lines: EditLine[] = shot.dialogueIds.flatMap((lineId) => {
        const line = lineById.get(lineId);
        if (!line) return [];
        const startMs = cursor;
        cursor += line.durationMs;
        const voice = line.audioAssetId
          ? assetById.get(line.audioAssetId)
          : undefined;
        const characterName =
          characterById.get(line.characterId)?.name ?? line.characterId;
        const cues: EditCue[] = subtitleCues(line.text, line.durationMs, {
          maxChars,
        }).flatMap((cue, index) => {
          const text = cue.text.trim();
          if (!text) return [];
          return [
            {
              id: `${line.id}-${index + 1}`,
              lineId: line.id,
              shotId: item.shotId,
              characterName,
              text,
              startMs: startMs + cue.startMs,
              durationMs: cue.durationMs,
            },
          ];
        });
        return [
          {
            id: line.id,
            text: line.text,
            characterId: line.characterId,
            characterName,
            startMs,
            durationMs: line.durationMs,
            audioUri: voice?.uri,
            cues,
          },
        ];
      });

      return [
        {
          id: item.id,
          shotId: item.shotId,
          shotNo: stageShot.no,
          takeId: item.takeId,
          takeNo: shot.takeIds.indexOf(item.takeId) + 1,
          takeStatus: take.status,
          startMs: item.startMs,
          durationMs: item.durationMs,
          uri,
          stillUri: stillUri ?? keyframe,
          hasPicture: Boolean(uri ?? stillUri ?? keyframe),
          art: stageShot.art,
          sceneCode: scene?.code || `S${(scene?.index ?? 0) + 1}`,
          locked: stageShot.locked,
          takes: stageShot.takes.map((option) => ({
            id: option.id,
            no: option.no,
            status: option.status,
            hasVideo: Boolean(option.uri),
          })),
          lines,
        },
      ];
    });

  const totalMs = clips.reduce(
    (end, clip) => Math.max(end, clip.startMs + clip.durationMs),
    0,
  );
  const inTimeline = new Set(clips.map((clip) => clip.shotId));
  const cues = clips
    .flatMap((clip) => clip.lines.flatMap((line) => line.cues))
    .sort((a, b) => a.startMs - b.startMs);
  const music: EditMusic[] = project.timeline.music.flatMap((cue) => {
    const asset = assetById.get(cue.assetId);
    if (!asset || asset.kind !== "audio") return [];
    return [
      {
        id: cue.id,
        assetId: cue.assetId,
        title: cue.title,
        mood: cue.mood,
        uri: asset.uri,
        assetDurationMs: asset.durationMs,
        startMs: cue.startMs,
        durationMs: cue.durationMs,
        gainDb: cue.gainDb,
        duckDb: cue.duckDb,
        ducking: cue.ducking,
        loop: cue.loop,
        licenseRef: cue.licenseRef,
      },
    ];
  });

  return {
    title: project.title,
    version: project.version,
    clips,
    music,
    cues,
    maxChars,
    totalMs,
    totalSec: Math.round(totalMs / 100) / 10,
    noPicture: clips.filter((clip) => !clip.hasPicture).length,
    withVoice: clips.filter((clip) => clip.lines.some((line) => line.audioUri))
      .length,
    missing: project.shots.filter((shot) => !inTimeline.has(shot.id)).length,
    first: clips[0],
  };
}

/** 时间码：00:03.200 */
export function timecode(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
