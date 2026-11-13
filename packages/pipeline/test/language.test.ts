import { describe, expect, it } from "vitest";
import {
  COMPOSITION_TEMPLATES,
  LIGHTING_TEMPLATES,
  SHOT_LANGUAGES,
  SHOT_LANGUAGE_GROUPS,
  compileComposition,
  compileLighting,
  compositionTemplateById,
  lightingTemplateById,
  matchShotLanguage,
  shotLanguageById,
  shotLanguagePatch,
} from "../src/language";

const baseCamera = { angle: "eye" as const, movement: "static" as const, focalMm: 35 };

describe("镜头语言库（I1）", () => {
  it("十四套说法，每套都有名字、说明与四个参数", () => {
    expect(SHOT_LANGUAGES).toHaveLength(14);
    for (const item of SHOT_LANGUAGES) {
      expect(item.name.trim()).not.toBe("");
      expect(item.blurb.trim()).not.toBe("");
      expect(item.focalMm).toBeGreaterThan(0);
      expect(SHOT_LANGUAGE_GROUPS).toContain(item.group);
    }
    // id 唯一
    expect(new Set(SHOT_LANGUAGES.map((item) => item.id)).size).toBe(SHOT_LANGUAGES.length);
  });

  it("每一组都有说法，没有空组", () => {
    for (const group of SHOT_LANGUAGE_GROUPS) {
      expect(SHOT_LANGUAGES.some((item) => item.group === group)).toBe(true);
    }
  });

  it("四个字段全对上才算这一套", () => {
    const insert = shotLanguageById("insert")!;
    expect(
      matchShotLanguage({
        shotSize: insert.shotSize,
        camera: { angle: insert.angle, movement: insert.movement, focalMm: insert.focalMm },
      })?.id,
    ).toBe("insert");
    // 只对上三项：不算
    expect(
      matchShotLanguage({
        shotSize: insert.shotSize,
        camera: { angle: insert.angle, movement: insert.movement, focalMm: 35 },
      }),
    ).toBeUndefined();
  });

  it("拼出来的一组不在库里，返回 undefined", () => {
    expect(
      matchShotLanguage({ shotSize: "close", camera: baseCamera }),
    ).toBeUndefined();
  });

  it("套用补丁写景别与机位四项，不动坐标", () => {
    const language = shotLanguageById("pov")!;
    const patch = shotLanguagePatch(language);
    expect(patch).toEqual({
      shotSize: "medium",
      camera: { angle: "eye", movement: "handheld", focalMm: 35 },
    });
    // 没有坐标时补丁里也不该冒出 placement
    expect("placement" in patch.camera).toBe(false);
  });

  it("已经摆好机位坐标的镜头，换说法时坐标原样保留", () => {
    const language = shotLanguageById("over-shoulder")!;
    const placement = { position: [0, 1.6, 2] as [number, number, number], target: [0, 1.6, 0] as [number, number, number] };
    const patch = shotLanguagePatch(language, { camera: { ...baseCamera, placement } });
    expect(patch.camera.placement).toEqual(placement);
    expect(patch.camera.focalMm).toBe(50);
  });

  it("不认识的 id 返回 undefined", () => {
    expect(shotLanguageById("dutch-angle")).toBeUndefined();
  });
});

describe("光影模板（I2）", () => {
  it("七套模板，每套都有名字与说明", () => {
    expect(LIGHTING_TEMPLATES).toHaveLength(7);
    for (const item of LIGHTING_TEMPLATES) {
      expect(item.name.trim()).not.toBe("");
      expect(item.blurb.trim()).not.toBe("");
      expect(lightingTemplateById(item.id)?.name).toBe(item.name);
    }
  });

  it("编译成一句：光源、方向、塑形，再加作者的补充", () => {
    expect(compileLighting(lightingTemplateById("window-side")!.value)).toBe(
      "光线：窗外自然光，侧光，明暗过渡清晰",
    );
    expect(compileLighting(lightingTemplateById("lamp-pool")!.value)).toContain("只有一盏台灯亮着");
    expect(compileLighting(undefined)).toBe("");
  });
});

describe("构图模板（I4）", () => {
  it("六套模板，编译成一句", () => {
    expect(COMPOSITION_TEMPLATES).toHaveLength(6);
    expect(compileComposition(compositionTemplateById("frame-in-frame")!.value)).toBe(
      "构图：框中框构图，透过门框或窗框看",
    );
    expect(compileComposition(undefined)).toBe("");
  });

  it("作者的补充句接在后面", () => {
    expect(
      compileComposition({ rule: "negative", note: "人站在画面右下角，只占十分之一" }),
    ).toBe("构图：大量留白，主体在画面中很小，人站在画面右下角，只占十分之一");
  });
});
