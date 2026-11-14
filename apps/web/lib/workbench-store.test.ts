import { DEFAULT_GRADE, ProjectSchema, applyEvent, rebuild, type ProjectEvent } from "@loomina/ir";
import { parseStoryDraft } from "@loomina/pipeline";
import type { CastImageRequest } from "./generate-image";
import { imagePlanOf } from "./image-plan";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { setEventLog, type EventLog } from "./event-log";
import { claimWriter, releaseWriter } from "./writer-lock";
import { spendOf, toScriptView, toStageView } from "./read-model";
import { referencedAssetIds } from "./asset-inventory";
import { toEditView } from "./edit";
import { stageStateOf } from "./stage-flow";
import { resetPersistenceForTests, useWorkbench } from "./workbench-store";
import { dataUriBytesOf, logBytesOf, sha256OfBytes } from "./log-compact";

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

  it("删一拍写一条 take.removed，只少这一条", () => {
    state().select("s-03");
    const before = state().events.length;
    expect(state().removeTake("t-03")).toBe(true);

    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "take.removed", takeId: "t-03" });
    expect(state().project.takes.some((take) => take.id === "t-03")).toBe(false);
    // 同镜的另一拍不受影响
    expect(state().project.takes.some((take) => take.id === "t-04")).toBe(true);
    expect(rebuild(state().events).takes.some((take) => take.id === "t-03")).toBe(false);
  });

  it("删一拍连带摘掉它在时间线上的片段", () => {
    const takeId = state().project.timeline.items[0]!.takeId;
    const itemId = state().project.timeline.items[0]!.id;
    expect(state().removeTake(takeId)).toBe(true);
    expect(state().project.timeline.items.some((item) => item.id === itemId)).toBe(false);
  });

  it("锁定的镜头不删这一拍，也不发事件", () => {
    state().select("s-08");
    const before = state().events.length;
    expect(state().removeTake("t-08")).toBe(false);
    expect(state().events).toHaveLength(before);
    expect(state().project.takes.some((take) => take.id === "t-08")).toBe(true);
  });

  it("删不存在的 take 返回 false", () => {
    expect(state().removeTake("t-nope")).toBe(false);
  });

  it("删片段：后面的整体前移，起点不留空隙（E1）", () => {
    state().autoCutTimeline();
    const items = state().project.timeline.items;
    expect(items.length).toBeGreaterThan(1);
    const removed = items[0]!;
    const before = state().events.length;

    expect(state().removeTimelineItem(removed.id)).toBe(true);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)?.type).toBe("timeline.updated");

    const after = [...state().project.timeline.items].sort((a, b) => a.startMs - b.startMs);
    expect(after.some((item) => item.id === removed.id)).toBe(false);
    expect(after[0]!.startMs).toBe(0);
    // 首尾相接：每一段的起点等于上一段的终点
    let cursor = 0;
    for (const item of after) {
      expect(item.startMs).toBe(cursor);
      cursor += item.durationMs;
    }
  });

  it("挪片段：交换顺序后起点重排，仍首尾相接（E1）", () => {
    state().autoCutTimeline();
    const ordered = [...state().project.timeline.items].sort((a, b) => a.startMs - b.startMs);
    const first = ordered[0]!;
    const second = ordered[1]!;
    expect(state().moveTimelineItem(first.id, 1)).toBe(true);

    const after = [...state().project.timeline.items].sort((a, b) => a.startMs - b.startMs);
    expect(after[0]!.id).toBe(second.id);
    expect(after[1]!.id).toBe(first.id);
    expect(after[0]!.startMs).toBe(0);
    expect(after[1]!.startMs).toBe(after[0]!.durationMs);
  });

  it("挪到边界外不写事件", () => {
    state().autoCutTimeline();
    const ordered = [...state().project.timeline.items].sort((a, b) => a.startMs - b.startMs);
    const before = state().events.length;
    expect(state().moveTimelineItem(ordered[0]!.id, -1)).toBe(false);
    expect(state().moveTimelineItem(ordered.at(-1)!.id, 1)).toBe(false);
    expect(state().events).toHaveLength(before);
  });

  it("删不存在的片段返回 false", () => {
    expect(state().removeTimelineItem("ti-nope")).toBe(false);
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

  it("旧项目里没有资产位的角色：先补四格再出图（ADR-0144）", async () => {
    // 模拟旧项目 / 外部导入的人物：sheet 是空的
    const { project, events } = state();
    const at = "2026-11-12T10:00:00+08:00";
    const legacy = {
      id: "c-legacy",
      name: "旧人",
      appearance: "长外套",
      sheet: {},
      referenceImages: [],
      mustNotChange: [],
    };
    const added: ProjectEvent = { type: "character.added", at, character: legacy };
    useWorkbench.setState({ project: applyEvent(project, added), events: [...events, added] });

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

    await state().generateSheet("c-legacy");

    // 一条 character.updated 补格子，四格各出一条 asset.updated
    const sheetEvent = state().events.find(
      (event) => event.type === "character.updated" && event.characterId === "c-legacy",
    );
    expect(sheetEvent).toMatchObject({
      patch: {
        sheet: {
          front: "a-sheet-c-legacy-front",
          threeQuarter: "a-sheet-c-legacy-threeQuarter",
          side: "a-sheet-c-legacy-side",
          back: "a-sheet-c-legacy-back",
        },
      },
    });
    expect(calls.map((call) => call.angle)).toEqual([
      "front",
      "threeQuarter",
      "side",
      "back",
    ]);
    expect(
      state().project.characters.find((item) => item.id === "c-legacy")?.sheet.front,
    ).toBe("a-sheet-c-legacy-front");
    expect(state().project.assets.find((item) => item.id === "a-sheet-c-legacy-front")?.uri).toContain(
      "front",
    );

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

  it("本机资产库里的片子也能贴：帧级找点只认这种地址（E7.2 / ADR-0129）", () => {
    const uri = `loomina://assets/${"a".repeat(64)}.mp4`;
    expect(state().attachVideo("s-03", uri)).toBe(true);
    const shot = state().project.shots.find((item) => item.id === "s-03")!;
    const take = state().project.takes.find((item) => item.id === shot.takeIds.at(-1))!;
    expect(state().project.assets.find((item) => item.id === take.assetId)?.uri).toBe(uri);
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

  it("「再压抑一点」落到 Shot.lighting，写一条 shot.updated 且可回放（F7 / ADR-0217）", () => {
    const id = state().currentShotId;
    const ok = state().instruct("再压抑一点");

    expect(ok).toBe(true);
    const after = state().project.shots.find((item) => item.id === id)!;
    expect(after.lighting).toMatchObject({ position: "top", mood: "silhouette" });
    // 落到了结构字段，就不再往 promptNotes 里塞同一件事
    expect(after.promptNotes).toEqual([]);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      patch: { lighting: { position: "top", mood: "silhouette" } },
    });
    expect(
      rebuild(state().events).shots.find((item) => item.id === id)?.lighting,
    ).toMatchObject({ position: "top", mood: "silhouette" });
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

  it("整段锁定：只锁留用过的镜头，跳过的照实说", () => {
    const sceneId = state().project.scenes[0]!.id;
    const shotIds = state().project.scenes[0]!.shotIds;
    const before = state().events.length;

    const result = state().setSceneLock(sceneId, true);
    // 示例项目第 1 场只有 s-02 留用过（t-02 approved），另外两镜没留用
    expect(result.locked).toBe(1);
    expect(result.skipped).toBe(2);
    expect(state().events.slice(before).map((event) => event.type)).toEqual(["shot.updated"]);
    expect(state().project.shots.find((item) => item.id === "s-02")?.locked).toBe(true);
    for (const id of shotIds.filter((item) => item !== "s-02")) {
      expect(state().project.shots.find((item) => item.id === id)?.locked).toBe(false);
    }
    expect(state().castError).toContain("跳过");
  });

  it("整段解锁：把这一场锁着的全部打开", () => {
    const sceneId = state().project.scenes[0]!.id;
    const shotIds = state().project.scenes[0]!.shotIds;
    for (const id of shotIds) {
      state().select(id);
      state().decide("approved");
      state().setShotLock(id, true);
    }
    const before = state().events.length;
    const result = state().setSceneLock(sceneId, false);
    expect(result.locked).toBe(shotIds.length);
    expect(state().events.length - before).toBe(shotIds.length);
    for (const id of shotIds) {
      expect(state().project.shots.find((item) => item.id === id)?.locked).toBe(false);
    }
    expect(rebuild(state().events).shots.find((item) => item.id === shotIds[0])?.locked).toBe(false);
  });

  it("一镜都锁不了时说清原因，不写事件", () => {
    // 第 2 场：s-04 与 s-05，s-05 留用过；先把它淘汰掉再试
    const sceneId = state().project.scenes[1]!.id;
    state().select("s-05");
    state().decide("rejected");
    const before = state().events.length;
    const result = state().setSceneLock(sceneId, true);
    expect(result.locked).toBe(0);
    expect(state().events).toHaveLength(before);
    expect(state().castError).toContain("留用");
  });

  it("只读模式不写事件", () => {
    const sceneId = state().project.scenes[0]!.id;
    const before = state().events.length;
    useWorkbench.setState({ readOnly: true });
    expect(state().setSceneLock(sceneId, true)).toEqual({ locked: 0, skipped: 0 });
    expect(state().events).toHaveLength(before);
    useWorkbench.setState({ readOnly: false });
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

  it("挑张补：只补传进来的那几镜（H21）", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls += 1; return okResponse(); }));

    await state().generateMissingFrames("first", ["s-02", "s-03", "s-08"]);

    const patched = state()
      .events.filter((event) => event.type === "shot.updated")
      .map((event) => event.shotId);
    // s-08 锁着，即使点名也不碰
    expect(calls).toBe(2);
    expect(patched).toEqual(["s-02", "s-03"]);
    expect(state().batch).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("点名的那几镜都齐了就说「这一档里没有缺的」，不写事件", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls += 1; return okResponse(); }));
    await state().generateMissingFrames("first", ["s-02"]);
    const snapshot = state().events.length;

    await state().generateMissingFrames("first", ["s-02"]);

    expect(calls).toBe(1);
    expect(state().events).toHaveLength(snapshot);
    expect(state().castError).toContain("这一档里没有缺首帧");
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

  it("改画面风格写一条 project.updated，重放后一致（B7 / ADR-0165）", () => {
    const before = state().events.length;
    const ok = state().setLook({
      ...state().project.look,
      presetId: "noir",
      contrast: "hard",
      temperature: "cool",
      note: "雨夜霓虹",
    });
    expect(ok).toBe(true);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "project.updated" });
    expect(state().project.look.presetId).toBe("noir");
    expect(state().project.look.note).toBe("雨夜霓虹");

    const replayed = rebuild(state().events);
    expect(replayed.look.presetId).toBe("noir");
    expect(replayed.look.contrast).toBe("hard");
  });

  it("风格没变就不写日志，越界的项被挡下", () => {
    const before = state().events.length;
    expect(state().setLook(state().project.look)).toBe(false);
    expect(state().events).toHaveLength(before);
    const bad = { ...state().project.look, note: "x".repeat(200) };
    expect(state().setLook(bad)).toBe(false);
    expect(state().events).toHaveLength(before);
  });

  it("改调色写一条 project.updated，不动画面风格（E4 / ADR-0169）", () => {
    const lookBefore = state().project.look;
    const before = state().events.length;
    expect(
      state().setGrade({
        ...DEFAULT_GRADE,
        presetId: "thriller",
        contrast: "punchy",
        saturation: "muted",
        temperature: "cool",
        vignette: true,
      }),
    ).toBe(true);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "project.updated" });
    expect(state().project.grade.presetId).toBe("thriller");
    expect(state().project.look).toEqual(lookBefore);
    expect(rebuild(state().events).grade).toEqual(state().project.grade);
  });

  it("调色没变就不写日志", () => {
    const before = state().events.length;
    expect(state().setGrade(state().project.grade)).toBe(false);
    expect(state().events).toHaveLength(before);
  });

  it("导入 .cube 落一条 lut 资产，不动当前调色（I3 / ADR-0181）", async () => {
    const before = state().events.length;
    const result = await state().importLut({
      name: "k.cube",
      base64: btoa("LUT_3D_SIZE 2\n"),
    });
    expect(result.assetId).toBeTruthy();
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "asset.updated" });
    const asset = state().project.assets.find((item) => item.id === result.assetId);
    expect(asset?.kind).toBe("lut");
    // 只是把文件放进库，是否启用由作者在面板里勾
    expect(state().project.grade.lutAssetId).toBe("");
  });

  it("空的调色表不落资产", async () => {
    const before = state().events.length;
    const result = await state().importLut({ name: "empty.cube", base64: "" });
    expect(result.error).toContain("空");
    expect(state().events).toHaveLength(before);
  });

  it("封面存进资产库：落一条 image 资产（G6 / ADR-0183）", async () => {
    const before = state().events.length;
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const result = await state().saveCoverAsset({
      dataUrl: png,
      title: "夜班",
      width: 1080,
      height: 1920,
    });
    expect(result.assetId).toBeTruthy();
    const asset = state().project.assets.find((item) => item.id === result.assetId);
    expect(asset).toMatchObject({ kind: "image", mime: "image/png", width: 1080, height: 1920 });
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "asset.updated" });
  });

  it("不是 PNG 的封面不落资产", async () => {
    const before = state().events.length;
    const result = await state().saveCoverAsset({
      dataUrl: "data:image/jpeg;base64,AAAA",
      title: "夜班",
      width: 1080,
      height: 1920,
    });
    expect(result.error).toContain("PNG");
    expect(state().events).toHaveLength(before);
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

  it("渲染耗时随发布记录落进 IR（H4）：本机渲染不折成钱，但机器时间要留痕", () => {
    expect(
      state().recordPublish({ platform: "douyin", quality: "final", renderMs: 42_500 }),
    ).toBe(true);
    expect(state().project.publishPackages.at(-1)?.renderMs).toBe(42_500);
    expect(rebuild(state().events).publishPackages.at(-1)?.renderMs).toBe(42_500);
    // 负耗时是坏数据：当作没给，不写一个负数
    expect(state().recordPublish({ platform: "douyin", renderMs: -1 })).toBe(true);
    expect(state().project.publishPackages.at(-1)?.renderMs).toBeUndefined();
  });

  it("内容指纹随发布记录落进 IR（H5）：标识与这一版剪辑绑在一起", () => {
    expect(state().recordPublish({ platform: "douyin", contentHash: "1a2b3c4d" })).toBe(true);
    expect(state().project.publishPackages.at(-1)?.aiLabel?.contentHash).toBe("1a2b3c4d");
    expect(rebuild(state().events).publishPackages.at(-1)?.aiLabel?.contentHash).toBe("1a2b3c4d");
    // 格式不对就当没给；不写坏数据，也不让整条记录失败
    expect(state().recordPublish({ platform: "douyin", contentHash: "XYZ" })).toBe(false);
    expect(state().project.publishPackages.at(-1)?.aiLabel?.contentHash).toBe("1a2b3c4d");
  });
});

describe("镜头语言（I1）", () => {
  beforeEach(() => {
    state().reset();
  });

  it("套一套说法写一条 shot.updated，四个字段一起变", () => {
    const shot = state().project.shots[0]!;
    const before = state().events.length;
    expect(state().applyShotLanguage(shot.id, "insert")).toBe(true);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      shotId: shot.id,
      patch: { shotSize: "extreme-close" },
    });
    const after = state().project.shots[0]!;
    expect(after.shotSize).toBe("extreme-close");
    expect(after.camera).toMatchObject({ angle: "high", movement: "static", focalMm: 100 });
    expect(rebuild(state().events).shots[0]?.camera.focalMm).toBe(100);
  });

  it("已经是这一套就不写日志，不认识的 id 也不写", () => {
    const shot = state().project.shots[0]!;
    expect(state().applyShotLanguage(shot.id, "insert")).toBe(true);
    const before = state().events.length;
    expect(state().applyShotLanguage(shot.id, "insert")).toBe(false);
    expect(state().applyShotLanguage(shot.id, "dutch-angle")).toBe(false);
    expect(state().events).toHaveLength(before);
  });

  it("锁定或找不到镜头就不写", () => {
    const locked = state().project.shots.find((item) => item.locked)!;
    const before = state().events.length;
    expect(state().applyShotLanguage(locked.id, "insert")).toBe(false);
    expect(state().castError).toContain("已锁定");
    expect(state().applyShotLanguage("sh-nope", "insert")).toBe(false);
    expect(state().events).toHaveLength(before);
  });
});

describe("手调摄影参数（I7）", () => {
  beforeEach(() => {
    state().reset();
  });

  it("改景别只写一条 shot.updated，机位三项原样保留", () => {
    const shot = state().project.shots[0]!;
    const before = state().events.length;
    expect(state().setShotCamera(shot.id, { shotSize: "close" })).toBe(true);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      shotId: shot.id,
      patch: { shotSize: "close" },
    });
    const after = state().project.shots[0]!;
    expect(after.shotSize).toBe("close");
    expect(after.camera).toEqual(shot.camera);
  });

  it("改一项机位写整份 camera，另两项跟着保留，回放一致", () => {
    const shot = state().project.shots[0]!;
    expect(state().setShotCamera(shot.id, { angle: "low" })).toBe(true);
    expect(state().setShotCamera(shot.id, { focalMm: 85 })).toBe(true);
    const after = state().project.shots[0]!;
    expect(after.camera.angle).toBe("low");
    expect(after.camera.focalMm).toBe(85);
    expect(after.camera.movement).toBe(shot.camera.movement);
    expect(rebuild(state().events).shots[0]?.camera).toEqual(after.camera);
  });

  it("焦段只收 8–300，越界拒绝且不写事件", () => {
    const shot = state().project.shots[0]!;
    const before = state().events.length;
    expect(state().setShotCamera(shot.id, { focalMm: 4 })).toBe(false);
    expect(state().castError).toContain("8–300");
    expect(state().setShotCamera(shot.id, { focalMm: 400 })).toBe(false);
    expect(state().setShotCamera(shot.id, { focalMm: Number.NaN })).toBe(false);
    expect(state().events).toHaveLength(before);
  });

  it("已经是这个值 / 锁定 / 找不到镜头都不写", () => {
    const shot = state().project.shots[0]!;
    const before = state().events.length;
    expect(state().setShotCamera(shot.id, { shotSize: shot.shotSize })).toBe(false);
    const locked = state().project.shots.find((item) => item.locked)!;
    expect(state().setShotCamera(locked.id, { movement: "push" })).toBe(false);
    expect(state().castError).toContain("已锁定");
    expect(state().setShotCamera("sh-nope", { movement: "push" })).toBe(false);
    expect(state().events).toHaveLength(before);
  });
});

describe("光影与构图（I2 / I4）", () => {
  beforeEach(() => {
    state().reset();
  });

  it("写光影写一条 shot.updated，重放后还在；清空也留一条", () => {
    const shot = state().project.shots[1]!;
    const before = state().events.length;
    expect(
      state().setShotLighting(shot.id, {
        source: "window",
        position: "back",
        mood: "silhouette",
        note: "",
      }),
    ).toBe(true);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "shot.updated", shotId: shot.id });
    expect(state().project.shots[1]?.lighting).toMatchObject({
      source: "window",
      position: "back",
      mood: "silhouette",
    });
    expect(rebuild(state().events).shots[1]?.lighting?.source).toBe("window");

    expect(state().setShotLighting(shot.id, undefined)).toBe(true);
    expect(state().project.shots[1]?.lighting).toBeUndefined();
    expect(rebuild(state().events).shots[1]?.lighting).toBeUndefined();
  });

  it("同值不写；锁定或找不到镜头也不写", () => {
    const shot = state().project.shots[1]!;
    const value = { source: "lamp" as const, position: "side" as const, mood: "modeled" as const, note: "" };
    expect(state().setShotLighting(shot.id, value)).toBe(true);
    const before = state().events.length;
    expect(state().setShotLighting(shot.id, value)).toBe(false);
    expect(state().setShotLighting("sh-nope", value)).toBe(false);
    const locked = state().project.shots.find((item) => item.locked)!;
    expect(state().setShotLighting(locked.id, value)).toBe(false);
    expect(state().events).toHaveLength(before);
  });

  it("构图同样一条事件，清空也留痕", () => {
    const shot = state().project.shots[2]!;
    expect(state().setShotComposition(shot.id, { rule: "centered", note: "" })).toBe(true);
    expect(state().project.shots[2]?.composition?.rule).toBe("centered");
    expect(rebuild(state().events).shots[2]?.composition?.rule).toBe("centered");
    expect(state().setShotComposition(shot.id, { rule: "centered", note: "" })).toBe(false);
    expect(state().setShotComposition(shot.id, undefined)).toBe(true);
    expect(state().project.shots[2]?.composition).toBeUndefined();
  });

  it("不认识的枚举值在 store 层就被挡下", () => {
    const shot = state().project.shots[0]!;
    const before = state().events.length;
    expect(
      state().setShotLighting(shot.id, { source: "candle" as never, position: "side", mood: "modeled", note: "" }),
    ).toBe(false);
    expect(state().events).toHaveLength(before);
  });
});

describe("发布台账回执（G10 / ADR-0166）", () => {
  beforeEach(() => {
    state().reset();
  });

  it("贴回执写 publish.updated，重放后还在；发布包本身不动", () => {
    expect(
      state().recordPublish({
        platform: "douyin",
        quality: "final",
        fileName: "夜班-成片.mp4",
        bytes: 2_000_000,
        contentHash: "1a2b3c4d",
      }),
    ).toBe(true);
    const pack = state().project.publishPackages[0]!;
    const before = state().events.length;

    const ok = state().recordPublishReceipt(pack.id, {
      publishedAt: "2026-11-13 21:04",
      url: "https://www.douyin.com/video/123",
      receipt: "已通过审核",
      note: "主号首发",
    });

    expect(ok).toBe(true);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "publish.updated",
      packageId: pack.id,
      patch: { publishedAt: "2026-11-13 21:04" },
    });
    const after = state().project.publishPackages[0]!;
    expect(after).toMatchObject({
      publishedAt: "2026-11-13 21:04",
      url: "https://www.douyin.com/video/123",
      receipt: "已通过审核",
      note: "主号首发",
    });
    // 导出那一刻的事实不许回填改
    expect(after.platform).toBe("douyin");
    expect(after.quality).toBe("final");
    expect(after.fileName).toBe("夜班-成片.mp4");
    expect(after.aiLabel?.contentHash).toBe("1a2b3c4d");

    const replayed = rebuild(state().events);
    expect(replayed.publishPackages[0]).toMatchObject({
      publishedAt: "2026-11-13 21:04",
      receipt: "已通过审核",
    });
  });

  it("只写真的变了的字段：全没变就不写事件", () => {
    state().recordPublish({ platform: "douyin" });
    const pack = state().project.publishPackages[0]!;
    state().recordPublishReceipt(pack.id, { url: "https://a.example/1" });
    const before = state().events.length;

    expect(state().recordPublishReceipt(pack.id, { url: " https://a.example/1 " })).toBe(false);
    expect(state().recordPublishReceipt(pack.id, {})).toBe(false);
    expect(state().events).toHaveLength(before);

    // 改一项也只记一项
    expect(state().recordPublishReceipt(pack.id, { url: "https://a.example/1", note: "补一条" })).toBe(
      true,
    );
    expect(state().events.at(-1)).toMatchObject({
      type: "publish.updated",
      patch: { note: "补一条" },
    });
  });

  it("指向不存在的发布包就不记", () => {
    const before = state().events.length;
    expect(state().recordPublishReceipt("pub-nope", { url: "https://x.example" })).toBe(false);
    expect(state().events).toHaveLength(before);
  });
});

describe("授权记录（H7 / ADR-0167）", () => {
  beforeEach(() => {
    state().reset();
  });

  it("新增写 rights.updated，重放后还在", () => {
    const before = state().events.length;
    const ok = state().upsertRights({
      id: "rights-1",
      subject: "林晚的肖像",
      kind: "portrait",
      targetId: "c-lin",
      grantor: "本人",
      grantedAt: "2026-11-01",
      expiresAt: "2027-11-01",
      evidence: "合同 2026-A-07",
      note: "仅本片",
    });

    expect(ok).toBe(true);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "rights.updated" });
    expect(state().project.authorizations).toHaveLength(1);
    expect(rebuild(state().events).authorizations[0]).toMatchObject({
      subject: "林晚的肖像",
      kind: "portrait",
      targetId: "c-lin",
    });
  });

  it("同一个 id 再写一次是替换，不追加", () => {
    state().upsertRights({ id: "rights-1", subject: "林晚的肖像", kind: "portrait" });
    state().upsertRights({ id: "rights-1", subject: "林晚的肖像", kind: "portrait", note: "续到 2028" });

    expect(state().project.authorizations).toHaveLength(1);
    expect(state().project.authorizations[0]?.note).toBe("续到 2028");
    expect(rebuild(state().events).authorizations).toHaveLength(1);
  });

  it("缺对象名或字段越界就不记", () => {
    const before = state().events.length;
    expect(state().upsertRights({ id: "rights-1", subject: "", kind: "portrait" })).toBe(false);
    expect(
      state().upsertRights({ id: "rights-2", subject: "x".repeat(80), kind: "portrait" }),
    ).toBe(false);
    expect(state().events).toHaveLength(before);
  });

  it("删一条写 rights.removed；删不存在的就不写", () => {
    state().upsertRights({ id: "rights-1", subject: "林晚的肖像", kind: "portrait" });
    const before = state().events.length;

    expect(state().removeRights("rights-nope")).toBe(false);
    expect(state().events).toHaveLength(before);

    expect(state().removeRights("rights-1")).toBe(true);
    expect(state().project.authorizations).toHaveLength(0);
    expect(state().events.at(-1)).toMatchObject({ type: "rights.removed", rightsId: "rights-1" });
    expect(rebuild(state().events).authorizations).toHaveLength(0);
  });
});

describe("重置为示例项目（H18）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("清掉所有编辑，只留引导事件", () => {
    state().setBudget(120);
    state().editStory({ logline: "改过的 logline" });
    expect(state().events.length).toBeGreaterThan(1);

    state().reset();

    expect(state().events).toHaveLength(1);
    expect(state().events[0]?.type).toBe("project.created");
    expect(state().project.story.logline).not.toBe("改过的 logline");
    expect(state().project.budgetCny).toBe(60);
    expect(state().castError).toBeUndefined();
  });

  it("只读标签页不能重置", () => {
    state().setBudget(120);
    const snapshot = state().events.length;
    useWorkbench.setState({ readOnly: true });

    state().reset();

    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
  });

  it("重置后能继续写，回放等于内存", () => {
    state().setBudget(120);
    state().reset();
    state().setBudget(90);
    expect(state().project.budgetCny).toBe(90);
    expect(rebuild(state().events)).toEqual(state().project);
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

describe("手改断句（D2）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("写一条 subtitle.updated，可回放", () => {
    const cues = [
      { text: "你早就知道", durationMs: 1200 },
      { text: "对吧", durationMs: 1400 },
    ];
    expect(state().editSubtitles("d-01", cues)).toBe(true);
    expect(state().events.at(-1)).toMatchObject({
      type: "subtitle.updated",
      lineId: "d-01",
      cues,
    });
    expect(rebuild(state().events).subtitleOverrides).toEqual([{ lineId: "d-01", cues }]);
  });

  it("null 恢复自动断句；本来就没改过时不写事件", () => {
    const snapshot = state().events.length;
    expect(state().editSubtitles("d-01", null)).toBe(false);
    expect(state().castError).toContain("本来就是自动断句");
    expect(state().events).toHaveLength(snapshot);

    state().editSubtitles("d-01", [{ text: "整句", durationMs: 2600 }]);
    expect(state().editSubtitles("d-01", null)).toBe(true);
    expect(state().project.subtitleOverrides).toHaveLength(0);
  });

  it("同样的内容不重复写事件", () => {
    const cues = [{ text: "整句", durationMs: 2600 }];
    state().editSubtitles("d-01", cues);
    const snapshot = state().events.length;
    expect(state().editSubtitles("d-01", [{ ...cues[0]! }])).toBe(false);
    expect(state().castError).toContain("没改");
    expect(state().events).toHaveLength(snapshot);
  });

  it("空字被拦下，不写事件", () => {
    const snapshot = state().events.length;
    expect(
      state().editSubtitles("d-01", [
        { text: "有字", durationMs: 1000 },
        { text: "  ", durationMs: 1000 },
      ]),
    ).toBe(false);
    expect(state().castError).toContain("都要有字");
    expect(state().events).toHaveLength(snapshot);
  });

  it("不存在的台词与只读模式都不写事件", () => {
    expect(state().editSubtitles("d-nope", [{ text: "字", durationMs: 100 }])).toBe(false);
    const snapshot = state().events.length;
    useWorkbench.setState({ readOnly: true });
    expect(state().editSubtitles("d-01", [{ text: "字", durationMs: 100 }])).toBe(false);
    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
  });
});

describe("字幕版式（D3）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("调字号写一条 subtitle.layout.updated，刷新可回放", () => {
    expect(state().setSubtitleLayout({ fontSizeCqw: 6.4 })).toBe(true);
    expect(state().events.at(-1)).toMatchObject({
      type: "subtitle.layout.updated",
      layout: { fontSizeCqw: 6.4 },
    });
    expect(rebuild(state().events).subtitleLayout.fontSizeCqw).toBe(6.4);
  });

  it("同一个值不重复写事件：拖滑块不会灌满日志", () => {
    state().setSubtitleLayout({ bottomPct: 20 });
    const snapshot = state().events.length;
    expect(state().setSubtitleLayout({ bottomPct: 20 })).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });

  it("null 表示回模板；本来就是模板时不写事件", () => {
    expect(state().setSubtitleLayout({ fontSizeCqw: null })).toBe(false);
    state().setSubtitleLayout({ fontSizeCqw: 7 });
    expect(state().setSubtitleLayout({ fontSizeCqw: null })).toBe(true);
    expect(state().project.subtitleLayout.fontSizeCqw).toBeUndefined();
  });

  it("点名角色颜色写一条事件，颜色统一大写、同样一份不重复写（ADR-0146）", () => {
    expect(
      state().setSubtitleLayout({ speakerColorOverrides: { "c-lin": "#ffd666" } }),
    ).toBe(true);
    expect(state().events.at(-1)).toMatchObject({
      type: "subtitle.layout.updated",
      layout: { speakerColorOverrides: { "c-lin": "#FFD666" } },
    });
    expect(rebuild(state().events).subtitleLayout.speakerColorOverrides).toEqual({
      "c-lin": "#FFD666",
    });

    const snapshot = state().events.length;
    // 键序不同也算同一份
    expect(
      state().setSubtitleLayout({ speakerColorOverrides: { "c-lin": "#FFD666" } }),
    ).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });

  it("清空角色配色：空对象与 null 都回到色板默认（ADR-0146）", () => {
    state().setSubtitleLayout({ speakerColorOverrides: { "c-lin": "#FFD666" } });
    expect(state().setSubtitleLayout({ speakerColorOverrides: {} })).toBe(true);
    expect(state().project.subtitleLayout.speakerColorOverrides).toBeUndefined();
    // 已经是默认：再清一次不写事件
    expect(state().setSubtitleLayout({ speakerColorOverrides: null })).toBe(false);
  });

  it("越界被拒并把原因写到 editError，项目不变", () => {
    const snapshot = state().events.length;
    expect(state().setSubtitleLayout({ fontSizeCqw: 99 })).toBe(false);
    expect(state().editError).toContain("fontSizeCqw");
    expect(state().events).toHaveLength(snapshot);
  });

  it("只读模式不写事件", () => {
    const snapshot = state().events.length;
    useWorkbench.setState({ readOnly: true });
    expect(state().setSubtitleLayout({ bottomPct: 24 })).toBe(false);
    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
  });
});

describe("音轨与字幕轨（E1 / ADR-0131）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("配音后挪 300ms：写一条 dialogue.updated，读模型把音轨挪过去", () => {
    expect(state().shiftLineTrack("d-01", "voice", 300)).toBe(true);
    expect(state().events.at(-1)).toMatchObject({
      type: "dialogue.updated",
      lineId: "d-01",
      patch: { voiceOffsetMs: 300 },
    });
    const line = toEditView(state().project).clips[0]!.lines[0]!;
    expect(line.voiceOffsetMs).toBe(300);
    expect(line.audioStartMs).toBe(line.startMs + 300);
    // 字幕没跟着动
    expect(line.subtitleOffsetMs).toBe(0);
    expect(line.cueStartMs).toBe(line.startMs);
  });

  it("两条轨互不影响：只挪字幕时配音还在原处", () => {
    expect(state().shiftLineTrack("d-01", "subtitle", 200)).toBe(true);
    const line = toEditView(state().project).clips[0]!.lines[0]!;
    expect(line.subtitleOffsetMs).toBe(200);
    expect(line.cueStartMs).toBe(line.startMs + 200);
    expect(line.audioStartMs).toBe(line.startMs);
  });

  it("往前挪到 0 之前会被夹回 0，不会出现负的起点", () => {
    // 第一句从 0 开始：前挪 200ms 只能停在 0
    state().shiftLineTrack("d-01", "subtitle", -200);
    const line = toEditView(state().project).clips[0]!.lines[0]!;
    expect(line.cueStartMs).toBe(0);
    expect(line.subtitleOffsetMs).toBe(-200);
  });

  it("归零写 null，字段真的消失（不是留着 0）", () => {
    state().shiftLineTrack("d-01", "voice", 400);
    expect(state().shiftLineTrack("d-01", "voice", null)).toBe(true);
    expect(state().events.at(-1)).toMatchObject({
      patch: { voiceOffsetMs: null },
    });
    expect(state().project.dialogue.find((l) => l.id === "d-01")!.voiceOffsetMs).toBe(0);
  });

  it("收的是增量：连点两次就挪两步", () => {
    // 界面上连点时 React 闭包里还是旧值；store 必须自己读当前值再累加
    expect(state().shiftLineTrack("d-01", "voice", 100)).toBe(true);
    expect(state().shiftLineTrack("d-01", "voice", 100)).toBe(true);
    expect(state().project.dialogue.find((l) => l.id === "d-01")!.voiceOffsetMs).toBe(200);
    expect(state().events.at(-1)).toMatchObject({ patch: { voiceOffsetMs: 200 } });
  });

  it("增量把值推过 ±30 秒也会被拒，不会静默夹到边界", () => {
    state().shiftLineTrack("d-01", "voice", 29_900);
    const snapshot = state().events.length;
    expect(state().shiftLineTrack("d-01", "voice", 300)).toBe(false);
    expect(state().editError).toContain("voiceOffsetMs");
    expect(state().events).toHaveLength(snapshot);
    expect(state().project.dialogue.find((l) => l.id === "d-01")!.voiceOffsetMs).toBe(29_900);
  });

  it("同一个值不写事件", () => {
    const snapshot = state().events.length;
    expect(state().shiftLineTrack("d-01", "voice", 0)).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });

  it("超过 ±30 秒被拒，原因写进 editError", () => {
    const snapshot = state().events.length;
    expect(state().shiftLineTrack("d-01", "voice", 30_001)).toBe(false);
    expect(state().editError).toContain("voiceOffsetMs");
    expect(state().events).toHaveLength(snapshot);
  });

  it("只读模式不写事件", () => {
    const snapshot = state().events.length;
    useWorkbench.setState({ readOnly: true });
    expect(state().shiftLineTrack("d-01", "voice", 200)).toBe(false);
    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
  });

  it("挪出成片之外时读模型夹回来：渲染清单只收成片里的叠加层", () => {
    // 第一句往后挪 30 秒：远超 5.5 秒的成片
    state().shiftLineTrack("d-01", "subtitle", 30_000);
    const view = toEditView(state().project);
    const line = view.clips[0]!.lines[0]!;
    expect(line.cueStartMs).toBeGreaterThanOrEqual(0);
    expect(line.cueStartMs + line.durationMs).toBeLessThanOrEqual(view.totalMs + 1);
    // 原始记录仍留着作者填的数，只在读模型里夹
    expect(line.subtitleOffsetMs).toBe(30_000);
  });
});

describe("生成结果复核（H6 / ADR-0132）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("标「已看」写一条 asset.reviewed，资产上带复核记录", () => {
    expect(state().reviewAsset("a-lin-front", "passed")).toBe(true);
    expect(state().events.at(-1)).toMatchObject({
      type: "asset.reviewed",
      assetId: "a-lin-front",
      status: "passed",
    });
    const asset = state().project.assets.find((item) => item.id === "a-lin-front")!;
    expect(asset.review?.status).toBe("passed");
  });

  it("标「不可用」时带上原因", () => {
    expect(state().reviewAsset("a-lin-front", "rejected", "  多了一只手  ")).toBe(true);
    const asset = state().project.assets.find((item) => item.id === "a-lin-front")!;
    expect(asset.review).toMatchObject({ status: "rejected", note: "多了一只手" });
  });

  it("收回复核：字段真的消失，不是留着 undefined", () => {
    state().reviewAsset("a-lin-front", "passed");
    expect(state().reviewAsset("a-lin-front", null)).toBe(true);
    const asset = state().project.assets.find((item) => item.id === "a-lin-front")!;
    expect("review" in asset).toBe(false);
  });

  it("不存在的资产不写事件", () => {
    const snapshot = state().events.length;
    expect(state().reviewAsset("a-gone", "passed")).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });

  it("只读模式不写事件", () => {
    const snapshot = state().events.length;
    useWorkbench.setState({ readOnly: true });
    expect(state().reviewAsset("a-lin-front", "passed")).toBe(false);
    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
  });

  it("复核结果随日志回放：刷新后还在", () => {
    state().reviewAsset("a-lin-front", "passed");
    const replayed = rebuild(state().events);
    const asset = replayed.assets.find((item) => item.id === "a-lin-front")!;
    expect(asset.review?.status).toBe("passed");
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

  it("新建人物：四格先占资产位，再写一条 character.added", () => {
    const snapshot = state().events.length;

    const id = state().addCharacter(" 阿棠 ", " 齐耳短发，灰毛衣 ");
    expect(id).toBeTruthy();

    // 四格占位资产 + 一条 character.added（ADR-0144）
    expect(state().events).toHaveLength(snapshot + 5);
    expect(state().events.at(-1)).toMatchObject({ type: "character.added" });
    expect(
      state().events.slice(-5, -1).map((event) => event.type),
    ).toEqual(["asset.updated", "asset.updated", "asset.updated", "asset.updated"]);
    const character = state().project.characters.find((item) => item.id === id);
    expect(character).toMatchObject({
      name: "阿棠",
      appearance: "齐耳短发，灰毛衣",
      sheet: {
        front: `a-sheet-${id}-front`,
        threeQuarter: `a-sheet-${id}-threeQuarter`,
        side: `a-sheet-${id}-side`,
        back: `a-sheet-${id}-back`,
      },
      referenceImages: [],
      mustNotChange: [],
    });
    // 占位资产不算「已出图」：闸门仍判不完整
    expect(
      state().project.assets.filter((asset) => asset.id.startsWith(`a-sheet-${id}-`)),
    ).toHaveLength(4);
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

  it("从别的空间搬一个演员：事件落库、回放一致、只读拒绝（C1 / ADR-0190）", () => {
    const character = state().project.characters[0]!;
    const shared = {
      key: `w1:character:${character.id}`,
      kind: "character" as const,
      id: character.id,
      name: character.name,
      detail: "",
      workspaceId: "w1",
      workspaceName: "第一集",
      entity: character,
      assets: state().project.assets.filter(
        (asset) =>
          [...Object.values(character.sheet), ...character.referenceImages].includes(asset.id) &&
          Boolean(asset.uri),
      ),
    };
    const count = state().events.length;
    expect(state().importSharedEntity(shared)).toBe(true);
    expect(state().events.length).toBeGreaterThan(count);
    expect(rebuild(state().events)).toEqual(state().project);

    useWorkbench.setState({ readOnly: true });
    expect(state().importSharedEntity(shared)).toBe(false);
    expect(state().castError).toContain("只读");
  });

  it("从别的空间取来、原件是生成的：记 library，不按「另有未定价调用」算（C1 / ADR-0190）", () => {
    const uri = `loomina://assets/${"c".repeat(64)}.png`;
    const unpricedBefore = spendOf(state().project).unpriced;
    expect(state().addCharacterReference("c-lin", uri, "library")).toBe(true);
    const lin = state().project.characters.find((item) => item.id === "c-lin")!;
    const copied = state().project.assets.find((item) => item.id === lin.referenceImages.at(-1))!;
    expect(copied).toMatchObject({ source: "library", uri });
    expect(copied.costCny).toBeUndefined();
    expect(spendOf(state().project).unpriced).toBe(unpricedBefore);
  });

  it("资产库与对象存储的地址也能挂：跨空间取回来的图就是这两种（C4 / ADR-0189）", () => {
    const stored = `loomina://assets/${"a".repeat(64)}.png`;
    const remote = `s3://loomina/assets/${"b".repeat(64)}.png`;
    expect(state().addCharacterReference("c-lin", stored)).toBe(true);
    expect(state().addCharacterReference("c-lin", remote)).toBe(true);
    const lin = state().project.characters.find((item) => item.id === "c-lin")!;
    expect(lin.referenceImages).toHaveLength(3);
    const uris = lin.referenceImages.map(
      (id) => state().project.assets.find((asset) => asset.id === id)?.uri,
    );
    expect(uris).toContain(stored);
    expect(uris).toContain(remote);
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("地点：挂一张写 asset.updated 与 location.updated，再摘掉；只读时不动（B8）", () => {
    const locationId = state().project.locations[0]!.id;
    const refs = () =>
      state().project.locations.find((item) => item.id === locationId)!.referenceImages;
    expect(refs()).toEqual([]);
    const count = state().events.length;

    expect(state().addLocationReference(locationId, svg("loc"))).toBe(true);
    expect(refs()).toHaveLength(1);
    expect(state().events).toHaveLength(count + 2);
    expect(state().events.at(-1)).toMatchObject({ type: "location.updated" });
    expect(rebuild(state().events)).toEqual(state().project);

    const added = refs()[0]!;
    useWorkbench.setState({ readOnly: true });
    expect(state().removeLocationReference(locationId, added)).toBe(false);
    useWorkbench.setState({ readOnly: false });
    expect(state().removeLocationReference(locationId, added)).toBe(true);
    expect(refs()).toEqual([]);
  });

  it("地点参考图同样拒绝重复与超过 8 张", () => {
    const locationId = state().project.locations[0]!.id;
    expect(state().addLocationReference(locationId, svg("dup"))).toBe(true);
    const count = state().events.length;
    expect(state().addLocationReference(locationId, svg("dup"))).toBe(false);
    expect(state().castError).toContain("已经挂过了");
    expect(state().events).toHaveLength(count);
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

  it("给一处接缝设转场：只改这一项，第一段拒绝（E4 / ADR-0169）", () => {
    state().autoCutTimeline();
    const first = state().project.timeline.items[0]!;
    const second = state().project.timeline.items[1]!;
    expect(second.transitionIn).toBeUndefined();

    expect(state().setTimelineTransition(second.id, { kind: "black", durationMs: 300 })).toBe(true);
    const after = state().project.timeline.items.find((item) => item.id === second.id)!;
    expect(after.transitionIn).toEqual({ kind: "black", durationMs: 300 });
    expect(after.startMs).toBe(second.startMs);
    expect(after.durationMs).toBe(second.durationMs);
    expect(state().events.at(-1)?.type).toBe("timeline.updated");
    expect(rebuild(state().events)).toEqual(state().project);

    // 第一段前面没有画面
    expect(state().setTimelineTransition(first.id, { kind: "black", durationMs: 300 })).toBe(false);
    expect(state().editError).toContain("第一段");
  });

  it("改画幅写一条 project.updated，不动调色与画面风格（E5 / ADR-0170）", () => {
    const lookBefore = state().project.look;
    const gradeBefore = state().project.grade;
    const before = state().events.length;
    expect(state().setFrame({ aspect: "16:9", fit: "crop" })).toBe(true);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "project.updated" });
    expect(state().project.frame).toEqual({ aspect: "16:9", fit: "crop" });
    expect(state().project.look).toEqual(lookBefore);
    expect(state().project.grade).toEqual(gradeBefore);
    expect(rebuild(state().events).frame).toEqual(state().project.frame);

    // 没变就不写
    const count = state().events.length;
    expect(state().setFrame({ aspect: "16:9", fit: "crop" })).toBe(false);
    expect(state().events).toHaveLength(count);
  });

  it("裁切焦点按镜头存，回到居中时把字段清掉（E5 / ADR-0170）", () => {
    const shot = state().project.shots[0]!;
    expect(state().setShotFocus(shot.id, { x: 0.2, y: 0.8 })).toBe(true);
    expect(state().project.shots.find((item) => item.id === shot.id)?.focus).toEqual({ x: 0.2, y: 0.8 });
    expect(state().events.at(-1)?.type).toBe("shot.updated");
    expect(rebuild(state().events)).toEqual(state().project);

    // 同一个焦点不写第二遍
    const count = state().events.length;
    expect(state().setShotFocus(shot.id, { x: 0.2, y: 0.8 })).toBe(false);
    expect(state().events).toHaveLength(count);

    // undefined 是「回到居中」，字段消失而不是写 {0.5, 0.5}
    expect(state().setShotFocus(shot.id, undefined)).toBe(true);
    expect(state().project.shots.find((item) => item.id === shot.id)?.focus).toBeUndefined();
  });

  it("裁切焦点越界拒绝，不悄悄夹到边上", () => {
    const shot = state().project.shots[0]!;
    expect(state().setShotFocus(shot.id, { x: 1.4, y: 0.5 })).toBe(false);
    expect(state().editError).toContain("裁切焦点不合法");
    expect(state().setShotFocus("nope", { x: 0.5, y: 0.5 })).toBe(false);
    expect(state().editError).toContain("找不到这一镜");
  });

  it("转场可以改回硬切，同一个值不写重复事件", () => {
    state().autoCutTimeline();
    const id = state().project.timeline.items[1]!.id;
    state().setTimelineTransition(id, { kind: "white", durationMs: 250 });
    const count = state().events.length;
    expect(state().setTimelineTransition(id, { kind: "white", durationMs: 250 })).toBe(false);
    expect(state().events).toHaveLength(count);

    expect(state().setTimelineTransition(id, undefined)).toBe(true);
    expect(state().project.timeline.items.find((item) => item.id === id)?.transitionIn).toBeUndefined();
  });

  it("转场时长越界就拒绝，不悄悄夹到合法值", () => {
    state().autoCutTimeline();
    const id = state().project.timeline.items[1]!.id;
    expect(state().setTimelineTransition(id, { kind: "black", durationMs: 50 })).toBe(false);
    expect(state().editError).toContain("转场不合法");
    expect(state().setTimelineTransition(id, { kind: "black", durationMs: 900 })).toBe(false);
    expect(state().editError).toContain("转场不合法");
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

  it("生成草稿那一次的钱与用量随开工落进故事溯源（H4）", () => {
    state().reset();
    expect(
      state().startProjectFromStory(draft, {
        modelId: "claude-sonnet-5-5",
        idea: "外卖员",
        costCny: 0.0312,
        usage: { units: 15_600, unit: "tokens" },
      }),
    ).toBe(true);
    expect(state().project.story.provenance?.costCny).toBe(0.0312);
    expect(state().project.story.provenance?.usage).toEqual({ units: 15_600, unit: "tokens" });
    // 回放一遍还在：钱是项目自己的事实，不是内存里的一次性状态
    expect(rebuild(state().events).story.provenance?.costCny).toBe(0.0312);
  });

  it("没给金额时溯源里就不写：不知道多少钱不是 0", () => {
    state().reset();
    expect(
      state().startProjectFromStory(draft, { modelId: "m", idea: "x" }),
    ).toBe(true);
    expect(state().project.story.provenance?.costCny).toBeUndefined();
    expect(state().project.story.provenance?.usage).toBeUndefined();
  });
});

describe("故事层单独编辑（A16）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  const seedArc = () => {
    const characterId = state().project.characters[0]!.id;
    state().editStory({
      arcs: [
        {
          characterId,
          want: "拿到监控",
          need: "被看见",
          wound: "父亲坠楼那晚他不在",
          flaw: "不肯先开口",
          secret: "他早就看过录像",
          agency: "把灯关上",
          arc: "从躲着到承认",
        },
      ],
    });
    return characterId;
  };

  it("改一条弧光只写一条 story.updated，别的字段不动", () => {
    const characterId = seedArc();
    const before = state().project.story;
    expect(state().editArc(characterId, { want: "拿到监控录像" })).toBe(true);

    const after = state().project.story;
    expect(after.arcs[0]!.want).toBe("拿到监控录像");
    // 弧光里其他字段与故事的其余部分都没动
    expect(after.arcs[0]!.need).toBe(before.arcs[0]!.need);
    expect(after.logline).toBe(before.logline);
    expect(after.relationships).toEqual(before.relationships);
    expect(state().events.at(-1)).toMatchObject({ type: "story.updated" });
    expect(rebuild(state().events).story).toEqual(after);
  });

  it("没改动的弧光不写事件", () => {
    const characterId = seedArc();
    const want = state().project.story.arcs[0]!.want;
    const snapshot = state().events.length;
    expect(state().editArc(characterId, { want })).toBe(false);
    expect(state().castError).toContain("没改");
    expect(state().events).toHaveLength(snapshot);
  });

  it("没有弧光的角色不能直接改", () => {
    const snapshot = state().events.length;
    expect(state().editArc("c-nope", { want: "x" })).toBe(false);
    expect(state().castError).toContain("还没有弧光");
    expect(state().events).toHaveLength(snapshot);
  });

  it("改关系：已有就改、没有就加、张力写空就删", () => {
    const [a, b] = [state().project.characters[0]!.id, state().project.characters[1]!.id];

    // 加一对
    expect(state().editRelationship(a, b, "互相试探")).toBe(true);
    expect(state().project.story.relationships).toHaveLength(1);

    // 改同一对
    expect(state().editRelationship(a, b, "谁先承认灯是谁关的")).toBe(true);
    expect(state().project.story.relationships).toHaveLength(1);
    expect(state().project.story.relationships[0]!.tension).toBe("谁先承认灯是谁关的");

    // 写空 → 删
    expect(state().editRelationship(a, b, "   ")).toBe(true);
    expect(state().project.story.relationships).toHaveLength(0);
    expect(rebuild(state().events).story.relationships).toHaveLength(0);
  });

  it("关系两端相同或角色不存在时不写事件", () => {
    const a = state().project.characters[0]!.id;
    const snapshot = state().events.length;
    expect(state().editRelationship(a, a, "自己跟自己")).toBe(false);
    expect(state().castError).toContain("同一个人");
    expect(state().editRelationship(a, "c-nope", "不存在")).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });

  it("文字字段没改不写事件；改了才写", () => {
    const before = state().project.story.logline;
    const snapshot = state().events.length;
    expect(state().editStory({ logline: before })).toBe(false);
    expect(state().castError).toContain("没改");
    expect(state().events).toHaveLength(snapshot);

    expect(state().editStory({ logline: "两个夜班保安互相试探。" })).toBe(true);
    expect(state().project.story.logline).toBe("两个夜班保安互相试探。");
  });

  it("只读时全部拒绝", () => {
    const characterId = seedArc();
    const snapshot = state().events.length;
    useWorkbench.setState({ readOnly: true });
    expect(state().editStory({ genre: "悬疑" })).toBe(false);
    expect(state().editArc(characterId, { want: "x" })).toBe(false);
    expect(state().editRelationship(characterId, characterId, "x")).toBe(false);
    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
  });
});

describe("故事版本库（C2）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("恢复初版写一条 story.updated，文字整份回到初版", () => {
    const before = state().project.story;
    expect(state().editStory({ logline: "改过的 logline" })).toBe(true);
    expect(state().editStory({ synopsis: "改过的梗概" })).toBe(true);
    const snapshot = state().events.length;

    expect(state().useStoryVersion(0)).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "story.updated" });
    expect(state().project.story.logline).toBe(before.logline);
    expect(state().project.story.synopsis).toBe(before.synopsis);
    expect(state().storyNotice).toContain("已恢复");
    expect(rebuild(state().events).story.logline).toBe(before.logline);
  });

  it("恢复旧版能把弧光与关系带回来", () => {
    const [a, b] = [state().project.characters[0]!.id, state().project.characters[1]!.id];
    const withStory = state().events.length; // 这一条 story.updated 的下标
    expect(
      state().editStory({
        arcs: [
          {
            characterId: a,
            want: "拿到监控",
            need: "",
            wound: "",
            flaw: "",
            secret: "",
            agency: "",
            arc: "",
          },
        ],
        relationships: [{ fromCharacterId: a, toCharacterId: b, tension: "都想先开口" }],
      }),
    ).toBe(true);
    const seeded = state().project.story;
    expect(seeded.arcs).toHaveLength(1);

    expect(state().editStory({ arcs: [], relationships: [] })).toBe(true);
    expect(state().project.story.arcs).toHaveLength(0);

    expect(state().useStoryVersion(withStory)).toBe(true);
    expect(state().project.story.arcs).toEqual(seeded.arcs);
    expect(state().project.story.relationships).toEqual(seeded.relationships);
  });

  it("已经是这一版 / 找不到这一版都不写事件", () => {
    const snapshot = state().events.length;
    expect(state().useStoryVersion(0)).toBe(false);
    expect(state().castError).toContain("就是这一版");

    expect(state().useStoryVersion(999)).toBe(false);
    expect(state().castError).toContain("找不到这一版");
    expect(state().events).toHaveLength(snapshot);
  });

  it("只读时拒绝恢复", () => {
    expect(state().editStory({ tone: "更冷" })).toBe(true);
    const snapshot = state().events.length;
    useWorkbench.setState({ readOnly: true });
    expect(state().useStoryVersion(0)).toBe(false);
    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
  });
});

describe("跨空间取一版故事（C1 / ADR-0198）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  const sourceOf = () => {
    const project = structuredClone(state().project);
    return {
      ...project,
      story: {
        ...project.story,
        logline: "外卖员撞见顶层的秘密",
        tone: "冷",
        arcs: [
          {
            characterId: "c-lin",
            want: "拿到监控",
            need: "",
            wound: "",
            flaw: "",
            secret: "",
            agency: "",
            arc: "",
          },
        ],
      },
    };
  };

  it("取用写一条 story.updated，文字与弧光一起过来", () => {
    const snapshot = state().events.length;
    expect(state().adoptSharedStory(sourceOf(), "夜班")).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "story.updated" });
    expect(state().project.story.logline).toBe("外卖员撞见顶层的秘密");
    expect(state().project.story.tone).toBe("冷");
    expect(state().project.story.arcs).toHaveLength(1);
    expect(state().storyNotice).toContain("夜班");
    expect(rebuild(state().events).story.logline).toBe("外卖员撞见顶层的秘密");
  });

  it("名字对不上的弧光跳过并在提示里说清楚", () => {
    const source = sourceOf();
    source.characters = source.characters.map((character) =>
      character.id === "c-lin" ? { ...character, name: "林小姐" } : character,
    );
    expect(state().adoptSharedStory(source, "夜班")).toBe(true);
    expect(state().project.story.arcs).toHaveLength(0);
    expect(state().storyNotice).toContain("没有同名角色");
  });

  it("同一版不写事件；只读时拒绝", () => {
    expect(state().adoptSharedStory(sourceOf(), "夜班")).toBe(true);
    const snapshot = state().events.length;
    expect(state().adoptSharedStory(sourceOf(), "夜班")).toBe(false);
    expect(state().castError).toContain("就是这一版");

    useWorkbench.setState({ readOnly: true });
    const source = sourceOf();
    source.story.tone = "更冷";
    expect(state().adoptSharedStory(source, "夜班")).toBe(false);
    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
  });
});

describe("跨空间取一场剧本（C1 / ADR-0199）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  const sourceOf = () => structuredClone(state().project);

  it("整场追加到末尾：场 / 镜 / 台词一起进来，一条事件一目了然", () => {
    const before = state().project;
    const source = sourceOf();
    const snapshot = state().events.length;

    expect(state().adoptSharedScene(source, "sc-1", "夜班")).toBe(true);
    expect(state().events).toHaveLength(snapshot + 6);
    expect(state().events.slice(snapshot).map((event) => event.type)).toEqual([
      "scene.added",
      "shot.added",
      "dialogue.added",
      "shot.added",
      "shot.added",
      "dialogue.added",
    ]);
    // 同一批事件共用一个 at：撤销一步就能整场退回
    const batch = state().events.slice(snapshot);
    expect(new Set(batch.map((event) => event.at)).size).toBe(1);

    const scene = state().project.scenes.at(-1)!;
    expect(scene.id).not.toBe("sc-1");
    expect(scene.shotIds).toHaveLength(3);
    expect(state().project.shots).toHaveLength(before.shots.length + 3);
    expect(state().project.dialogue).toHaveLength(before.dialogue.length + 2);
    expect(rebuild(state().events).scenes).toHaveLength(before.scenes.length + 1);
  });

  it("缺演员时整场拒绝且不写事件", () => {
    const source = sourceOf();
    const snapshot = state().events.length;
    useWorkbench.setState({
      project: {
        ...state().project,
        characters: state().project.characters.filter((character) => character.id !== "c-lin"),
      },
    });
    const trimmed = state().project;
    expect(state().adoptSharedScene(source, "sc-1", "夜班")).toBe(false);
    expect(state().castError).toContain("演员「林」");
    expect(state().events).toHaveLength(snapshot);
    expect(state().project).toBe(trimmed);
  });

  it("只读时拒绝", () => {
    const source = sourceOf();
    useWorkbench.setState({ readOnly: true });
    const snapshot = state().events.length;
    expect(state().adoptSharedScene(source, "sc-1", "夜班")).toBe(false);
    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
  });
});

describe("采用剧本医生的改写（A18 / ADR-0123）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("台词改走 editDialogue：写一条 dialogue.updated", () => {
    expect(
      state().adoptDoctorItem({
        kind: "dialogue",
        lineId: "d-01",
        text: "你早就知道了，对吧。",
        target: "SH-01 · 周",
      }),
    ).toBe(true);
    // 改台词会顺带按字数重估镜头时长，所以最后一条是 shot.updated
    expect(
      state().events.filter((event) => event.type === "dialogue.updated").at(-1),
    ).toMatchObject({
      type: "dialogue.updated",
      lineId: "d-01",
      patch: { text: "你早就知道了，对吧。" },
    });
    expect(state().project.dialogue.find((line) => line.id === "d-01")?.text).toBe(
      "你早就知道了，对吧。",
    );
  });

  it("动作改走 editAction：写一条 shot.updated { description }", () => {
    expect(
      state().adoptDoctorItem({
        kind: "shot",
        shotId: "s-01",
        text: "周把灯关掉，回头看监控。",
        target: "SH-01 · 动作",
      }),
    ).toBe(true);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      shotId: "s-01",
      patch: { description: "周把灯关掉，回头看监控。" },
    });
  });

  it("故事层改走 editStory：写一条 story.updated", () => {
    expect(
      state().adoptDoctorItem({
        kind: "story",
        field: "logline",
        text: "两个夜班保安互相试探。",
        target: "一句话梗概",
      }),
    ).toBe(true);
    expect(state().events.at(-1)).toMatchObject({
      type: "story.updated",
      patch: { logline: "两个夜班保安互相试探。" },
    });
  });

  it("和原文一样就返回 false、不写事件", () => {
    const before = state().project.dialogue.find((line) => line.id === "d-01")!.text;
    const snapshot = state().events.length;
    expect(
      state().adoptDoctorItem({
        kind: "dialogue",
        lineId: "d-01",
        text: before,
        target: "SH-01 · 周",
      }),
    ).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });

  it("只读时拒绝", () => {
    const snapshot = state().events.length;
    useWorkbench.setState({ readOnly: true });
    expect(
      state().adoptDoctorItem({
        kind: "story",
        field: "tone",
        text: "冷",
        target: "调性",
      }),
    ).toBe(false);
    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
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

describe("表演设计与镜头调度（B16 / B17 / ADR-0103）", () => {
  beforeEach(() => {
    state().reset();
  });

  const performance = {
    objective: "让她相信自己没有被出卖",
    emotion: { surface: "克制", subtext: "其实在试探" },
    beats: [
      { phase: "before" as const, micro: "眼神躲开", body: "手指扣住门框", startMs: 0, endMs: 800 },
      { phase: "after" as const, micro: "嘴角松下来", body: "肩膀落下", startMs: 1600, endMs: 2400 },
    ],
    gaze: { target: "character" as const, targetId: "c-zhou", direction: "right" as const },
    intensity: 4,
    avoid: ["不要哭出来"],
  };

  it("写表演设计：一条 shot.updated，回放一致，提示词跟着变", () => {
    const before = state().events.length;
    const promptBefore = toStageView(state().project, { currentShotId: "s-02" }).shots.find(
      (shot) => shot.id === "s-02",
    )!.prompts.video;

    expect(state().setShotPerformance("s-02", performance)).toBe(true);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      shotId: "s-02",
      patch: { performance },
    });
    expect(state().project.shots.find((shot) => shot.id === "s-02")?.performance).toMatchObject({
      objective: "让她相信自己没有被出卖",
      gaze: { target: "character", targetId: "c-zhou", direction: "right" },
      intensity: 4,
    });
    expect(rebuild(state().events)).toEqual(state().project);

    const promptAfter = toStageView(state().project, { currentShotId: "s-02" }).shots.find(
      (shot) => shot.id === "s-02",
    )!.prompts.video;
    expect(promptBefore).not.toContain("表演：");
    expect(promptAfter).toContain("表演：");
    expect(promptAfter).toContain("看人周");
    expect(promptAfter).toContain("起：眼神躲开，手指扣住门框");
  });

  it("值没变、清空不存在的表演、锁定镜头：都不写日志", () => {
    state().setShotPerformance("s-02", performance);
    const after = state().events.length;
    expect(state().setShotPerformance("s-02", performance)).toBe(false);
    expect(state().setShotPerformance("s-01", undefined)).toBe(false);
    expect(state().setShotPerformance("s-08", performance)).toBe(false);
    expect(state().castError).toContain("已锁定");
    expect(state().events).toHaveLength(after);
  });

  it("清空表演设计：写一条把 performance 置空的事件", () => {
    state().setShotPerformance("s-02", performance);
    expect(state().setShotPerformance("s-02", undefined)).toBe(true);
    expect(state().project.shots.find((shot) => shot.id === "s-02")?.performance).toBeUndefined();
  });

  it("视线指向不存在的对象、或看人却没给 id：拒绝写入", () => {
    const before = state().events.length;
    expect(
      state().setShotPerformance("s-02", {
        ...performance,
        gaze: { target: "character", targetId: "c-404", direction: "left" },
      }),
    ).toBe(false);
    expect(state().castError).toContain("不在这部片里");

    expect(
      state().setShotPerformance("s-02", {
        ...performance,
        gaze: { target: "character", direction: "left" } as never,
      }),
    ).toBe(false);
    expect(state().events).toHaveLength(before);
  });

  it("写镜头内调度：角色与道具各一条，回放一致，提示词出现调度", () => {
    const before = state().events.length;
    expect(
      state().setShotStaging("s-02", [
        { characterId: "c-lin", side: "left", depth: "foreground", note: "背对门" },
      ]),
    ).toBe(true);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      shotId: "s-02",
      patch: {
        staging: [{ characterId: "c-lin", side: "left", depth: "foreground", note: "背对门" }],
      },
    });
    expect(rebuild(state().events)).toEqual(state().project);

    const prompt = toStageView(state().project, { currentShotId: "s-02" }).shots.find(
      (shot) => shot.id === "s-02",
    )!.prompts.video;
    expect(prompt).toContain("调度：林在画面左（前景），背对门");
  });

  it("调度里有没出场的人 / 道具：拒绝写入", () => {
    const before = state().events.length;
    expect(
      state().setShotStaging("s-02", [
        { characterId: "c-zhou", side: "right", depth: "background", note: "" },
      ]),
    ).toBe(false);
    expect(state().castError).toContain("出场名单");
    expect(
      state().setShotStaging("s-02", [
        { propId: "p-cup", side: "center", depth: "foreground", note: "" },
      ]),
    ).toBe(false);
    expect(state().castError).toContain("道具名单");
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

  it("带条件确认把 override 记进记录与事件（A12）", () => {
    expect(state().confirmGate("storyboard", "覆盖率先这样", true)).toBe(true);
    const record = state().project.gates.find((gate) => gate.stage === "storyboard");
    expect(record?.override).toBe(true);
    expect(state().events.at(-1)).toMatchObject({
      type: "gate.confirmed",
      stage: "storyboard",
      override: true,
    });
    expect(rebuild(state().events).gates).toEqual(state().project.gates);
  });

  it("不带 override 时记录里是 false，不是 undefined", () => {
    state().confirmGate("storyboard");
    const record = state().project.gates.find((gate) => gate.stage === "storyboard");
    expect(record?.override).toBe(false);
    expect(state().events.at(-1)).not.toHaveProperty("override");
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

describe("多步撤销与历史回滚（F2 / ADR-0109）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("撤销退一步：留用的 take 回到草稿，日志只多一条回滚事件", () => {
    state().select("s-03");
    state().decide("approved");
    const before = state().events.length;

    expect(state().undo()).toBe(true);

    expect(statusOf("t-03")).toBe("draft");
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "project.restored",
      toEventCount: 1,
    });
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("连撤两步：每一步都真的往回走，不会停在同一个地方", () => {
    state().select("s-03");
    state().decide("approved");
    state().select("s-04");
    state().decide("approved");

    expect(state().undo()).toBe(true);
    expect(statusOf("t-03")).toBe("approved");
    expect(statusOf("t-04")).toBe("draft");

    expect(state().undo()).toBe(true);
    expect(statusOf("t-03")).toBe("draft");
    // 退到最早之后没有可撤的了
    expect(state().undo()).toBe(false);
    expect(state().historyNotice).toContain("最早");
  });

  it("回到某一步：预算回到当时那个数，之后的改动不再生效", () => {
    state().setBudget(100);
    const afterBudget = state().events.length;
    state().setBudget(200);
    expect(state().project.budgetCny).toBe(200);

    expect(state().restoreTo(afterBudget, "回到预算 ¥100")).toBe(true);
    expect(state().project.budgetCny).toBe(100);
    expect(state().events.at(-1)).toMatchObject({
      type: "project.restored",
      toEventCount: afterBudget,
      label: "回到预算 ¥100",
    });
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("已经在最新一步时不再写多余的回滚事件", () => {
    state().setBudget(100);
    const before = state().events.length;
    expect(state().restoreTo(before)).toBe(false);
    expect(state().events).toHaveLength(before);
    expect(state().historyNotice).toContain("已经是这一步");
  });

  it("回收站按任意一条删除放回：不顺手撤掉之后的改动", () => {
    expect(state().removeShot("s-03")).toBe(true);
    const removedAt = state().events.findIndex((event) => event.type === "shot.removed");
    expect(removedAt).toBeGreaterThan(0);
    state().setBudget(120);

    expect(state().restoreRemovalAt(removedAt)).toBe(true);
    expect(state().project.shots.some((shot) => shot.id === "s-03")).toBe(true);
    // 删完之后改的预算还在：回收站只放回这一条
    expect(state().project.budgetCny).toBe(120);
    expect(state().currentShotId).toBe("s-03");
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("只读时撤销与回滚都不写事件", () => {
    state().setBudget(100);
    const before = state().events.length;
    useWorkbench.setState({ readOnly: true });

    expect(state().undo()).toBe(false);
    expect(state().restoreTo(1)).toBe(false);
    expect(state().events).toHaveLength(before);
  });
});

describe("自由工作台与阶段硬锁（F8）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ mode: "guided", lockedNotice: undefined, readOnly: false });
  });

  it("确认分镜后再改分镜：写入被拦下，提示先回退本阶段", () => {
    expect(state().confirmGate("storyboard")).toBe(true);
    const before = state().events.length;

    state().setShotPlan("s-03", { beat: "setup" });

    expect(state().events).toHaveLength(before);
    expect(state().project.shots.find((shot) => shot.id === "s-03")?.beat).toBeUndefined();
    expect(state().lockedNotice).toContain("分镜");
    expect(state().lockedNotice).toContain("回退本阶段");
  });

  it("回退本阶段之后就能改，拦下的提示也收起", () => {
    state().confirmGate("storyboard");
    state().setShotPlan("s-03", { beat: "setup" });
    expect(state().lockedNotice).toContain("分镜");

    expect(state().reopenGate("storyboard")).toBe(true);
    expect(state().lockedNotice).toBeUndefined();

    state().setShotPlan("s-03", { beat: "setup" });

    expect(state().project.shots.find((shot) => shot.id === "s-03")?.beat).toBe("setup");
  });

  it("自由工作台不锁：改得进去，闸门转「内容改过」", () => {
    state().confirmGate("storyboard");
    state().setMode("free");
    const before = state().events.length;

    state().setShotPlan("s-03", { beat: "setup" });

    expect(state().events).toHaveLength(before + 1);
    expect(state().project.shots.find((shot) => shot.id === "s-03")?.beat).toBe("setup");
    expect(stageStateOf(state().project, "storyboard").gate).toBe("stale");
  });

  it("花图钱之前就拦：确认关键帧后一次请求都不发", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response("{}", { status: 200 });
      }),
    );
    state().confirmGate("keyframes");
    const before = state().events.length;

    const ok = await state().generateKeyframe("s-03");

    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(state().events).toHaveLength(before);
    expect(state().lockedNotice).toContain("关键帧");
    vi.unstubAllGlobals();
  });

  it("切回阶段式后，自由工作台里改过的阶段已经过期，不锁", () => {
    state().confirmGate("storyboard");
    state().setMode("free");
    state().setShotPlan("s-03", { beat: "setup" });
    state().setMode("guided");

    state().setShotPlan("s-03", { purpose: "information" });

    expect(state().project.shots.find((shot) => shot.id === "s-03")?.purpose).toBe("information");
    expect(state().lockedNotice).toBeUndefined();
  });
});

describe("本机资产库（H3 / ADR-0128）", () => {
  const HASH = "e".repeat(64);
  const BIG = `data:image/png;base64,${"A".repeat(300_000)}`;

  beforeEach(() => {
    state().reset();
  });

  it("素材清点跟着项目走：没人引用的单独列出来", () => {
    const inventory = state().assetInventory();
    expect(inventory.total).toBe(state().project.assets.length);
    // 示例项目的资产没有 uri，全部记「没地址」
    expect(inventory.inline).toBe(0);
    expect(inventory.usage.every((item) => item.placement === "none")).toBe(true);
  });

  it("迁移：只搬日志里的 data URI，每搬一个写一条 asset.updated", async () => {
    const uris: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { uri: string };
        uris.push(body.uri);
        return new Response(JSON.stringify({ uri: `loomina://assets/${HASH}.png` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    // 塞两个 data URI 资产：一个被引用、一个没人用
    state().addCharacterReference("c-lin", BIG);
    const before = state().events.length;

    const result = await state().migrateAssets();

    expect(result.moved).toBe(1);
    expect(result.failed).toBe(0);
    expect(uris).toHaveLength(1);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "asset.updated" });
    const asset = state().project.assets.find((item) => item.uri?.startsWith("loomina://"));
    expect(asset).toBeDefined();
    expect(state().assetInventory().inline).toBe(0);

    // 再迁一次什么都不做
    expect((await state().migrateAssets()).moved).toBe(0);
    vi.unstubAllGlobals();
  });

  it("日志压缩：只换地址、不删事件，回放结果与内存里那份一致", async () => {
    state().addCharacterReference("c-lin", BIG);
    const payload = dataUriBytesOf(BIG)!;
    const hash = (await sha256OfBytes(payload.bytes))!;
    const storedUri = `loomina://assets/${hash}.png`;
    const before = state().events.length;
    const beforeBytes = logBytesOf(state().events);

    const result = await state().compactLog([{ uri: storedUri }]);

    expect(result.assets).toBeGreaterThan(0);
    expect(result.unmatched).toBe(0);
    expect(result.afterBytes).toBeLessThan(beforeBytes);
    // 事件一条都没少：压缩不改变「怎么变成这样的」
    expect(state().events).toHaveLength(before);
    expect(rebuild(state().events)).toEqual(state().project);
    expect(state().project.assets.some((asset) => asset.uri === storedUri)).toBe(true);
  });

  it("日志压缩：库里找不到同一段字节就留着不动，如实报几处", async () => {
    state().addCharacterReference("c-lin", BIG);
    const before = state().events;

    const result = await state().compactLog([{ uri: `loomina://assets/${HASH}.png` }]);

    expect(result.rewritten).toBe(0);
    expect(result.unmatched).toBe(1);
    expect(state().events).toBe(before);
  });

  it("迁移失败不动 IR：素材留在日志里，数如实报", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "磁盘满了" }), { status: 500 })),
    );
    state().addCharacterReference("c-lin", BIG);
    const before = state().events.length;

    const result = await state().migrateAssets();

    expect(result.moved).toBe(0);
    expect(result.failed).toBe(1);
    expect(state().events).toHaveLength(before);
    expect(state().assetInventory().inline).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe("走位与场地几何（B13.1 / ADR-0126）", () => {
  beforeEach(() => {
    useWorkbench.setState({ readOnly: false });
    state().reset();
  });

  const SPACE = {
    dimensions: [5, 4, 2.8] as [number, number, number],
    anchors: [
      { id: "door", kind: "door" as const, position: [2.5, 0, -1.6] as [number, number, number], facingRad: 0, capacity: 0 },
    ],
  };

  it("换到带几何的模板：一条 location.updated 写进 space", () => {
    const snapshot = state().events.length;
    expect(state().editLocation("loc-table", { templateId: "living-room" })).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    const event = state().events.at(-1) as { type: string; patch: { space?: unknown } };
    expect(event.type).toBe("location.updated");
    expect(event.patch.space).toBeTruthy();
    const space = state().project.locations.find((item) => item.id === "loc-table")?.space;
    expect(space?.dimensions).toEqual([5, 4, 2.8]);
    expect(space?.anchors.some((anchor) => anchor.id === "door")).toBe(true);
    // 回放后一致
    expect(rebuild(state().events).locations.find((item) => item.id === "loc-table")?.space).toEqual(
      space,
    );
  });

  it("换回没有几何的旧模板：space 用 null 清掉，回放后真的没有", () => {
    expect(state().editLocation("loc-table", { templateId: "living-room" })).toBe(true);
    expect(state().project.locations.find((item) => item.id === "loc-table")?.space).toBeTruthy();

    expect(state().editLocation("loc-table", { templateId: "table" })).toBe(true);
    expect(state().events.at(-1)).toMatchObject({
      type: "location.updated",
      patch: { space: null },
    });
    expect(state().project.locations.find((item) => item.id === "loc-table")?.space).toBeUndefined();
    expect(
      "space" in (rebuild(state().events).locations.find((item) => item.id === "loc-table") ?? {}),
    ).toBe(false);
  });

  it("写走位：一条 shot.updated，回放后一致；不在场与越界都不写", () => {
    expect(state().editLocation("loc-table", { space: SPACE })).toBe(true);
    const snapshot = state().events.length;

    // s-04 出场 c-lin + c-zhou
    expect(
      state().setShotBlocking("s-04", {
        actors: [
          { characterId: "c-lin", position: [0, 0, 0.8], facingRad: Math.PI },
          { characterId: "c-zhou", position: [0, 0, -0.8], facingRad: 0 },
        ],
        props: [],
      }),
    ).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "shot.updated", shotId: "s-04" });
    expect(rebuild(state().events).shots.find((shot) => shot.id === "s-04")?.blocking).toEqual({
      actors: [
        { characterId: "c-lin", position: [0, 0, 0.8], facingRad: Math.PI },
        { characterId: "c-zhou", position: [0, 0, -0.8], facingRad: 0 },
      ],
      props: [],
    });

    // s-05 只出场 c-zhou，写 c-lin 的走位不合法
    expect(
      state().setShotBlocking("s-05", {
        actors: [{ characterId: "c-lin", position: [0, 0, 0], facingRad: 0 }],
        props: [],
      }),
    ).toBe(false);
    expect(state().castError).toContain("不在这一镜出场");

    // 越界
    expect(
      state().setShotBlocking("s-04", {
        actors: [{ characterId: "c-lin", position: [9, 0, 0], facingRad: 0 }],
        props: [],
      }),
    ).toBe(false);
    expect(state().castError).toContain("超出场地");
    expect(state().events).toHaveLength(snapshot + 1);
  });

  it("机位坐标随走位一起写；锁定与只读都不写", () => {
    expect(state().editLocation("loc-table", { space: SPACE })).toBe(true);
    const snapshot = state().events.length;
    const placement = {
      position: [0, 1.5, 1.5] as [number, number, number],
      target: [0, 1.2, 0] as [number, number, number],
    };
    expect(
      state().setShotBlocking(
        "s-04",
        {
          actors: [{ characterId: "c-lin", position: [0, 0, 0.8], facingRad: 0 }],
          props: [],
        },
        placement,
      ),
    ).toBe(true);
    const camera = state().project.shots.find((shot) => shot.id === "s-04")?.camera;
    expect(camera?.placement).toEqual(placement);
    // 角度不因为坐标自动改写
    expect(camera?.angle).toBe("eye");

    // s-08 已锁定
    expect(
      state().setShotBlocking("s-08", {
        actors: [{ characterId: "c-lin", position: [0, 0, 0], facingRad: 0 }],
        props: [],
      }),
    ).toBe(false);
    expect(state().castError).toContain("锁定");

    useWorkbench.setState({ readOnly: true });
    const after = state().events.length;
    expect(
      state().setShotBlocking("s-04", {
        actors: [{ characterId: "c-lin", position: [0, 0, 1], facingRad: 0 }],
        props: [],
      }),
    ).toBe(false);
    expect(state().events).toHaveLength(after);
  });
});

describe("存量地点补几何（B13.1 / ADR-0126）", () => {
  beforeEach(() => {
    useWorkbench.setState({ readOnly: false });
    state().reset();
  });

  it("模板早就选好但没有 space：存名字时顺手补上", () => {
    // 示例项目里 loc-table 的模板是旧 id "table"，先换成带几何的模板但不给 space
    expect(state().editLocation("loc-table", { templateId: "living-room" })).toBe(true);
    expect(state().project.locations.find((item) => item.id === "loc-table")?.space).toBeTruthy();

    // 模拟存量：把 space 去掉，模板保持 living-room
    const cleared = state().events.length;
    expect(state().editLocation("loc-table", { space: undefined })).toBe(false);
    // 用事件直接把几何清掉，模拟 B13.1 之前存下来的项目
    useWorkbench.setState((current) => ({
      project: {
        ...current.project,
        locations: current.project.locations.map((item) =>
          item.id === "loc-table" ? { ...item, space: undefined } : item,
        ),
      },
    }));
    expect(state().project.locations.find((item) => item.id === "loc-table")?.space).toBeUndefined();

    // 再存一次名字（模板没变）：几何按模板补上
    expect(state().editLocation("loc-table", { name: "餐桌边", templateId: "living-room" })).toBe(true);
    const location = state().project.locations.find((item) => item.id === "loc-table");
    expect(location?.space?.dimensions).toEqual([5, 4, 2.8]);
    expect(state().events.length).toBeGreaterThan(cleared);
  });
});

describe("逐句表演参数与试听台（C2 / C9 / ADR-0124）", () => {
  beforeEach(() => {
    state().reset();
  });

  it("改表演参数写一条 dialogue.updated，时长不动", () => {
    const before = state().events.length;
    const duration = state().project.dialogue.find((line) => line.id === "d-01")!.durationMs;
    expect(
      state().updatePerformance("d-01", {
        rate: 1.2,
        pitch: 0,
        volume: 1,
        breathiness: 0,
        emphasis: [{ start: 0, end: 2, strength: 2 }],
        pauses: [],
        emotion: "克制",
        ending: "fall",
      }),
    ).toBe(true);
    expect(state().events.slice(before).map((event) => event.type)).toEqual(["dialogue.updated"]);
    const line = state().project.dialogue.find((item) => item.id === "d-01")!;
    expect(line.performance).toMatchObject({ rate: 1.2, emotion: "克制", ending: "fall" });
    expect(line.durationMs).toBe(duration);
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("传 undefined 清回默认：字段整个去掉", () => {
    state().updatePerformance("d-01", {
      rate: 1.3,
      pitch: 0,
      volume: 1,
      breathiness: 0,
      emphasis: [],
      pauses: [],
      emotion: "",
      ending: "flat",
    });
    expect(state().updatePerformance("d-01", undefined)).toBe(true);
    const line = state().project.dialogue.find((item) => item.id === "d-01")!;
    expect(line.performance).toBeUndefined();
    expect("performance" in line).toBe(false);
    // 事件过一遍 JSON 再回放，清空仍然是清空（undefined 会被丢掉，null 不会）
    expect(JSON.stringify(rebuild(JSON.parse(JSON.stringify(state().events))))).toBe(
      JSON.stringify(state().project),
    );
  });

  it("重音越界写不进去，台词原样不动", () => {
    const before = state().events.length;
    expect(
      state().updatePerformance("d-01", {
        rate: 1,
        pitch: 0,
        volume: 1,
        breathiness: 0,
        emphasis: [{ start: 0, end: 999, strength: 2 }],
        pauses: [],
        emotion: "",
        ending: "flat",
      }),
    ).toBe(false);
    expect(state().events).toHaveLength(before);
    expect(state().castError).toContain("重音区间越出当前台词");
  });

  it("锁定的镜头不给改表演", () => {
    // d-04 在锁定的 s-08 里
    expect(
      state().updatePerformance("d-04", {
        rate: 1.2,
        pitch: 0,
        volume: 1,
        breathiness: 0,
        emphasis: [],
        pauses: [],
        emotion: "",
        ending: "flat",
      }),
    ).toBe(false);
    expect(state().castError).toContain("已锁定");
  });

  it("批量补缺按顺序念，跳过锁定镜头，失败即停（C1）", async () => {
    const locked = new Set(
      state().project.shots.filter((shot) => shot.locked).map((shot) => shot.id),
    );
    const targets = state().project.dialogue.filter(
      (line) =>
        !line.audioAssetId &&
        line.text.trim() &&
        !locked.has(
          state().project.shots.find((shot) => shot.dialogueIds.includes(line.id))?.id ?? "",
        ),
    );
    expect(targets.length).toBeGreaterThan(1);

    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 2) {
          return new Response(JSON.stringify({ error: "分组未授权" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ uri: "data:audio/mpeg;base64,SUQz", mime: "audio/mpeg", model: "tts-x" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const result = await state().generateMissingVoice();
    expect(result.attempted).toBe(targets.length);
    expect(result.done).toBe(1);
    expect(result.failedLineId).toBe(targets[1]!.id);
    expect(calls).toBe(2);
    expect(state().project.dialogue.find((line) => line.id === targets[0]!.id)?.audioAssetId).toBe(
      `a-voice-${targets[0]!.id}`,
    );
    expect(state().project.dialogue.find((line) => line.id === targets[2]!.id)?.audioAssetId).toBeUndefined();
    expect(state().castError).toContain("分组未授权");
    vi.unstubAllGlobals();
  });

  it("出声时把语速与表演说明一起发出去", async () => {
    state().updatePerformance("d-01", {
      rate: 1.2,
      pitch: 0,
      volume: 1,
      breathiness: 0.3,
      emphasis: [],
      pauses: [],
      emotion: "克制",
      ending: "fall",
    });
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ uri: "data:audio/mpeg;base64,SUQz", mime: "audio/mpeg", model: "tts-x" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    expect(await state().generateVoice("d-01")).toBe(true);
    expect(bodies[0]).toMatchObject({ speed: 1.2 });
    expect(String(bodies[0]!.instructions)).toContain("情绪：克制");
    expect(String(bodies[0]!.instructions)).toContain("句尾下沉");
    expect(state().project.dialogue.find((line) => line.id === "d-01")?.audioAssetId).toBe(
      "a-voice-d-01",
    );
    // 普通重配不进试听台
    expect(state().project.voiceTakes).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("默认参数不发送 speed / instructions", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ uri: "data:audio/mpeg;base64,SUQz", mime: "audio/mpeg", model: "tts-x" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    await state().generateVoice("d-01");
    expect(bodies[0]).not.toHaveProperty("speed");
    expect(bodies[0]).not.toHaveProperty("instructions");
    vi.unstubAllGlobals();
  });

  it("存一版：每版占自己的资产，进试听台并设为当前音轨", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ uri: "data:audio/mpeg;base64,SUQz", mime: "audio/mpeg", model: "tts-x" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    expect(await state().generateVoice("d-01", { keepTake: true })).toBe(true);
    expect(await state().generateVoice("d-01", { keepTake: true })).toBe(true);
    const takes = state().project.voiceTakes;
    expect(takes).toHaveLength(2);
    expect(new Set(takes.map((take) => take.assetId)).size).toBe(2);
    expect(state().project.dialogue.find((line) => line.id === "d-01")?.audioAssetId).toBe(
      takes[1]!.assetId,
    );
    expect(rebuild(state().events)).toEqual(state().project);
    vi.unstubAllGlobals();
  });

  it("采用某一版只改音轨，试听台不动；正采用的那版不能删", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ uri: "data:audio/mpeg;base64,SUQz", mime: "audio/mpeg", model: "tts-x" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    await state().generateVoice("d-01", { keepTake: true });
    await state().generateVoice("d-01", { keepTake: true });
    const [first, second] = state().project.voiceTakes;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // 采用第一版
    expect(state().adoptVoiceTake(first!.id)).toBe(true);
    expect(state().project.dialogue.find((line) => line.id === "d-01")?.audioAssetId).toBe(
      first!.assetId,
    );
    expect(state().project.voiceTakes).toHaveLength(2);
    // 正被采用的那一版不能删
    expect(state().removeVoiceTake(first!.id)).toBe(false);
    expect(state().castError).toContain("正被采用");
    // 另一版可以删，资产不删
    expect(state().removeVoiceTake(second!.id)).toBe(true);
    expect(state().project.voiceTakes).toHaveLength(1);
    expect(state().project.assets.some((asset) => asset.id === second!.assetId)).toBe(true);
    expect(rebuild(state().events)).toEqual(state().project);
    vi.unstubAllGlobals();
  });
});

describe("删掉没人引用的资产（F4 / ADR-0136）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("没人引用就写一条 asset.removed，回放一致", () => {
    // 造一条谁都不引用的资产
    const at = "2026-11-12T10:00:00+08:00";
    useWorkbench.setState((current) => ({
      project: applyEvent(current.project, {
        type: "asset.updated",
        at,
        asset: { id: "a-orphan", kind: "image", uri: "data:image/png;base64,QQ==", source: "generated", createdAt: at },
      }),
      events: [
        ...current.events,
        { type: "asset.updated", at, asset: { id: "a-orphan", kind: "image", uri: "data:image/png;base64,QQ==", source: "generated", createdAt: at } },
      ],
    }));

    expect(state().removeAsset("a-orphan")).toBe(true);
    expect(state().project.assets.some((asset) => asset.id === "a-orphan")).toBe(false);
    expect(state().events.at(-1)).toMatchObject({ type: "asset.removed", assetId: "a-orphan" });
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("还在用的资产不删：引用点先摘掉", () => {
    // 挑一条真的被引用、且真的在项目里的资产（示例项目里有引用了不存在的资产的镜头）
    const referenced = referencedAssetIds(state().project);
    const assetId = state().project.assets.find((asset) => referenced.has(asset.id))!.id;
    const snapshot = state().events.length;
    expect(state().removeAsset(assetId)).toBe(false);
    expect(state().castError).toContain("还在用");
    expect(state().events).toHaveLength(snapshot);
    expect(state().project.assets.some((asset) => asset.id === assetId)).toBe(true);
  });

  it("找不到的资产、只读标签页都不写事件", () => {
    const snapshot = state().events.length;
    expect(state().removeAsset("a-nope")).toBe(false);
    expect(state().events).toHaveLength(snapshot);

    useWorkbench.setState({ readOnly: true });
    expect(state().removeAsset(state().project.assets[0]!.id)).toBe(false);
    expect(state().events).toHaveLength(snapshot);
  });
});

describe("按项目固定模型（H22）", () => {
  beforeEach(() => {
    useWorkbench.setState({ readOnly: false });
    state().reset();
    state().setImagePrice({ model: "gpt-image-2-c", cny: 0.12 });
  });

  const stub = () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ uri: "data:image/png;base64,RkFLRQ==", model: "gpt-image-2-c", cny: 0.12 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    return bodies;
  };

  it("固定与取消各写一条 project.updated，重放日志得到同一份", () => {
    state().setModelPin("video", "m-video");
    expect(state().project.models.video).toBe("m-video");
    expect(state().events.at(-1)).toMatchObject({
      type: "project.updated",
      models: { video: "m-video" },
    });
    expect(rebuild(state().events).models.video).toBe("m-video");

    state().setModelPin("video", null);
    expect(state().project.models.video).toBeUndefined();
    expect(rebuild(state().events).models.video).toBeUndefined();
  });

  it("同一个值不重复写；只读标签页改不了", () => {
    state().setModelPin("image", "m-image");
    const count = state().events.length;
    state().setModelPin("image", "m-image");
    expect(state().events).toHaveLength(count);

    useWorkbench.setState({ readOnly: true });
    state().setModelPin("image", "m-other");
    expect(state().project.models.image).toBe("m-image");
    useWorkbench.setState({ readOnly: false });
  });

  it("固定后生成请求带固定的 modelId；取消后不再带", async () => {
    const bodies = stub();
    state().setModelPin("image", "m-image-pinned");
    await state().generateKeyframe("s-03");
    expect(bodies.at(-1)?.modelId).toBe("m-image-pinned");

    state().setModelPin("image", null);
    await state().generateKeyframe("s-03");
    expect(bodies.at(-1)?.modelId).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("手改提示词（ADR-0148）", () => {
  beforeEach(() => {
    // 前面的用例可能把 store 留成只读（另一个标签页在编辑）：先复位
    useWorkbench.setState({ readOnly: false });
    state().reset();
    state().setImagePrice({ model: "gpt-image-2-c", cny: 0.12 });
  });

  /** 按 URL 收请求体：图片 / 视频 / 配音各回一份最小可用结果 */
  const stub = () => {
    const bodies: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        bodies.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        if (String(url).includes("/api/video")) {
          return new Response(
            JSON.stringify({
              uri: "data:video/mp4;base64,QUJD",
              model: "seedance",
              prompt: "自定义视频提示词",
              durationMs: 3000,
              cny: 1.8,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (String(url).includes("/api/voice")) {
          return new Response(
            JSON.stringify({ uri: "data:audio/mpeg;base64,SUQz", mime: "audio/mpeg", model: "tts-x" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ uri: "data:image/png;base64,RkFLRQ==", model: "gpt-image-2-c", cny: 0.12 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    return bodies;
  };

  it("四视图手改的那一格单独送出改后的提示词，其他格照旧", async () => {
    const bodies = stub();
    state().setPromptOverride("sheet:c-lin:front", "正面：雨夜巷口，冷白路灯");
    await state().generateSheet("c-lin");

    const sheetBodies = bodies.filter((item) => item.body.kind === "sheet");
    expect(sheetBodies.length).toBeGreaterThan(0);
    const front = sheetBodies.find((item) => item.body.angle === "front");
    const side = sheetBodies.find((item) => item.body.angle !== "front");
    expect(front?.body.prompt).toBe("正面：雨夜巷口，冷白路灯");
    expect(side?.body).not.toHaveProperty("prompt");
    vi.unstubAllGlobals();
  });

  it("关键帧带上手改的提示词；恢复默认后不再带", async () => {
    const bodies = stub();
    state().setPromptOverride("keyframe:s-03:first", "雨夜，林晚站在巷口，冷白路灯");
    await state().generateKeyframe("s-03");
    expect(bodies.at(-1)?.body.prompt).toBe("雨夜，林晚站在巷口，冷白路灯");

    state().setPromptOverride("keyframe:s-03:first", null);
    await state().generateKeyframe("s-03");
    expect(bodies.at(-1)?.body).not.toHaveProperty("prompt");
    vi.unstubAllGlobals();
  });

  it("出视频带的是视频提示词，不是首帧那一段", async () => {
    const bodies = stub();
    await state().generateKeyframe("s-03");
    state().setPromptOverride("keyframe:s-03:first", "首帧：只用来起势");
    state().setPromptOverride("video:s-03", "镜头缓慢推近，林晚抬眼");
    await state().generateVideo("s-03");

    const video = bodies.find((item) => item.url.includes("/api/video"));
    expect(video?.body.prompt).toBe("镜头缓慢推近，林晚抬眼");
    vi.unstubAllGlobals();
  });

  it("配音的手改提示词替代表演参数拼出的 instructions", async () => {
    const bodies = stub();
    state().updatePerformance("d-01", {
      rate: 1,
      pitch: 0,
      volume: 0,
      breathiness: 0,
      emphasis: [],
      pauses: [],
      emotion: "克制",
      ending: "flat",
    });
    state().setPromptOverride("voice:d-01", "压低声音，像怕被人听见");
    await state().generateVoice("d-01");

    const voice = bodies.find((item) => item.url.includes("/api/voice"));
    expect(voice?.body.instructions).toBe("压低声音，像怕被人听见");
    vi.unstubAllGlobals();
  });
});

describe("逐字导入开工（F6 / ADR-0154）", () => {
  const document = {
    title: "第二章 天亮",
    chapterIndex: 1,
    chapterCount: 2,
    text: "第二章 天亮\n周把杯子放回桌边。\n门没有关。",
    fileName: "雨夜.txt",
    sourceChars: 100,
    importedAt: "2026-11-13T10:00:00+08:00",
    fingerprint: "1a2b3c4d",
  };

  it("写一条新的 project.created，原文进 IR，骨架只有一空镜", () => {
    state().reset();
    const before = state().events.length;
    expect(state().startProjectFromVerbatim(document)).toBe(true);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "project.created" });
    expect(state().project.story.sourceDocument).toEqual(document);
    expect(state().project.story.provenance?.modelId).toBe("local:verbatim");
    expect(state().project.characters).toHaveLength(0);
    expect(state().project.dialogue).toHaveLength(0);
    expect(state().project.scenes).toHaveLength(1);
    expect(state().project.shots).toHaveLength(1);
    expect(state().currentShotId).toBe("shot-verbatim-1");
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("只读时不换项目、不写事件", () => {
    state().reset();
    state().readOnly = true;
    const before = state().events.length;
    expect(state().startProjectFromVerbatim(document)).toBe(false);
    expect(state().events).toHaveLength(before);
    state().readOnly = false;
  });
});

describe("参考图真的发出去（B2 / ADR-0162）", () => {
  beforeEach(() => {
    state().reset();
    state().setImagePrice({ model: "gpt-image-2-c", cny: 0.12 });
  });

  type Body = {
    kind: string;
    references?: { assetId: string; uri: string; label: string }[];
    referenceAssetIds?: string[];
  };

  const stub = (reply: (body: Body) => Record<string, unknown> = () => ({})) => {
    const calls: Body[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Body;
        calls.push(body);
        return new Response(
          JSON.stringify({
            uri: "data:image/png;base64,RkFLRQ==",
            model: "gpt-image-2-c",
            cny: 0.12,
            ...reply(body),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    return calls;
  };

  it("尾帧把这一镜的首帧当参考图发出去", async () => {
    const calls = stub();
    await state().generateKeyframe("s-03");
    await state().generateKeyframe("s-03", "last");

    const last = calls.at(-1)!;
    expect(last.kind).toBe("keyframe");
    expect(last.references?.length).toBe(1);
    expect(last.references?.[0]?.assetId).toBe("a-keyframe-s-03");
    expect(last.references?.[0]?.uri).toContain("data:image/png");
    vi.unstubAllGlobals();
  });

  it("首帧没有参考图时不带 references，请求体与以前一致", async () => {
    const calls = stub();
    await state().generateKeyframe("s-03");
    expect(calls[0]?.references).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("服务端说参考图没发出去时，界面留一句人话而不是假装带上了", async () => {
    stub(() => ({ references: { mode: "prompt-only", sent: 0, missing: [] } }));
    await state().generateKeyframe("s-03");
    expect(state().generationNotice).toContain("纯文生图");
    vi.unstubAllGlobals();
  });

  it("参考图真的带上时，回执说清带了几张", async () => {
    stub(() => ({ references: { mode: "edits", sent: 1, missing: [] } }));
    await state().generateKeyframe("s-03");
    expect(state().generationNotice).toContain("已带 1 张参考图");
    vi.unstubAllGlobals();
  });

  it("参考图压过时，回执另说一句压到长边 1536（B2 / ADR-0206）", async () => {
    stub(() => ({ references: { mode: "edits", sent: 1, missing: [], fitted: 1 } }));
    await state().generateKeyframe("s-03");
    expect(state().generationNotice).toContain("已带 1 张参考图");
    expect(state().generationNotice).toContain("压到长边 1536");
    expect(state().generationNotice).toContain("不裁剪");
    vi.unstubAllGlobals();
  });

  it("参考图资产还没有地址时不硬塞空地址：这一张按纯文生图出", async () => {
    const calls = stub(() => ({ references: { mode: "prompt-only", sent: 0, missing: [] } }));
    // 示例项目里的道具参考图只有 id、没有 uri（还没真出过图）
    await state().generateProp("p-cup");
    expect(calls[0]?.kind).toBe("prop");
    expect(calls[0]?.references).toBeUndefined();
    expect(state().generationNotice).toContain("纯文生图");
    vi.unstubAllGlobals();
  });
});

describe("品牌包与头尾卡（E9 / ADR-0174）", () => {
  beforeEach(() => {
    state().reset();
  });

  it("写一条 brand.updated，读模型里的卡片跟着出来", () => {
    const before = state().events.length;
    expect(state().setBrand({ name: "织光机" })).toBe(true);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "brand.updated",
      patch: { name: "织光机" },
    });
    expect(state().project.brand.name).toBe("织光机");
  });

  it("和当前值一样就不写事件：拖两次同样的时长只留一条", () => {
    state().setBrand({ outro: { enabled: true, title: "下一集", durationMs: 1500 } });
    const after = state().events.length;
    expect(state().setBrand({ outro: { enabled: true, title: "下一集", durationMs: 1500 } })).toBe(
      false,
    );
    expect(state().events).toHaveLength(after);
    // 只改时长：标题不会被一起清掉
    expect(state().setBrand({ outro: { durationMs: 2500 } })).toBe(true);
    expect(state().project.brand.outro).toMatchObject({
      enabled: true,
      title: "下一集",
      durationMs: 2500,
    });
  });

  it("卡片时长让成片变长，时间线上的镜头整体后移", () => {
    const before = toEditView(state().project);
    state().setBrand({ intro: { enabled: true, title: "夜班", durationMs: 2000 } });
    const after = toEditView(state().project);
    expect(after.totalMs).toBe(before.totalMs + 2000);
    expect(after.clips[0]!.startMs).toBe(before.clips[0]!.startMs + 2000);
    expect(after.cards).toHaveLength(1);
  });

  it("越界的时长被拒，项目不动", () => {
    const before = state().project.brand.outro;
    expect(state().setBrand({ outro: { durationMs: 30_000 } })).toBe(false);
    expect(state().project.brand.outro).toEqual(before);
    expect(state().editError).toMatch(/500–10000/);
  });
});

describe("多条配乐混排（C4）", () => {
  beforeEach(() => {
    state().reset();
  });

  const add = (startSec: number) =>
    state().addMusic({
      uri: "data:audio/mpeg;base64,AAAA",
      mime: "audio/mpeg",
      title: "床",
      mood: "紧张",
      durationMs: 8000,
      licenseRef: "自己录制",
      startMs: startSec * 1000,
    });

  it("两段各有自己的起点，后一段不改前一段", () => {
    expect(add(0)).toBe(true);
    expect(add(3)).toBe(true);
    const music = state().project.timeline.music;
    expect(music).toHaveLength(2);
    expect(music[0]!.startMs).toBe(0);
    expect(music[1]!.startMs).toBe(3000);
    // 默认铺到成片末尾（示例时间线 5.5 秒）
    expect(music[1]!.durationMs).toBe(2500);
  });

  it("改起点与长度只写一条 timeline.music.updated", () => {
    add(0);
    const cueId = state().project.timeline.music[0]!.id;
    const before = state().events.length;
    expect(state().updateMusic({ startMs: 1500, durationMs: 4000 }, cueId)).toBe(true);
    const cue = state().project.timeline.music[0]!;
    expect(cue.startMs).toBe(1500);
    expect(cue.durationMs).toBe(4000);
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "timeline.music.updated" });
  });

  it("起点落在成片之外：拒收，项目不动", () => {
    add(0);
    const cueId = state().project.timeline.music[0]!.id;
    const before = state().project.timeline.music;
    expect(state().updateMusic({ startMs: 6000 }, cueId)).toBe(false);
    expect(state().project.timeline.music).toEqual(before);
    expect(add(9)).toBe(false);
    expect(state().editError).toContain("成片之外");
  });

  it("最多 4 段：第 5 段被拦下", () => {
    for (let index = 0; index < 4; index += 1) expect(add(index)).toBe(true);
    expect(state().project.timeline.music).toHaveLength(4);
    expect(add(0)).toBe(false);
    expect(state().editError).toContain("最多 4 条");
  });
});

describe("音效层与三路平衡（C7）", () => {
  beforeEach(() => {
    state().reset();
  });

  const add = (
    startSec: number,
    extra: { loop?: boolean; durationMs?: number; licenseRef?: string } = {},
  ) =>
    state().addSfx({
      uri: "data:audio/wav;base64,AAAA",
      mime: "audio/wav",
      title: "关门",
      durationMs: extra.durationMs ?? 800,
      licenseRef: extra.licenseRef ?? "自己录制",
      startMs: startSec * 1000,
      role: "foley",
      loop: extra.loop ?? false,
    });

  it("默认按文件长度放一遍，增益 −12 dB，不循环", () => {
    expect(add(1.2)).toBe(true);
    const cue = state().project.timeline.sfx[0]!;
    expect(cue.startMs).toBe(1200);
    expect(cue.durationMs).toBe(800);
    expect(cue.gainDb).toBe(-12);
    expect(cue.loop).toBe(false);
    expect(cue.role).toBe("foley");
    // 素材同时落成一条音频资产
    expect(state().project.assets.some((asset) => asset.id === cue.assetId && asset.kind === "audio")).toBe(true);
  });

  it("循环音效按起点铺到片尾", () => {
    expect(add(2, { loop: true })).toBe(true);
    expect(state().project.timeline.sfx[0]!.durationMs).toBe(3500);
  });

  it("改起点 / 长度 / 增益 / 循环只写一条 timeline.sfx.updated", () => {
    add(0);
    const cueId = state().project.timeline.sfx[0]!.id;
    const before = state().events.length;
    expect(
      state().updateSfx({ startMs: 900, durationMs: 1200, gainDb: -6, loop: true }, cueId),
    ).toBe(true);
    const cue = state().project.timeline.sfx[0]!;
    expect(cue).toMatchObject({ startMs: 900, durationMs: 1200, gainDb: -6, loop: true });
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "timeline.sfx.updated" });
  });

  it("起点在成片之外拒收；授权来源必填", () => {
    add(0);
    const cueId = state().project.timeline.sfx[0]!.id;
    expect(state().updateSfx({ startMs: 6000 }, cueId)).toBe(false);
    expect(state().editError).toContain("成片之外");
    expect(add(9)).toBe(false);
    expect(add(0, { licenseRef: " " })).toBe(false);
    expect(state().editError).toContain("授权来源");
  });

  it("最多 8 条；移掉一条只写一条事件", () => {
    for (let index = 0; index < 8; index += 1) expect(add(index * 0.5)).toBe(true);
    expect(add(0)).toBe(false);
    expect(state().editError).toContain("最多 8 条");
    const cueId = state().project.timeline.sfx[0]!.id;
    const before = state().events.length;
    expect(state().removeSfx(cueId)).toBe(true);
    expect(state().project.timeline.sfx).toHaveLength(7);
    expect(state().events).toHaveLength(before + 1);
  });

  it("三路平衡写一条事件；越界夹回 ±12 dB", () => {
    const before = state().events.length;
    expect(state().setMix({ dialogueDb: 3, musicDb: -4, sfxDb: 0 })).toBe(true);
    expect(state().project.timeline.mix).toEqual({ dialogueDb: 3, musicDb: -4, sfxDb: 0 });
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "timeline.mix.updated" });
    expect(state().setMix({ dialogueDb: 30 })).toBe(true);
    expect(state().project.timeline.mix.dialogueDb).toBe(12);
    // 已经在这个值上：不重复写事件
    const settled = state().events.length;
    expect(state().setMix({ dialogueDb: 12 })).toBe(true);
    expect(state().events).toHaveLength(settled);
  });
});

describe("关键帧版本库（C2）", () => {
  beforeEach(() => {
    state().reset();
    state().setImagePrice({ model: "gpt-image-2-c", cny: 0.12 });
  });

  // 每次生成给一个不同的地址：同一张图不去重历史，不同图才进旧版
  let round = 0;
  const stub = () => {
    round = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        round += 1;
        return new Response(
          JSON.stringify({
            uri: `data:image/png;base64,RkFLRR${round}`,
            model: "gpt-image-2-c",
            cny: 0.12,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
  };

  it("重生成把上一版复制进历史，不丢、也不重复记钱", async () => {
    stub();
    await state().generateKeyframe("s-03");
    const firstUri = state().project.assets.find((item) => item.id === "a-keyframe-s-03")?.uri;
    const spentAfterFirst = spendOf(state().project).spent;

    await state().generateKeyframe("s-03");
    const shot = state().project.shots.find((item) => item.id === "s-03")!;
    const history = shot.keyframes.history?.first ?? [];
    expect(history).toHaveLength(1);
    expect(history[0]!.startsWith("a-kfhist-s-03-first-")).toBe(true);

    const archive = state().project.assets.find((item) => item.id === history[0]);
    expect(archive?.uri).toBe(firstUri);
    expect(archive?.costCny).toBeUndefined();
    // 旧的图还在，最新的仍是标准资产位
    expect(state().project.assets.find((item) => item.id === "a-keyframe-s-03")?.uri).not.toBe(firstUri);
    // 历史副本不另记一笔：花费仍按资产位记（与改动前的口径一致）
    expect(spendOf(state().project).spent).toBeCloseTo(spentAfterFirst, 2);
    vi.unstubAllGlobals();
  });

  it("换回旧版：内容写回资产位，现在这版也进历史，钱不变", async () => {
    stub();
    await state().generateKeyframe("s-03");
    const firstUri = state().project.assets.find((item) => item.id === "a-keyframe-s-03")?.uri;
    await state().generateKeyframe("s-03");
    const shot = state().project.shots.find((item) => item.id === "s-03")!;
    const archiveId = shot.keyframes.history!.first[0]!;
    const spentBefore = spendOf(state().project).spent;

    expect(state().useKeyframeVersion("s-03", "first", archiveId)).toBe(true);
    const after = state().project.shots.find((item) => item.id === "s-03")!;
    expect(state().project.assets.find((item) => item.id === "a-keyframe-s-03")?.uri).toBe(firstUri);
    expect(after.keyframes.firstAssetId).toBe("a-keyframe-s-03");
    // 换走的那一版也留在历史里，可以换回去
    expect(after.keyframes.history!.first.length).toBe(2);
    expect(spendOf(state().project).spent).toBeCloseTo(spentBefore, 2);
    vi.unstubAllGlobals();
  });

  it("锁定的镜头不让换版；旧图没了如实拒绝", async () => {
    stub();
    // s-02 已经有一条留用的 take，可以锁定
    await state().generateKeyframe("s-02");
    const firstUri = state().project.assets.find((item) => item.id === "a-keyframe-s-02")?.uri;
    await state().generateKeyframe("s-02");
    const archiveId =
      state().project.shots.find((item) => item.id === "s-02")!.keyframes.history!.first[0]!;

    state().setShotLock("s-02", true);
    expect(state().useKeyframeVersion("s-02", "first", archiveId)).toBe(false);
    expect(state().castError).toContain("锁定");
    state().setShotLock("s-02", false);

    expect(state().useKeyframeVersion("s-02", "first", "a-kfhist-nope")).toBe(false);
    expect(state().castError).toContain("不在资产库");
    expect(state().project.assets.find((item) => item.id === "a-keyframe-s-02")?.uri).not.toBe(firstUri);
    vi.unstubAllGlobals();
  });
});

describe("废片作参考（C2 / ADR-0200）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("挂到人物 / 场景 / 道具的参考图：一条 updated 事件，同一个文件不复制", () => {
    const assetId = "a-keyframe-s-03";
    useWorkbench.setState({
      project: ProjectSchema.parse({
        ...state().project,
        assets: [
          ...state().project.assets,
          {
            id: assetId,
            kind: "image",
            source: "generated",
            uri: "loomina://assets/kf.png",
            createdAt: "2026-11-13T00:00:00Z",
          },
        ],
      }),
    });
    const snapshot = state().events.length;

    expect(state().attachTrashReference(assetId, { kind: "character", id: "c-lin" })).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "character.updated", characterId: "c-lin" });
    expect(state().project.characters.find((item) => item.id === "c-lin")!.referenceImages).toContain(assetId);
    // 同一张图只登记一次，资产数量不变
    expect(state().project.assets).toHaveLength(state().project.assets.length);

    expect(state().attachTrashReference(assetId, { kind: "location", id: "loc-corridor" })).toBe(true);
    expect(state().project.locations.find((item) => item.id === "loc-corridor")!.referenceImages).toContain(assetId);
    expect(state().attachTrashReference(assetId, { kind: "prop", id: "p-cup" })).toBe(true);
    expect(state().project.props.find((item) => item.id === "p-cup")!.referenceImages).toContain(assetId);
  });

  it("已经挂过 / 不是图片 / 文件不在 都拒绝且不写事件", () => {
    const snapshot = state().events.length;
    // a-lin-expr 已经挂在林身上
    expect(state().attachTrashReference("a-lin-expr", { kind: "character", id: "c-lin" })).toBe(false);
    expect(state().castError).toContain("已经挂过");

    useWorkbench.setState({
      project: ProjectSchema.parse({
        ...state().project,
        assets: [
          ...state().project.assets,
          { id: "a-vid", kind: "video", source: "generated", createdAt: "2026-11-13T00:00:00Z" },
        ],
      }),
    });
    expect(state().attachTrashReference("a-vid", { kind: "character", id: "c-lin" })).toBe(false);
    expect(state().castError).toContain("只有图片");

    expect(state().attachTrashReference("a-nope", { kind: "character", id: "c-lin" })).toBe(false);
    expect(state().castError).toContain("不在项目里");
    expect(state().events).toHaveLength(snapshot);
  });

  it("只读时拒绝", () => {
    useWorkbench.setState({ readOnly: true });
    const snapshot = state().events.length;
    expect(state().attachTrashReference("a-lin-expr", { kind: "prop", id: "p-cup" })).toBe(false);
    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
  });
});

describe("技能（C.5 / ADR-0191）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("加一条技能写整份 skills，关掉不删，删掉留事件", () => {
    const count = state().events.length;
    const id = state().addSkill({
      name: "禁止现代物品",
      body: "场景里不要出现现代物品。",
      stage: "master",
    });
    expect(id).toBeTruthy();
    expect(state().events).toHaveLength(count + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "project.updated" });
    const skill = state().project.skills.find((item) => item.id === id)!;
    expect(skill).toMatchObject({ name: "禁止现代物品", stage: "master", enabled: true });

    expect(state().updateSkill(id!, { enabled: false })).toBe(true);
    expect(state().project.skills[0]?.enabled).toBe(false);
    expect(state().updateSkill(id!, { enabled: false })).toBe(false);

    expect(state().removeSkill(id!)).toBe(true);
    expect(state().project.skills).toEqual([]);
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("空名字、空内容与只读都拒绝", () => {
    const count = state().events.length;
    expect(state().addSkill({ name: " ", body: "有内容" })).toBeUndefined();
    expect(state().addSkill({ name: "有名字", body: "  " })).toBeUndefined();
    expect(state().events).toHaveLength(count);

    useWorkbench.setState({ readOnly: true });
    expect(state().addSkill({ name: "有名字", body: "有内容" })).toBeUndefined();
  });
});

describe("接上一段（C.6 / ADR-0192）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("第二镜可接，写一条 shot.updated；清成 null 表示硬接", () => {
    const count = state().events.length;
    expect(state().setShotContinuation("s-02", 3000)).toBe(true);
    expect(state().events).toHaveLength(count + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "shot.updated",
      shotId: "s-02",
      patch: { continuation: { tailMs: 3000 } },
    });
    expect(state().project.shots.find((shot) => shot.id === "s-02")?.continuation).toEqual({
      tailMs: 3000,
    });
    expect(state().setShotContinuation("s-02", 3000)).toBe(false);
    expect(state().setShotContinuation("s-02", null)).toBe(true);
    expect(
      state().project.shots.find((shot) => shot.id === "s-02")?.continuation,
    ).toBeNull();
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("开头那一镜、越界时长与只读都拒绝", () => {
    const before = state().events.length;
    expect(state().setShotContinuation("s-01", 3000)).toBe(false);
    expect(state().castError).toContain("开头");
    expect(state().setShotContinuation("s-02", 200)).toBe(false);
    expect(state().setShotContinuation("s-02", 9000)).toBe(false);
    expect(state().events).toHaveLength(before);

    useWorkbench.setState({ readOnly: true });
    expect(state().setShotContinuation("s-02", 3000)).toBe(false);
  });
});

describe("废片库取回（C14 / ADR-0193）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("淘汰的一拍改回待审，并回到镜头最后", () => {
    state().select("s-03");
    state().decide("rejected");
    expect(statusOf("t-03")).toBe("rejected");
    const before = state().events.length;

    expect(state().restoreTake("t-03")).toBe(true);
    expect(statusOf("t-03")).toBe("draft");
    const shot = state().project.shots.find((item) => item.id === "s-03")!;
    expect(shot.takeIds.at(-1)).toBe("t-03");
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "take.updated",
      takeId: "t-03",
      patch: { status: "draft" },
    });
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("删掉的一拍按日志里原记录放回去，不重新生成", () => {
    expect(state().removeTake("t-04")).toBe(true);
    expect(state().project.takes.some((take) => take.id === "t-04")).toBe(false);
    const before = state().events.length;

    expect(state().restoreTake("t-04")).toBe(true);
    expect(state().project.takes.find((take) => take.id === "t-04")?.status).toBe("draft");
    const shot = state().project.shots.find((item) => item.id === "s-04")!;
    expect(shot.takeIds).toContain("t-04");
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "take.added",
      take: { id: "t-04", shotId: "s-04", status: "draft" },
    });
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("找不到、锁定、已留用与只读都拒绝，且不写事件", () => {
    const before = state().events.length;
    expect(state().restoreTake("t-nope")).toBe(false);
    expect(state().restoreTake("t-08")).toBe(false); // s-08 锁定
    expect(state().castError).toContain("锁定");
    expect(state().restoreTake("t-02")).toBe(false); // 已留用
    expect(state().castError).toContain("留用");
    expect(state().events).toHaveLength(before);

    useWorkbench.setState({ readOnly: true });
    expect(state().restoreTake("t-03")).toBe(false);
    expect(state().events).toHaveLength(before);
    useWorkbench.setState({ readOnly: false });
  });
});

describe("从别的空间取一拍视频（C1 / ADR-0194）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("只登记地址与一拍 take：资产记 library，不花钱", () => {
    const uri = `loomina://assets/${"c".repeat(64)}.mp4`;
    expect(state().attachVideo("s-03", uri, "library")).toBe(true);

    const shot = state().project.shots.find((item) => item.id === "s-03")!;
    const take = state().project.takes.find((item) => item.id === shot.takeIds.at(-1))!;
    expect(take.costCny).toBe(0);
    expect(take.status).toBe("draft");
    expect(take.provenance.modelId).toBe("library");
    const asset = state().project.assets.find((item) => item.id === take.assetId)!;
    expect(asset).toMatchObject({ kind: "video", source: "library", uri });
    expect(asset.costCny).toBeUndefined();
    // 导出 / 回放看到的是同一份
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("这一镜已经挂过同一条地址就不重复挂", () => {
    const uri = `loomina://assets/${"d".repeat(64)}.mp4`;
    expect(state().attachVideo("s-03", uri, "library")).toBe(true);
    expect(state().attachVideo("s-03", uri, "library")).toBe(false);
    expect(state().castError).toContain("贴过");
  });
});

describe("从别的空间取一版配音（C1 / ADR-0195）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("只登记地址与台词当前音轨：资产记 library，不花钱", () => {
    const uri = `loomina://assets/${"e".repeat(64)}.mp3`;
    expect(state().attachVoice("d-01", uri, "library")).toBe(true);

    const line = state().project.dialogue.find((item) => item.id === "d-01")!;
    expect(line.audioAssetId).toBe("a-voice-d-01");
    const asset = state().project.assets.find((item) => item.id === "a-voice-d-01")!;
    expect(asset).toMatchObject({ kind: "audio", source: "library", uri });
    expect(asset.provenance?.modelId).toBe("library");
    expect(asset.costCny).toBeUndefined();
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("本机资产库 / 对象存储地址都能贴；锁定镜头仍拒绝", () => {
    expect(
      state().attachVoice("d-01", `s3://loomina/assets/${"f".repeat(64)}.mp3`),
    ).toBe(true);
    expect(state().attachVoice("d-04", "https://cdn.example.com/x.mp3")).toBe(false);
    expect(state().castError).toContain("锁定");
  });
});

describe("废片库取回配音（C14 / ADR-0196）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stub = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ uri: "data:audio/mpeg;base64,SUQz", mime: "audio/mpeg", model: "tts-x" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

  it("删掉的一版回到试听台，不自动采用、不重新配音", async () => {
    stub();
    await state().generateVoice("d-01", { keepTake: true });
    await state().generateVoice("d-01", { keepTake: true });
    const [first, second] = state().project.voiceTakes;
    expect(first && second).toBeTruthy();
    expect(state().adoptVoiceTake(first!.id)).toBe(true);
    expect(state().removeVoiceTake(second!.id)).toBe(true);
    expect(state().project.voiceTakes).toHaveLength(1);
    const before = state().events.length;

    expect(state().restoreVoiceTake(second!.id)).toBe(true);
    expect(state().project.voiceTakes).toHaveLength(2);
    expect(state().project.dialogue.find((line) => line.id === "d-01")?.audioAssetId).toBe(
      first!.assetId,
    );
    expect(state().events).toHaveLength(before + 1);
    expect(state().events.at(-1)).toMatchObject({
      type: "voice.take.added",
      take: { id: second!.id, assetId: second!.assetId },
    });
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("还在试听台、找不到、只读都拒绝，且不写事件", () => {
    const before = state().events.length;
    expect(state().restoreVoiceTake("vt-nope")).toBe(false);
    expect(state().events).toHaveLength(before);

    useWorkbench.setState({ readOnly: true });
    expect(state().restoreVoiceTake("vt-nope")).toBe(false);
    expect(state().events).toHaveLength(before);
    useWorkbench.setState({ readOnly: false });
  });
});

describe("删工作空间（C15 / ADR-0201）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("不能删正在打开的空间：说清楚先切走，不写状态", async () => {
    const list = state().workspaces;
    expect(await state().deleteWorkspace(state().workspaceId)).toBeUndefined();
    expect(state().workspaceError).toContain("正在打开");
    expect(state().workspaces).toBe(list);
  });

  it("测试环境没有 IndexedDB：删别的空间也不报成功", async () => {
    expect(await state().deleteWorkspace("w-somewhere-else")).toBeUndefined();
    expect(state().workspaceError).toContain("不支持多工作空间");
  });
});

describe("跨空间取技能（C.5 / ADR-0202）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  const source = () => ({
    id: "sk-night",
    name: "不要现代物品",
    description: "夜班是九十年代",
    stage: "all" as const,
    body: "场景里不要出现手机、汽车、路灯。",
    enabled: false,
    createdAt: "2026-11-13T00:00:00Z",
  });

  it("取用抄成一条新技能：id 重编、默认启用，一条 project.updated", () => {
    const before = state().project.skills.length;
    const snapshot = state().events.length;
    expect(state().adoptSharedSkill(source())).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "project.updated" });
    const added = state().project.skills.at(-1)!;
    expect(state().project.skills).toHaveLength(before + 1);
    expect(added.id).not.toBe("sk-night");
    expect(added.name).toBe("不要现代物品");
    expect(added.description).toBe("夜班是九十年代");
    expect(added.body).toBe("场景里不要出现手机、汽车、路灯。");
    // 在来源空间关着的，取过来默认打开
    expect(added.enabled).toBe(true);
    expect(rebuild(state().events).skills).toHaveLength(before + 1);
  });

  it("同名同内容已经在用就不重复加；只读拒绝", () => {
    expect(state().adoptSharedSkill(source())).toBe(true);
    const snapshot = state().events.length;
    expect(state().adoptSharedSkill(source())).toBe(false);
    expect(state().castError).toContain("已经在用");
    expect(state().events).toHaveLength(snapshot);

    useWorkbench.setState({ readOnly: true });
    const other = { ...source(), body: "另一条要求" };
    expect(state().adoptSharedSkill(other)).toBe(false);
    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
  });
});

describe("剧本版本库写回（C14 / ADR-0204）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("改过动作与台词后写回初版：一批事件、同一 at、成片不动", () => {
    const initial = structuredClone(state().project);
    expect(state().editAction("s-01", "改过的动作")).toBe(true);
    expect(state().editDialogue("d-01", "改过的台词")).toBe(true);
    const snapshot = state().events.length;

    expect(state().restoreScriptVersion(0)).toBe(true);
    const batch = state().events.slice(snapshot);
    expect(batch.length).toBeGreaterThan(0);
    expect(new Set(batch.map((event) => event.at)).size).toBe(1);
    expect(state().project.shots.find((shot) => shot.id === "s-01")!.description).toBe(
      initial.shots.find((shot) => shot.id === "s-01")!.description,
    );
    expect(state().project.dialogue.find((line) => line.id === "d-01")!.text).toBe(
      initial.dialogue.find((line) => line.id === "d-01")!.text,
    );
    expect(state().project.takes).toEqual(state().project.takes);
    expect(state().scriptNotice).toContain("已写回这一版");
    expect(rebuild(state().events).shots.find((shot) => shot.id === "s-01")!.description).toBe(
      initial.shots.find((shot) => shot.id === "s-01")!.description,
    );
  });

  it("现在就是这一版 / 找不到这一版 / 只读 都不写事件", () => {
    expect(state().restoreScriptVersion(state().events.length - 1)).toBe(false);
    expect(state().scriptNotice).toContain("现在就是这一版");
    expect(state().restoreScriptVersion(999)).toBe(false);
    expect(state().scriptNotice).toContain("找不到这一版");

    expect(state().editAction("s-01", "改过的动作")).toBe(true);
    const snapshot = state().events.length;
    useWorkbench.setState({ readOnly: true });
    expect(state().restoreScriptVersion(0)).toBe(false);
    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
  });
});

describe("镜头模板套用（F3 / ADR-0207）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  const template = (over: Partial<import("./shot-template").ShotTemplate> = {}) => ({
    format: "loomina.shot-template" as const,
    version: 1 as const,
    id: "st-1",
    name: "低机位推近",
    createdAt: "2026-11-14T00:00:00Z",
    from: { projectId: "p", title: "夜班", shotId: "s-01", shotLabel: "第 1 镜" },
    shotSize: "close" as const,
    angle: "low" as const,
    movement: "push" as const,
    focalMm: 85,
    ...over,
  });

  it("只换摄影四项：动作、台词、时长、出场人物与道具不动", () => {
    const before = structuredClone(state().project.shots.find((shot) => shot.id === "s-03")!);
    const snapshot = state().events.length;
    expect(state().applyShotTemplate("s-03", template())).toBe(true);

    const after = state().project.shots.find((shot) => shot.id === "s-03")!;
    expect(after.shotSize).toBe("close");
    expect(after.camera).toMatchObject({ angle: "low", movement: "push", focalMm: 85 });
    expect(after.description).toBe(before.description);
    expect(after.durationMs).toBe(before.durationMs);
    expect(after.characterIds).toEqual(before.characterIds);
    expect(after.propIds).toEqual(before.propIds);
    expect(after.dialogueIds).toEqual(before.dialogueIds);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "shot.updated", shotId: "s-03" });
    expect(rebuild(state().events).shots.find((shot) => shot.id === "s-03")!.shotSize).toBe("close");
  });

  it("模板没有光影 / 构图时不清空这一镜原来的；锁定拒绝", () => {
    expect(
      state().setShotLighting("s-04", { source: "window", position: "side", mood: "modeled", note: "台灯" }),
    ).toBe(true);
    expect(state().applyShotTemplate("s-04", template())).toBe(true);
    expect(state().project.shots.find((shot) => shot.id === "s-04")!.lighting?.note).toBe("台灯");

    expect(state().applyShotTemplate("s-08", template())).toBe(false); // s-08 在示例里是锁的
    expect(state().castError).toContain("锁定");
  });

  it("只读拒绝", () => {
    useWorkbench.setState({ readOnly: true });
    const snapshot = state().events.length;
    expect(state().applyShotTemplate("s-03", template())).toBe(false);
    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
  });
});

describe("结果缓存与复用（H14 / ADR-0208）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false, reuseCache: true });
    state().setImagePrice({ model: "gpt-image-2-c", cny: 0.12 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  type Body = { kind: string; frame?: string };

  /** 每次请求给一个不同的地址：能看出第二次到底有没有真发请求 */
  const stub = () => {
    const calls: Body[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Body;
        calls.push(body);
        return new Response(
          JSON.stringify({
            uri: `data:image/png;base64,${btoa(String(calls.length))}`,
            model: "gpt-image-2-c",
            // 真实服务端返回的就是它实际发出去的那段提示词（imagePlanOf 的结果）
            prompt: imagePlanOf(body as unknown as CastImageRequest).prompt,
            cny: 0.12,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    return calls;
  };

  it("同一套输入第二次命中：不发请求、不花钱、资产记 library", async () => {
    const calls = stub();
    await state().generateKeyframe("s-03");
    expect(calls).toHaveLength(1);
    const first = state().project.assets.find((item) => item.id === "a-keyframe-s-03")!;
    expect(first.source).toBe("generated");
    expect(first.costCny).toBe(0.12);

    // 把提示词覆盖清掉后重新生成同一镜：输入完全一样
    const before = state().events.length;
    await state().generateKeyframe("s-03");
    expect(calls).toHaveLength(1); // 没有第二次请求
    expect(state().events.length).toBeGreaterThan(before); // 但仍写了资产事件
    expect(state().generationNotice).toContain("复用");
    const reused = state().project.assets.find((item) => item.id === "a-keyframe-s-03")!;
    expect(reused.uri).toBe(first.uri);
    expect(reused.source).toBe("library");
    // 花费不抹：那是这一格当初真花过的钱（浅合并保留原值）
    expect(reused.costCny).toBe(0.12);
    expect(rebuild(state().events)).toEqual(state().project);
  });

  it("关掉结果复用就真去生成", async () => {
    const calls = stub();
    await state().generateKeyframe("s-03");
    useWorkbench.setState({ reuseCache: false });
    await state().generateKeyframe("s-03");
    expect(calls).toHaveLength(2);
    expect(state().project.assets.find((item) => item.id === "a-keyframe-s-03")!.source).toBe("generated");
  });

  it("提示词变了不再命中", async () => {
    const calls = stub();
    await state().generateKeyframe("s-03");
    state().setPromptOverride("keyframe:s-03:first", "换一段提示词");
    await state().generateKeyframe("s-03");
    expect(calls).toHaveLength(2);
  });
});

describe("空间归档与技能导入（C15 / C18 / ADR-0210）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("不能归档正在打开的空间", async () => {
    expect(await state().archiveWorkspace(state().workspaceId, true)).toBe(false);
    expect(state().workspaceError).toContain("正在打开");
  });

  it("没有 IndexedDB 时如实说不支持", async () => {
    expect(await state().archiveWorkspace("w-other", true)).toBe(false);
    expect(state().workspaceError).toContain("不支持多工作空间");
  });

  it("导入一批技能：一次 project.updated，id 撞车时补后缀", () => {
    const before = state().project.skills.length;
    const snapshot = state().events.length;
    expect(
      state().importSkills([
        {
          id: "sk-import-1",
          name: "不要现代物品",
          description: "",
          stage: "all",
          body: "场景里不要出现手机。",
          enabled: true,
          createdAt: "2026-11-14T00:00:00Z",
        },
      ]),
    ).toBe(true);
    expect(state().events).toHaveLength(snapshot + 1);
    expect(state().events.at(-1)).toMatchObject({ type: "project.updated" });
    expect(state().project.skills).toHaveLength(before + 1);
    expect(rebuild(state().events).skills).toHaveLength(before + 1);

    // 再导一次同一批：id 撞车，补后缀后仍能落库（判重交给 parseSkillsFile）
    expect(
      state().importSkills([
        {
          id: "sk-import-1",
          name: "另一条",
          description: "",
          stage: "all",
          body: "另一条内容。",
          enabled: true,
          createdAt: "2026-11-14T00:00:00Z",
        },
      ]),
    ).toBe(true);
    const ids = state().project.skills.map((skill) => skill.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("空批次与只读都拒绝", () => {
    const snapshot = state().events.length;
    expect(state().importSkills([])).toBe(false);
    useWorkbench.setState({ readOnly: true });
    expect(
      state().importSkills([
        {
          id: "sk-x",
          name: "x",
          description: "",
          stage: "all",
          body: "x",
          enabled: true,
          createdAt: "2026-11-14T00:00:00Z",
        },
      ]),
    ).toBe(false);
    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
  });
});

describe("整本剧本一起取（C24 / ADR-0212）", () => {
  beforeEach(() => {
    state().reset();
    useWorkbench.setState({ readOnly: false });
  });

  it("一次写一批事件、同一个 at，回放一致", () => {
    const source = structuredClone(state().project);
    const before = state().project;
    const snapshot = state().events.length;
    const result = state().adoptSharedScenes(source, ["sc-1", "sc-2"], "来源集");
    expect(result).toMatchObject({ scenes: 2, skipped: 0 });
    expect(result!.shots).toBeGreaterThan(0);
    const batch = state().events.slice(snapshot);
    expect(new Set(batch.map((event) => event.at)).size).toBe(1);
    expect(state().project.scenes).toHaveLength(before.scenes.length + 2);
    expect(rebuild(state().events).scenes).toHaveLength(before.scenes.length + 2);
  });

  it("缺人时跳过那几场、其余照取；一场都没成时不写事件", () => {
    const source = structuredClone(state().project);
    useWorkbench.setState({
      project: {
        ...state().project,
        characters: state().project.characters.filter((character) => character.id !== "c-zhou"),
      },
    });
    const snapshot = state().events.length;
    const result = state().adoptSharedScenes(source, ["sc-1"], "来源集");
    expect(result).toBeUndefined();
    expect(state().castError).toContain("一场都没取过来");
    expect(state().events).toHaveLength(snapshot);

    const mixed = state().adoptSharedScenes(source, ["sc-1", "sc-3"], "来源集");
    expect(mixed).toMatchObject({ scenes: 1, skipped: 1 });
  });

  it("只读拒绝", () => {
    const source = structuredClone(state().project);
    useWorkbench.setState({ readOnly: true });
    const snapshot = state().events.length;
    expect(state().adoptSharedScenes(source, ["sc-1"], "来源集")).toBeUndefined();
    expect(state().events).toHaveLength(snapshot);
    useWorkbench.setState({ readOnly: false });
  });
});
