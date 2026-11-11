import { rebuild, type ProjectEvent } from "@loomina/ir";
import { parseStoryDraft } from "@loomina/pipeline";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { setEventLog, type EventLog } from "./event-log";
import { claimWriter, releaseWriter } from "./writer-lock";
import { toScriptView, toStageView } from "./read-model";
import { resetPersistenceForTests, useWorkbench } from "./workbench-store";

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

  it("场景主镜写一条 asset.updated；道具参考图往后挂一张", async () => {
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
    // 道具不再覆盖第一张，而是往后挂（ADR-0079）
    const cup = state().project.props.find((item) => item.id === "p-cup")!;
    expect(cup.referenceImages[0]).toBe("a-cup");
    expect(cup.referenceImages).toHaveLength(2);
    const generated = state().project.assets.find(
      (item) => item.id === cup.referenceImages[1],
    )!;
    expect(generated.uri).toContain("prop");
    expect(generated.costCny).toBe(0.12);
    expect(state().jobs["loc-corridor"]).toBeUndefined();
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

describe("首帧（ADR-0037）", () => {
  beforeEach(() => {
    state().reset();
    state().setImagePrice({ model: "gpt-image-2-c", cny: 0.12 });
  });

  const stub = () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)).kind);
        return new Response(
          JSON.stringify({ uri: "data:image/png;base64,RkFLRQ==", model: "gpt-image-2-c", cny: 0.12 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    return calls;
  };

  it("落一张图并挂回镜头首帧，两条事件先后有序", async () => {
    const calls = stub();
    await state().generateKeyframe("s-03");

    expect(calls).toEqual(["keyframe"]);
    const types = state().events.map((event) => event.type);
    expect(types.slice(-2)).toEqual(["asset.updated", "shot.updated"]);

    const shot = state().project.shots.find((item) => item.id === "s-03");
    expect(shot?.keyframes.firstAssetId).toBe("a-keyframe-s-03");
    expect(state().project.assets.find((item) => item.id === "a-keyframe-s-03")?.costCny).toBe(0.12);
    expect(state().jobs["s-03"]).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("溯源记下这一镜引用的锚点，不记空的", async () => {
    stub();
    await state().generateKeyframe("s-03");

    const asset = state().project.assets.find((item) => item.id === "a-keyframe-s-03");
    expect(asset?.provenance?.referenceAssetIds.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it("锁定的镜头不生成，一次请求都不发", async () => {
    const calls = stub();
    await state().generateKeyframe("s-08");

    expect(calls).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("超预算时不发请求，说清是哪一镜", async () => {
    state().setBudget(19);
    const calls = stub();
    await state().generateKeyframe("s-03");

    expect(calls).toHaveLength(0);
    expect(state().castError).toContain("SH-03");
    expect(state().castError).toContain("超出预算");
    vi.unstubAllGlobals();
  });
});

describe("尾帧（ADR-0038）", () => {
  beforeEach(() => {
    state().reset();
    state().setImagePrice({ model: "gpt-image-2-c", cny: 0.12 });
  });

  const stub = () => {
    const frames: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        frames.push(JSON.parse(String(init?.body)).frame);
        return new Response(
          JSON.stringify({ uri: "data:image/png;base64,RkFLRQ==", model: "gpt-image-2-c", cny: 0.12 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    return frames;
  };

  it("尾帧落到 lastAssetId，首帧不被抹掉", async () => {
    const frames = stub();
    await state().generateKeyframe("s-03");
    await state().generateKeyframe("s-03", "last");

    expect(frames).toEqual(["first", "last"]);
    const shot = state().project.shots.find((item) => item.id === "s-03");
    expect(shot?.keyframes.firstAssetId).toBe("a-keyframe-s-03");
    expect(shot?.keyframes.lastAssetId).toBe("a-lastframe-s-03");
    expect(state().project.assets.find((item) => item.id === "a-lastframe-s-03")?.costCny).toBe(0.12);
    vi.unstubAllGlobals();
  });

  it("两帧进度分开记：首帧还在跑时点尾帧，首帧的进度不被盖掉", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { frame: string };
        // 尾帧立刻回来，首帧挂着——模拟一次慢请求
        if (body.frame === "first") await pending;
        return new Response(
          JSON.stringify({ uri: "data:image/png;base64,RkFLRQ==", model: "gpt-image-2-c", cny: 0.12 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const first = state().generateKeyframe("s-03");
    expect(state().jobs["s-03:first"]).toEqual({ kind: "keyframe", frame: "first" });
    await state().generateKeyframe("s-03", "last");
    expect(state().jobs["s-03:first"]).toEqual({ kind: "keyframe", frame: "first" });
    expect(state().jobs["s-03:last"]).toBeUndefined();

    release();
    await first;
    expect(state().jobs["s-03:first"]).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("视频与多 take（ADR-0083）", () => {
  beforeEach(() => {
    state().reset();
    state().setImagePrice({ model: "gpt-image-2-c", cny: 0.12 });
    state().setVideoPrice({ model: "seedance", cnyPerSecond: 0.6 });
  });

  /** 一个假网关：出图与出视频按 URL 分开回。 */
  const stub = () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        const body = String(url).endsWith("/api/video")
          ? {
              uri: "data:video/mp4;base64,QUJD",
              model: "seedance",
              prompt: "从首帧起势",
              durationMs: 3000,
              cny: 1.8,
            }
          : { uri: "data:image/png;base64,RkFLRQ==", model: "gpt-image-2-c", cny: 0.12 };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    return calls;
  };

  it("贴一条视频地址就当一拍 take：资产是 upload，不花钱", () => {
    const before = state().project.takes.length;
    const ok = state().attachVideo("s-03", "https://cdn.example.com/take.mp4");

    expect(ok).toBe(true);
    expect(state().project.takes).toHaveLength(before + 1);
    const types = state().events.map((event) => event.type);
    expect(types.slice(-2)).toEqual(["asset.updated", "take.added"]);

    const shot = state().project.shots.find((item) => item.id === "s-03")!;
    const take = state().project.takes.find((item) => item.id === shot.takeIds.at(-1))!;
    expect(take.status).toBe("draft");
    expect(take.costCny).toBe(0);
    expect(take.provenance.modelId).toBe("import");

    const asset = state().project.assets.find((item) => item.id === take.assetId)!;
    expect(asset.kind).toBe("video");
    expect(asset.source).toBe("upload");
    expect(asset.uri).toBe("https://cdn.example.com/take.mp4");

    const view = toStageView(state().project);
    expect(view.shots.find((item) => item.id === "s-03")?.hasVideo).toBe(true);
  });

  it("同一条地址不重复贴，认不出的地址不收", () => {
    state().attachVideo("s-03", "https://cdn.example.com/take.mp4");
    expect(state().attachVideo("s-03", "https://cdn.example.com/take.mp4")).toBe(false);
    expect(state().castError).toContain("已经贴过");

    expect(state().attachVideo("s-03", "ftp://nope")).toBe(false);
    expect(state().castError).toContain("http(s)://");
  });

  it("没有首帧就不出视频，一次请求都不发", async () => {
    const calls = stub();
    const ok = await state().generateVideo("s-03");

    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(state().castError).toContain("首帧");
    vi.unstubAllGlobals();
  });

  it("首帧在就出一拍：资产 video，take 追加，旧 take 不覆盖", async () => {
    const calls = stub();
    await state().generateKeyframe("s-03");
    const before = state().project.shots.find((item) => item.id === "s-03")!.takeIds.length;

    const ok = await state().generateVideo("s-03");

    expect(ok).toBe(true);
    expect(calls.filter((url) => url.endsWith("/api/video"))).toHaveLength(1);
    const shot = state().project.shots.find((item) => item.id === "s-03")!;
    expect(shot.takeIds).toHaveLength(before + 1);
    expect(state().jobs["s-03:video"]).toBeUndefined();

    const take = state().project.takes.find((item) => item.id === shot.takeIds.at(-1))!;
    expect(take.status).toBe("draft");
    expect(take.costCny).toBe(1.8);
    const asset = state().project.assets.find((item) => item.id === take.assetId)!;
    expect(asset.kind).toBe("video");
    expect(asset.uri).toBe("data:video/mp4;base64,QUJD");
    expect(asset.provenance?.referenceAssetIds).toEqual(["a-keyframe-s-03"]);

    const view = toStageView(state().project);
    const shown = view.shots.find((item) => item.id === "s-03")!;
    expect(shown.takes.at(-1)?.uri).toBe("data:video/mp4;base64,QUJD");
    expect(shown.videoUri).toBe("data:video/mp4;base64,QUJD");
    vi.unstubAllGlobals();
  });

  it("超预算的镜头不出视频，说清是哪一镜", async () => {
    const calls = stub();
    await state().generateKeyframe("s-03");
    state().setBudget(19);
    const before = calls.length;

    const ok = await state().generateVideo("s-03");

    expect(ok).toBe(false);
    expect(calls).toHaveLength(before);
    expect(state().castError).toContain("SH-03");
    expect(state().castError).toContain("预算");
    vi.unstubAllGlobals();
  });

  it("超时不自动重交：任务可能还在跑，别多花一笔（B6）", async () => {
    let videoCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/api/video")) {
          videoCalls += 1;
          return new Response(
            JSON.stringify({
              error: "等了 240 秒还没出片（running）。任务可能还在跑",
              code: "timeout",
              retryable: false,
            }),
            { status: 502, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ uri: "data:image/png;base64,RkFLRQ==", model: "gpt-image-2-c", cny: 0.12 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    await state().generateKeyframe("s-03");
    const before = state().project.shots.find((item) => item.id === "s-03")!.takeIds.length;

    const ok = await state().generateVideo("s-03");

    expect(ok).toBe(false);
    expect(videoCalls).toBe(1);
    expect(state().castError).toContain("任务可能还在跑");
    expect(state().project.shots.find((item) => item.id === "s-03")!.takeIds).toHaveLength(before);
    vi.unstubAllGlobals();
  });

  it("服务端说可重试时自动重交一次，成功后只留一拍新 take（B6）", async () => {
    let videoCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/api/video")) {
          videoCalls += 1;
          if (videoCalls === 1) {
            return new Response(
              JSON.stringify({ error: "上游忙", code: "submit", retryable: true }),
              { status: 502, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              uri: "data:video/mp4;base64,QUJD",
              model: "seedance",
              prompt: "从首帧起势",
              durationMs: 3000,
              cny: 1.8,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ uri: "data:image/png;base64,RkFLRQ==", model: "gpt-image-2-c", cny: 0.12 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    await state().generateKeyframe("s-03");
    const before = state().project.shots.find((item) => item.id === "s-03")!.takeIds.length;

    vi.useFakeTimers();
    const pending = state().generateVideo("s-03");
    await vi.runAllTimersAsync();
    const ok = await pending;
    vi.useRealTimers();

    expect(ok).toBe(true);
    expect(videoCalls).toBe(2);
    expect(state().project.shots.find((item) => item.id === "s-03")!.takeIds).toHaveLength(before + 1);
    expect(state().castError).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("可重试的错误最多试 3 次，第 3 次失败就停（B6）", async () => {
    let videoCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/api/video")) {
          videoCalls += 1;
          return new Response(
            JSON.stringify({ error: "上游忙", code: "submit", retryable: true }),
            { status: 502, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ uri: "data:image/png;base64,RkFLRQ==", model: "gpt-image-2-c", cny: 0.12 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    await state().generateKeyframe("s-03");
    const before = state().project.takes.length;

    vi.useFakeTimers();
    const pending = state().generateVideo("s-03");
    await vi.runAllTimersAsync();
    const ok = await pending;
    vi.useRealTimers();

    expect(ok).toBe(false);
    expect(videoCalls).toBe(3);
    expect(state().project.takes).toHaveLength(before);
    expect(state().castError).toContain("试了 3 次");
    expect(state().jobs["s-03:video"]).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("配置错误不重交：重试三次也不会变好（B6）", async () => {
    let videoCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/api/video")) {
          videoCalls += 1;
          return new Response(
            JSON.stringify({ error: "视频模型还没配置", code: "config", retryable: false }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ uri: "data:image/png;base64,RkFLRQ==", model: "gpt-image-2-c", cny: 0.12 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    await state().generateKeyframe("s-03");

    const ok = await state().generateVideo("s-03");

    expect(ok).toBe(false);
    expect(videoCalls).toBe(1);
    expect(state().castError).toContain("视频模型还没配置");
    vi.unstubAllGlobals();
  });

  it("锁定的镜头不出视频，也不收地址", async () => {
    const calls = stub();
    expect(await state().generateVideo("s-08")).toBe(false);
    expect(state().castError).toContain("锁定");
    expect(state().attachVideo("s-08", "https://cdn.example.com/x.mp4")).toBe(false);
    expect(calls).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

describe("一句话指令（ADR-0039）", () => {
  beforeEach(() => {
    state().reset();
  });

  it("换个角度写一条 shot.updated，机位真的变了，可回放", () => {
    const before = state().project.shots.find((item) => item.id === state().currentShotId)!;
    const ok = state().instruct("换个角度");

    expect(ok).toBe(true);
    const after = state().project.shots.find((item) => item.id === before.id)!;
    expect(after.camera.angle).not.toBe(before.camera.angle);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      shotId: before.id,
      patch: { camera: { angle: after.camera.angle } },
    });
    expect(rebuild(state().events).shots.find((item) => item.id === before.id)?.camera.angle).toBe(
      after.camera.angle,
    );
  });

  it("补充要求进 promptNotes，同一句不重复追加", () => {
    state().instruct("太暗了");
    state().instruct("太暗了");

    const shot = state().project.shots.find((item) => item.id === state().currentShotId)!;
    expect(shot.promptNotes).toHaveLength(1);
    expect(shot.promptNotes[0]).toContain("提亮");
    // 第二次没改动，不写事件，只给一句说明
    expect(state().events.filter((event) => event.type === "shot.updated")).toHaveLength(1);
    expect(state().castError).toContain("没改动");
  });

  it("划掉一条补充：写一条 shot.updated，重放后确实没了", () => {
    state().instruct("太暗了");
    const id = state().currentShotId;
    const note = state().project.shots.find((item) => item.id === id)!.promptNotes[0]!;
    state().removeNote(id, note);

    expect(state().project.shots.find((item) => item.id === id)?.promptNotes).toEqual([]);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      patch: { promptNotes: [] },
    });
    expect(rebuild(state().events).shots.find((item) => item.id === id)?.promptNotes).toEqual([]);
  });

  it("快一点改时长：写一条 shot.updated，重做报价跟着变，可回放", () => {
    const id = state().currentShotId;
    const before = state().project.shots.find((item) => item.id === id)!;
    const quoteBefore = toStageView(state().project, { currentShotId: id }).requote.totalCny;
    const ok = state().instruct("快一点");

    expect(ok).toBe(true);
    const after = state().project.shots.find((item) => item.id === id)!;
    expect(after.durationMs).toBe(before.durationMs - 500);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      patch: { durationMs: before.durationMs - 500 },
    });
    expect(rebuild(state().events).shots.find((item) => item.id === id)?.durationMs).toBe(
      before.durationMs - 500,
    );
    const quoteAfter = toStageView(state().project, { currentShotId: id }).requote.totalCny;
    expect(quoteAfter).toBeLessThan(quoteBefore!);
  });

  it("没听懂就什么都不写，并说清现在认得哪些", () => {
    const ok = state().instruct("她笑得太早了");

    expect(ok).toBe(false);
    expect(state().events).toHaveLength(1);
    expect(state().castError).toContain("没听懂");
    expect(state().castError).toContain("太暗了");
  });
});

describe("镜头锁定（ADR-0041）", () => {
  beforeEach(() => {
    state().reset();
  });

  it("没有留用过的 take 不许锁，只给一句说明", async () => {
    const id = state().currentShotId;
    state().setShotLock(id, true);

    const shot = state().project.shots.find((item) => item.id === id);
    expect(shot?.locked).toBe(false);
    expect(state().events).toHaveLength(1);
    expect(state().castError).toContain("先留用");
  });

  it("留用之后可以锁，写一条 shot.updated；解锁也留痕", () => {
    const id = state().currentShotId;
    state().decide("approved");
    state().setShotLock(id, true);

    expect(state().project.shots.find((item) => item.id === id)?.locked).toBe(true);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      patch: { locked: true },
    });

    state().setShotLock(id, false);
    expect(state().project.shots.find((item) => item.id === id)?.locked).toBe(false);
    expect(rebuild(state().events).shots.find((item) => item.id === id)?.locked).toBe(false);
  });

  it("一步留用并锁：写两条事件，锁定生效，选中照常前进", () => {
    const id = state().currentShotId;
    const before = state().events.length;
    state().approveAndLock(id);

    const shot = state().project.shots.find((item) => item.id === id)!;
    expect(shot.locked).toBe(true);
    expect(shot.takeIds.map((takeId) => state().project.takes.find((item) => item.id === takeId)?.status)).toContain("approved");
    expect(state().events.slice(before).map((event) => event.type)).toEqual([
      "take.updated",
      "shot.updated",
    ]);
    expect(state().currentShotId).not.toBe(id);
    expect(rebuild(state().events).shots.find((item) => item.id === id)?.locked).toBe(true);
  });

  it("锁定的镜头拒绝生成与一句话指令", async () => {
    const id = state().currentShotId;
    state().decide("approved");
    state().select(id); // 留用会把选中挪到下一格，这里回到原镜
    state().setShotLock(id, true);
    const before = state().events.length;

    state().instruct("太暗了");
    await state().generateKeyframe(id, "first");

    expect(state().events).toHaveLength(before);
  });
});

describe("批量补帧（ADR-0042 附记）", () => {
  beforeEach(() => {
    state().reset();
    state().setImagePrice({ model: "gpt-image-2-c", cny: 0.12 });
  });

  const okResponse = () =>
    new Response(
      JSON.stringify({ uri: "data:image/png;base64,RkFLRQ==", model: "gpt-image-2-c", cny: 0.12 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  it("按镜号补缺、跳过锁定，一镜两条事件，跑完清空进度", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls += 1; return okResponse(); }));

    await state().generateMissingFrames("first");

    const patched = state()
      .events.filter((event) => event.type === "shot.updated")
      .map((event) => event.shotId);
    // 十二镜里 s-08 锁着：批量不碰它
    expect(calls).toBe(11);
    expect(patched).toHaveLength(11);
    expect(patched).not.toContain("s-08");
    expect(state().project.shots.find((shot) => shot.id === "s-08")?.keyframes.firstAssetId).toBeUndefined();
    expect(state().batch).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("失败说明用整片镜号：第二场以后不能报场内序号", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "上游失败" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    // s-05 是第二场的第一镜，场内 index 是 0
    await state().generateKeyframe("s-05");

    expect(state().castError).toContain("SH-05");
    vi.unstubAllGlobals();
  });

  it("一张失败就停，后面的不再发请求", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 2) {
          return new Response(JSON.stringify({ error: "上游失败" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        return okResponse();
      }),
    );

    await state().generateMissingFrames("first");

    expect(calls).toBe(2);
    expect(state().castError).toContain("上游失败");
    expect(state().batch).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("预算（ADR-0035）", () => {
  beforeEach(() => {
    state().reset();
    state().setImagePrice({ model: "gpt-image-2-c", cny: 0.12 });
  });

  it("改预算写一条 project.updated，重放日志得到同一个数", () => {
    state().setBudget(120);

    expect(state().project.budgetCny).toBe(120);
    expect(state().events.at(-1)).toMatchObject({
      type: "project.updated",
      budgetCny: 120,
    });
    expect(rebuild(state().events).budgetCny).toBe(120);
  });

  it("预算没变就不写日志", () => {
    state().setBudget(60);
    expect(state().events).toHaveLength(1);
  });

  it("预算不是正数就忽略，不写进日志", () => {
    state().setBudget(0);
    state().setBudget(Number.NaN);
    expect(state().project.budgetCny).toBe(60);
    expect(state().events).toHaveLength(1);
  });

  it("超出预算就不提交：一次请求都不发，并说清差多少", async () => {
    state().setBudget(19); // 示例项目已花 ¥18.96
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls.push("fetch");
        return new Response("{}", { status: 200 });
      }),
    );

    await state().generateProp("p-cup");

    expect(calls).toHaveLength(0);
    expect(state().castError).toContain("超出预算");
    vi.unstubAllGlobals();
  });

  it("超预算选「保留现有结果」时同样不发请求，并说明沿用手上的画面（H10）", async () => {
    state().setBudget(19);
    state().setOnBudgetExceed("keep");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls.push("fetch");
        return new Response("{}", { status: 200 });
      }),
    );

    await state().generateProp("p-cup");

    expect(calls).toHaveLength(0);
    expect(state().castError).toContain("超出预算");
    expect(state().castError).toContain("保留现有结果");
    vi.unstubAllGlobals();
  });

  it("改重试上限与超预算处置都写 project.updated，重放后一致（H10）", () => {
    state().setRetryLimit(4);
    state().setOnBudgetExceed("keep");

    expect(state().project.maxAttemptsPerShot).toBe(4);
    expect(state().project.onBudgetExceed).toBe("keep");
    expect(state().events.at(-2)).toMatchObject({
      type: "project.updated",
      maxAttemptsPerShot: 4,
    });
    expect(state().events.at(-1)).toMatchObject({
      type: "project.updated",
      onBudgetExceed: "keep",
    });
    const replayed = rebuild(state().events);
    expect(replayed.maxAttemptsPerShot).toBe(4);
    expect(replayed.onBudgetExceed).toBe("keep");
  });

  it("重试上限越界或没变就不写日志", () => {
    const before = state().events.length;
    state().setRetryLimit(0);
    state().setRetryLimit(9);
    state().setRetryLimit(3);
    expect(state().events).toHaveLength(before);
  });

  it("预算还够就照常生成", async () => {
    state().setBudget(60);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)).kind);
        return new Response(
          JSON.stringify({ uri: "data:image/png;base64,QUJD", model: "gpt-image-2-c", cny: 0.12 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await state().generateProp("p-cup");

    expect(calls).toEqual(["prop"]);
    expect(state().castError).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("发布记录（G1 / ADR-0102）", () => {
  beforeEach(() => {
    state().reset();
  });

  it("记发布记录写 publish.recorded，重放后还在", () => {
    const ok = state().recordPublish({
      platform: "douyin",
      quality: "final",
      fileName: "夜班-成片.mp4",
      bytes: 1_048_576,
    });

    expect(ok).toBe(true);
    expect(state().project.publishPackages).toHaveLength(1);
    expect(state().project.publishPackages[0]).toMatchObject({
      platform: "douyin",
      quality: "final",
      fileName: "夜班-成片.mp4",
      bytes: 1_048_576,
      aiLabel: { explicit: true, implicit: true },
    });
    expect(state().events.at(-1)?.type).toBe("publish.recorded");
    expect(rebuild(state().events).publishPackages).toHaveLength(1);
  });

  it("没渲染过成片也能记：只带平台，不编文件名", () => {
    expect(state().recordPublish({ platform: "generic" })).toBe(true);
    const pack = state().project.publishPackages[0];
    expect(pack?.platform).toBe("generic");
    expect(pack?.fileName).toBeUndefined();
    expect(pack?.bytes).toBeUndefined();
    expect(pack?.quality).toBeUndefined();
  });

  it("平台为空或字节数不合法就不记", () => {
    const before = state().events.length;
    expect(state().recordPublish({ platform: "  " })).toBe(false);
    expect(state().recordPublish({ platform: "douyin", bytes: -1 })).toBe(false);
    expect(state().recordPublish({ platform: "douyin", bytes: 1.5 })).toBe(false);
    expect(state().events).toHaveLength(before);
  });
});

describe("本地事件日志（ADR-0034）", () => {
  type MemoryLog = EventLog & {
    records: ProjectEvent[];
    appends: ProjectEvent[];
    replaces: number;
  };

  function memoryLog(initial: ProjectEvent[] = []): MemoryLog {
    const log: MemoryLog = {
      records: [...initial],
      appends: [],
      replaces: 0,
      async load() {
        return { version: 1, events: [...log.records] };
      },
      async append(event) {
        log.records.push(event);
        log.appends.push(event);
      },
      async replace(events) {
        log.records.length = 0;
        log.records.push(...events);
        log.replaces += 1;
      },
    };
    return log;
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    // hydrate 会把单写者锁握到标签页关闭；测试里每个用例换一个新的"标签页"
    releaseWriter();
    resetPersistenceForTests();
    state().reset();
  });

  it("本地有日志就从日志恢复，不回到示例项目", async () => {
    const log = memoryLog([
      { type: "project.created", at: "2026-11-10T00:00:00+08:00", project: state().project },
      {
        type: "approval.updated",
        at: "2026-11-10T00:01:00+08:00",
        approval: {
          id: "ap-prop-p-cup",
          targetType: "prop",
          targetId: "p-cup",
          status: "approved",
          approvedAt: "2026-11-10T00:01:00+08:00",
          lockedAssetIds: ["a-cup"],
        },
      },
    ]);
    setEventLog(log);

    await state().hydrate();

    expect(state().events).toHaveLength(2);
    expect(state().project.approvals).toHaveLength(1);
    expect(log.replaces).toBe(0);
  });

  it("第一次打开把示例的引导事件写进去", async () => {
    const log = memoryLog();
    setEventLog(log);

    await state().hydrate();

    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.type).toBe("project.created");
  });

  it("新事件逐条追加，失败也不挡操作", async () => {
    const log = memoryLog();
    setEventLog(log);
    await state().hydrate();

    state().lockCast("prop", "p-cup");
    await tick();

    expect(log.appends).toHaveLength(1);
    expect(log.appends[0]?.type).toBe("approval.updated");
    expect(state().storageError).toBeUndefined();
  });

  it("写不进去就挂一句未保存，界面状态照常", async () => {
    const log = memoryLog();
    log.append = async () => {
      throw new Error("QuotaExceededError");
    };
    setEventLog(log);
    await state().hydrate();

    state().lockCast("prop", "p-cup");
    await tick();

    expect(state().storageError).toContain("QuotaExceededError");
    expect(state().project.approvals).toHaveLength(1);
  });
});

describe("单写者（ADR-0034）", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("另一个标签页在编辑时只读：读得到进度，不写日志", async () => {
    releaseWriter();
    resetPersistenceForTests();
    state().reset();

    const records: ProjectEvent[] = [
      { type: "project.created", at: "2026-11-10T00:00:00+08:00", project: state().project },
    ];
    const appends: ProjectEvent[] = [];
    setEventLog({
      async load() {
        return { version: 1, events: [...records] };
      },
      async append(event) {
        appends.push(event);
      },
      async replace() {
        throw new Error("只读标签页不该覆盖本地日志");
      },
    });

    // 假装另一个标签页拿着写权。放锁是异步生效的：上一轮 hydrate 的锁
    // 可能还没真正交出去，所以这里重试到拿到为止，否则测的就不是只读分支。
    let claimed = false;
    for (let i = 0; i < 20 && !claimed; i++) {
      claimed = await claimWriter();
      if (!claimed) await tick();
    }
    expect(claimed).toBe(true);

    await state().hydrate();

    expect(state().readOnly).toBe(true);
    expect(state().events).toHaveLength(1);

    state().lockCast("prop", "p-cup");
    await tick();
    expect(appends).toHaveLength(0);
    expect(state().project.approvals).toHaveLength(0);

    releaseWriter();
    resetPersistenceForTests();
  });
});

describe("台词改写（ADR-0044）", () => {
  beforeEach(() => {
    // 上一个用例可能把标签页设成了只读，这里回到可写
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("改台词写两条事件：台词与所属镜头的时长一起挪，可回放", () => {
    const before = state().project.shots.find((item) => item.id === "s-01")!;
    const ok = state().editDialogue("d-01", "你早就知道了。");

    expect(ok).toBe(true);
    expect(state().project.dialogue.find((line) => line.id === "d-01")?.text).toBe(
      "你早就知道了。",
    );
    // 7 字 → 2100ms，比原来的 2600ms 少 500，镜头跟着少 500
    const after = state().project.shots.find((item) => item.id === "s-01")!;
    expect(after.durationMs).toBe(before.durationMs - 500);

    const tail = state().events.slice(-2);
    expect(tail[0]).toMatchObject({
      type: "dialogue.updated",
      lineId: "d-01",
      patch: { text: "你早就知道了。", durationMs: 2100 },
    });
    expect(tail[1]).toMatchObject({
      type: "shot.updated",
      shotId: "s-01",
      patch: { durationMs: before.durationMs - 500 },
    });

    const replay = rebuild(state().events);
    expect(replay.dialogue.find((line) => line.id === "d-01")?.text).toBe("你早就知道了。");
    expect(replay.shots.find((item) => item.id === "s-01")?.durationMs).toBe(
      before.durationMs - 500,
    );
  });

  it("锁定的镜头不让改台词", () => {
    const snapshot = state().events.length;
    const ok = state().editDialogue("d-04", "换一句试试。"); // d-04 属于锁定的 s-08

    expect(ok).toBe(false);
    expect(state().events).toHaveLength(snapshot);
    expect(state().castError).toContain("锁定");
  });

  it("用回最初那版：文本与当时时长一起写回，镜头也挪回去", () => {
    const before = state().project.shots.find((item) => item.id === "s-01")!;
    state().editDialogue("d-01", "你早就知道了。");
    const ok = state().restoreDialogue("d-01", "你早就知道，对吧。", 2600);

    expect(ok).toBe(true);
    const line = state().project.dialogue.find((item) => item.id === "d-01")!;
    // 还原用的是那一版当时的时长，不是按字数重新估的
    expect(line).toMatchObject({ text: "你早就知道，对吧。", durationMs: 2600 });
    expect(state().project.shots.find((item) => item.id === "s-01")?.durationMs).toBe(
      before.durationMs,
    );
    expect(state().events.at(-2)).toMatchObject({
      type: "dialogue.updated",
      lineId: "d-01",
      patch: { text: "你早就知道，对吧。", durationMs: 2600 },
    });
    expect(rebuild(state().events).dialogue.find((item) => item.id === "d-01")?.text).toBe(
      "你早就知道，对吧。",
    );

    // 已经是这一版就不动
    expect(state().restoreDialogue("d-01", "你早就知道，对吧。", 2600)).toBe(false);
    expect(state().castError).toContain("已经是这一版");
  });

  it("空台词与没改动的台词都不写事件", () => {
    const before = state().project.dialogue.find((line) => line.id === "d-01")!;
    const snapshot = state().events.length;

    expect(state().editDialogue("d-01", "   ")).toBe(false);
    expect(state().castError).toContain("不能是空");
    expect(state().editDialogue("d-01", before.text)).toBe(false);
    expect(state().castError).toContain("没改");
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("台词增删（ADR-0045）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("加一句：写 dialogue.added + shot.updated，镜头变长，可回放", () => {
    const before = state().project.shots.find((item) => item.id === "s-01")!;
    const ok = state().addDialogue("s-01", "c-zhou", "又是我。");

    expect(ok).toBe(true);
    const lines = state().project.shots.find((item) => item.id === "s-01")!.dialogueIds;
    expect(lines).toHaveLength(2);
    const added = state().project.dialogue.at(-1)!;
    expect(added).toMatchObject({ characterId: "c-zhou", text: "又是我。", durationMs: 1200 });
    expect(state().project.shots.find((item) => item.id === "s-01")?.durationMs).toBe(
      before.durationMs + 1200,
    );

    const tail = state().events.slice(-2);
    expect(tail[0]).toMatchObject({ type: "dialogue.added", shotId: "s-01" });
    expect(tail[1]).toMatchObject({
      type: "shot.updated",
      shotId: "s-01",
      patch: { durationMs: before.durationMs + 1200 },
    });
    expect(rebuild(state().events).dialogue.at(-1)?.text).toBe("又是我。");
  });

  it("删一句：写 dialogue.removed + shot.updated，镜头变短，可回放", () => {
    const before = state().project.shots.find((item) => item.id === "s-04")!;
    const ok = state().removeDialogue("d-03");

    expect(ok).toBe(true);
    expect(state().project.shots.find((item) => item.id === "s-04")?.dialogueIds).toEqual([]);
    expect(state().project.shots.find((item) => item.id === "s-04")?.durationMs).toBe(
      before.durationMs - 1800,
    );
    expect(state().project.dialogue.some((line) => line.id === "d-03")).toBe(false);
    expect(state().events.at(-2)).toMatchObject({ type: "dialogue.removed", lineId: "d-03" });
    expect(rebuild(state().events).dialogue.some((line) => line.id === "d-03")).toBe(false);
  });

  it("锁定镜头加不了也删不了，空台词与陌生说话人都拒", () => {
    const snapshot = state().events.length;
    expect(state().addDialogue("s-08", "c-lin", "试试。")).toBe(false);
    expect(state().castError).toContain("锁定");
    expect(state().removeDialogue("d-04")).toBe(false);
    expect(state().addDialogue("s-01", "c-zhou", "  ")).toBe(false);
    expect(state().castError).toContain("不能是空");
    expect(state().addDialogue("s-01", "c-404", "试试。")).toBe(false);
    expect(state().castError).toContain("说话人");
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("换说话人（ADR-0046）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("写一条事件，名字变了，文本与时长不动，可回放", () => {
    const before = state().project.dialogue.find((line) => line.id === "d-01")!;
    const ok = state().changeSpeaker("d-01", "c-lin");

    expect(ok).toBe(true);
    const after = state().project.dialogue.find((line) => line.id === "d-01")!;
    expect(after.characterId).toBe("c-lin");
    expect(after.text).toBe(before.text);
    expect(after.durationMs).toBe(before.durationMs);
    expect(state().events.at(-1)).toMatchObject({
      type: "dialogue.speaker.updated",
      lineId: "d-01",
      characterId: "c-lin",
    });
    expect(rebuild(state().events).dialogue.find((line) => line.id === "d-01")?.characterId).toBe(
      "c-lin",
    );
  });

  it("锁定镜头、同一个人、陌生人都不写事件", () => {
    const snapshot = state().events.length;
    expect(state().changeSpeaker("d-04", "c-zhou")).toBe(false); // d-04 在锁定的 s-08
    expect(state().castError).toContain("锁定");
    expect(state().changeSpeaker("d-01", "c-zhou")).toBe(false); // 本来就是周
    expect(state().changeSpeaker("d-01", "c-404")).toBe(false);
    expect(state().castError).toContain("说话人");
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("台词排序（ADR-0047）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("下移一句：写一条 shot.updated 换顺序，可回放", () => {
    state().addDialogue("s-01", "c-zhou", "又是我。");
    const added = state().project.shots.find((item) => item.id === "s-01")!.dialogueIds[1]!;
    const ok = state().moveDialogue("d-01", "down");

    expect(ok).toBe(true);
    expect(state().project.shots.find((item) => item.id === "s-01")?.dialogueIds).toEqual([
      added,
      "d-01",
    ]);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      shotId: "s-01",
      patch: { dialogueIds: [added, "d-01"] },
    });
    expect(rebuild(state().events).shots.find((item) => item.id === "s-01")?.dialogueIds).toEqual([
      added,
      "d-01",
    ]);
  });

  it("到顶就停、锁定不能调，都不写事件", () => {
    const snapshot = state().events.length;
    expect(state().moveDialogue("d-01", "up")).toBe(false);
    expect(state().events).toHaveLength(snapshot);

    expect(state().moveDialogue("d-04", "down")).toBe(false); // d-04 在锁定的 s-08
    expect(state().castError).toContain("锁定");
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("动作改写（ADR-0049）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("改动作写一条 shot.updated，只动描述，时长与台词不动", () => {
    const before = state().project.shots.find((item) => item.id === "s-01")!;
    const snapshot = state().events.length;

    expect(state().editAction("s-01", "走廊尽头，灯管又闪了一下。")).toBe(true);

    const after = state().project.shots.find((item) => item.id === "s-01")!;
    expect(after.description).toBe("走廊尽头，灯管又闪了一下。");
    expect(after.durationMs).toBe(before.durationMs);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      shotId: "s-01",
      patch: { description: "走廊尽头，灯管又闪了一下。" },
    });
    expect(rebuild(state().events).shots.find((item) => item.id === "s-01")?.description).toBe(
      "走廊尽头，灯管又闪了一下。",
    );
  });

  it("锁定的镜头不让改动作", () => {
    const snapshot = state().events.length;
    expect(state().editAction("s-08", "换一个动作。")).toBe(false);
    expect(state().castError).toContain("锁定");
    expect(state().events).toHaveLength(snapshot);
  });

  it("空动作、没改动的动作、只读时都不写事件", () => {
    const before = state().project.shots.find((item) => item.id === "s-02")!;
    const snapshot = state().events.length;

    expect(state().editAction("s-02", "  ")).toBe(false);
    expect(state().castError).toContain("不能是空");
    expect(state().editAction("s-02", before.description)).toBe(false);
    expect(state().castError).toContain("没改");

    useWorkbench.setState({ readOnly: true });
    expect(state().editAction("s-02", "另一个动作。")).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("场头改写（ADR-0050）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("改场头写一条 scene.updated，只动这一场", () => {
    const snapshot = state().events.length;

    expect(state().editScene("sc-1", { space: "ext", timeOfDay: "dawn" })).toBe(true);

    const scene = state().project.scenes.find((item) => item.id === "sc-1")!;
    expect(scene).toMatchObject({ space: "ext", timeOfDay: "dawn" });
    expect(state().project.scenes.find((item) => item.id === "sc-2")).toMatchObject({
      space: "int",
      timeOfDay: "night",
    });
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "scene.updated",
      sceneId: "sc-1",
      patch: { space: "ext", timeOfDay: "dawn" },
    });
    expect(rebuild(state().events).scenes.find((item) => item.id === "sc-1")).toMatchObject({
      space: "ext",
      timeOfDay: "dawn",
    });
  });

  it("没变化、只读、陌生的场次都不写事件", () => {
    const before = state().project.scenes.find((item) => item.id === "sc-1")!;
    const snapshot = state().events.length;

    expect(state().editScene("sc-1", { space: before.space })).toBe(false);
    expect(state().castError).toContain("没改");
    expect(state().editScene("sc-404", { space: "ext" })).toBe(false);

    useWorkbench.setState({ readOnly: true });
    expect(state().editScene("sc-1", { space: "ext" })).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });

  it("改地点：一条 scene.updated，读模型与导出跟着换名字（ADR-0056）", () => {
    const target = state().project.locations.find((item) => item.id === "loc-table")!;
    expect(state().editScene("sc-1", { locationId: target.id })).toBe(true);

    expect(state().project.scenes.find((item) => item.id === "sc-1")?.locationId).toBe(
      "loc-table",
    );
    expect(state().events.at(-1)).toMatchObject({
      type: "scene.updated",
      sceneId: "sc-1",
      patch: { locationId: "loc-table" },
    });

    // 改回同一个地点不再写事件
    const snapshot = state().events.length;
    expect(state().editScene("sc-1", { locationId: "loc-table" })).toBe(false);
    expect(state().castError).toContain("没改");
    // 不存在的地点
    expect(state().editScene("sc-1", { locationId: "loc-404" })).toBe(false);
    expect(state().castError).toContain("地点");
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("显式场号（ADR-0080）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("改场号写一条 scene.updated；空串回到顺序号", () => {
    const snapshot = state().events.length;
    expect(state().editSceneCode("sc-1", "2A")).toBe(true);

    expect(state().project.scenes.find((item) => item.id === "sc-1")?.code).toBe("2A");
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "scene.updated",
      sceneId: "sc-1",
      patch: { code: "2A" },
    });
    expect(rebuild(state().events).scenes.find((item) => item.id === "sc-1")?.code).toBe("2A");

    expect(state().editSceneCode("sc-1", "  ")).toBe(true);
    expect(state().project.scenes.find((item) => item.id === "sc-1")?.code).toBe("");
  });

  it("非法、重复、没改、只读都不写事件", () => {
    expect(state().editSceneCode("sc-1", "2A场")).toBe(false);
    expect(state().castError).toContain("1–4 位");
    expect(state().editSceneCode("sc-1", "ABCDE")).toBe(false);

    expect(state().editSceneCode("sc-2", "2A")).toBe(true);
    const snapshot = state().events.length;
    expect(state().editSceneCode("sc-1", "2A")).toBe(false);
    expect(state().castError).toContain("已经有「2A」");
    expect(state().editSceneCode("sc-2", "2A")).toBe(false);
    expect(state().castError).toContain("没改");
    expect(state().editSceneCode("sc-404", "3")).toBe(false);
    expect(state().events).toHaveLength(snapshot);

    useWorkbench.setState({ readOnly: true });
    expect(state().editSceneCode("sc-1", "3")).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("这一镜里谁出场（ADR-0065）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("点一个人名：一条 shot.updated { characterIds }，锚点与提示词跟着变", () => {
    const snapshot = state().events.length;

    expect(state().toggleShotCharacter("s-01", "c-lin")).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      shotId: "s-01",
      patch: { characterIds: ["c-lin"] },
    });

    const view = toStageView(state().project);
    const shot = view.shots.find((item) => item.id === "s-01")!;
    expect(shot.characterIds).toEqual(["c-lin"]);
    expect(shot.prompts.first).toContain("林");
    expect(shot.anchors.labels.some((label) => label.includes("林"))).toBe(true);
    expect(rebuild(state().events).shots.find((item) => item.id === "s-01")?.characterIds).toEqual([
      "c-lin",
    ]);
  });

  it("再点一次就拿掉；还有台词的人拿不掉", () => {
    expect(state().toggleShotCharacter("s-04", "c-lin")).toBe(true);
    expect(
      state().project.shots.find((item) => item.id === "s-04")?.characterIds,
    ).toEqual(["c-zhou"]);

    const snapshot = state().events.length;
    expect(state().toggleShotCharacter("s-04", "c-zhou")).toBe(false);
    expect(state().castError).toContain("台词");
    expect(state().events).toHaveLength(snapshot);
  });

  it("锁定的镜头、陌生镜头 / 人物、只读都不写事件", () => {
    const snapshot = state().events.length;

    expect(state().toggleShotCharacter("s-08", "c-zhou")).toBe(false);
    expect(state().castError).toContain("锁定");
    expect(state().toggleShotCharacter("s-404", "c-lin")).toBe(false);
    expect(state().castError).toContain("找不到");
    expect(state().toggleShotCharacter("s-01", "c-404")).toBe(false);
    expect(state().castError).toContain("找不到");

    useWorkbench.setState({ readOnly: true });
    expect(state().toggleShotCharacter("s-01", "c-lin")).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("这一镜里有哪些道具（ADR-0066）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("点一件道具：一条 shot.updated { propIds }，提示词与锚点跟着变", () => {
    const snapshot = state().events.length;

    expect(state().toggleShotProp("s-09", "p-lamp")).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      shotId: "s-09",
      patch: { propIds: ["p-cup", "p-lamp"] },
    });

    const view = toStageView(state().project);
    const shot = view.shots.find((item) => item.id === "s-09")!;
    expect(shot.propIds).toEqual(["p-cup", "p-lamp"]);
    expect(shot.prompts.first).toContain("台灯");
    expect(shot.anchors.labels.some((label) => label.includes("台灯"))).toBe(true);
    expect(rebuild(state().events).shots.find((item) => item.id === "s-09")?.propIds).toEqual([
      "p-cup",
      "p-lamp",
    ]);
  });

  it("再点一次就拿掉；最后一个道具也拿得掉（与人物不同，不受台词约束）", () => {
    expect(state().toggleShotProp("s-05", "p-lamp")).toBe(true);
    expect(state().project.shots.find((item) => item.id === "s-05")?.propIds).toEqual([]);

    expect(state().toggleShotProp("s-09", "p-cup")).toBe(true);
    expect(state().project.shots.find((item) => item.id === "s-09")?.propIds).toEqual([]);
    expect(state().castError).toBeUndefined();
  });

  it("锁定的镜头、陌生镜头 / 道具、只读都不写事件", () => {
    const snapshot = state().events.length;

    expect(state().toggleShotProp("s-08", "p-cup")).toBe(false);
    expect(state().castError).toContain("锁定");
    expect(state().toggleShotProp("s-404", "p-cup")).toBe(false);
    expect(state().castError).toContain("找不到");
    expect(state().toggleShotProp("s-05", "p-404")).toBe(false);
    expect(state().castError).toContain("找不到");

    useWorkbench.setState({ readOnly: true });
    expect(state().toggleShotProp("s-05", "p-cup")).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("新建场次与镜头（ADR-0064）", () => {  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("加一场：一条 scene.added，加在末尾，新场没有镜头", () => {
    const snapshot = state().events.length;

    const id = state().addScene();
    expect(id).toBeTruthy();
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "scene.added",
      scene: {
        id,
        index: 5,
        locationId: "loc-table",
        space: "int",
        timeOfDay: "night",
        shotIds: [],
      },
    });

    const view = toScriptView(state().project);
    expect(view.scenes).toHaveLength(6);
    expect(view.scenes.at(-1)).toMatchObject({ id, no: 6, shots: [] });
    expect(view.shotCount).toBe(12);
    expect(rebuild(state().events).scenes.at(-1)?.index).toBe(5);
  });

  it("加一镜：一条 shot.added，挂在那一场末尾，镜号接着排", () => {
    const sceneId = state().addScene()!;
    const snapshot = state().events.length;

    const shotId = state().addShot(sceneId);
    expect(shotId).toBeTruthy();
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.added",
      shot: { id: shotId, sceneId, index: 0, durationMs: 3000, shotSize: "medium" },
    });

    const view = toScriptView(state().project);
    expect(view.shotCount).toBe(13);
    expect(view.scenes.at(-1)?.shots[0]).toMatchObject({
      id: shotId,
      no: 13,
      action: "",
      dur: 3,
      locked: false,
    });
    expect(state().project.scenes.find((scene) => scene.id === sceneId)?.shotIds).toEqual([
      shotId,
    ]);
  });

  it("陌生场次、只读都不写事件", () => {
    const snapshot = state().events.length;

    expect(state().addShot("sc-404")).toBeUndefined();
    expect(state().castError).toContain("找不到");

    useWorkbench.setState({ readOnly: true });
    expect(state().addScene()).toBeUndefined();
    expect(state().addShot("sc-1")).toBeUndefined();
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("中间插入场次与镜头（ADR-0068）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("在指定场后面插一场：index 落在下一格，场号重排", () => {
    const snapshot = state().events.length;

    const id = state().addScene(undefined, "sc-1");
    expect(id).toBeTruthy();
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "scene.added",
      scene: { id, index: 1, locationId: "loc-corridor", shotIds: [] },
    });

    const view = toScriptView(state().project);
    expect(view.scenes.map((scene) => scene.id)).toEqual([
      "sc-1",
      id,
      "sc-2",
      "sc-3",
      "sc-4",
      "sc-5",
    ]);
    expect(view.scenes.map((scene) => scene.no)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rebuild(state().events).scenes.map((scene) => scene.id)).toEqual(
      view.scenes.map((scene) => scene.id),
    );
  });

  it("在指定镜后面插一镜：后面几镜的镜号顺次后移", () => {
    const snapshot = state().events.length;

    const id = state().addShot("sc-1", "s-01");
    expect(id).toBeTruthy();
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.added",
      shot: { id, sceneId: "sc-1", index: 1, durationMs: 3000 },
    });

    expect(state().project.scenes.find((scene) => scene.id === "sc-1")?.shotIds).toEqual([
      "s-01",
      id,
      "s-02",
      "s-03",
    ]);
    expect(state().project.shots.find((shot) => shot.id === "s-02")?.index).toBe(2);
    const view = toScriptView(state().project);
    expect(view.shotCount).toBe(13);
    expect(view.scenes[0]?.shots.map((shot) => shot.no)).toEqual([1, 2, 3, 4]);
    expect(view.scenes[0]?.shots[1]?.id).toBe(id);
  });

  it("指定位置不存在就不写事件", () => {
    const snapshot = state().events.length;

    expect(state().addScene(undefined, "sc-404")).toBeUndefined();
    expect(state().castError).toContain("找不到");
    expect(state().addShot("sc-1", "s-404")).toBeUndefined();
    expect(state().castError).toContain("找不到");
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("新场沿用前一场的地点与日夜（ADR-0069）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("接在末尾：沿用最后一场的地点、内外景与日夜", () => {
    const id = state().addScene()!;
    const scene = state().project.scenes.find((item) => item.id === id);

    // 示例最后一场是 sc-5：桌边 · 内 · 夜
    expect(scene).toMatchObject({ locationId: "loc-table", space: "int", timeOfDay: "night" });
  });

  it("插在某场后面：沿用那一场，而不是第一个地点", () => {
    const id = state().addScene(undefined, "sc-1")!;
    const scene = state().project.scenes.find((item) => item.id === id);

    // sc-1 是走廊 · 内 · 夜
    expect(scene).toMatchObject({ locationId: "loc-corridor", space: "int", timeOfDay: "night" });
  });

  it("显式指定地点时地点跟着指定值，日夜仍沿用前一场", () => {
    const id = state().addScene("loc-door", "sc-1")!;
    const scene = state().project.scenes.find((item) => item.id === id);

    expect(scene).toMatchObject({ locationId: "loc-door", space: "int", timeOfDay: "night" });
  });
});

describe("人物库：新建与改名（ADR-0071）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("新建人物：一条 character.added，名字与外形去掉首尾空白", () => {
    const snapshot = state().events.length;

    const id = state().addCharacter(" 阿棠 ", " 齐耳短发，灰毛衣 ");
    expect(id).toBeTruthy();

    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "character.added" });
    const character = state().project.characters.find((item) => item.id === id);
    expect(character).toMatchObject({
      name: "阿棠",
      appearance: "齐耳短发，灰毛衣",
      sheet: {},
      referenceImages: [],
      mustNotChange: [],
    });
    expect(rebuild(state().events)).toEqual(state().project);

    // 新建的人立刻能出现在剧本页的换人下拉里
    const view = toScriptView(state().project);
    expect(view.characters.map((item) => item.name)).toContain("阿棠");
  });

  it("重名、空名字、超长外形都拒绝，不写事件", () => {
    const snapshot = state().events.length;

    expect(state().addCharacter("林")).toBeUndefined();
    expect(state().castError).toContain("已经有一个叫「林」的人物");

    expect(state().addCharacter("   ")).toBeUndefined();
    expect(state().castError).toContain("总得有个名字");

    expect(state().addCharacter("阿棠", "长".repeat(201))).toBeUndefined();
    expect(state().castError).toContain("外形描述太长");

    useWorkbench.setState({ readOnly: true });
    expect(state().addCharacter("阿棠")).toBeUndefined();

    expect(state().events).toHaveLength(snapshot);
  });

  it("改名与外形描述：一条 character.updated，读模型跟着变", () => {
    const snapshot = state().events.length;

    expect(state().editCharacter("c-lin", { name: "小林", appearance: "短发，深色风衣" })).toBe(true);

    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "character.updated",
      characterId: "c-lin",
      patch: { name: "小林", appearance: "短发，深色风衣" },
    });
    const character = state().project.characters.find((item) => item.id === "c-lin");
    expect(character).toMatchObject({ name: "小林", appearance: "短发，深色风衣" });

    // 改成和另一个人重名要拒绝；没改也要拒绝
    expect(state().editCharacter("c-lin", { name: "周" })).toBe(false);
    expect(state().castError).toContain("已经有一个叫「周」的人物");
    expect(state().editCharacter("c-lin", { name: "小林" })).toBe(false);
    expect(state().castError).toContain("人物没改");
  });
});

describe("道具库：新建与改名（ADR-0072）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("新建道具：一条 prop.added，名字与描述去掉首尾空白", () => {
    const snapshot = state().events.length;

    const id = state().addProp(" 旧钥匙 ", " 黄铜钥匙，齿口磨圆 ");
    expect(id).toBeTruthy();

    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "prop.added" });
    const prop = state().project.props.find((item) => item.id === id);
    expect(prop).toMatchObject({
      name: "旧钥匙",
      description: "黄铜钥匙，齿口磨圆",
      referenceImages: [],
    });
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("重名、空名字、超长描述都拒绝，不写事件", () => {
    const snapshot = state().events.length;

    expect(state().addProp("搪瓷杯")).toBeUndefined();
    expect(state().castError).toContain("已经有一件叫「搪瓷杯」的道具");

    expect(state().addProp("  ")).toBeUndefined();
    expect(state().castError).toContain("总得有个名字");

    expect(state().addProp("旧钥匙", "长".repeat(201))).toBeUndefined();
    expect(state().castError).toContain("道具描述太长");

    useWorkbench.setState({ readOnly: true });
    expect(state().addProp("旧钥匙")).toBeUndefined();

    expect(state().events).toHaveLength(snapshot);
  });

  it("改道具：一条 prop.updated，重名与没改都拒绝", () => {
    const snapshot = state().events.length;

    expect(state().editProp("p-cup", { name: "旧搪瓷缸", description: "白底蓝边，磕掉一块瓷" })).toBe(true);

    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "prop.updated",
      propId: "p-cup",
      patch: { name: "旧搪瓷缸", description: "白底蓝边，磕掉一块瓷" },
    });
    expect(state().project.props.find((item) => item.id === "p-cup")).toMatchObject({
      name: "旧搪瓷缸",
      description: "白底蓝边，磕掉一块瓷",
    });

    expect(state().editProp("p-cup", { name: "台灯" })).toBe(false);
    expect(state().castError).toContain("已经有一件叫「台灯」的道具");
    expect(state().editProp("p-cup", { name: "旧搪瓷缸" })).toBe(false);
    expect(state().castError).toContain("道具没改");
  });
});

describe("删除人物与道具（ADR-0073）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("删掉没被引用的人物：一条 character.removed", () => {
    const id = state().addCharacter("阿棠", "齐耳短发")!;
    const snapshot = state().events.length;

    expect(state().removeCharacter(id)).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "character.removed", characterId: id });
    expect(state().project.characters.some((item) => item.id === id)).toBe(false);
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("还在出场里的人物删不掉：提示先去分镜页点掉", () => {
    const snapshot = state().events.length;

    expect(state().removeCharacter("c-lin")).toBe(false);
    expect(state().castError).toContain("出场里");
    expect(state().removeCharacter("c-nobody")).toBe(false);
    expect(state().castError).toContain("找不到这个人物");

    useWorkbench.setState({ readOnly: true });
    expect(state().removeCharacter("c-zhou")).toBe(false);

    expect(state().events).toHaveLength(snapshot);
  });

  it("删掉没被镜头用着的道具；被用着时提示先点掉", () => {
    const id = state().addProp("旧钥匙")!;
    const snapshot = state().events.length;
    expect(state().removeProp(id)).toBe(true);
    expect(state().events.at(-1)).toMatchObject({ type: "prop.removed", propId: id });

    // p-cup 在 s-09 的道具里
    expect(state().removeProp("p-cup")).toBe(false);
    expect(state().castError).toContain("还在 1 镜里");
    expect(state().events).toHaveLength(snapshot + 1); // 只有那条 prop.removed，拒绝不写事件
  });
});

describe("这一镜里换人（ADR-0070）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("换人同时改出场与这一镜里他的话", () => {
    // s-03：林出场，台词 d-02 是林说的
    const snapshot = state().events.length;

    expect(state().swapShotCharacter("s-03", "c-lin", "c-zhou")).toBe(true);

    expect(state().events).toHaveLength(snapshot + 2);
    expect(state().events.at(-2)).toMatchObject({
      type: "shot.updated",
      shotId: "s-03",
      patch: { characterIds: ["c-zhou"] },
    });
    expect(state().events.at(-1)).toMatchObject({
      type: "dialogue.speaker.updated",
      lineId: "d-02",
      characterId: "c-zhou",
    });
    expect(state().project.shots.find((shot) => shot.id === "s-03")?.characterIds).toEqual(["c-zhou"]);
    expect(state().project.dialogue.find((line) => line.id === "d-02")?.characterId).toBe("c-zhou");
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("换上的人本来就在这一镜里：并到原来那一位，不写重复", () => {
    // s-04：林、周都在场，d-03 是周说的
    expect(state().swapShotCharacter("s-04", "c-zhou", "c-lin")).toBe(true);

    expect(state().project.shots.find((shot) => shot.id === "s-04")?.characterIds).toEqual(["c-lin"]);
    expect(state().project.dialogue.find((line) => line.id === "d-03")?.characterId).toBe("c-lin");
  });

  it("锁定的镜头、不在场的人、陌生目标都不写事件", () => {
    const snapshot = state().events.length;

    expect(state().swapShotCharacter("s-08", "c-lin", "c-zhou")).toBe(false);
    expect(state().castError).toContain("已锁定");

    expect(state().swapShotCharacter("s-01", "c-lin", "c-zhou")).toBe(false);
    expect(state().castError).toContain("不在这一镜的出场里");

    expect(state().swapShotCharacter("s-03", "c-lin", "c-nobody")).toBe(false);
    expect(state().castError).toContain("找不到要换上的人");

    useWorkbench.setState({ readOnly: true });
    expect(state().swapShotCharacter("s-03", "c-lin", "c-zhou")).toBe(false);

    expect(state().events).toHaveLength(snapshot);
  });
});

describe("换人撤销（ADR-0081）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("撤销：出场顺序与这一镜的说话人一起写回", () => {
    expect(state().swapShotCharacter("s-03", "c-lin", "c-zhou")).toBe(true);
    expect(state().lastSwap).toMatchObject({
      shotId: "s-03",
      fromId: "c-lin",
      toId: "c-zhou",
      lineIds: ["d-02"],
    });
    const snapshot = state().events.length;

    expect(state().undoSwap()).toBe(true);

    expect(state().events).toHaveLength(snapshot + 2);
    expect(state().events.at(-2)).toMatchObject({
      type: "shot.updated",
      shotId: "s-03",
      patch: { characterIds: ["c-lin"] },
    });
    expect(state().events.at(-1)).toMatchObject({
      type: "dialogue.speaker.updated",
      lineId: "d-02",
      characterId: "c-lin",
    });
    expect(state().project.shots.find((shot) => shot.id === "s-03")?.characterIds).toEqual(["c-lin"]);
    expect(state().project.dialogue.find((line) => line.id === "d-02")?.characterId).toBe("c-lin");
    expect(state().lastSwap).toBeUndefined();
    expect(rebuild(state().events)).toEqual(state().project);

    // 撤过就没有可撤的了
    expect(state().undoSwap()).toBe(false);
    expect(state().castError).toContain("没有刚做完的换人");
  });

  it("出场顺序整组回原位：两个人对调再撤", () => {
    // s-04 是「林、周」；把周换成林会并成一位
    expect(state().swapShotCharacter("s-04", "c-zhou", "c-lin")).toBe(true);
    expect(state().project.shots.find((shot) => shot.id === "s-04")?.characterIds).toEqual(["c-lin"]);

    expect(state().undoSwap()).toBe(true);
    expect(state().project.shots.find((shot) => shot.id === "s-04")?.characterIds).toEqual([
      "c-lin",
      "c-zhou",
    ]);
    expect(state().project.dialogue.find((line) => line.id === "d-03")?.characterId).toBe("c-zhou");
  });

  it("只留最近一次；锁定、只读、手改过的说话人都不乱撤", () => {
    expect(state().swapShotCharacter("s-03", "c-lin", "c-zhou")).toBe(true);
    expect(state().swapShotCharacter("s-03", "c-zhou", "c-lin")).toBe(true);
    expect(state().lastSwap?.toId).toBe("c-lin");

    // 撤销一次换回来：撤的是「周 → 林」，出场回到周
    expect(state().undoSwap()).toBe(true);
    expect(state().project.shots.find((shot) => shot.id === "s-03")?.characterIds).toEqual([
      "c-zhou",
    ]);
    expect(state().project.dialogue.find((line) => line.id === "d-02")?.characterId).toBe("c-zhou");

    // 换完之后锁上：撤不了；解锁再撤可以
    expect(state().swapShotCharacter("s-03", "c-zhou", "c-lin")).toBe(true);
    state().approveAndLock("s-03");
    expect(state().undoSwap()).toBe(false);
    expect(state().castError).toContain("已锁定");
    state().setShotLock("s-03", false);
    expect(state().undoSwap()).toBe(true);

    // 换完之后这一句又被改成别人说的：撤销只回出场，句子保持后来改的
    expect(state().swapShotCharacter("s-03", "c-zhou", "c-lin")).toBe(true);
    expect(state().changeSpeaker("d-02", "c-zhou")).toBe(true);
    expect(state().undoSwap()).toBe(true);
    expect(state().project.shots.find((shot) => shot.id === "s-03")?.characterIds).toEqual([
      "c-zhou",
    ]);
    expect(state().project.dialogue.find((line) => line.id === "d-02")?.characterId).toBe("c-zhou");

    useWorkbench.setState({ readOnly: true });
    expect(state().undoSwap()).toBe(false);
  });
});

describe("删一场、删一镜（ADR-0067）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("删一镜：台词、take、时间线项一起走，后面的镜号往前补", () => {
    const snapshot = state().events.length;

    expect(state().removeShot("s-01")).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "shot.removed", shotId: "s-01" });

    const project = state().project;
    expect(project.shots.some((shot) => shot.id === "s-01")).toBe(false);
    expect(project.dialogue.some((line) => line.id === "d-01")).toBe(false);
    expect(project.takes.some((take) => take.id === "t-01")).toBe(false);
    expect(project.timeline.items.map((item) => item.id)).toEqual(["tl-02"]);
    expect(project.scenes.find((scene) => scene.id === "sc-1")?.shotIds).toEqual(["s-02", "s-03"]);
    expect(project.shots.find((shot) => shot.id === "s-02")?.index).toBe(0);

    const view = toScriptView(state().project);
    expect(view.shotCount).toBe(11);
    expect(view.scenes[0]?.shots.map((shot) => shot.no)).toEqual([1, 2]);
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("删一场：先逐镜删、再删场，场号重排", () => {
    const snapshot = state().events.length;

    expect(state().removeScene("sc-3")).toBe(true);
    expect(state().events).toHaveLength(snapshot + 2);
    expect(state().events.at(-2)).toMatchObject({ type: "shot.removed", shotId: "s-06" });
    expect(state().events.at(-1)).toMatchObject({ type: "scene.removed", sceneId: "sc-3" });

    const view = toScriptView(state().project);
    expect(view.scenes).toHaveLength(4);
    expect(view.scenes.map((scene) => scene.no)).toEqual([1, 2, 3, 4]);
    expect(view.shotCount).toBe(11);
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("锁定的镜头 / 场次、陌生场次 / 镜头、只读都不写事件", () => {
    const snapshot = state().events.length;

    expect(state().removeShot("s-08")).toBe(false);
    expect(state().castError).toContain("锁定");
    expect(state().removeScene("sc-4")).toBe(false);
    expect(state().castError).toContain("锁定");
    expect(state().removeShot("s-404")).toBe(false);
    expect(state().castError).toContain("找不到");
    expect(state().removeScene("sc-404")).toBe(false);
    expect(state().castError).toContain("找不到");

    useWorkbench.setState({ readOnly: true });
    expect(state().removeShot("s-01")).toBe(false);
    expect(state().removeScene("sc-3")).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("调整场序（ADR-0060）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("上移一场：一条 scene.moved，场号与镜号跟着重排", () => {
    const snapshot = state().events.length;

    expect(state().moveScene("sc-2", "up")).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "scene.moved",
      sceneId: "sc-2",
      toIndex: 0,
    });

    const view = toScriptView(state().project);
    expect(view.scenes.map((scene) => scene.id)).toEqual([
      "sc-2", "sc-1", "sc-3", "sc-4", "sc-5",
    ]);
    expect(view.scenes.map((scene) => scene.no)).toEqual([1, 2, 3, 4, 5]);
    // 镜号按新的场序重排：第 2 场的两镜变成 SH-01 / SH-02
    expect(
      view.scenes.flatMap((scene) => scene.shots.map((shot) => [shot.id, shot.no])).slice(0, 3),
    ).toEqual([
      ["s-04", 1],
      ["s-05", 2],
      ["s-01", 3],
    ]);
    // 场里的台词不属于场序，不跟着动
    expect(view.scenes[0]?.shots.find((shot) => shot.id === "s-04")?.lines[0]?.text).toBe(
      "灯是我关的。",
    );
    expect(rebuild(state().events).scenes.find((scene) => scene.id === "sc-2")?.index).toBe(0);
  });

  it("直接挪到第 N 位：一条 scene.moved，长距离一步到位（ADR-0060 附记）", () => {
    const snapshot = state().events.length;

    expect(state().moveSceneTo("sc-1", 3)).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "scene.moved",
      sceneId: "sc-1",
      toIndex: 3,
    });
    expect(toScriptView(state().project).scenes.map((scene) => scene.id)).toEqual([
      "sc-2", "sc-3", "sc-4", "sc-1", "sc-5",
    ]);
  });

  it("挪到原地或越界都不写事件", () => {
    const snapshot = state().events.length;

    expect(state().moveSceneTo("sc-1", 0)).toBe(false);
    expect(state().castError).toContain("已经在这个位置");
    expect(state().moveSceneTo("sc-1", 9)).toBe(false);
    expect(state().castError).toContain("没有这个位置");
    expect(state().events).toHaveLength(snapshot);
  });

  it("第一场不能再上移、最后一场不能再下移、陌生场次与只读都不写事件", () => {    const snapshot = state().events.length;

    expect(state().moveScene("sc-1", "up")).toBe(false);
    expect(state().castError).toContain("第一场");
    expect(state().moveScene("sc-5", "down")).toBe(false);
    expect(state().castError).toContain("最后一场");
    expect(state().moveScene("sc-404", "up")).toBe(false);
    expect(state().castError).toContain("找不到");

    useWorkbench.setState({ readOnly: true });
    expect(state().moveScene("sc-1", "down")).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("新建 / 编辑地点（ADR-0059）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("新建一个地点：一条 location.added，可回放，定妆页能看到", () => {
    const snapshot = state().events.length;

    const id = state().addLocation("  阳台 ", "corridor");
    expect(id).toBeTruthy();
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "location.added",
      location: { id, name: "阳台", templateId: "corridor" },
    });

    const added = state().project.locations.find((item) => item.id === id);
    expect(added).toMatchObject({ name: "阳台", templateId: "corridor", referenceImages: [] });
    expect(rebuild(state().events).locations.find((item) => item.id === id)?.name).toBe("阳台");
  });

  it("空名字、重名、只读都不写事件", () => {
    const snapshot = state().events.length;

    expect(state().addLocation("   ")).toBeUndefined();
    expect(state().castError).toContain("名字");
    expect(state().addLocation("走廊")).toBeUndefined();
    expect(state().castError).toContain("走廊");

    useWorkbench.setState({ readOnly: true });
    expect(state().addLocation("阳台")).toBeUndefined();
    expect(state().events).toHaveLength(snapshot);
  });

  it("改名与换模板：一条 location.updated，只动这个地点", () => {
    const snapshot = state().events.length;

    expect(state().editLocation("loc-table", { name: "餐桌边", templateId: "corridor" })).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "location.updated",
      locationId: "loc-table",
      patch: { name: "餐桌边", templateId: "corridor" },
    });

    expect(state().project.locations.find((item) => item.id === "loc-table")).toMatchObject({
      name: "餐桌边",
      templateId: "corridor",
    });
    expect(state().project.locations.find((item) => item.id === "loc-corridor")?.name).toBe("走廊");
    expect(rebuild(state().events).locations.find((item) => item.id === "loc-table")?.name).toBe(
      "餐桌边",
    );
  });

  it("没变化、重名、陌生地点、只读都不写事件", () => {
    const snapshot = state().events.length;

    expect(state().editLocation("loc-table", { name: "桌边" })).toBe(false);
    expect(state().castError).toContain("没改");
    expect(state().editLocation("loc-table", { name: "走廊" })).toBe(false);
    expect(state().castError).toContain("走廊");
    expect(state().editLocation("loc-404", { name: "门厅" })).toBe(false);
    expect(state().castError).toContain("找不到");
    expect(state().editLocation("loc-table", { name: "  " })).toBe(false);
    expect(state().castError).toContain("名字");

    useWorkbench.setState({ readOnly: true });
    expect(state().editLocation("loc-table", { name: "餐桌边" })).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });

  it("写场景描述：一条 location.updated { description }，能回放（ADR-0063）", () => {
    const snapshot = state().events.length;

    expect(state().editLocation("loc-table", { description: " 餐桌靠窗，吊灯昏黄 " })).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "location.updated",
      locationId: "loc-table",
      patch: { description: "餐桌靠窗，吊灯昏黄" },
    });
    expect(state().project.locations.find((item) => item.id === "loc-table")?.description).toBe(
      "餐桌靠窗，吊灯昏黄",
    );
    expect(rebuild(state().events).locations.find((item) => item.id === "loc-table")?.description).toBe(
      "餐桌靠窗，吊灯昏黄",
    );
  });

  it("场景描述超过 200 字不写事件；新建时也可以带描述", () => {
    const snapshot = state().events.length;

    expect(state().editLocation("loc-table", { description: "长".repeat(201) })).toBe(false);
    expect(state().castError).toContain("200");
    expect(state().addLocation("楼梯间", "corridor", "长".repeat(201))).toBeUndefined();
    expect(state().castError).toContain("200");
    expect(state().events).toHaveLength(snapshot);

    const id = state().addLocation("楼梯间", "corridor", " 水泥台阶，声控灯 ");
    expect(state().project.locations.find((item) => item.id === id)?.description).toBe(
      "水泥台阶，声控灯",
    );
  });

  it("删一个没被场次占用的地点：一条 location.removed，可回放", () => {
    const id = state().addLocation("阳台", "corridor")!;
    const snapshot = state().events.length;

    expect(state().removeLocation(id)).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "location.removed", locationId: id });
    expect(state().project.locations.some((item) => item.id === id)).toBe(false);
    expect(rebuild(state().events).locations.some((item) => item.id === id)).toBe(false);
  });

  it("还有场次的地点不删；陌生地点、只读都不写事件", () => {
    const snapshot = state().events.length;

    // 示例里 loc-corridor 被 sc-1 与 sc-3 用了
    expect(state().removeLocation("loc-corridor")).toBe(false);
    expect(state().castError).toContain("还有 2 场");
    expect(state().removeLocation("loc-404")).toBe(false);
    expect(state().castError).toContain("找不到");

    useWorkbench.setState({ readOnly: true });
    expect(state().removeLocation("loc-door")).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });

  it("把占用它的场次搬到别的地点再删：N 条 scene.updated + 1 条 location.removed（ADR-0062）", () => {
    const snapshot = state().events.length;

    // loc-door 只被 sc-4 用；搬到 loc-table
    expect(state().removeLocation("loc-door", "loc-table")).toBe(true);
    expect(state().events).toHaveLength(snapshot + 2);
    expect(state().events.at(-2)).toMatchObject({
      type: "scene.updated",
      sceneId: "sc-4",
      patch: { locationId: "loc-table" },
    });
    expect(state().events.at(-1)).toMatchObject({ type: "location.removed", locationId: "loc-door" });

    expect(state().project.scenes.find((scene) => scene.id === "sc-4")?.locationId).toBe(
      "loc-table",
    );
    expect(state().project.locations.some((item) => item.id === "loc-door")).toBe(false);
    expect(rebuild(state().events).scenes.find((scene) => scene.id === "sc-4")?.locationId).toBe(
      "loc-table",
    );
  });

  it("搬到自己或不存在的地点都拒绝，不写事件", () => {
    const snapshot = state().events.length;

    expect(state().removeLocation("loc-door", "loc-door")).toBe(false);
    expect(state().castError).toContain("搬不到");
    expect(state().removeLocation("loc-door", "loc-404")).toBe(false);
    expect(state().castError).toContain("搬不到");
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("台词顺序整组写回（ADR-0053）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("把顺序写回去：一条 shot.updated，可回放", () => {
    const before = state().project.shots.find((item) => item.id === "s-02")!;
    expect(before.dialogueIds).toHaveLength(0);

    expect(state().addDialogue("s-02", "c-lin", "谁在那儿？")).toBe(true);
    expect(state().addDialogue("s-02", "c-lin", "门开着呢。")).toBe(true);
    const shot = state().project.shots.find((item) => item.id === "s-02")!;
    const [first, second] = shot.dialogueIds;

    const snapshot = state().events.length;
    expect(state().setDialogueOrder("s-02", [second!, first!])).toBe(true);
    expect(
      state().project.shots.find((item) => item.id === "s-02")?.dialogueIds,
    ).toEqual([second, first]);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      shotId: "s-02",
      patch: { dialogueIds: [second, first] },
    });
    expect(rebuild(state().events).shots.find((item) => item.id === "s-02")?.dialogueIds).toEqual([
      second,
      first,
    ]);
  });

  it("顺序没变、对不上、锁定与只读都不写事件", () => {
    expect(state().addDialogue("s-02", "c-lin", "谁在那儿？")).toBe(true);
    const shot = state().project.shots.find((item) => item.id === "s-02")!;
    const snapshot = state().events.length;

    expect(state().setDialogueOrder("s-02", [...shot.dialogueIds])).toBe(false);
    expect(state().castError).toContain("没改");
    expect(state().setDialogueOrder("s-02", ["d-01", "d-02"])).toBe(false);
    expect(state().castError).toContain("删掉");
    expect(state().setDialogueOrder("s-02", ["d-02"])).toBe(false);
    expect(state().castError).toContain("对不上");

    expect(state().setDialogueOrder("s-08", ["d-04"])).toBe(false);
    expect(state().castError).toContain("锁定");

    useWorkbench.setState({ readOnly: true });
    expect(state().setDialogueOrder("s-02", ["x"])).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("跨镜头挪台词（ADR-0054）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("挪到另一镜：两镜时长各加减这一句，两条 shot.updated", () => {
    const source = state().project.shots.find((item) => item.id === "s-01")!;
    const target = state().project.shots.find((item) => item.id === "s-02")!;
    const line = state().project.dialogue.find((item) => item.id === "d-01")!;
    const snapshot = state().events.length;

    expect(state().moveDialogueTo("d-01", "s-02")).toBe(true);

    const afterSource = state().project.shots.find((item) => item.id === "s-01")!;
    const afterTarget = state().project.shots.find((item) => item.id === "s-02")!;
    expect(afterSource.dialogueIds).not.toContain("d-01");
    expect(afterTarget.dialogueIds).toContain("d-01");
    expect(afterSource.durationMs).toBe(Math.max(500, source.durationMs - line.durationMs));
    expect(afterTarget.durationMs).toBe(target.durationMs + line.durationMs);
    // 台词本体不动：说话人、文本、时长都留在原处
    expect(state().project.dialogue.find((item) => item.id === "d-01")).toMatchObject({
      characterId: "c-zhou",
      text: "你早就知道，对吧。",
      durationMs: 2600,
    });

    const tail = state().events.slice(-2);
    expect(tail[0]).toMatchObject({
      type: "shot.updated",
      shotId: "s-01",
      patch: { durationMs: afterSource.durationMs },
    });
    expect(tail[1]).toMatchObject({
      type: "shot.updated",
      shotId: "s-02",
      patch: { durationMs: afterTarget.durationMs },
    });
    expect(state().events).toHaveLength(snapshot + 2);

    const replay = rebuild(state().events);
    expect(replay.shots.find((item) => item.id === "s-01")?.dialogueIds).not.toContain("d-01");
    expect(replay.shots.find((item) => item.id === "s-02")?.dialogueIds).toContain("d-01");
  });

  it("同一镜、锁定的镜、陌生的台词都不写事件", () => {
    const snapshot = state().events.length;

    expect(state().moveDialogueTo("d-01", "s-01")).toBe(false);
    expect(state().castError).toContain("这一镜");
    // d-04 在锁定的 s-08 里
    expect(state().moveDialogueTo("d-04", "s-02")).toBe(false);
    expect(state().castError).toContain("锁定");
    // 目标是锁定的 s-08
    expect(state().moveDialogueTo("d-01", "s-08")).toBe(false);
    expect(state().castError).toContain("锁定");
    expect(state().moveDialogueTo("d-404", "s-02")).toBe(false);
    expect(state().moveDialogueTo("d-01", "s-404")).toBe(false);

    useWorkbench.setState({ readOnly: true });
    expect(state().moveDialogueTo("d-01", "s-02")).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("恢复被删的台词（ADR-0055）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("删掉再恢复：回到原镜队尾，时长加回，两条事件", () => {
    const shot = state().project.shots.find((item) => item.id === "s-03")!;
    expect(state().removeDialogue("d-02")).toBe(true);
    const afterRemove = state().project.shots.find((item) => item.id === "s-03")!;
    expect(afterRemove.durationMs).toBe(Math.max(500, shot.durationMs - 2100));

    const snapshot = state().events.length;
    expect(state().restoreLine("d-02")).toBe(true);

    const restored = state().project.shots.find((item) => item.id === "s-03")!;
    expect(restored.dialogueIds).toEqual(["d-02"]);
    // 删的时候 2400 − 2100 触到 500ms 地板；加回来是 500 + 2100，比原来的 2400 长
    expect(restored.durationMs).toBe(2600);
    expect(state().project.dialogue.find((item) => item.id === "d-02")).toMatchObject({
      characterId: "c-lin",
      text: "知道了又怎样。",
      durationMs: 2100,
    });

    const tail = state().events.slice(-2);
    expect(tail[0]).toMatchObject({ type: "dialogue.added", shotId: "s-03" });
    expect(tail[1]).toMatchObject({ type: "shot.updated", shotId: "s-03" });
    expect(state().events).toHaveLength(snapshot + 2);

    const replay = rebuild(state().events);
    expect(replay.shots.find((item) => item.id === "s-03")?.dialogueIds).toEqual(["d-02"]);
  });

  it("没删过、已经在了、锁定镜头、只读标签页都不写事件", () => {
    const snapshot = state().events.length;

    // 没删过：日志里找不到删除记录
    expect(state().restoreLine("d-404")).toBe(false);
    // 已经在了
    expect(state().restoreLine("d-01")).toBe(false);
    expect(state().castError).toContain("已经在");

    // 在 s-02 加一句、删掉，再锁上这一镜（t-02 已留用，可以锁）
    expect(state().addDialogue("s-02", "c-lin", "等等。")).toBe(true);
    const added = state().project.shots.find((item) => item.id === "s-02")!.dialogueIds.at(-1)!;
    expect(state().removeDialogue(added)).toBe(true);
    state().setShotLock("s-02", true);
    expect(state().project.shots.find((item) => item.id === "s-02")?.locked).toBe(true);
    expect(state().restoreLine(added)).toBe(false);
    expect(state().castError).toContain("锁定");
    state().setShotLock("s-02", false);

    useWorkbench.setState({ readOnly: true });
    expect(state().restoreLine(added)).toBe(false);
  });
});

describe("编辑不许变清单（ADR-0074）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("加一条：一条 character.updated，清单整份写回", () => {
    // 示例项目里林已经有「左眼下的痣」等三条
    const snapshot = state().events.length;
    const before = state().project.characters.find((item) => item.id === "c-lin")!;

    expect(state().addMustNotChange("c-lin", " 耳后一颗小痣 ")).toBe(true);

    expect(state().events).toHaveLength(snapshot + 1);
    const character = state().project.characters.find((item) => item.id === "c-lin")!;
    expect(character.mustNotChange).toEqual([...before.mustNotChange, "耳后一颗小痣"]);
    expect(state().events.at(-1)).toMatchObject({
      type: "character.updated",
      characterId: "c-lin",
      patch: { mustNotChange: character.mustNotChange },
    });
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("划掉一条：只去掉那一条，重复划掉不写事件", () => {
    const before = state().project.characters.find((item) => item.id === "c-lin")!;
    const target = before.mustNotChange[0]!;
    const snapshot = state().events.length;

    expect(state().removeMustNotChange("c-lin", target)).toBe(true);
    expect(
      state().project.characters.find((item) => item.id === "c-lin")!.mustNotChange,
    ).toEqual(before.mustNotChange.slice(1));

    expect(state().removeMustNotChange("c-lin", target)).toBe(false);
    expect(state().events).toHaveLength(snapshot + 1);
  });

  it("空条目、重复、过长、太多、只读都不写事件", () => {
    const snapshot = state().events.length;

    expect(state().addMustNotChange("c-lin", "  ")).toBe(false);
    expect(state().castError).toContain("空的");

    expect(state().addMustNotChange("c-lin", "左眼下的痣")).toBe(false);
    expect(state().castError).toContain("已经有一条");

    expect(state().addMustNotChange("c-lin", "字".repeat(61))).toBe(false);
    expect(state().castError).toContain("60 字以内");

    const many = state().addCharacter("话很多", "")!;
    for (let i = 0; i < 20; i += 1) state().addMustNotChange(many, `第 ${i} 条`);
    expect(state().addMustNotChange(many, "第 21 条")).toBe(false);
    expect(state().castError).toContain("最多 20 条");

    useWorkbench.setState({ readOnly: true });
    expect(state().addMustNotChange("c-lin", "只读") ).toBe(false);

    // 20 条成功的 + 前面都被拒
    expect(state().events.filter((item) => item.type === "character.updated")).toHaveLength(20);
    expect(snapshot).toBeGreaterThan(0);
  });
});

describe("撤销删除（ADR-0076）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("删人物再撤销：人物带着原来的 id、清单与三视图回来", () => {
    const before = state().project.characters.find((item) => item.id === "c-lin")!;
    const id = state().addCharacter("阿棠", "齐耳短发")!;
    state().addMustNotChange(id, "耳后一颗小痣");
    const snapshot = state().events.length;

    expect(state().removeCharacter(id)).toBe(true);
    const undone = state().undoLastRemoval();
    if (!undone) console.log("undo error:", state().castError);
    expect(undone).toBe(true);

    const back = state().project.characters.find((item) => item.id === id)!;
    expect(back).toMatchObject({ id, name: "阿棠", mustNotChange: ["耳后一颗小痣"] });
    expect(state().events).toHaveLength(snapshot + 2); // removed + added
    expect(state().events.at(-1)).toMatchObject({ type: "character.added", character: { id } });
    expect(rebuild(state().events)).toEqual(state().project);
    expect(before).toBeTruthy();
  });

  it("删一镜再撤销：台词、时长与顺序按删之前的样子回来", () => {
    const before = state().project.shots.find((item) => item.id === "s-03")!;
    const beforeLines = before.dialogueIds.map(
      (id) => state().project.dialogue.find((line) => line.id === id)!,
    );
    expect(beforeLines.length).toBeGreaterThan(0);

    expect(state().removeShot("s-03")).toBe(true);
    expect(state().undoLastRemoval()).toBe(true);

    const back = state().project.shots.find((item) => item.id === "s-03")!;
    expect(back).toMatchObject({
      id: "s-03",
      sceneId: before.sceneId,
      durationMs: before.durationMs,
      dialogueIds: before.dialogueIds,
    });
    for (const line of beforeLines) {
      expect(state().project.dialogue.find((item) => item.id === line.id)).toEqual(line);
    }
    expect(
      state().project.scenes.find((item) => item.id === before.sceneId)?.shotIds,
    ).toContain("s-03");
    expect(state().currentShotId).toBe("s-03");
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("先删镜、再删场：撤销按删除的反向一步来", () => {
    const sceneId = state().addScene()!;
    const shotId = state().addShot(sceneId)!;
    state().toggleShotCharacter(shotId, "c-lin");

    expect(state().removeShot(shotId)).toBe(true);
    expect(state().removeScene(sceneId)).toBe(true);

    // 第一步：场次回来（还是空的）
    expect(state().undoLastRemoval()).toBe(true);
    expect(state().project.scenes.some((item) => item.id === sceneId)).toBe(true);
    expect(state().project.shots.some((item) => item.id === shotId)).toBe(false);

    // 第二步：镜头回来，出场也跟着回来
    expect(state().undoLastRemoval()).toBe(true);
    expect(state().project.shots.find((item) => item.id === shotId)?.characterIds).toEqual([
      "c-lin",
    ]);
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("没有可撤销的删除、或只读时不写事件", () => {
    const snapshot = state().events.length;
    expect(state().undoLastRemoval()).toBe(false);
    expect(state().castError).toContain("没有可撤销的删除");
    expect(state().events).toHaveLength(snapshot);

    state().removeCharacter(state().addCharacter("阿棠", "")!);
    useWorkbench.setState({ readOnly: true });
    expect(state().undoLastRemoval()).toBe(false);
    useWorkbench.setState({ readOnly: false });
    expect(state().undoLastRemoval()).toBe(true);
  });
});

describe("出场顺序（ADR-0077）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  const shot = (id: string) => state().project.shots.find((item) => item.id === id)!;

  it("人物：往前挪一位，两人互换，写一条 shot.updated", () => {
    expect(shot("s-04").characterIds).toEqual(["c-lin", "c-zhou"]);
    const before = state().events.length;

    expect(state().moveShotCharacter("s-04", "c-zhou", -1)).toBe(true);
    expect(shot("s-04").characterIds).toEqual(["c-zhou", "c-lin"]);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      shotId: "s-04",
      patch: { characterIds: ["c-zhou", "c-lin"] },
    });
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("到头、不在出场里、锁定的镜头都不写事件", () => {
    const before = state().events.length;
    expect(state().moveShotCharacter("s-04", "c-lin", -1)).toBe(false);
    expect(state().moveShotCharacter("s-04", "c-zhou", 1)).toBe(false);
    expect(state().moveShotCharacter("s-04", "c-tang", -1)).toBe(false);
    expect(state().moveShotCharacter("s-08", "c-lin", 1)).toBe(false);
    expect(state().castError).toContain("已锁定");
    expect(state().events).toHaveLength(before);
  });

  it("道具同一套：点进出场再挪到前面", () => {
    expect(state().toggleShotProp("s-05", "p-cup")).toBe(true);
    expect(shot("s-05").propIds).toEqual(["p-lamp", "p-cup"]);

    expect(state().moveShotProp("s-05", "p-cup", -1)).toBe(true);
    expect(shot("s-05").propIds).toEqual(["p-cup", "p-lamp"]);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      patch: { propIds: ["p-cup", "p-lamp"] },
    });
    expect(rebuild(state().events)).toEqual(state().project);
  });
});

describe("参考图多张与手动挂（ADR-0079）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  const svg = (mark: string) =>
    `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'>${mark}</svg>`;

  it("人物：挂一张写资产与 character.updated 两条事件", () => {
    const before = state().project.characters.find((item) => item.id === "c-lin")!;
    expect(before.referenceImages).toHaveLength(1);
    const count = state().events.length;

    expect(state().addCharacterReference("c-lin", svg("a"))).toBe(true);
    const after = state().project.characters.find((item) => item.id === "c-lin")!;
    expect(after.referenceImages).toHaveLength(2);
    expect(state().events).toHaveLength(count + 2);
    expect(state().events.at(-2)).toMatchObject({ type: "asset.updated", asset: { source: "upload" } });
    expect(state().events.at(-1)).toMatchObject({ type: "character.updated" });
    expect(rebuild(state().events)).toEqual(state().project);

    const added = after.referenceImages[1]!;
    expect(state().project.assets.find((item) => item.id === added)?.mime).toBe("image/svg+xml");
    expect(state().removeCharacterReference("c-lin", added)).toBe(true);
    expect(
      state().project.characters.find((item) => item.id === "c-lin")!.referenceImages,
    ).toHaveLength(1);
  });

  it("地址不合法、重复、超过 8 张都拒绝且不写事件", () => {
    const count = state().events.length;
    expect(state().addCharacterReference("c-lin", "   ")).toBe(false);
    expect(state().addCharacterReference("c-lin", "ftp://x/y.png")).toBe(false);
    expect(state().castError).toContain("http(s)://");

    expect(state().addCharacterReference("c-lin", svg("x"))).toBe(true);
    const afterOne = state().events.length;
    expect(state().addCharacterReference("c-lin", svg("x"))).toBe(false);
    expect(state().castError).toContain("已经挂过了");
    expect(state().events).toHaveLength(afterOne);

    // 原有 1 张 + x 1 张 = 2，再挂 6 张到上限 8；第 7 张被拒
    for (let i = 0; i < 6; i += 1) {
      expect(state().addCharacterReference("c-lin", svg(`n${i}`))).toBe(true);
    }
    expect(state().addCharacterReference("c-lin", svg("too-many"))).toBe(false);
    expect(state().castError).toContain("最多 8 张");
    const lin = state().project.characters.find((item) => item.id === "c-lin")!;
    expect(lin.referenceImages).toHaveLength(8);
  });

  it("道具：挂上再摘掉；只读时不动", () => {
    const refs = () =>
      state().project.props.find((item) => item.id === "p-lamp")!.referenceImages;
    expect(refs()).toEqual(["a-lamp"]);
    expect(state().addPropReference("p-lamp", svg("prop"))).toBe(true);
    expect(refs()).toHaveLength(2);

    const added = refs()[1]!;
    useWorkbench.setState({ readOnly: true });
    expect(state().removePropReference("p-lamp", added)).toBe(false);
    useWorkbench.setState({ readOnly: false });
    expect(state().removePropReference("p-lamp", added)).toBe(true);
    expect(refs()).toEqual(["a-lamp"]);
    expect(rebuild(state().events)).toEqual(state().project);
  });
});

describe("配音（ADR-0085）", () => {
  beforeEach(() => {
    state().reset();
  });

  it("贴一条音轨：落一条音频资产，再把这句挂在它上面", () => {
    const before = state().events.length;
    expect(state().attachVoice("d-01", "data:audio/mpeg;base64,SUQz")).toBe(true);

    expect(state().events.slice(before).map((event) => event.type)).toEqual([
      "asset.updated",
      "dialogue.updated",
    ]);
    const asset = state().project.assets.find((item) => item.id === "a-voice-d-01");
    expect(asset).toMatchObject({ kind: "audio", source: "upload", uri: "data:audio/mpeg;base64,SUQz" });
    expect(state().project.dialogue.find((line) => line.id === "d-01")?.audioAssetId).toBe(
      "a-voice-d-01",
    );
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("只收 http(s) / data:audio，锁定的镜头不给配", () => {
    expect(state().attachVoice("d-01", "ftp://nope")).toBe(false);
    expect(state().attachVoice("d-01", "https://cdn.example.com/x.mp3")).toBe(true);
    expect(state().attachVoice("d-99", "https://cdn.example.com/x.mp3")).toBe(false);

    // d-04 在锁定的 s-08 里
    expect(state().attachVoice("d-04", "https://cdn.example.com/x.mp3")).toBe(false);
    expect(state().castError).toContain("已锁定");
  });

  it("量出音轨时长之后，台词与镜头一起挪（准则 P5）", () => {
    state().attachVoice("d-01", "https://cdn.example.com/x.mp3");
    const before = state().events.length;

    expect(state().fitLineToAudio("d-01", 3000)).toBe(true);
    expect(state().events.slice(before).map((event) => event.type)).toEqual([
      "dialogue.updated",
      "shot.updated",
      "asset.updated",
    ]);
    expect(state().project.dialogue.find((line) => line.id === "d-01")?.durationMs).toBe(3000);
    expect(state().project.shots.find((shot) => shot.id === "s-01")?.durationMs).toBe(3500);
    expect(
      state().project.assets.find((item) => item.id === "a-voice-d-01")?.durationMs,
    ).toBe(3000);
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("时长差得小就不写事件：不让重放产生无意义的抖动", () => {
    state().attachVoice("d-01", "https://cdn.example.com/x.mp3");
    const before = state().events.length;
    expect(state().fitLineToAudio("d-01", 2610)).toBe(false);
    expect(state().events).toHaveLength(before);
  });

  it("给角色指定音色，空串表示用回默认", () => {
    expect(state().setCharacterVoice("c-zhou", "Cherry")).toBe(true);
    expect(
      state().project.characters.find((item) => item.id === "c-zhou")?.voiceProfileId,
    ).toBe("Cherry");
    expect(state().events.at(-1)).toMatchObject({
      type: "character.updated",
      patch: { voiceProfileId: "Cherry" },
    });

    expect(state().setCharacterVoice("c-zhou", "  ")).toBe(true);
    expect(
      state().project.characters.find((item) => item.id === "c-zhou"),
    ).not.toHaveProperty("voiceProfileId");
    expect(rebuild(state().events)).toEqual(state().project);
  });
});

describe("识别（ADR-0087）", () => {
  beforeEach(() => {
    state().reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("识别这一句的音轨：结果先放一边，不改台词、不写事件", async () => {
    state().attachVoice("d-01", "data:audio/mpeg;base64,SUQz");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${url} ${String(init?.body ?? "")}`);
        return new Response(
          JSON.stringify({
            text: "你早就知道了，对吧？",
            model: "qwen-audio-3.0-asr-flash",
            segments: [{ text: "你早就知道了，对吧？", startMs: 0, endMs: 2600 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const before = state().events.length;
    const ok = await state().transcribeLine("d-01");

    expect(ok).toBe(true);
    expect(calls[0]).toContain("/api/transcribe");
    expect(state().asrResult).toMatchObject({
      lineId: "d-01",
      text: "你早就知道了，对吧？",
      model: "qwen-audio-3.0-asr-flash",
    });
    expect(state().events).toHaveLength(before);
    expect(state().project.dialogue.find((line) => line.id === "d-01")?.text).toBe(
      "你早就知道，对吧。",
    );
  });

  it("没有音轨就不送识别，也不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await state().transcribeLine("d-02")).toBe(false);
    expect(state().castError).toContain("还没有音轨");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("识别失败如实报，不留下半条结果", async () => {
    state().attachVoice("d-01", "data:audio/mpeg;base64,SUQz");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: "No authorized bound group supports this request" }),
          { status: 502, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    expect(await state().transcribeLine("d-01")).toBe(false);
    expect(state().asrResult).toBeUndefined();
    expect(state().castError).toContain("没识别出来");
    expect(state().castError).toContain("No authorized bound group");
  });

  it("用识别结果替换台词：只改文字，时长与镜头不动", () => {
    const before = state().project.dialogue.find((line) => line.id === "d-01")!;
    const shotBefore = state().project.shots.find((shot) => shot.id === "s-01")!;
    const count = state().events.length;

    expect(state().applyAsrText("d-01", " 你早就知道了，对吧？ ")).toBe(true);

    const after = state().project.dialogue.find((line) => line.id === "d-01")!;
    expect(after.text).toBe("你早就知道了，对吧？");
    expect(after.durationMs).toBe(before.durationMs);
    expect(state().project.shots.find((shot) => shot.id === "s-01")?.durationMs).toBe(
      shotBefore.durationMs,
    );
    expect(state().events.slice(count).map((event) => event.type)).toEqual([
      "dialogue.updated",
    ]);
    expect(state().events.at(-1)).toMatchObject({ patch: { text: "你早就知道了，对吧？" } });
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("空结果、原句、锁定镜头都不替换", () => {
    expect(state().applyAsrText("d-01", "   ")).toBe(false);
    expect(state().applyAsrText("d-01", "你早就知道，对吧。")).toBe(false);
    expect(state().castError).toContain("一样");
    // d-04 在锁定的 s-08 里
    expect(state().applyAsrText("d-04", "换一句")).toBe(false);
    expect(state().castError).toContain("已锁定");
  });
});

describe("成片（ADR-0086）", () => {
  beforeEach(() => {
    state().reset();
  });

  it("自动初剪写一条 timeline.updated，跳过没有可用 take 的镜头", () => {
    const ok = state().autoCutTimeline();
    expect(ok).toBe(true);
    expect(state().project.timeline.items).toHaveLength(10);
    expect(state().events.at(-1)?.type).toBe("timeline.updated");
    expect(state().editError).toContain("SH-01");
    expect(state().editError).toContain("SH-10");
  });

  it("已经剪过再点一次不写重复事件", () => {
    state().autoCutTimeline();
    const count = state().events.length;
    expect(state().autoCutTimeline()).toBe(false);
    expect(state().events).toHaveLength(count);
  });

  it("换 take 整条替换，只改这一项", () => {
    state().attachVideo("s-02", "https://example.com/s-02.mp4");
    state().autoCutTimeline();
    const before = state().project.timeline.items.find((item) => item.id === "tl-s-02")!;
    expect(before.takeId).toBe("t-02");
    const added = state().project.takes.filter((take) => take.shotId === "s-02").at(-1)!;

    expect(state().setTimelineTake("tl-s-02", added.id)).toBe(true);
    const after = state().project.timeline.items.find((item) => item.id === "tl-s-02")!;
    expect(after.takeId).toBe(added.id);
    expect(after.startMs).toBe(before.startMs);
    expect(state().events.at(-1)?.type).toBe("timeline.updated");
  });

  it("别的镜头的 take、已淘汰的 take 都拒绝", () => {
    state().autoCutTimeline();
    expect(state().setTimelineTake("tl-s-02", "t-03")).toBe(false);
    expect(state().editError).toContain("不属于");
    expect(state().setTimelineTake("tl-s-02", "t-01")).toBe(false);
    expect(state().editError).toContain("不属于");

    // 同一镜的 take 被淘汰之后，也不能再换进去
    state().attachVideo("s-02", "https://example.com/s-02.mp4");
    const added = state().project.takes.filter((take) => take.shotId === "s-02").at(-1)!;
    state().select("s-02");
    state().decide("rejected");
    expect(state().setTimelineTake("tl-s-02", added.id)).toBe(false);
    expect(state().editError).toContain("淘汰");
  });

  it("只读时初剪与换 take 都不写", () => {
    const log = state().events.length;
    state().readOnly = true;
    expect(state().autoCutTimeline()).toBe(false);
    expect(state().events).toHaveLength(log);
    state().readOnly = false;
  });
});

describe("故事入口开工（ADR-0088）", () => {
  const draft = parseStoryDraft(
    JSON.stringify({
      title: "少主归来",
      logline: "外卖员送餐撞破董事会，才知道自己是被夺走人生的继承人。",
      synopsis: "程野每天给顶层公寓送餐，暗中查父亲坠楼的真相。",
      genre: "都市逆袭",
      audience: "竖屏用户",
      tone: "冷峻",
      characters: [
        { name: "程野", role: "外卖员", appearance: "旧骑手服，虎口有疤" },
        { name: "沈岚", role: "董事长", appearance: "深灰西装" },
      ],
      locations: [{ name: "董事会", description: "顶层会议室，暴雨", space: "int", timeOfDay: "night" }],
      scenes: [
        {
          locationName: "董事会",
          space: "int",
          timeOfDay: "night",
          shots: [
            {
              description: "程野拎着餐盒推门。",
              shotSize: "wide",
              angle: "eye",
              movement: "push",
              focalMm: 35,
              characterNames: ["程野", "沈岚"],
              dialogue: [{ characterName: "沈岚", text: "你是谁？" }],
            },
          ],
        },
      ],
    }),
  );

  it("在日志末尾写一条新的 project.created，界面换成新项目", () => {
    state().reset();
    const before = state().events.length;

    expect(
      state().startProjectFromStory(draft, { modelId: "claude-sonnet-5-5", idea: "外卖员" }),
    ).toBe(true);

    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)?.type).toBe("project.created");
    expect(state().project.title).toBe("少主归来");
    expect(state().project.story.logline).toContain("外卖员");
    expect(state().project.story.arcs).toHaveLength(2);
    expect(state().project.scenes).toHaveLength(1);
    expect(state().currentShotId).toBe("shot-1-1");

    // 回放整份日志：新的 project.created 从中间接管，结果与内存一致
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("只读时不换项目", () => {
    state().reset();
    const before = state().events.length;
    const title = state().project.title;
    state().readOnly = true;
    expect(state().startProjectFromStory(draft, { modelId: "m", idea: "x" })).toBe(false);
    expect(state().events).toHaveLength(before);
    expect(state().project.title).toBe(title);
    state().readOnly = false;
  });
});

describe("分镜节拍与镜头目的（ADR-0096）", () => {
  beforeEach(() => {
    state().reset();
  });

  it("改节拍写一条 shot.updated，回放一致", () => {
    const before = state().events.length;
    expect(state().setShotPlan("s-01", { beat: "climax" })).toBe(true);

    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      shotId: "s-01",
      patch: { beat: "climax" },
    });
    expect(state().project.shots.find((shot) => shot.id === "s-01")?.beat).toBe("climax");
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("可以把节拍和目的一起改，也可以只改目的", () => {
    expect(state().setShotPlan("s-02", { beat: "turn", purpose: "reaction" })).toBe(true);
    expect(
      state().project.shots.find((shot) => shot.id === "s-02"),
    ).toMatchObject({ beat: "turn", purpose: "reaction" });

    expect(state().setShotPlan("s-02", { purpose: "emotion" })).toBe(true);
    expect(state().project.shots.find((shot) => shot.id === "s-02")).toMatchObject({
      beat: "turn",
      purpose: "emotion",
    });
    // 只传一个没变化的字段，不把另一个也不写掉，也不产生事件
    expect(state().setShotPlan("s-02", { beat: "turn" })).toBe(false);
    expect(state().project.shots.find((shot) => shot.id === "s-02")).toMatchObject({
      beat: "turn",
      purpose: "emotion",
    });
  });

  it("值没变就不写日志", () => {
    state().setShotPlan("s-01", { beat: "setup" });
    const after = state().events.length;
    expect(state().setShotPlan("s-01", { beat: "setup" })).toBe(false);
    expect(state().events).toHaveLength(after);
  });

  it("锁定的镜头不改，给出人话原因", () => {
    const before = state().events.length;
    expect(state().setShotPlan("s-08", { beat: "climax" })).toBe(false);
    expect(state().events).toHaveLength(before);
    expect(state().castError).toContain("已锁定");
    expect(state().project.shots.find((shot) => shot.id === "s-08")?.beat).toBeUndefined();
  });

  it("找不到镜头或没给任何字段时不写", () => {
    const before = state().events.length;
    expect(state().setShotPlan("s-404", { beat: "hook" })).toBe(false);
    expect(state().setShotPlan("s-01", {})).toBe(false);
    expect(state().events).toHaveLength(before);
  });
});

describe("阶段闸门与单镜预算（F8 / F9 / H10）", () => {
  beforeEach(() => {
    state().reset();
    state().setImagePrice({ model: "gpt-image-2-c", cny: 0.12 });
  });

  const stub = () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)).kind);
        return new Response(
          JSON.stringify({ uri: "data:image/png;base64,RkFLRQ==", model: "gpt-image-2-c", cny: 0.12 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    return calls;
  };

  it("单镜上限低于这一张的报价时，不发请求", async () => {
    const calls = stub();
    state().setShotBudget("s-03", 0.05);
    await state().generateKeyframe("s-03");

    expect(calls).toHaveLength(0);
    expect(state().castError).toContain("这一镜的上限");
    expect(state().castError).toContain("SH-03");
    vi.unstubAllGlobals();
  });

  it("单镜上限够就照常生成，事件重放后上限还在", async () => {
    const calls = stub();
    state().setShotBudget("s-03", 5);
    await state().generateKeyframe("s-03");

    expect(calls).toHaveLength(1);
    expect(
      state().events.find(
        (event) =>
          event.type === "shot.updated" &&
          event.shotId === "s-03" &&
          event.patch.budgetCny === 5,
      ),
    ).toBeDefined();
    expect(rebuild(state().events).shots.find((shot) => shot.id === "s-03")?.budgetCny).toBe(5);
    vi.unstubAllGlobals();
  });

  it("0 元不是「不限」：拒绝写入", () => {
    state().setShotBudget("s-03", 0);
    expect(state().project.shots.find((shot) => shot.id === "s-03")?.budgetCny).toBeUndefined();
    expect(state().castError).toContain("大于 0");
  });

  it("确认阶段写一条 gate.confirmed，签名与当前内容一致", () => {
    const project = state().project;
    expect(state().confirmGate("story", "先认下来")).toBe(true);

    const record = state().project.gates.find((gate) => gate.stage === "story");
    expect(record?.note).toBe("先认下来");
    expect(record?.signature).toMatch(/^[0-9a-f]{8}$/);
    expect(state().events.at(-1)?.type).toBe("gate.confirmed");
    expect(rebuild(state().events).gates).toEqual(state().project.gates);
    expect(project.gates).toHaveLength(0);
  });

  it("回退阶段删掉记录并留一条 gate.reopened", () => {
    state().confirmGate("script");
    expect(state().reopenGate("script")).toBe(true);
    expect(state().project.gates).toHaveLength(0);
    expect(state().events.at(-1)).toMatchObject({ type: "gate.reopened", stage: "script" });
  });

  it("没确认过的阶段回退不写日志", () => {
    const before = state().events.length;
    expect(state().reopenGate("voice")).toBe(false);
    expect(state().events).toHaveLength(before);
  });
});
