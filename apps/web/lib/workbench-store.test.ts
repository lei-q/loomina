import { rebuild } from "@loomina/ir";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("锁定定妆写一条闸门事件，锁住四格与参考图", () => {
    state().lockCast("character", "c-lin");

    const approval = state().project.approvals[0];
    expect(approval?.status).toBe("approved");
    expect(approval?.lockedAssetIds).toEqual([
      "a-lin-front", "a-lin-34", "a-lin-side", "a-lin-back", "a-lin-expr",
    ]);
    expect(state().events.at(-1)?.type).toBe("approval.updated");
  });

  it("道具锁定的是它的参考图", () => {
    state().lockCast("prop", "p-cup");

    const approval = state().project.approvals[0];
    expect(approval?.targetType).toBe("prop");
    expect(approval?.lockedAssetIds).toEqual(["a-cup"]);
  });

  it("解锁把闸门改回待定，不留两条记录", () => {    state().lockCast("location", "loc-corridor");
    state().unlockCast("location", "loc-corridor");

    expect(state().project.approvals).toHaveLength(1);
    expect(state().project.approvals[0]?.status).toBe("pending");
    expect(state().project.approvals[0]?.lockedAssetIds).toEqual([]);
  });

  it("锁不存在或没资产的目标不写事件", () => {
    state().lockCast("character", "c-ghost");
    expect(state().project.approvals).toHaveLength(0);
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

describe("生成定妆资产（ADR-0031 / ADR-0032）", () => {
  beforeEach(() => {
    state().reset();
  });

  type Call = { kind: string; angle?: string };

  const stub = (impl: (body: Call) => Response) => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Call;
      calls.push(body);
      return impl(body);
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  };

  it("四格逐张生成，每落一张写一条 asset.updated", async () => {
    const calls = stub(
      (body) =>
        new Response(
          JSON.stringify({
            uri: `data:image/png;base64,${body.angle}`,
            model: "gemini-2.5-flash-image",
            prompt: `定妆 ${body.angle}`,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await state().generateSheet("c-lin");

    expect(calls.map((call) => call.angle)).toEqual([
      "front",
      "threeQuarter",
      "side",
      "back",
    ]);
    expect(state().events.filter((event) => event.type === "asset.updated")).toHaveLength(4);
    const asset = state().project.assets.find((item) => item.id === "a-lin-front")!;
    expect(asset.uri).toContain("front");
    expect(asset.provenance?.modelId).toBe("gemini-2.5-flash-image");
    expect(state().jobs["c-lin"]).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("锁定的定妆不重生成，一次请求都不发", async () => {
    state().lockCast("character", "c-lin");
    const calls = stub(() => new Response("{}", { status: 200 }));

    await state().generateSheet("c-lin");

    expect(calls).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("失败就停下，写一句人话，不写资产事件", async () => {
    stub(() => new Response(JSON.stringify({ error: "上游 429 配额不足" }), { status: 502 }));

    await state().generateSheet("c-lin");

    expect(state().castError).toContain("配额不足");
    expect(state().events.filter((event) => event.type === "asset.updated")).toHaveLength(0);
    expect(state().jobs["c-lin"]).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("场景主镜与道具参考图各写一条 asset.updated", async () => {
    const calls = stub(
      (body) =>
        new Response(
          JSON.stringify({
            uri: `data:image/png;base64,${body.kind}`,
            model: "gpt-image-2-c",
            prompt: body.kind,
            cny: 0.12,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await state().generateMaster("loc-corridor");
    await state().generateProp("p-cup");

    expect(calls.map((call) => call.kind)).toEqual(["master", "prop"]);
    expect(
      state().project.assets.find((item) => item.id === "a-corridor")?.uri,
    ).toContain("master");
    expect(state().project.assets.find((item) => item.id === "a-cup")?.uri).toContain(
      "prop",
    );
    expect(state().jobs["loc-corridor"]).toBeUndefined();
    expect(state().project.assets.find((item) => item.id === "a-cup")?.costCny).toBe(0.12);
    expect(state().jobs["p-cup"]).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("锁定的场景与道具不重生成", async () => {
    state().lockCast("location", "loc-corridor");
    state().lockCast("prop", "p-cup");
    const calls = stub(() => new Response("{}", { status: 200 }));

    await state().generateMaster("loc-corridor");
    await state().generateProp("p-cup");

    expect(calls).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
