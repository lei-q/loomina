import { describe, expect, it } from "vitest";
import { clone } from "../src/clone";
import { applyEvent, rebuild, type ProjectEvent } from "../src/events";
import { ProjectSchema, type Project, type Take } from "../src/schema";
import minimalJson from "../../../examples/minimal.json";

const AT = "2026-11-09T12:00:00Z";

function load(): Project {
  return ProjectSchema.parse(clone(minimalJson));
}

function created(project: Project): ProjectEvent {
  return { type: "project.created", at: AT, project };
}

function makeTake(): Take {
  return {
    id: "take-3",
    shotId: "sh-1",
    assetId: "asset-3",
    provenance: {
      modelId: "fake-video",
      referenceAssetIds: [],
      createdAt: AT,
    },
    status: "draft",
    costCny: 1.2,
  };
}

describe("事件日志", () => {
  it("由 created 事件重建出等价项目", () => {
    const project = load();
    expect(rebuild([created(project)])).toEqual(project);
  });

  it("take.added 会同时更新 takes 与 shot.takeIds", () => {
    const project = load();
    const take = makeTake();
    const result = rebuild([
      created(project),
      { type: "take.added", at: AT, take },
    ]);

    expect(result.takes).toHaveLength(3);
    expect(result.shots[0]!.takeIds).toContain("take-3");
  });

  it("shot.updated 只改目标镜头", () => {
    const project = load();
    const result = rebuild([
      created(project),
      { type: "shot.updated", at: AT, shotId: "sh-1", patch: { locked: true } },
    ]);

    expect(result.shots[0]!.locked).toBe(true);
    expect(result.shots[1]!.locked).toBe(false);
  });

  it("没有 created 事件时拒绝增量事件", () => {
    expect(() =>
      applyEvent(null, { type: "take.added", at: AT, take: makeTake() }),
    ).toThrow();
  });
});

describe("take.updated", () => {
  const approve: ProjectEvent = {
    type: "take.updated",
    at: AT,
    takeId: "take-1",
    patch: { status: "approved" },
  };

  it("只改目标 take 的状态", () => {
    const project = load();
    const result = rebuild([created(project), approve]);
    const touched = result.takes.find((take) => take.id === "take-1");

    expect(touched?.status).toBe("approved");
    expect(result.takes.filter((take) => take.id !== "take-1")).toEqual(
      project.takes.filter((take) => take.id !== "take-1"),
    );
    expect(result.shots).toEqual(project.shots);
  });

  it("指向不存在的 take 时拒绝，不静默吞掉", () => {
    const project = load();
    expect(() =>
      rebuild([
        created(project),
        { ...approve, takeId: "take-missing" },
      ]),
    ).toThrow(/take-missing/);
  });
});

describe("approval.updated", () => {
  const lock: ProjectEvent = {
    type: "approval.updated",
    at: AT,
    approval: {
      id: "ap-character-c-lin",
      targetType: "character",
      targetId: "c-lin",
      status: "approved",
      approvedAt: AT,
      lockedAssetIds: [],
    },
  };

  it("第一次锁定追加一条闸门记录", () => {
    const project = applyEvent(load(), lock);
    expect(project.approvals).toHaveLength(1);
    expect(project.approvals[0]!.status).toBe("approved");
  });

  it("同一目标再次写入是覆盖，不是追加", () => {
    const locked = applyEvent(load(), lock);
    const unlocked = applyEvent(locked, {
      ...lock,
      approval: { ...lock.approval, status: "pending", approvedAt: undefined },
    });
    expect(unlocked.approvals).toHaveLength(1);
    expect(unlocked.approvals[0]!.status).toBe("pending");
  });
});
