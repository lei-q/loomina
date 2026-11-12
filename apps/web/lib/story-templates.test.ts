import { describe, expect, it } from "vitest";
import {
  STORY_TEMPLATES,
  TEMPLATE_BEAT_SHEET,
  templateById,
  templateIssues,
  templateStoryInput,
} from "./story-templates";

/**
 * 模板剧本（A7 / ADR-0159）。
 *
 * 模板是纯数据，不建项目、不调模型；这里只保证它们引用的题材 / 节拍表真实存在，
 * 并且「用这个模板」确实填满想法、题材与两个钩子。
 */

describe("模板剧本（A7 / ADR-0159）", () => {
  it("六条模板引用的题材与节拍表都真实存在", () => {
    expect(STORY_TEMPLATES).toHaveLength(6);
    expect(templateIssues()).toEqual([]);
    expect(TEMPLATE_BEAT_SHEET).toBe("60s");
  });

  it("每条模板都有梗概、人物、六拍与两个钩子", () => {
    for (const template of STORY_TEMPLATES) {
      expect(template.logline.length).toBeGreaterThan(10);
      expect(template.synopsis.length).toBeGreaterThan(20);
      expect(template.cast.length).toBeGreaterThanOrEqual(2);
      expect(template.beats).toHaveLength(6);
      expect(template.beats[0]?.label).toBe("hook");
      expect(template.beats.at(-1)?.label).toBe("endHook");
      expect(template.openingHook).not.toBe(template.endingHook);
    }
  });

  it("用模板填想法：梗概、钩子、题材、节拍表一起给到", () => {
    const template = STORY_TEMPLATES[0]!;
    const input = templateStoryInput(template);
    expect(input.idea).toContain(template.logline);
    expect(input.idea).toContain(`开场钩子：${template.openingHook}`);
    expect(input.idea).toContain(`结尾钩子：${template.endingHook}`);
    expect(input.genre).toBe("逆袭打脸");
    expect(input.beatSheetId).toBe("60s");
    expect(input.openingHook).toBe(template.openingHook);
  });

  it("按 id 取模板；未知 id 不硬造一个", () => {
    expect(templateById("comeback-heir")?.genre).toBe("逆袭打脸");
    expect(templateById("nope")).toBeUndefined();
    expect(templateById(undefined)).toBeUndefined();
  });
});
