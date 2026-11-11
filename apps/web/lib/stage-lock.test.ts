import { applyEvent, type ProjectEvent } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import { sampleProject } from "./sample-project";
import { stageLockOf, stageLockViolation } from "./stage-lock";
import { stageSignature } from "./stage-flow";

const AT = "2026-11-11T10:00:00.000Z";

function confirmedStoryboard() {
  const project = sampleProject;
  const event: ProjectEvent = {
    type: "gate.confirmed",
    at: AT,
    stage: "storyboard",
    signature: stageSignature(project, "storyboard"),
    note: "",
  };
  return { before: applyEvent(project, event), event };
}

describe("阶段硬锁（F8）", () => {
  it("阶段式下改已确认阶段的内容会被拦下，并说清先回退", () => {
    const { before } = confirmedStoryboard();
    const edit: ProjectEvent = {
      type: "shot.updated",
      at: AT,
      shotId: "s-03",
      patch: { description: "换一个动作" },
    };
    const after = applyEvent(before, edit);

    const lock = stageLockViolation(before, after, [edit], "guided");
    expect(lock?.stage).toBe("storyboard");
    expect(lock?.message).toContain("回退本阶段");
  });

  it("自由工作台不锁", () => {
    const { before } = confirmedStoryboard();
    const edit: ProjectEvent = {
      type: "shot.updated",
      at: AT,
      shotId: "s-03",
      patch: { description: "换一个动作" },
    };
    const after = applyEvent(before, edit);

    expect(stageLockViolation(before, after, [edit], "free")).toBeUndefined();
    expect(stageLockOf(before, "storyboard", "free")).toBeUndefined();
  });

  it("闸门自己的事件不锁：回退 / 确认本来就该能写", () => {
    const { before } = confirmedStoryboard();
    const reopen: ProjectEvent = { type: "gate.reopened", at: AT, stage: "storyboard" };
    const after = applyEvent(before, reopen);

    expect(stageLockViolation(before, after, [reopen], "guided")).toBeUndefined();
  });

  it("全局回滚不锁：撤销是通用出口", () => {
    const { before } = confirmedStoryboard();
    const restore: ProjectEvent = { type: "project.restored", at: AT, toEventCount: 1 };

    expect(stageLockViolation(before, before, [restore], "guided")).toBeUndefined();
  });

  it("只改别的阶段不锁", () => {
    const { before } = confirmedStoryboard();
    const budget: ProjectEvent = { type: "project.updated", at: AT, budgetCny: 120 };
    const after = applyEvent(before, budget);

    expect(stageLockViolation(before, after, [budget], "guided")).toBeUndefined();
  });

  it("确认后已经改过（stale）的阶段不锁：改完重新确认即可", () => {
    const project = sampleProject;
    const stale: ProjectEvent = {
      type: "gate.confirmed",
      at: AT,
      stage: "storyboard",
      // 跟当前内容对不上的签名 = 确认之后改过
      signature: "00000000",
      note: "",
    };
    const before = applyEvent(project, stale);
    const edit: ProjectEvent = {
      type: "shot.updated",
      at: AT,
      shotId: "s-03",
      patch: { description: "再改一次" },
    };
    const after = applyEvent(before, edit);

    expect(stageLockViolation(before, after, [edit], "guided")).toBeUndefined();
    expect(stageLockOf(before, "storyboard", "guided")).toBeUndefined();
  });

  it("没有确认过的阶段不锁", () => {
    const edit: ProjectEvent = {
      type: "shot.updated",
      at: AT,
      shotId: "s-03",
      patch: { description: "随便改" },
    };
    const after = applyEvent(sampleProject, edit);

    expect(stageLockViolation(sampleProject, after, [edit], "guided")).toBeUndefined();
  });

  it("stageLockOf：确认且没改过才算锁住", () => {
    const { before } = confirmedStoryboard();
    expect(stageLockOf(before, "storyboard", "guided")?.name).toBe("分镜");
    expect(stageLockOf(before, "script", "guided")).toBeUndefined();
  });
});
