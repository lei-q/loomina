import { describe, expect, it } from "vitest";
import {
  GRADE_PRESETS,
  TRANSITION_LABEL,
  clipFades,
  fadeFilters,
  gradeCssFilter,
  gradeFilters,
  gradeLine,
  gradePresetById,
  focusLine,
  frameChain,
  frameLine,
  isDefaultFrame,
  isDefaultGrade,
} from "./render-effects";

const cut = { durationMs: 1000 };
/** 留边底色：与 render-effects 里的常量同一份，测试不另写一份颜色 */
const PAD_COLOR = "0x0C0C0D";
const dip = (kind: "black" | "white", durationMs = 300, clipMs = 1000) => ({
  durationMs: clipMs,
  transitionIn: { kind, durationMs },
});

describe("转场（E4 / ADR-0169）", () => {
  it("第一段没有淡入；它的 transitionIn 被忽略", () => {
    const fades = clipFades([dip("black"), cut]);
    expect(fades[0]).toEqual({ fadeInMs: 0, fadeInKind: "black", fadeOutMs: 0, fadeOutKind: "black" });
  });

  it("一处转场同时给上一段淡出、下一段淡入", () => {
    const fades = clipFades([cut, dip("black", 300), cut]);
    expect(fades[0]!.fadeOutMs).toBe(300);
    expect(fades[1]!.fadeInMs).toBe(300);
    expect(fades[1]!.fadeInKind).toBe("black");
    // 第二段后面是硬切
    expect(fades[1]!.fadeOutMs).toBe(0);
    expect(fades[2]!.fadeInMs).toBe(0);
  });

  it("单侧不超过这一段的一半：400ms 的短镜放不下 300ms 的转场", () => {
    const fades = clipFades([{ durationMs: 400 }, { durationMs: 400, transitionIn: { kind: "white", durationMs: 300 } }]);
    // 夹到 200ms 仍然 ≥ 100ms，所以照做
    expect(fades[0]!.fadeOutMs).toBe(200);
    expect(fades[1]!.fadeInMs).toBe(200);
    // 150ms 的镜：一半 75ms < 100ms，不做——40ms 的闪白不是转场
    const tiny = clipFades([{ durationMs: 150 }, { durationMs: 150, transitionIn: { kind: "white", durationMs: 300 } }]);
    expect(tiny[0]!.fadeOutMs).toBe(0);
    expect(tiny[1]!.fadeInMs).toBe(0);
  });

  it("编译成 fade 滤镜：淡入从 0 起，淡出从这一段末尾倒数", () => {
    expect(fadeFilters({ fadeInMs: 300, fadeInKind: "black", fadeOutMs: 0, fadeOutKind: "black" }, 2000)).toEqual([
      "fade=t=in:st=0:d=0.300:color=black",
    ]);
    expect(fadeFilters({ fadeInMs: 0, fadeInKind: "black", fadeOutMs: 250, fadeOutKind: "white" }, 2000)).toEqual([
      "fade=t=out:st=1.750:d=0.250:color=white",
    ]);
    expect(fadeFilters({ fadeInMs: 0, fadeInKind: "black", fadeOutMs: 0, fadeOutKind: "black" }, 2000)).toEqual([]);
  });

  it("两种接法都有中文说法", () => {
    expect(TRANSITION_LABEL.black).toBe("淡到黑");
    expect(TRANSITION_LABEL.white).toBe("淡到白");
  });
});

describe("调色（E4 / ADR-0169）", () => {
  it("默认档不产生任何滤镜：旧项目导出与以前逐字节同构", () => {
    expect(gradeFilters(undefined)).toEqual([]);
    expect(gradeFilters({ presetId: "", contrast: "natural", saturation: "natural", temperature: "neutral", vignette: false })).toEqual([]);
    expect(isDefaultGrade(undefined)).toBe(true);
  });

  it("对比 / 饱和 / 色温各编译成一段", () => {
    expect(
      gradeFilters({ presetId: "", contrast: "punchy", saturation: "muted", temperature: "cool", vignette: false }),
    ).toEqual(["eq=contrast=1.16:saturation=0.85", "colorbalance=rs=-0.05:bs=0.05"]);
    expect(
      gradeFilters({ presetId: "", contrast: "flat", saturation: "rich", temperature: "warm", vignette: true }),
    ).toEqual(["eq=contrast=0.92:saturation=1.18", "colorbalance=rs=0.06:bs=-0.06", "vignette=PI/4"]);
  });

  it("五个预设都能落到一组具体参数上，且都能被认出来", () => {
    expect(GRADE_PRESETS).toHaveLength(5);
    for (const preset of GRADE_PRESETS) {
      expect(gradePresetById(preset.id)?.name).toBe(preset.name);
      expect(preset.blurb.trim()).not.toBe("");
    }
    const cinema = gradePresetById("cinema")!;
    expect(gradeFilters({ presetId: "cinema", ...cinema.value })).toContain("vignette=PI/4");
  });

  it("预览用的 CSS 近似：默认档为空串，调过才有值", () => {
    expect(gradeCssFilter(undefined)).toBe("");
    expect(gradeCssFilter({ presetId: "thriller", contrast: "punchy", saturation: "muted", temperature: "cool", vignette: true })).toBe(
      "contrast(1.16) saturate(0.85) hue-rotate(-8deg) saturate(0.96)",
    );
  });

  it("一句人话：默认档说「不调色」，选过预设先说预设名", () => {
    expect(gradeLine(undefined)).toBe("原样，不调色");
    const thriller = gradePresetById("thriller")!;
    expect(gradeLine({ presetId: "thriller", ...thriller.value })).toContain("冷峻：");
  });
});

describe("画幅（E5 / ADR-0170）", () => {
  const size = { width: 1080, height: 1920 };

  it("默认画幅不产生任何新滤镜：留边链与以前的 pad 一致", () => {
    const chain = frameChain(undefined, size, undefined, 0);
    expect(chain.statements).toEqual([
      "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease," +
        "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=" + PAD_COLOR + ",setsar=1[frame0]",
    ]);
    expect(chain.out).toBe("frame0");
  });

  it("裁切：放大铺满，按焦点决定留住哪一块", () => {
    const chain = frameChain({ aspect: "16:9", fit: "crop" }, { width: 1920, height: 1080 }, { x: 0.25, y: 0.75 }, 2);
    expect(chain.statements).toHaveLength(1);
    const line = chain.statements[0]!;
    expect(line).toContain("scale=1920:1080:force_original_aspect_ratio=increase");
    expect(line).toContain("crop=1920:1080:(iw-1920)*0.250:(ih-1080)*0.750");
    expect(line).toContain("[frame2]");
  });

  it("裁切没设焦点时居中", () => {
    const line = frameChain({ aspect: "1:1", fit: "crop" }, { width: 1080, height: 1080 }, undefined, 0).statements[0]!;
    expect(line).toContain("crop=1080:1080:(iw-1080)*0.500:(ih-1080)*0.500");
  });

  it("模糊填充：同一帧拆两路，模糊的当底、缩小的放中间", () => {
    const chain = frameChain({ aspect: "16:9", fit: "blur" }, { width: 1920, height: 1080 }, undefined, 3);
    expect(chain.statements).toHaveLength(4);
    expect(chain.statements[0]).toBe("[3:v]split=2[bgIn3][fgIn3]");
    expect(chain.statements[1]).toContain("gblur=sigma=");
    expect(chain.statements[2]).toContain("force_original_aspect_ratio=decrease");
    expect(chain.statements[3]).toBe("[bg3][fg3]overlay=(W-w)/2:(H-h)/2[frame3]");
  });

  it("默认画幅判定与一句人话", () => {
    expect(isDefaultFrame(undefined)).toBe(true);
    expect(isDefaultFrame({ aspect: "9:16", fit: "pad" })).toBe(true);
    expect(isDefaultFrame({ aspect: "9:16", fit: "crop" })).toBe(false);
    expect(frameLine(undefined)).toBe("竖屏 9:16，留边");
    expect(frameLine({ aspect: "16:9", fit: "blur" })).toBe("横屏 16:9，模糊填充");
  });

  it("焦点的人话：偏上偏左分开说，居中不啰嗦", () => {
    expect(focusLine(undefined)).toBe("居中");
    expect(focusLine({ x: 0.5, y: 0.5 })).toBe("居中");
    expect(focusLine({ x: 0.5, y: 0.2 })).toBe("偏上");
    expect(focusLine({ x: 0.2, y: 0.2 })).toBe("偏上偏左");
    expect(focusLine({ x: 0.8, y: 0.5 })).toBe("偏右");
  });
});
