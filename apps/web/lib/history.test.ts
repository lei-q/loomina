import { rebuild, type ProjectEvent } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import { buildHistory, historyPosition, nextUndo } from "./history";
import { sampleProject } from "./sample-project";

const T = (second: number) => `2026-11-11T10:00:${String(second).padStart(2, "0")}Z`;

function created(): ProjectEvent {
  return { type: "project.created", at: T(0), project: sampleProject };
}

function budget(cny: number, at = T(1)): ProjectEvent {
  return { type: "project.updated", at, budgetCny: cny };
}

function lockShot(shotId = "s-03", at = T(2)): ProjectEvent {
  return { type: "shot.updated", at, shotId, patch: { locked: true } };
}

describe("历史读法（F2 / ADR-0109）", () => {
  it("每条事件都有一句人话，名字按当时的样子算", () => {
    const events = [created(), budget(120), lockShot()];
    const entries = buildHistory(events);

    expect(entries.map((entry) => entry.count)).toEqual([1, 2, 3]);
    expect(entries[0]!.label).toContain("新建项目「夜班」");
    expect(entries[1]!.label).toBe("项目设置：预算 ¥120");
    expect(entries[2]!.label).toContain("锁定");
    expect(entries[2]!.label).toContain("SH-");
  });

  it("同一次操作写出的多条事件共用时间戳：只有第一条标为起点", () => {
    const events = [created(), lockShot("s-03", T(5)), lockShot("s-04", T(5)), budget(90, T(6))];
    const entries = buildHistory(events);

    expect(entries.map((entry) => entry.stepStart)).toEqual([true, true, false, true]);
    expect(entries.map((entry) => entry.groupSize)).toEqual([1, 2, 2, 1]);
  });

  it("回收站的名字也用删除之前的那一份算", () => {
    const character = {
      id: "c-temp",
      name: "阿棠",
      appearance: "",
      sheet: {},
      referenceImages: [],
      mustNotChange: [],
    };
    const events: ProjectEvent[] = [
      created(),
      { type: "character.added", at: T(2), character },
      { type: "character.removed", at: T(3), characterId: character.id },
    ];
    const entries = buildHistory(events);
    expect(entries[2]!.label).toBe(`删人物「${character.name}」`);
    expect(entries[2]!.kind).toBe("removal");
  });

  it("当前位置：普通日志是全部条数，末尾是回滚时按回滚目标算", () => {
    expect(historyPosition([created(), budget(120)])).toBe(2);
    expect(
      historyPosition([
        created(),
        budget(120),
        { type: "project.restored", at: T(3), toEventCount: 1 },
      ]),
    ).toBe(1);
  });

  it("撤销退一个操作整组：同一毫秒两条一起退", () => {
    const events = [created(), budget(120), lockShot("s-03", T(5)), lockShot("s-04", T(5))];
    const entries = buildHistory(events);
    const step = nextUndo(events, entries);

    expect(step).toMatchObject({ toEventCount: 2, eventCount: 2 });
    expect(step!.label).toContain("锁定");
    // 退回去之后就是「预算 ¥120」那一步
    expect(rebuild(events.slice(0, step!.toEventCount)).budgetCny).toBe(120);
  });

  it("撤销连着用会一直往回退，不会停在同一个地方", () => {
    const events = [created(), budget(120), lockShot()];
    let log = events;
    const first = nextUndo(log, buildHistory(log))!;
    log = [...log, { type: "project.restored", at: T(9), toEventCount: first.toEventCount }];
    const second = nextUndo(log, buildHistory(log))!;

    expect(first.toEventCount).toBe(2);
    expect(second.toEventCount).toBe(1);
    expect(second.label).toBe("项目设置：预算 ¥120");
  });

  it("只剩引导事件时没有可撤销的步骤", () => {
    const events = [created()];
    expect(nextUndo(events, buildHistory(events))).toBeUndefined();
  });

  it("坏日志不抛错：历史读成空列表，界面不会因为一条事件崩掉", () => {
    expect(buildHistory([{ type: "shot.updated", at: T(1), shotId: "x", patch: {} }])).toEqual([]);
  });
});
