import { describe, expect, it } from "vitest";
import {
  LOUDNESS_TARGET,
  buildAudioMixCommand,
  correctionGainDb,
  duckVolumeExpression,
  loudnessVerdict,
  loudnormFilter,
  mergeIntervals,
  parseLoudnessJson,
  parsePhaseMeter,
  secondPassAudioArgs,
  segmentGainDb,
  SFX_TARGET_LUFS,
  sfxGainDb,
} from "./render-audio";

describe("分段响度（C12）", () => {
  it("每句拉向 −18 LUFS，最多 ±12 dB", () => {
    expect(segmentGainDb(-18)).toBe(0);
    expect(segmentGainDb(-22)).toBe(4);
    expect(segmentGainDb(-14)).toBe(-4);
    expect(segmentGainDb(-22.34)).toBe(4.3);
    expect(segmentGainDb(-60)).toBe(12);
    expect(segmentGainDb(-8)).toBe(-10);
  });

  it("量不到 / 静音不抬：null、非有限值与 −70 都返回 0", () => {
    expect(segmentGainDb(null)).toBe(0);
    expect(segmentGainDb(undefined)).toBe(0);
    expect(segmentGainDb(Number.NaN)).toBe(0);
    expect(segmentGainDb(-70)).toBe(0);
    expect(segmentGainDb(-80)).toBe(0);
  });

  it("每句的增益写进对白滤镜，0 dB 不加 volume", () => {
    const args = buildAudioMixCommand({
      dialogue: [
        { path: "/tmp/a.m4a", startMs: 0, durationMs: 2000, gainDb: 4 },
        { path: "/tmp/b.m4a", startMs: 3000, durationMs: 1000, gainDb: 0 },
      ],
      music: [],
      totalMs: 5000,
      outFile: "/tmp/mix.wav",
    });
    const filters = args[args.indexOf("-filter_complex") + 1]!;
    expect(filters).toContain("[0:a]aresample=48000,adelay=0|0,volume=1.584893,atrim=");
    expect(filters).toContain("[1:a]aresample=48000,adelay=3000|3000,atrim=");
    expect(filters).not.toContain("adelay=3000|3000,volume=");
  });
});

describe("混音（C12）", () => {
  it("合并重叠与一口气的台词窗，远处的窗保持分开", () => {
    expect(
      mergeIntervals([
        { startMs: 0, endMs: 1000 },
        { startMs: 900, endMs: 2000 },
        { startMs: 2400, endMs: 3000 },
        { startMs: 5000, endMs: 6000 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 3000 },
      { startMs: 5000, endMs: 6000 },
    ]);
  });

  it("空窗与非法窗被丢掉", () => {
    expect(
      mergeIntervals([
        { startMs: 1000, endMs: 1000 },
        { startMs: 3000, endMs: 2000 },
        { startMs: Number.NaN, endMs: 4000 },
      ]),
    ).toEqual([]);
  });

  it("不 ducking 时只有基础增益", () => {
    expect(duckVolumeExpression([{ startMs: 0, endMs: 1000 }], -18, 15, false)).toBe(
      "0.125893",
    );
  });

  it("没有台词窗时也只有基础增益", () => {
    expect(duckVolumeExpression([], -18, 15)).toBe("0.125893");
  });

  it("台词窗里按 duckDb 压低，两侧留斜坡", () => {
    const expression = duckVolumeExpression([{ startMs: 1000, endMs: 3000 }], -18, 15);
    expect(expression).toContain("0.125893"); // -18 dB 基础增益
    expect(expression).toContain("0.177828"); // 压 15 dB
    expect(expression).toContain("lt(t,0.800)"); // 提前 200 ms 起坡
    expect(expression).toContain("lt(t,3.300)"); // 之后 300 ms 抬回
    expect(expression.startsWith("0.125893*")).toBe(true);
  });

  it("两个台词窗各乘一层，压深与增益互不影响", () => {
    const expression = duckVolumeExpression(
      [
        { startMs: 0, endMs: 1000 },
        { startMs: 4000, endMs: 5000 },
      ],
      -12,
      18,
    );
    expect(expression).toContain("0.251189"); // -12 dB
    expect(expression).toContain("0.125893"); // 压 18 dB
    expect(expression.match(/if\(lt\(t,-?[0-9.]+\),1,/g)).toHaveLength(2);
    expect(expression).toContain("lt(t,-0.200)");
    expect(expression).toContain("lt(t,3.800)");
  });

  it("混音命令：对白与循环配乐分别入轨，输出 PCM wav", () => {
    const args = buildAudioMixCommand({
      dialogue: [{ path: "/tmp/dlg1.m4a", startMs: 0, durationMs: 2000 }],
      music: [
        {
          path: "/tmp/music.mp3",
          startMs: 0,
          endMs: 8000,
          gainDb: -18,
          duckDb: 15,
          ducking: true,
          loop: true,
        },
      ],
      totalMs: 8000,
      outFile: "/tmp/mix.wav",
    });
    expect(args.join(" ")).toContain("-stream_loop -1");
    expect(args.filter((arg) => arg === "-i")).toHaveLength(2);
    const filters = args[args.indexOf("-filter_complex") + 1]!;
    expect(filters).toContain("[0:a]aresample=48000,adelay=0|0");
    expect(filters).toContain("volume=volume='0.125893*");
    expect(filters).toContain("[dlgmix][musmix]amix=inputs=2");
    expect(filters).toContain("atrim=duration=8.000");
    expect(args).toContain("[aout]");
    expect(args).toContain("pcm_s16le");
    expect(args.at(-1)).toBe("/tmp/mix.wav");
  });

  it("只有配乐时不循环就不加 -stream_loop，单轨走 anull", () => {
    const args = buildAudioMixCommand({
      dialogue: [],
      music: [
        {
          path: "/tmp/music.mp3",
          startMs: 500,
          endMs: 2500,
          gainDb: -20,
          duckDb: 12,
          ducking: false,
          loop: false,
        },
      ],
      totalMs: 3000,
      outFile: "/tmp/mix.wav",
    });
    expect(args).not.toContain("-stream_loop");
    const filters = args[args.indexOf("-filter_complex") + 1]!;
    expect(filters).toContain("[0:a]aresample=48000");
    expect(filters).toContain("adelay=500|500");
    expect(filters).toContain("[mus0]anull[musmix]");
    expect(filters).toContain("[musmix]apad,atrim=duration=3.000");
  });

  it("没有任何音轨时补一段等长静音", () => {
    const args = buildAudioMixCommand({
      dialogue: [],
      music: [],
      totalMs: 4000,
      outFile: "/tmp/mix.wav",
    });
    expect(args.join(" ")).toContain("anullsrc=r=48000:cl=stereo");
    const filters = args[args.indexOf("-filter_complex") + 1]!;
    expect(filters).toContain("atrim=duration=4.000");
  });
});

describe("响度（C12）", () => {
  const measured = {
    inputI: -22.4,
    inputTp: -4.1,
    inputLra: 3.2,
    inputThresh: -32.7,
    targetOffset: 0.12,
  };

  it("量到值后线性归一，目标 −14 LUFS / −1.5 dBTP", () => {
    const filter = loudnormFilter(measured);
    expect(filter).toContain(`I=${LOUDNESS_TARGET.integratedLufs}`);
    expect(filter).toContain(`TP=${LOUDNESS_TARGET.loudnormTruePeakDb}`);
    expect(filter).toContain("measured_I=-22.4");
    expect(filter).toContain("measured_TP=-4.1");
    expect(filter).toContain("measured_LRA=3.2");
    expect(filter).toContain("measured_thresh=-32.7");
    expect(filter).toContain("offset=0.12");
    expect(filter).toContain("linear=true");
  });

  it("没量到就退回动态 loudnorm，不编 measured 值", () => {
    const filter = loudnormFilter(null);
    expect(filter).toBe("loudnorm=I=-14:TP=-1.5:LRA=11");
    expect(filter).not.toContain("measured_I");
  });

  it("从 stderr 里取最后一个 loudnorm JSON", () => {
    const stderr = [
      "[Parsed_loudnorm_0 @ 0x1] {",
      '  "input_i" : "-70.00",',
      '  "input_tp" : "-70.00"',
      "}",
      "some noise",
      "{",
      '  "input_i" : "-22.40",',
      '  "input_tp" : "-4.10",',
      '  "input_lra" : "3.20",',
      '  "input_thresh" : "-32.70",',
      '  "target_offset" : "0.12"',
      "}",
    ].join("\n");
    expect(parseLoudnessJson(stderr)).toEqual(measured);
  });

  it("JSON 里的 -inf 当作没量到", () => {
    const parsed = parseLoudnessJson('{"input_i":"-inf","input_tp":"-inf"}');
    expect(parsed).toEqual({
      inputI: null,
      inputTp: null,
      inputLra: null,
      inputThresh: null,
      targetOffset: null,
    });
    expect(parseLoudnessJson("no json here")).toBeNull();
  });

  it("反相与单声道时长换算成毫秒", () => {
    const stderr = [
      "[Parsed_aphasemeter_2 @ 0x1] out_phase_duration: 0.512",
      "[Parsed_aphasemeter_2 @ 0x1] mono_duration: 8.000",
    ].join("\n");
    expect(parsePhaseMeter(stderr)).toEqual({ outOfPhaseMs: 512, monoMs: 8000 });
    expect(parsePhaseMeter("")).toEqual({ outOfPhaseMs: null, monoMs: null });
  });

  it("达标算通过，明细写清量到的数值", () => {
    const verdict = loudnessVerdict({
      integratedLufs: -14.2,
      truePeakDb: -1.4,
      outOfPhaseMs: 0,
    });
    expect(verdict.status).toBe("pass");
    expect(verdict.detail).toContain("-14.2 LUFS");
  });

  it("响度或真峰值不达标即失败", () => {
    expect(
      loudnessVerdict({ integratedLufs: -18.6, truePeakDb: -1.2, outOfPhaseMs: 0 }).status,
    ).toBe("fail");
    expect(
      loudnessVerdict({ integratedLufs: -14.0, truePeakDb: -0.2, outOfPhaseMs: 0 }).status,
    ).toBe("fail");
    expect(
      loudnessVerdict({ integratedLufs: -14.0, truePeakDb: null, outOfPhaseMs: 0 }).status,
    ).toBe("fail");
  });

  it("反相超过半秒只提示复核，不冒充不合格", () => {
    const verdict = loudnessVerdict({
      integratedLufs: -14.3,
      truePeakDb: -1.6,
      outOfPhaseMs: 900,
    });
    expect(verdict.status).toBe("review");
    expect(verdict.detail).toContain("0.9 秒反相");
  });

  it("量不到集成响度就写未测", () => {
    const verdict = loudnessVerdict({
      integratedLufs: null,
      truePeakDb: null,
      outOfPhaseMs: null,
    });
    expect(verdict.status).toBe("unmeasured");
  });
});

describe("自动二次归一（C12）", () => {
  it("偏轻就往上补，偏响就往下压，按 0.1 dB 取整", () => {
    expect(correctionGainDb({ integratedLufs: -12.4, truePeakDb: -4 })).toBe(-1.6);
    expect(correctionGainDb({ integratedLufs: -16.34, truePeakDb: -4 })).toBe(2.3);
  });

  it("真峰值不够时以峰值为准，不为了响度顶破上限", () => {
    // 响度只差 +1.0，但峰值已经 −0.5，要压到 −1.5 得退 −1.0
    expect(correctionGainDb({ integratedLufs: -15, truePeakDb: -0.5 })).toBe(-1);
  });

  it("静音 / 量不到 / 已经对得上都不补", () => {
    expect(correctionGainDb({ integratedLufs: null, truePeakDb: null })).toBeNull();
    expect(correctionGainDb({ integratedLufs: -70, truePeakDb: -20 })).toBeNull();
    expect(correctionGainDb({ integratedLufs: -14.05, truePeakDb: -1.6 })).toBeNull();
  });

  it("修正量夹在 −12 … +6 dB", () => {
    expect(correctionGainDb({ integratedLufs: -40, truePeakDb: null })).toBe(6);
    expect(correctionGainDb({ integratedLufs: -2, truePeakDb: -6 })).toBe(-12);
  });

  it("二次归一只重编码音轨，画面 copy、元数据跟着走", () => {
    const args = secondPassAudioArgs({
      inputFile: "out.mp4",
      outputFile: "out-fixed.mp4",
      gainDb: -1.6,
      audioBitrate: "128k",
    });
    expect(args).toContain("-c:v");
    expect(args[args.indexOf("-c:v") + 1]).toBe("copy");
    expect(args[args.indexOf("-af") + 1]).toBe("volume=-1.6dB");
    expect(args).toContain("aac");
    expect(args).toContain("out-fixed.mp4");
  });
});

describe("音效层与三路平衡（C7）", () => {
  it("音效按自己的增益进音效总线，不 ducking", () => {
    const args = buildAudioMixCommand({
      dialogue: [],
      music: [],
      sfx: [{ path: "/tmp/door.wav", startMs: 1200, endMs: 2100, gainDb: -12, loop: false }],
      mix: { dialogueDb: 0, musicDb: 0, sfxDb: 6 },
      totalMs: 5500,
      outFile: "/tmp/mix.wav",
    });
    const filters = args[args.indexOf("-filter_complex") + 1]!;
    // −12 + 6 = −6 dB → 0.501187
    expect(filters).toContain(
      "[0:a]aresample=48000,atrim=duration=0.900,asetpts=PTS-STARTPTS,adelay=1200|1200,volume=0.501187,anull[sfx0]",
    );
    expect(filters).toContain("[sfx0]anull[sfxmix]");
    expect(filters).not.toContain("duck");
  });

  it("循环音效加 -stream_loop", () => {
    const args = buildAudioMixCommand({
      dialogue: [],
      music: [],
      sfx: [{ path: "/tmp/rain.wav", startMs: 0, endMs: 5500, gainDb: -20, loop: true }],
      totalMs: 5500,
      outFile: "/tmp/mix.wav",
    });
    expect(args[args.indexOf("-stream_loop") + 1]).toBe("-1");
  });

  it("对白与音效两条总线用 amix 合成", () => {
    const args = buildAudioMixCommand({
      dialogue: [{ path: "/tmp/a.m4a", startMs: 0, durationMs: 2000 }],
      music: [],
      sfx: [{ path: "/tmp/door.wav", startMs: 1200, endMs: 2100, gainDb: -12, loop: false }],
      mix: { dialogueDb: 3, musicDb: 0, sfxDb: 0 },
      totalMs: 5500,
      outFile: "/tmp/mix.wav",
    });
    const filters = args[args.indexOf("-filter_complex") + 1]!;
    // 对白总线 +3 dB 叠到每句上：0 → 1.412538
    expect(filters).toContain("volume=1.412538");
    expect(filters).toContain("[dlgmix][sfxmix]amix=inputs=2:duration=longest:normalize=0");
  });

  it("总线全 0 时命令与以前同构", () => {
    const args = buildAudioMixCommand({
      dialogue: [{ path: "/tmp/a.m4a", startMs: 0, durationMs: 2000 }],
      music: [],
      mix: { dialogueDb: 0, musicDb: 0, sfxDb: 0 },
      totalMs: 5500,
      outFile: "/tmp/mix.wav",
    });
    const filters = args[args.indexOf("-filter_complex") + 1]!;
    expect(filters).not.toContain("volume=");
  });
});

describe("音效自动响度归一（C7 / ADR-0218）", () => {
  it("按角色归一到不同目标位：环境垫在后面、重音跳出来", () => {
    // 同一条 −45 LUFS 的音效，环境只抬 15（封顶），重音抬 27→封顶 15
    expect(sfxGainDb(-25, "foley")).toBe(5);
    expect(sfxGainDb(-25, "impact")).toBe(7);
    expect(sfxGainDb(-25, "ambience")).toBe(-5);
    expect(sfxGainDb(-25, "transition")).toBe(3);
  });

  it("单条最多 ±15 dB：太小声也不无限抬", () => {
    expect(sfxGainDb(-60, "impact")).toBe(15);
    expect(sfxGainDb(-5, "ambience")).toBe(-15);
  });

  it("量不到 / 静音不抬：null、非有限值与 −70 都返回 0", () => {
    expect(sfxGainDb(null, "foley")).toBe(0);
    expect(sfxGainDb(undefined, "foley")).toBe(0);
    expect(sfxGainDb(Number.NaN, "foley")).toBe(0);
    expect(sfxGainDb(-70, "foley")).toBe(0);
    expect(sfxGainDb(-80, "ambience")).toBe(0);
  });

  it("结果按 0.1 dB 取整", () => {
    expect(sfxGainDb(-20.06, "foley")).toBe(0.1);
    expect(sfxGainDb(-19.94, "foley")).toBe(-0.1);
  });

  it("目标位表覆盖四个角色，且环境最低", () => {
    const targets = Object.values(SFX_TARGET_LUFS);
    expect(targets).toHaveLength(4);
    expect(SFX_TARGET_LUFS.ambience).toBeLessThan(SFX_TARGET_LUFS.foley);
    expect(SFX_TARGET_LUFS.impact).toBeGreaterThan(SFX_TARGET_LUFS.foley);
  });
});
