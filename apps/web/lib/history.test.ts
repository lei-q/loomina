import { rebuild, type ProjectEvent } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import { buildHistory, describeEvent, historyPosition, nextUndo } from "./history";
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

  it("配音相关事件有专门的说法（C2 / C9）", () => {
    const performance = {
      rate: 1.2,
      pitch: 0,
      volume: 1,
      breathiness: 0,
      emphasis: [],
      pauses: [],
      emotion: "",
      ending: "flat" as const,
    };
    const events: ProjectEvent[] = [
      created(),
      {
        type: "asset.updated",
        at: T(1),
        asset: {
          id: "a-voice-d-01",
          kind: "audio",
          source: "generated",
          uri: "data:audio/mpeg;base64,SUQz",
          createdAt: T(1),
        },
      },
      { type: "dialogue.updated", at: T(2), lineId: "d-01", patch: { performance } },
      {
        type: "voice.take.added",
        at: T(3),
        take: {
          id: "vt-1",
          lineId: "d-01",
          assetId: "a-voice-d-01",
          performance,
          provenance: { modelId: "tts", referenceAssetIds: [], createdAt: T(3) },
          createdAt: T(3),
        },
      },
      { type: "voice.take.removed", at: T(4), takeId: "vt-1" },
    ];
    const labels = buildHistory(events).map((entry) => entry.label);
    expect(labels).toHaveLength(5);
    expect(labels[2]).toContain("表演参数");
    expect(labels[3]).toContain("加一版配音");
    expect(labels[4]).toBe("删一版配音");
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

describe("字幕版式的人话（D3）", () => {
  it("说清改了哪一项，没写的项不提", () => {
    const label = describeEvent(rebuild([created()]), {
      type: "subtitle.layout.updated",
      at: T(2),
      layout: { fontSizeCqw: 6.4, bottomPct: 22 },
    });
    expect(label).toContain("字号 6.4");
    expect(label).toContain("离底边 22%");
    expect(label).not.toContain("描边");
  });

  it("回模板时说「回模板」，不写一个空数字", () => {
    const label = describeEvent(rebuild([created()]), {
      type: "subtitle.layout.updated",
      at: T(2),
      layout: { fontSizeCqw: null, strokeCqw: null },
    });
    expect(label).toContain("字号回模板");
    expect(label).toContain("描边回模板");
  });

  it("换模板说清换成了哪一档", () => {
    const label = describeEvent(rebuild([created()]), {
      type: "subtitle.layout.updated",
      at: T(2),
      layout: { preset: "large" },
    });
    expect(label).toBe("字幕版式：模板「大字」");
  });
});

describe("历史文案：双语字幕（D5 / ADR-0173）", () => {
  it("开关说清开 / 关，语言与位置单独一条", () => {
    const at = "2026-11-13T00:00:00.000Z";
    const events: ProjectEvent[] = [
      { type: "subtitle.translation.updated", at, patch: { enabled: true, lang: "ja" } },
      { type: "subtitle.translation.updated", at, patch: { position: "above" } },
      { type: "subtitle.translation.updated", at, patch: { enabled: false } },
    ];
    expect(events.map((event) => describeEvent(sampleProject, event))).toEqual([
      "双语字幕：开（第二行 ja）",
      "双语字幕：第二行放在上面",
      "双语字幕：关",
    ]);
  });

  it("写译文 / 清译文都带上那一句的前 12 个字", () => {
    const at = "2026-11-13T00:00:00.000Z";
    const lineId = sampleProject.dialogue[0]!.id;
    const written = describeEvent(sampleProject, {
      type: "dialogue.translation.updated",
      at,
      lineId,
      translation: "You knew it.",
    });
    const cleared = describeEvent(sampleProject, {
      type: "dialogue.translation.updated",
      at,
      lineId,
      translation: null,
    });
    expect(written).toContain("写译文");
    expect(written).toContain(sampleProject.dialogue[0]!.text.slice(0, 12));
    expect(cleared).toContain("清掉译文");
  });
});
