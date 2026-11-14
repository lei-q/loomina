import { describe, expect, it } from "vitest";
import type { ProjectTemplate } from "./project-template";
import type { ShotTemplate } from "./shot-template";
import {
  TEMPLATE_NAME_MAX,
  TEMPLATE_NOTE_MAX,
  findSameProjectTemplate,
  findSameShotTemplate,
  renameProjectTemplate,
  renameShotTemplate,
  sameProjectParams,
  sameShotParams,
  templateNameProblem,
  templateNoteProblem,
  withProjectTemplateNote,
  withShotTemplateNote,
} from "./template-edit";

const projectTemplate = (patch: Partial<ProjectTemplate> = {}): ProjectTemplate => ({
  format: "loomina.template",
  version: 1,
  id: "t-1",
  name: "夜班 · 班底",
  createdAt: "2026-11-14T00:00:00Z",
  from: { projectId: "p-1", title: "夜班" },
  cast: [{ id: "c-1", name: "林晚" }] as ProjectTemplate["cast"],
  locations: [{ id: "l-1", name: "客厅" }] as ProjectTemplate["locations"],
  props: [{ id: "pr-1", name: "杯子" }] as ProjectTemplate["props"],
  assets: [{ id: "a-1" }] as ProjectTemplate["assets"],
  look: {} as ProjectTemplate["look"],
  grade: {} as ProjectTemplate["grade"],
  frame: {} as ProjectTemplate["frame"],
  brand: {} as ProjectTemplate["brand"],
  ...patch,
});

const shotTemplate = (patch: Partial<ShotTemplate> = {}): ShotTemplate => ({
  format: "loomina.shot-template",
  version: 1,
  id: "st-1",
  name: "低机位推近",
  createdAt: "2026-11-14T00:00:00Z",
  from: { projectId: "p-1", title: "夜班", shotId: "s-1", shotLabel: "SH-01" },
  shotSize: "medium",
  angle: "low",
  movement: "push",
  focalMm: 35,
  ...patch,
});

describe("模板改名与说明（F3 第二档 / ADR-0230）", () => {
  it("名字不能空、不能超长", () => {
    expect(templateNameProblem("")).toContain("要有名字");
    expect(templateNameProblem("   ")).toContain("要有名字");
    expect(templateNameProblem("x".repeat(TEMPLATE_NAME_MAX))).toBeUndefined();
    expect(templateNameProblem("x".repeat(TEMPLATE_NAME_MAX + 1))).toContain("最多");
  });

  it("说明可以空着，但不能超长", () => {
    expect(templateNoteProblem("")).toBeUndefined();
    expect(templateNoteProblem("x".repeat(TEMPLATE_NOTE_MAX))).toBeUndefined();
    expect(templateNoteProblem("x".repeat(TEMPLATE_NOTE_MAX + 1))).toContain("最多");
  });

  it("改名字保留 createdAt 与 from：模板的来历不丢", () => {
    const before = projectTemplate();
    const after = renameProjectTemplate(before, "新名字");
    expect(after.name).toBe("新名字");
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.from).toEqual(before.from);
    expect(after.id).toBe(before.id);
    // 原对象不动
    expect(before.name).toBe("夜班 · 班底");
  });

  it("名字两端空白被去掉、超长截断", () => {
    expect(renameProjectTemplate(projectTemplate(), "  新名字  ").name).toBe("新名字");
    expect(renameProjectTemplate(projectTemplate(), "x".repeat(60)).name).toHaveLength(
      TEMPLATE_NAME_MAX,
    );
    expect(renameShotTemplate(shotTemplate(), " 跟拍 ").name).toBe("跟拍");
  });

  it("写说明；空说明等于删掉字段", () => {
    const withNote = withProjectTemplateNote(projectTemplate(), "  九十年代夜班  ");
    expect(withNote.note).toBe("九十年代夜班");
    const cleared = withProjectTemplateNote(withNote, "");
    expect("note" in cleared).toBe(false);
  });

  it("镜头模板的说明同理", () => {
    const withNote = withShotTemplateNote(shotTemplate(), "紧张时用");
    expect(withNote.note).toBe("紧张时用");
    expect("note" in withShotTemplateNote(withNote, "   ")).toBe(false);
  });
});

describe("模板去重（F3 第二档）", () => {
  it("参数一样就算同一套：名字、说明、id、来历都不影响", () => {
    const a = projectTemplate();
    const b = projectTemplate({
      id: "t-2",
      name: "另一个名字",
      note: "备注",
      createdAt: "2026-11-15T00:00:00Z",
      from: { projectId: "p-9", title: "别的片" },
    });
    expect(sameProjectParams(a, b)).toBe(true);
  });

  it("人物不一样就不是同一套", () => {
    const a = projectTemplate();
    const b = projectTemplate({
      cast: [{ id: "c-1", name: "林晚" }, { id: "c-2", name: "周决" }] as ProjectTemplate["cast"],
    });
    expect(sameProjectParams(a, b)).toBe(false);
  });

  it("风格 / 画幅 / 品牌任一不同都不算同一套", () => {
    const base = projectTemplate();
    expect(sameProjectParams(base, projectTemplate({ look: { note: "冷" } as never }))).toBe(false);
    expect(sameProjectParams(base, projectTemplate({ frame: { aspect: "16:9" } as never }))).toBe(
      false,
    );
    expect(sameProjectParams(base, projectTemplate({ brand: { name: "工作室" } as never }))).toBe(
      false,
    );
  });

  it("在列表里找同一套；排除自己", () => {
    const a = projectTemplate();
    const b = projectTemplate({ id: "t-2", name: "副本" });
    expect(findSameProjectTemplate([a], b)?.id).toBe("t-1");
    expect(findSameProjectTemplate([a], b, "t-1")).toBeUndefined();
    expect(findSameProjectTemplate([], b)).toBeUndefined();
  });

  it("镜头模板：四项 + 可选光影 / 构图全比", () => {
    const a = shotTemplate();
    expect(sameShotParams(a, shotTemplate({ id: "st-2", name: "别的名字" }))).toBe(true);
    expect(sameShotParams(a, shotTemplate({ focalMm: 50 }))).toBe(false);
    expect(
      sameShotParams(
        a,
        shotTemplate({ lighting: { source: "lamp", position: "top", mood: "flat", note: "" } }),
      ),
    ).toBe(false);
    // 两边都没写光影 → 相同
    expect(sameShotParams(a, shotTemplate({ id: "st-3" }))).toBe(true);
  });

  it("镜头模板列表里找同一套，支持排除自己", () => {
    const a = shotTemplate();
    const b = shotTemplate({ id: "st-2" });
    expect(findSameShotTemplate([a], b)?.id).toBe("st-1");
    expect(findSameShotTemplate([a], b, "st-1")).toBeUndefined();
  });
});
