import { describe, expect, it } from "vitest";
import {
  compareLines,
  documentFingerprint,
  fidelityOf,
  projectFromVerbatimDocument,
  splitChapters,
  verbatimDocument,
  verbatimExcerpt,
} from "../src/import-verbatim";

const TEXT = [
  "第一章 雨夜",
  "老楼走廊，声控灯亮了半盏。",
  "林说：你早就知道，对吧。",
  "第二章 天亮",
  "周把杯子放回桌边。",
  "门没有关。",
].join("\n");

describe("逐字导入（F6）", () => {
  it("按章节标题切，位置覆盖全文且不重不漏", () => {
    const chapters = splitChapters(TEXT);
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      "第一章 雨夜",
      "第二章 天亮",
    ]);
    expect(chapters[0]!.start).toBe(0);
    expect(chapters[1]!.end).toBe(TEXT.length);
    expect(chapters[0]!.end).toBe(chapters[1]!.start);
    expect(chapters.map((chapter) => chapter.body).join("")).toBe(TEXT);
  });

  it("认不出章节就整篇一段；中文数字与第 N 集也认", () => {
    expect(splitChapters("没有标题的一段文字\n第二行")[0]).toMatchObject({
      title: "全文",
    });
    const parts = splitChapters("第一集 归来\n甲\n第2集 出发\n乙");
    expect(parts.map((part) => part.title)).toEqual(["第一集 归来", "第2集 出发"]);
  });

  it("逐字片段与原文对应区间完全相等，报告不误报别的章节", () => {
    const chapter = splitChapters(TEXT)[1]!;
    const excerpt = verbatimExcerpt(TEXT, chapter);
    expect(excerpt.report).toMatchObject({
      exact: true,
      lines: 3,
      changedLines: [],
    });
    expect(excerpt.excerpt).toContain("门没有关。");
    expect(excerpt.excerpt).not.toContain("声控灯");
  });

  it("改动一行就能查出具体行号；CRLF 归一后仍算逐字", () => {
    const chapter = splitChapters(TEXT)[0]!;
    const changed = chapter.body.replace("对吧", "对吗");
    const report = fidelityOf(TEXT, chapter, changed);
    expect(report.exact).toBe(false);
    expect(report.changedLines).toEqual([3]);

    const crlf = TEXT.replace(/\n/g, "\r\n");
    const normalized = splitChapters(crlf)[0]!;
    expect(fidelityOf(crlf, normalized, normalized.body).exact).toBe(true);
  });

  it("逐行并排标出改动行；短的一边补空行不误判", () => {
    const rows = compareLines("甲\n乙\n丙", "甲\n乙改\n丙\n丁");
    expect(rows).toMatchObject([
      { line: 1, changed: false },
      { line: 2, original: "乙", draft: "乙改", changed: true },
      { line: 3, changed: false },
      { line: 4, original: "", draft: "丁", changed: true },
    ]);
  });

  it("原文文档带章节位置、指纹与全文字数；内容变了指纹就变", () => {
    const chapters = splitChapters(TEXT);
    const chapter = chapters[1]!;
    const doc = verbatimDocument({
      source: TEXT,
      chapter,
      chapterCount: chapters.length,
      text: chapter.body,
      fileName: "雨夜.txt",
      importedAt: "2026-11-13T10:00:00+08:00",
    });
    expect(doc).toMatchObject({
      title: "第二章 天亮",
      chapterIndex: 1,
      chapterCount: 2,
      fileName: "雨夜.txt",
      sourceChars: TEXT.length,
      fingerprint: documentFingerprint(chapter.body),
    });
    expect(doc.fingerprint).not.toBe(documentFingerprint(chapter.body + " "));
  });

  it("最小骨架不发明人物、台词与 take，只留一空镜和一份原文", () => {
    const chapters = splitChapters(TEXT);
    const doc = verbatimDocument({
      source: TEXT,
      chapter: chapters[1]!,
      chapterCount: chapters.length,
      text: chapters[1]!.body,
      importedAt: "2026-11-13T10:00:00+08:00",
    });
    const project = projectFromVerbatimDocument(doc, {
      id: "proj-verbatim",
      at: "2026-11-13T10:00:00+08:00",
      budgetCny: 60,
    });
    expect(project.story.sourceDocument).toEqual(doc);
    expect(project.story.provenance?.modelId).toBe("local:verbatim");
    expect(project.characters).toHaveLength(0);
    expect(project.dialogue).toHaveLength(0);
    expect(project.takes).toHaveLength(0);
    expect(project.scenes).toHaveLength(1);
    expect(project.shots).toHaveLength(1);
    expect(project.scenes[0]?.shotIds).toEqual([project.shots[0]?.id]);
  });
});
