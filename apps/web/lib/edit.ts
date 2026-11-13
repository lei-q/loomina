import type {
  Frame,
  Grade,
  MusicCue,
  Project,
  ShotFocus,
  SubtitleLayout,
  SubtitleTranslation,
  Take,
  TimelineItem,
  Transition,
} from "@loomina/ir";
import { toStageView, type SceneKind } from "./read-model";
import { SPEAKER_DEFAULT_COLOR, speakerPaletteOf } from "./speaker-color";
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
  /** 按角色着色（D3）：关掉时所有字幕回到白色 */
  speakerColors: boolean;
  /** 作者点名指定的角色颜色（D3 / ADR-0146）：缺省按色板顺序 */
  speakerColorOverrides?: Record<string, string>;
};

export const SUBTITLE_STYLES: Record<SubtitleStyleId, SubtitleStyle> = {
  default: {
    id: "default",
    label: "默认",
    fontSizeCqw: 4.6,
    bottomPct: 14,
    strokeCqw: 0.55,
    speakerColors: true,
  },
  large: {
    id: "large",
    label: "大字",
    fontSizeCqw: 5.8,
    bottomPct: 18,
    strokeCqw: 0.7,
    speakerColors: true,
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

/**
 * 把项目里的版式与档位合成一份「实际怎么画」的样式（D3）。
 *
 * 项目里只存作者**改过**的项；没改的项跟着档位模板走。这样换档位时
 * 作者调过的字号不会被悄悄改回去，没调过的位置又会跟着新档位一起变。
 */
export function subtitleStyleOf(
  preset: SubtitleStyleId,
  layout?: SubtitleLayout,
): SubtitleStyle {
  const base = SUBTITLE_STYLES[preset] ?? SUBTITLE_STYLES.default;
  if (!layout) return base;
  return {
    ...base,
    fontSizeCqw: layout.fontSizeCqw ?? base.fontSizeCqw,
    bottomPct: layout.bottomPct ?? base.bottomPct,
    strokeCqw: layout.strokeCqw ?? base.strokeCqw,
    speakerColors: layout.speakerColors ?? base.speakerColors,
    ...(layout.speakerColorOverrides && Object.keys(layout.speakerColorOverrides).length > 0
      ? { speakerColorOverrides: layout.speakerColorOverrides }
      : {}),
  };
}

/** 作者有没有手动调过版式：界面据此显示「已调」与「恢复模板」 */
export function isCustomSubtitleLayout(layout?: SubtitleLayout): boolean {
  if (!layout) return false;
  return (
    layout.fontSizeCqw !== undefined ||
    layout.bottomPct !== undefined ||
    layout.strokeCqw !== undefined ||
    layout.speakerColors !== undefined ||
    (layout.speakerColorOverrides !== undefined &&
      Object.keys(layout.speakerColorOverrides).length > 0)
  );
}

/**
 * 导出函数收两种入参：档位 id（测试与旧调用）或一份已经算好的样式。
 * 混着收是为了让「调过版式」不必改掉每一个调用点的签名。
 */
export function resolveSubtitleStyle(
  style: SubtitleStyleId | SubtitleStyle | undefined,
): SubtitleStyle {
  if (!style) return SUBTITLE_STYLES.default;
  if (typeof style === "string") return SUBTITLE_STYLES[style] ?? SUBTITLE_STYLES.default;
  return style;
}

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
  /** 说话人；没有就是旁白 / 没标 */
  characterId?: string;
  characterName: string;
  /** 这一句字幕的颜色（D3）；关掉按角色着色时没有，按白色画 */
  speakerColor?: string;
  text: string;
  /**
   * 这一条的第二行译文（D5 / ADR-0173）。
   *
   * 只在双语开着、且这一句台词写过译文时才有。断句后每一条都带同一句译文——
   * 译文按整句翻的，硬切成几条英文反而读不通。
   */
  translation?: string;
  /** 绝对时间：从整条片子的 0 点算起 */
  startMs: number;
  durationMs: number;
  /** 这一条是作者手改过的断句（D2），不是自动断出来的 */
  manual?: boolean;
};

export type EditLine = {
  id: string;
  text: string;
  characterId: string;
  characterName: string;
  /** 台词本该开始的位置：从整条片子的 0 点算起，画面轨排出来的 */
  startMs: number;
  durationMs: number;
  /** 配音实际开始的位置：`startMs + voiceOffsetMs`，已夹在成片范围内（E1） */
  audioStartMs: number;
  /** 字幕实际开始的位置：`startMs + subtitleOffsetMs`，已夹在成片范围内（E1） */
  cueStartMs: number;
  /** 作者把配音往后挪了多少毫秒（E1）；0 表示贴着台词走 */
  voiceOffsetMs: number;
  /** 作者把字幕往后挪了多少毫秒（E1）；0 表示贴着台词走 */
  subtitleOffsetMs: number;
  /** 这一句的音轨（data URI 或 http(s)） */
  audioUri?: string;
  /** 这一句的译文（D5 / ADR-0173）；没写就没有 */
  translation?: string;
  /** 断句后的显示单元；时间加起来等于整句 */
  cues: EditCue[];
  /** 这一句的断句被作者手改过（D2） */
  manual?: boolean;
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
  /**
   * 接进上一段的转场（E4 / ADR-0169）；`undefined` 是硬切。
   * 第一段恒为 `undefined`——它前面没有画面。
   */
  transitionIn?: Transition;
  /** 换画幅时留住哪一块（E5 / ADR-0170）；`undefined` 是居中 */
  focus?: ShotFocus;
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
  /** 作用：铺底 / 重音 / 转场（C10） */
  role: MusicCue["role"];
  /** 指向的主题动机（C10）；没挂就是 undefined */
  motifId?: string;
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
  /** 实际怎么画字幕（D3）：档位模板 + 作者调过的项 */
  subtitleStyle: SubtitleStyle;
  /** 作者调过版式没有：界面据此给「恢复模板」 */
  subtitleCustom: boolean;
  /** 双语字幕（D5 / ADR-0173）：开不开、第二行语言与位置 */
  translation: SubtitleTranslation;
  /** 有译文的句子数 / 总句数：双语开着但有句子没翻时，界面要说清楚 */
  translationCoverage: { lines: number; translated: number };
  /** 调色（E4 / ADR-0169）：导出时对画面做的色彩调整 */
  grade: Grade;
  /** 画幅与适配（E5 / ADR-0170）：导出时裁成什么形状、多出来的地方怎么补 */
  frame: Frame;
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
 * 手改断句的时间分配（D2）。
 *
 * 覆盖里存的是「这几条字幕各占多久」，但台词本身的时长是事实：手改不能改掉
 * 整句的时长，否则这一镜的时间线就对不上了。所以按比例缩放到整句时长，
 * 最后一条吃掉舍入误差——加起来永远等于 line.durationMs。
 */
function fitCues(
  cues: { durationMs: number }[],
  totalMs: number,
): { startMs: number; durationMs: number }[] {
  const wanted = cues.reduce((sum, cue) => sum + cue.durationMs, 0);
  const scale = wanted > 0 ? totalMs / wanted : 1;
  const spans: { startMs: number; durationMs: number }[] = [];
  let cursor = 0;
  cues.forEach((cue, index) => {
    const last = index === cues.length - 1;
    const durationMs = last
      ? totalMs - cursor
      : Math.max(1, Math.round(cue.durationMs * scale));
    spans.push({ startMs: cursor, durationMs });
    cursor += durationMs;
  });
  return spans;
}

/**
 * 把叠加层的起点挪 `offsetMs`，再夹回成片之内（E1 / ADR-0131）。
 *
 * 起点不能早于 0，也不能晚到整条片段都掉出成片之外——否则渲染清单会拒收
 * （叠加层起点必须落在成片里），界面却还显示得好好的。
 */
function shiftWithin(
  startMs: number,
  offsetMs: number,
  durationMs: number,
  totalMs: number,
): number {
  const latest = Math.max(0, totalMs - Math.max(1, durationMs));
  return Math.max(0, Math.min(latest, startMs + offsetMs));
}

/**
 * 时间线 → 成片读模型。
 *
 * 时间线是事实，台词与音轨按片段起点换算成绝对时间；画面先看这一 take 的视频，
 * 没有就看首帧 / 尾帧。三样都没有时仍保留片段，让缺口在时间线上看得见。
 */
export function toEditView(
  project: Project,
  options: { maxChars?: number; style?: SubtitleStyleId } = {},
): EditView {
  const maxChars = Math.max(6, Math.round(options.maxChars ?? DEFAULT_SUBTITLE_CHARS));
  const preset = options.style ?? project.subtitleLayout.preset;
  const subtitleStyle = subtitleStyleOf(preset, project.subtitleLayout);
  // 双语字幕（D5 / ADR-0173）：关着的时候一条译文都不带，读模型与单语完全一样
  const translationOn = project.subtitleTranslation.enabled;
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
  // 字幕颜色按角色顺序取（D3）：不存 IR，角色顺序不变颜色就不变
  const colorByCharacter = speakerPaletteOf(project.characters.map((item) => item.id));
  // 作者点名指定的颜色（D3 / ADR-0146）：只对还在项目里的角色生效
  for (const [characterId, color] of Object.entries(
    subtitleStyle.speakerColorOverrides ?? {},
  )) {
    if (colorByCharacter.has(characterId)) colorByCharacter.set(characterId, color);
  }
  const overrideByLine = new Map(
    project.subtitleOverrides.map((override) => [override.lineId, override]),
  );

  // 全长先算出来：配音与字幕的挪动要夹在成片之内，渲染清单也按这个校验
  const spanMs = project.timeline.items.reduce(
    (end, item) => Math.max(end, item.startMs + item.durationMs),
    0,
  );

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
        // 叠加层可以自由挪（E1 / ADR-0131）：画面轨必须首尾相接，配音与字幕不必。
        // 挪出成片之外的部分夹回来——渲染清单只收落在成片里的叠加层。
        const voiceOffsetMs = line.voiceOffsetMs ?? 0;
        const subtitleOffsetMs = line.subtitleOffsetMs ?? 0;
        const audioStartMs = shiftWithin(startMs, voiceOffsetMs, line.durationMs, spanMs);
        const cueStartMs = shiftWithin(startMs, subtitleOffsetMs, line.durationMs, spanMs);
        const voice = line.audioAssetId
          ? assetById.get(line.audioAssetId)
          : undefined;
        const characterName =
          characterById.get(line.characterId)?.name ?? line.characterId;
        const speakerColor = subtitleStyle.speakerColors
          ? (colorByCharacter.get(line.characterId) ?? SPEAKER_DEFAULT_COLOR)
          : undefined;
        // 译文（D5 / ADR-0173）：只有双语开着、这一句写过译文时才带第二行
        const translation =
          translationOn && line.translation?.trim() ? line.translation.trim() : undefined;
        const override = overrideByLine.get(line.id);
        const spans = override ? fitCues(override.cues, line.durationMs) : [];
        const cues: EditCue[] = override
          ? override.cues.map((cue, index) => ({
              id: `${line.id}-m${index + 1}`,
              lineId: line.id,
              shotId: item.shotId,
              characterId: line.characterId,
              characterName,
              ...(speakerColor ? { speakerColor } : {}),
              ...(translation ? { translation } : {}),
              text: cue.text.trim(),
              startMs: cueStartMs + spans[index]!.startMs,
              durationMs: spans[index]!.durationMs,
              manual: true,
            }))
          : subtitleCues(line.text, line.durationMs, { maxChars }).flatMap(
              (cue, index) => {
                const text = cue.text.trim();
                if (!text) return [];
                return [
                  {
                    id: `${line.id}-${index + 1}`,
                    lineId: line.id,
                    shotId: item.shotId,
                    characterId: line.characterId,
                    characterName,
                    ...(speakerColor ? { speakerColor } : {}),
                    ...(translation ? { translation } : {}),
                    text,
                    startMs: cueStartMs + cue.startMs,
                    durationMs: cue.durationMs,
                  },
                ];
              },
            );
        return [
          {
            id: line.id,
            text: line.text,
            characterId: line.characterId,
            characterName,
            startMs,
            durationMs: line.durationMs,
            audioStartMs,
            cueStartMs,
            voiceOffsetMs,
            subtitleOffsetMs,
            audioUri: voice?.uri,
            ...(translation ? { translation } : {}),
            cues,
            ...(override ? { manual: true } : {}),
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
          ...(item.transitionIn ? { transitionIn: item.transitionIn } : {}),
          ...(shot.focus ? { focus: shot.focus } : {}),
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
        role: cue.role,
        ...(cue.motifId ? { motifId: cue.motifId } : {}),
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
    subtitleStyle,
    subtitleCustom: isCustomSubtitleLayout(project.subtitleLayout),
    translation: project.subtitleTranslation,
    translationCoverage: {
      lines: project.dialogue.length,
      translated: project.dialogue.filter((line) => line.translation?.trim()).length,
    },
    grade: project.grade,
    frame: project.frame,
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
