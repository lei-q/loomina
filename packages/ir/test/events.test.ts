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
  // 示例项目自带三条已通过的闸门，这几条测试从"还没锁"开始。
  const unlockedProject = (): Project => ({ ...load(), approvals: [] });

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
    const project = applyEvent(unlockedProject(), lock);
    expect(project.approvals).toHaveLength(1);
    expect(project.approvals[0]!.status).toBe("approved");
  });

  it("同一目标再次写入是覆盖，不是追加", () => {
    const locked = applyEvent(unlockedProject(), lock);
    const unlocked = applyEvent(locked, {
      ...lock,
      approval: { ...lock.approval, status: "pending", approvedAt: undefined },
    });
    expect(unlocked.approvals).toHaveLength(1);
    expect(unlocked.approvals[0]!.status).toBe("pending");
  });
});

describe("asset.updated", () => {
  const generated: Extract<ProjectEvent, { type: "asset.updated" }> = {
    type: "asset.updated",
    at: AT,
    asset: {
      id: "a-lin-front",
      kind: "image",
      source: "generated",
      uri: "data:image/png;base64,AAAA",
      mime: "image/png",
      provenance: {
        modelId: "gemini-2.5-flash-image",
        prompt: "定妆三视图",
        referenceAssetIds: [],
        createdAt: AT,
      },
      createdAt: AT,
    },
  };

  it("已有的占位资产被生成结果覆盖，不新增一条", () => {
    const project = load();
    const before = project.assets.length;
    const next = applyEvent(project, generated);

    expect(next.assets).toHaveLength(before);
    const asset = next.assets.find((item) => item.id === "a-lin-front")!;
    expect(asset.uri).toBe("data:image/png;base64,AAAA");
    expect(asset.provenance?.modelId).toBe("gemini-2.5-flash-image");
  });

  it("没有的资产按 id 追加", () => {
    const next = applyEvent(load(), {
      ...generated,
      asset: { ...generated.asset, id: "a-new-panel" },
    });
    expect(next.assets.some((item) => item.id === "a-new-panel")).toBe(true);
  });
});

describe("project.updated", () => {
  it("改预算只动 budgetCny，其余字段原样保留", () => {
    const project = load();
    const next = applyEvent(project, { type: "project.updated", at: AT, budgetCny: 120 });

    expect(next.budgetCny).toBe(120);
    expect(next.shots).toEqual(project.shots);
    expect(next.title).toBe(project.title);
  });

  it("预算不是正数就拒绝，不写进日志", () => {
    expect(() =>
      applyEvent(load(), { type: "project.updated", at: AT, budgetCny: 0 }),
    ).toThrow();
  });

  it("没有 created 事件时拒绝", () => {
    expect(() =>
      applyEvent(null, { type: "project.updated", at: AT, budgetCny: 100 }),
    ).toThrow();
  });
});

describe("Project.budgetCny", () => {
  it("老快照没有这个字段时，解析成默认预算而不是失败", () => {
    const parsed = ProjectSchema.parse({ ...clone(minimalJson), budgetCny: undefined });
    expect(parsed.budgetCny).toBe(60);
  });

  it("预算必须是正数", () => {
    expect(() => ProjectSchema.parse({ ...clone(minimalJson), budgetCny: -1 })).toThrow();
  });
});

describe("dialogue.updated（ADR-0044）", () => {
  it("改写文本与时长，重放后一致", () => {
    const project = load();
    const event: ProjectEvent = {
      type: "dialogue.updated",
      at: AT,
      lineId: "dl-1",
      patch: { text: "你早就知道了。", durationMs: 1800 },
    };
    const after = applyEvent(project, event);

    expect(after.dialogue.find((line) => line.id === "dl-1")).toMatchObject({
      text: "你早就知道了。",
      durationMs: 1800,
      characterId: "c-lin",
    });
    expect(rebuild([created(project), event])).toEqual(after);
  });

  it("空台词、非正时长、指向不存在的台词都拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "dialogue.updated",
        at: AT,
        lineId: "dl-1",
        patch: { text: "   " },
      }),
    ).toThrow(/空/);
    expect(() =>
      applyEvent(project, {
        type: "dialogue.updated",
        at: AT,
        lineId: "dl-1",
        patch: { durationMs: 0 },
      }),
    ).toThrow(/大于 0/);
    expect(() =>
      applyEvent(project, {
        type: "dialogue.updated",
        at: AT,
        lineId: "dl-404",
        patch: { text: "嗯。" },
      }),
    ).toThrow(/不存在/);
  });
});
