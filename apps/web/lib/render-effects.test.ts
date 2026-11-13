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
  isDefaultGrade,
} from "./render-effects";

const cut = { durationMs: 1000 };
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
