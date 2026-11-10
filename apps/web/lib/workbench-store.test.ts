import { rebuild } from "@loomina/ir";
import { beforeEach, describe, expect, it } from "vitest";
import { toStageView } from "./read-model";
import { useWorkbench } from "./workbench-store";

const state = () => useWorkbench.getState();
const statusOf = (takeId: string) =>
  state().project.takes.find((take) => take.id === takeId)?.status;

describe("审片台 store", () => {
  beforeEach(() => {
    state().reset();
  });

  it("开局停在第一个还没定的镜头，日志里只有引导事件", () => {
    expect(state().currentShotId).toBe("s-03");
    expect(state().events).toHaveLength(1);
    expect(state().events[0]?.type).toBe("project.created");
  });

  it("点格子只改选择，不写事件", () => {
    state().select("s-04");
    expect(state().currentShotId).toBe("s-04");
    expect(state().events).toHaveLength(1);
  });

  it("留用写一条 take.updated，并把镜头定下来", () => {
    state().select("s-03");
    state().decide("approved");

    expect(statusOf("t-03")).toBe("approved");
    expect(state().events).toHaveLength(2);
    expect(state().events[1]).toMatchObject({
      type: "take.updated",
      takeId: "t-03",
      patch: { status: "approved" },
    });

    const view = toStageView(state().project, { currentShotId: "s-03" });
    expect(view.shots[view.current]?.state).toBe("pick");
  });

  it("留用之后跳到下一格还没定的", () => {
    state().select("s-03");
    state().decide("approved");
    expect(state().currentShotId).toBe("s-04");
  });

  it("淘汰同样只动这一条 take", () => {
    state().select("s-03");
    state().decide("rejected");

    expect(statusOf("t-03")).toBe("rejected");
    expect(statusOf("t-04")).toBe("draft"); // 下一镜没被顺手改掉
    expect(state().currentShotId).toBe("s-04");
  });

  it("锁定的镜头不改，也不发事件", () => {
    state().select("s-08");
    state().decide("rejected");

    expect(statusOf("t-08")).toBe("approved");
    expect(state().events).toHaveLength(1);
    expect(state().currentShotId).toBe("s-08");
  });

  it("状态没变就不写日志", () => {
    state().select("s-02"); // t-02 已经是 approved
    state().decide("approved");
    expect(state().events).toHaveLength(1);
  });

  it("事件日志能重放出当前项目", () => {
    state().select("s-03");
    state().decide("approved");
    state().select("s-06");
    state().decide("rejected");

    expect(rebuild(state().events)).toEqual(state().project);
  });
});
