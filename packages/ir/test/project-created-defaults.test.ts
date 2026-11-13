import { describe, expect, it } from "vitest";
import { clone } from "../src/clone";
import { applyEvent, rebuild } from "../src/events";
import { ProjectSchema, type Project } from "../src/schema";
import minimalJson from "../../../examples/minimal.json";

const AT = "2026-11-09T12:00:00Z";

/** 从合法项目里删掉几个「有 default」的字段，模拟早期 / 手工写出来的半份快照 */
function partial(): Project {
  const project = ProjectSchema.parse(clone(minimalJson));
  const raw = clone(project) as Record<string, unknown> & { timeline?: Record<string, unknown> };
  delete raw.authorizations;
  delete raw.skills;
  delete raw.publishPackages;
  delete raw.subtitleOverrides;
  delete raw.voiceTakes;
  if (raw.timeline) {
    delete raw.timeline.sfx;
    delete raw.timeline.mix;
  }
  return raw as unknown as Project;
}

describe("project.created 的快照按当前 schema 补齐（ADR-0203）", () => {
  it("缺 default 字段时，applyEvent 回放出来的是完整 Project", () => {
    const raw = partial();
    expect((raw as Record<string, unknown>).authorizations).toBeUndefined();

    const result = applyEvent(null, { type: "project.created", at: AT, project: raw });
    expect(result.authorizations).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.publishPackages).toEqual([]);
    expect(result.subtitleOverrides).toEqual([]);
    expect(result.voiceTakes).toEqual([]);
    expect(result.timeline.sfx).toEqual([]);
    expect(result.timeline.mix).toEqual({ dialogueDb: 0, musicDb: 0, sfxDb: 0 });
    // 已有字段不动；版本号仍由快照自己决定
    expect(result.id).toBe(raw.id);
    expect(result.version).toBe(raw.version);
    // 补齐发生在回放结果上，不改写日志里的事件对象
    expect((raw as Record<string, unknown>).authorizations).toBeUndefined();
  });

  it("日志末尾再写一条 project.created 时，rebuild 的结果同样完整", () => {
    const full = ProjectSchema.parse(clone(minimalJson));
    const events = [
      { type: "project.created", at: AT, project: full },
      { type: "project.updated", at: AT, budgetCny: 99 },
      { type: "project.created", at: AT, project: partial() },
    ] as Parameters<typeof rebuild>[0];

    const result = rebuild(events);
    expect(result.authorizations).toEqual([]);
    expect(result.timeline.mix).toEqual({ dialogueDb: 0, musicDb: 0, sfxDb: 0 });
    expect(result.version).toBe(full.version);
  });

  it("快照里真缺必填字段时仍然报错，不靠 default 硬凑", () => {
    const raw = partial();
    delete (raw as Record<string, unknown>).title;
    expect(() => applyEvent(null, { type: "project.created", at: AT, project: raw })).toThrow();
  });
});
