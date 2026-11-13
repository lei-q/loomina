import { describe, expect, it } from "vitest";
import { rebuild, type ProjectEvent } from "@loomina/ir";
import { diffEvents, LOG_VERSION, migrateLog, parseEvents } from "./event-log";
import { sampleProject } from "./sample-project";

const AT = "2026-11-10T00:00:00+08:00";

function created(): ProjectEvent {
  return { type: "project.created", at: AT, project: sampleProject };
}

function locked(): ProjectEvent {
  return {
    type: "approval.updated",
    at: AT,
    approval: {
      id: "ap-prop-p-cup",
      targetType: "prop",
      targetId: "p-cup",
      status: "approved",
      approvedAt: AT,
      lockedAssetIds: ["a-cup"],
    },
  };
}

describe("parseEvents", () => {
  it("回放得通的日志原样接受", () => {
    const events = parseEvents(JSON.parse(JSON.stringify([created(), locked()])));
    expect(events?.map((event) => event.type)).toEqual([
      "project.created",
      "approval.updated",
    ]);
  });

  it("空日志、非数组、没引导事件都判为无效", () => {
    expect(parseEvents([])).toBeNull();
    expect(parseEvents(null)).toBeNull();
    expect(parseEvents("{}")).toBeNull();
    expect(parseEvents([locked()])).toBeNull();
  });

  it("改预算的事件认得出来，回放后预算就是日志里最后那个数", () => {
    const events = parseEvents([
      created(),
      { type: "project.updated", at: AT, budgetCny: 120 },
    ]);
    expect(events?.map((event) => event.type)).toEqual([
      "project.created",
      "project.updated",
    ]);
  });

  it("认不出的事件类型整份丢掉", () => {
    expect(parseEvents([created(), { type: "shot.deleted", at: AT }])).toBeNull();
  });

  it("台词改写认得出来（漏登记过一次，整份日志被示例项目覆盖）", () => {
    const events = parseEvents([
      created(),
      {
        type: "dialogue.updated",
        at: AT,
        lineId: "d-01",
        patch: { text: "你早就知道了。", durationMs: 2100 },
      },
    ]);
    expect(events?.map((event) => event.type)).toEqual([
      "project.created",
      "dialogue.updated",
    ]);
  });

  it("场头改写也认得出来", () => {
    const events = parseEvents([
      created(),
      { type: "scene.updated", at: AT, sceneId: "sc-1", patch: { space: "ext" } },
    ]);
    expect(events?.map((event) => event.type)).toEqual(["project.created", "scene.updated"]);
  });

  it("项目快照坏了就不硬跑", () => {
    expect(parseEvents([{ type: "project.created", at: AT, project: { title: "" } }])).toBeNull();
  });
});

describe("diffEvents", () => {
  it("同一个数组什么都不用写", () => {
    const events = [created()];
    expect(diffEvents(events, events).kind).toBe("none");
  });

  it("只在末尾多了几条就逐条追加", () => {
    const first = created();
    const second = locked();
    const sync = diffEvents([first], [first, second]);
    expect(sync).toEqual({ kind: "append", events: [second] });
  });

  it("换了内容就整份覆盖", () => {
    expect(diffEvents([created(), locked()], [created()]).kind).toBe("replace");
  });
});

describe("migrateLog", () => {
  it("当前版本：迁移后照常解析", () => {
    const events = [created()];
    expect(migrateLog({ version: LOG_VERSION, events })).toHaveLength(1);
  });

  it("没有版本号的老库按第 1 版处理", () => {
    expect(migrateLog({ version: 0, events: [created()] })).toBeNull();
  });

  it("比当前版本新的日志不乱降级", () => {
    expect(migrateLog({ version: LOG_VERSION + 1, events: [created()] })).toBeNull();
  });

  it("迁移之后仍要过 parseEvents 这一关", () => {
    expect(migrateLog({ version: 1, events: [] })).toBeNull();
    expect(migrateLog({ version: 1, events: [locked()] })).toBeNull();
  });
});

describe("阶段闸门事件（F8 / F9）", () => {
  it("gate.confirmed 与 gate.reopened 能回放，整份日志仍然有效", () => {
    const events = parseEvents([
      created(),
      { type: "gate.confirmed", at: AT, stage: "story", signature: "1a2b3c4d", note: "故事定了" },
      { type: "gate.reopened", at: AT, stage: "story" },
    ]);
    expect(events?.map((event) => event.type)).toEqual([
      "project.created",
      "gate.confirmed",
      "gate.reopened",
    ]);
  });

  it("签名不合法的事件整份丢掉", () => {
    expect(
      parseEvents([created(), { type: "gate.confirmed", at: AT, stage: "story", signature: "x" }]),
    ).toBeNull();
  });
});

describe("全局回滚事件（F2 / ADR-0109）", () => {
  it("认得 project.restored，读回来按前缀回放", () => {
    const events = parseEvents([
      created(),
      { type: "project.updated", at: AT, budgetCny: 120 },
      { type: "project.restored", at: AT, toEventCount: 1, label: "回到起点" },
    ]);
    expect(events?.map((event) => event.type)).toEqual([
      "project.created",
      "project.updated",
      "project.restored",
    ]);
    expect(rebuild(events!).budgetCny).toBe(sampleProject.budgetCny);
  });

  it("回滚目标越界的日志整份判废", () => {
    expect(
      parseEvents([
        created(),
        { type: "project.restored", at: AT, toEventCount: 7 },
      ]),
    ).toBeNull();
  });
});

describe("逐字原文日志（F6 / ADR-0154）", () => {
  it("末尾再写一条半份 project.created：default 字段补齐，rightsReport 不会拿到 undefined（ADR-0203）", () => {
    const raw = structuredClone(sampleProject) as Partial<typeof sampleProject> & {
      authorizations?: unknown;
      skills?: unknown;
    };
    delete raw.authorizations;
    delete raw.skills;
    const events = parseEvents([
      created(),
      { type: "project.updated", at: AT, budgetCny: 120 },
      { type: "project.created", at: AT, project: raw as typeof sampleProject },
    ]);
    const result = rebuild(events!);
    expect(result.authorizations).toEqual([]);
    expect(result.skills).toEqual([]);
    // 末尾的引导事件整份接管项目：前面那条 budget 改动不参与最终状态（既有口径）
    expect(result.budgetCny).toBe(sampleProject.budgetCny);
  });

  it("旧版本日志带不了 sourceDocument 时由 zod 补齐；携带时也能读回", () => {
    const source = {
      title: "全文",
      chapterIndex: 0,
      chapterCount: 1,
      text: "一段原文",
      sourceChars: 4,
      importedAt: AT,
      fingerprint: "deadbeef",
    };
    const event: ProjectEvent = {
      type: "project.created",
      at: AT,
      project: { ...sampleProject, story: { ...sampleProject.story, sourceDocument: source } },
    };
    expect(parseEvents([event])?.[0]).toMatchObject({ type: "project.created" });
    expect(migrateLog({ version: LOG_VERSION, events: [event] })).toHaveLength(1);
    expect(rebuild(parseEvents([event])!).story.sourceDocument?.text).toBe("一段原文");
  });
});
