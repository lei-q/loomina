/**
 * 混音与响度（C12）。
 *
 * 这一层只做三件事，而且都可核对：
 * 1. 对白按时间落到一条总线上；
 * 2. 音乐按 `duckDb` 在台词窗里压低（12–18 dB，默认 15）；
 * 3. 整片走两遍 loudnorm：先量，再按量到的值线性归一到 −14 LUFS。
 *
 * 不在这里猜「听起来怎么样」。输出后还会量一次集成响度、真峰值与反相时长，
 * 结果原样交给界面；量不到就写「未测」。
 */

export const LOUDNESS_TARGET = {
  integratedLufs: -14,
  /** 编码成 AAC 会抬一点真峰值，留 0.5 dB 余量，保证成片仍 ≤ −1 dBTP */
  loudnormTruePeakDb: -1.5,
  ceilingDb: -1,
  toleranceLu: 1,
} as const;

/** 对白按句归一的目标准位；整片最后还会走一次 loudnorm 到 −14 LUFS */
export const DIALOGUE_TARGET_LUFS = -18;
/** 单句最多抬 / 压这么多：超过 12 dB 多半是文件本身坏了，别拿增益硬修 */
export const DIALOGUE_MAX_GAIN_DB = 12;

export type MixDialogue = {
  path: string;
  startMs: number;
  durationMs: number;
  /** 按句量出来的增益（dB）；缺省 / 0 表示不动这一句 */
  gainDb?: number;
};

export type MixMusic = {
  path: string;
  startMs: number;
  endMs: number;
  gainDb: number;
  duckDb: number;
  ducking: boolean;
  loop: boolean;
};

/** 一条音效（C7 / ADR-0184）：不 ducking，按自己的增益进音效总线 */
export type MixSfx = {
  path: string;
  startMs: number;
  endMs: number;
  gainDb: number;
  loop: boolean;
};

/** 三路总线平衡（C7 / ADR-0184）：缺省就是 0 dB */
export type MixBus = {
  dialogueDb: number;
  musicDb: number;
  sfxDb: number;
};

export type LoudnessMeasurement = {
  inputI: number | null;
  inputTp: number | null;
  inputLra: number | null;
  inputThresh: number | null;
  targetOffset: number | null;
};

export type LoudnessReport = {
  integratedLufs: number | null;
  truePeakDb: number | null;
  rangeLu: number | null;
  /** 反相（单声道折叠会抵消）的总时长；null 表示没量到 */
  outOfPhaseMs: number | null;
  /** 检测到的单声道段总时长；null 表示没量到 */
  monoMs: number | null;
  /** 分段响度（C12）：每句对白实际用的增益；没有对白或一句都没量到时缺省 */
  dialogueGainsDb?: number[];
  /** 自动二次归一（C12）：1 表示一遍过，2 表示复核不过后补了一遍 */
  passes?: number;
  checkedAt: string;
  verdict: "pass" | "review" | "fail" | "unmeasured";
  detail: string;
};

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * 分段响度（C12）：把一句对白拉到目标位需要多少 dB。
 *
 * 量不到（null / 非有限值 / 静音段的 −70）就不动：静音不是「很小声的台词」，
 * 按 −70 去抬 12 dB 只会把底噪推上来。结果按 0.1 dB 取整，增益太小也不写。
 */
export function segmentGainDb(
  inputLufs: number | null | undefined,
  target = DIALOGUE_TARGET_LUFS,
  maxDb = DIALOGUE_MAX_GAIN_DB,
): number {
  if (inputLufs === null || inputLufs === undefined) return 0;
  if (!Number.isFinite(inputLufs) || inputLufs <= -70) return 0;
  const wanted = target - inputLufs;
  const clamped = Math.max(-maxDb, Math.min(maxDb, wanted));
  return Math.round(clamped * 10) / 10;
}

/** 合并重叠的台词窗；两段只隔一口气时不来回抬音乐 */
export function mergeIntervals(
  intervals: { startMs: number; endMs: number }[],
): { startMs: number; endMs: number }[] {
  const sorted = intervals
    .filter((item) => Number.isFinite(item.startMs) && Number.isFinite(item.endMs))
    .filter((item) => item.endMs > item.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: { startMs: number; endMs: number }[] = [];
  for (const item of sorted) {
    const last = merged.at(-1);
    if (!last || item.startMs > last.endMs + 500) {
      merged.push({ ...item });
      continue;
    }
    last.endMs = Math.max(last.endMs, item.endMs);
  }
  return merged;
}

/**
 * 音乐增益 + ducking 的 volume 表达式。
 *
 * 用确定的台词窗而不是 sidechain 压缩：压多少 dB 是写死的，界面说 15 dB
 * 就是 15 dB，不随对白电平漂。两侧各留 200 / 300 ms 斜坡，避免咔哒声。
 */
export function duckVolumeExpression(
  intervals: { startMs: number; endMs: number }[],
  gainDb: number,
  duckDb: number,
  ducking = true,
): string {
  const base = dbToLinear(gainDb).toFixed(6);
  if (!ducking) return base;
  const merged = mergeIntervals(intervals);
  if (merged.length === 0) return base;
  const duck = dbToLinear(-Math.abs(duckDb)).toFixed(6);
  const factors = merged.map(({ startMs, endMs }) => {
    const start = (startMs / 1000).toFixed(3);
    const end = (endMs / 1000).toFixed(3);
    const rampIn = (Number(start) - 0.2).toFixed(3);
    const rampOut = (Number(end) + 0.3).toFixed(3);
    return (
      `if(lt(t,${rampIn}),1,` +
      `if(lt(t,${start}),1-(1-${duck})*(t-${rampIn})/0.2,` +
      `if(lt(t,${end}),${duck},` +
      `if(lt(t,${rampOut}),${duck}+(1-${duck})*(t-${end})/0.3,1))))`
    );
  });
  return `${base}*${factors.join("*")}`;
}

/**
 * 音频混音命令：对白 + 配乐 → PCM wav。
 *
 * 单独跑一遍而不是塞进最终命令，是为了先拿到混音文件量 loudnorm，
 * 再让视频编码用第二遍的 measured_* 参数；同时视频失败重试也不用重新混音。
 */
export function buildAudioMixCommand(input: {
  dialogue: MixDialogue[];
  music: MixMusic[];
  /** 音效层（C7）：不传就是没有，与旧命令同构 */
  sfx?: MixSfx[];
  /** 三路总线平衡（C7）：不传就是 0 dB，与旧命令同构 */
  mix?: MixBus;
  totalMs: number;
  outFile: string;
}): string[] {
  const sfxTracks = input.sfx ?? [];
  const bus = input.mix ?? { dialogueDb: 0, musicDb: 0, sfxDb: 0 };
  const args: string[] = ["-hide_banner", "-y", "-nostats"];
  input.dialogue.forEach((track) => args.push("-i", track.path));
  input.music.forEach((track) => {
    if (track.loop) args.push("-stream_loop", "-1");
    args.push("-i", track.path);
  });
  sfxTracks.forEach((track) => {
    if (track.loop) args.push("-stream_loop", "-1");
    args.push("-i", track.path);
  });

  const gainStage = (db: number) =>
    Math.abs(db) >= 0.1 ? `volume=${dbToLinear(db).toFixed(6)},` : "";

  const filters: string[] = [];
  const dialogueLabels: string[] = [];
  input.dialogue.forEach((track, index) => {
    // 分段响度（C12）+ 对白总线（C7）：每句先拉到自己该在的位置，再进总线
    const gain = gainStage((track.gainDb ?? 0) + bus.dialogueDb);
    filters.push(
      `[${index}:a]aresample=48000,` +
        `adelay=${track.startMs}|${track.startMs},` +
        gain +
        `atrim=duration=${seconds(input.totalMs)},asetpts=PTS-STARTPTS[dlg${index}]`,
    );
    dialogueLabels.push(`[dlg${index}]`);
  });

  const duckWindows = input.dialogue.map((track) => ({
    startMs: track.startMs,
    endMs: Math.min(input.totalMs, track.startMs + track.durationMs),
  }));
  const musicLabels: string[] = [];
  input.music.forEach((track, index) => {
    const inputIndex = input.dialogue.length + index;
    const length = seconds(track.endMs - track.startMs);
    // 配乐总线叠在每条 cue 的基础增益上；ducking 的深度不跟着总线变
    const expression = duckVolumeExpression(
      duckWindows,
      track.gainDb + bus.musicDb,
      track.duckDb,
      track.ducking,
    );
    filters.push(
      `[${inputIndex}:a]aresample=48000,` +
        `atrim=duration=${length},asetpts=PTS-STARTPTS,` +
        `adelay=${track.startMs}|${track.startMs},` +
        `volume=volume='${expression}':eval=frame[mus${index}]`,
    );
    musicLabels.push(`[mus${index}]`);
  });

  const sfxLabels: string[] = [];
  sfxTracks.forEach((track, index) => {
    const inputIndex = input.dialogue.length + input.music.length + index;
    const length = seconds(track.endMs - track.startMs);
    // 音效不 ducking：长短与增益都是作者定的，总线再统一调一次
    const gain = gainStage(track.gainDb + bus.sfxDb);
    filters.push(
      `[${inputIndex}:a]aresample=48000,` +
        `atrim=duration=${length},asetpts=PTS-STARTPTS,` +
        `adelay=${track.startMs}|${track.startMs},` +
        gain +
        `anull[sfx${index}]`,
    );
    sfxLabels.push(`[sfx${index}]`);
  });

  const mix = (labels: string[], name: string) => {
    if (labels.length === 1) {
      filters.push(`${labels[0]}anull[${name}]`);
      return;
    }
    filters.push(
      `${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0[${name}]`,
    );
  };

  if (dialogueLabels.length > 0) mix(dialogueLabels, "dlgmix");
  if (musicLabels.length > 0) mix(musicLabels, "musmix");
  if (sfxLabels.length > 0) mix(sfxLabels, "sfxmix");

  const busLabels: string[] = [];
  if (dialogueLabels.length > 0) busLabels.push("[dlgmix]");
  if (musicLabels.length > 0) busLabels.push("[musmix]");
  if (sfxLabels.length > 0) busLabels.push("[sfxmix]");
  const finish = `apad,atrim=duration=${seconds(input.totalMs)},asetpts=PTS-STARTPTS[aout]`;

  if (busLabels.length === 1) {
    filters.push(`${busLabels[0]}${finish}`);
  } else if (busLabels.length > 1) {
    filters.push(
      `${busLabels.join("")}amix=inputs=${busLabels.length}:duration=longest:normalize=0,${finish}`,
    );
  } else {
    const silentIndex = 0;
    args.push("-f", "lavfi", "-t", seconds(input.totalMs), "-i", "anullsrc=r=48000:cl=stereo");
    filters.push(
      `[${silentIndex}:a]atrim=duration=${seconds(input.totalMs)},asetpts=PTS-STARTPTS[aout]`,
    );
  }

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[aout]",
    "-c:a",
    "pcm_s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    input.outFile,
  );
  return args;
}

/** loudnorm 第二遍参数：拿第一遍量到的值做线性归一 */
export function loudnormFilter(
  measured: LoudnessMeasurement | null,
  target = LOUDNESS_TARGET,
): string {
  const base = `loudnorm=I=${target.integratedLufs}:TP=${target.loudnormTruePeakDb}:LRA=11`;
  if (
    !measured ||
    measured.inputI === null ||
    measured.inputTp === null ||
    measured.inputLra === null ||
    measured.inputThresh === null
  ) {
    return base;
  }
  return (
    `${base}:measured_I=${measured.inputI}:measured_TP=${measured.inputTp}` +
    `:measured_LRA=${measured.inputLra}:measured_thresh=${measured.inputThresh}` +
    `:offset=${measured.targetOffset ?? 0}:linear=true`
  );
}

/**
 * 自动二次归一（C12）：复核不过时，按实测偏差算一个线性修正量。
 *
 * 先看响度差目标多少，再看真峰值还剩多少余量；取更小的那个，保证修完
 * 既不超峰值也不把响度抬高。静音（≤ −70）与量不到的成片不动——没有
 * 可修的东西，硬抬只会把底噪推上来。修正量按 0.1 dB 取整，夹 ±12 / +6 dB。
 */
export function correctionGainDb(output: {
  integratedLufs: number | null;
  truePeakDb: number | null;
}): number | null {
  const lufs = output.integratedLufs;
  if (lufs === null || !Number.isFinite(lufs) || lufs <= -70) return null;
  // 两条验收口径都已经过了就没什么可补的：别为了 0.05 LU 去重编码一遍
  const loudnessOk =
    Math.abs(lufs - LOUDNESS_TARGET.integratedLufs) <= LOUDNESS_TARGET.toleranceLu;
  const peakOk =
    output.truePeakDb === null ||
    !Number.isFinite(output.truePeakDb) ||
    output.truePeakDb <= LOUDNESS_TARGET.ceilingDb + 0.05;
  if (loudnessOk && peakOk) return null;
  const byLoudness = LOUDNESS_TARGET.integratedLufs - lufs;
  const byPeak =
    output.truePeakDb === null || !Number.isFinite(output.truePeakDb)
      ? Number.POSITIVE_INFINITY
      : LOUDNESS_TARGET.loudnormTruePeakDb - output.truePeakDb;
  const wanted = Math.min(byLoudness, byPeak);
  if (!Number.isFinite(wanted)) return null;
  const clamped = Math.max(-12, Math.min(6, wanted));
  const rounded = Math.round(clamped * 10) / 10;
  return Math.abs(rounded) < 0.1 ? null : rounded;
}

/**
 * 二次归一的命令：只重编码音轨，画面直接 copy。
 *
 * 第一遍已经把画面压好，第二遍只为响度；重新编码整段视频既慢又可能掉画质。
 * 容器元数据（AI 标识、内容指纹）默认从输入继承。
 */
export function secondPassAudioArgs(input: {
  inputFile: string;
  outputFile: string;
  gainDb: number;
  audioBitrate: string;
}): string[] {
  return [
    "-hide_banner",
    "-y",
    "-nostats",
    "-i",
    input.inputFile,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "copy",
    "-af",
    `volume=${input.gainDb.toFixed(1)}dB`,
    "-c:a",
    "aac",
    "-b:a",
    input.audioBitrate,
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    input.outputFile,
  ];
}

/** ffmpeg 的 loudnorm JSON 输出夹在 stderr 里；取最后一个完整对象 */
export function parseLoudnessJson(stderr: string): LoudnessMeasurement | null {
  const blocks = stderr.match(/\{[\s\S]*?\}/g);
  if (!blocks) return null;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(blocks[index]!) as Record<string, unknown>;
      if (!("input_i" in parsed) && !("input_tp" in parsed)) continue;
      const number = (value: unknown): number | null => {
        const parsedNumber = typeof value === "string" ? Number(value) : value;
        return typeof parsedNumber === "number" && Number.isFinite(parsedNumber)
          ? parsedNumber
          : null;
      };
      return {
        inputI: number(parsed.input_i),
        inputTp: number(parsed.input_tp),
        inputLra: number(parsed.input_lra),
        inputThresh: number(parsed.input_thresh),
        targetOffset: number(parsed.target_offset),
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** aphasemeter 的 phasing 日志：反相与单声道各持续多久 */
export function parsePhaseMeter(stderr: string): {
  outOfPhaseMs: number | null;
  monoMs: number | null;
} {
  const duration = (name: string): number | null => {
    const match = new RegExp(`${name}_duration:\\s*([0-9.]+)`).exec(stderr);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? Math.round(value * 1000) : null;
  };
  return { outOfPhaseMs: duration("out_phase"), monoMs: duration("mono") };
}

/** 集成响度、真峰值与反相的验收口径：量不到不冒充通过 */
export function loudnessVerdict(input: {
  integratedLufs: number | null;
  truePeakDb: number | null;
  outOfPhaseMs: number | null;
}): { status: LoudnessReport["verdict"]; detail: string } {
  if (input.integratedLufs === null) {
    return { status: "unmeasured", detail: "没有量到集成响度：成片可能没有可测的音频" };
  }
  const loudnessOk =
    Math.abs(input.integratedLufs - LOUDNESS_TARGET.integratedLufs) <=
    LOUDNESS_TARGET.toleranceLu;
  const peakOk =
    input.truePeakDb !== null && input.truePeakDb <= LOUDNESS_TARGET.ceilingDb + 0.05;
  if (!loudnessOk || !peakOk) {
    const parts = [
      `集成响度 ${input.integratedLufs.toFixed(1)} LUFS（目标 ${LOUDNESS_TARGET.integratedLufs}±${LOUDNESS_TARGET.toleranceLu}）`,
      input.truePeakDb === null
        ? "真峰值未测"
        : `真峰值 ${input.truePeakDb.toFixed(1)} dBTP（上限 ${LOUDNESS_TARGET.ceilingDb}）`,
    ];
    return { status: "fail", detail: parts.join("；") };
  }
  if (input.outOfPhaseMs !== null && input.outOfPhaseMs > 500) {
    return {
      status: "review",
      detail: `响度与真峰值达标；检出 ${(input.outOfPhaseMs / 1000).toFixed(1)} 秒反相，单声道折叠可能抵消`,
    };
  }
  return {
    status: "pass",
    detail: `集成响度 ${input.integratedLufs.toFixed(1)} LUFS、真峰值 ${input.truePeakDb?.toFixed(1) ?? "未测"} dBTP`,
  };
}
