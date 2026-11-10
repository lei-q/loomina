import { describe, expect, it } from "vitest";
import type { ProjectEvent } from "@loomina/ir";
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

  it("认不出的事件类型整份丢掉", () => {
    expect(parseEvents([created(), { type: "shot.deleted", at: AT }])).toBeNull();
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
