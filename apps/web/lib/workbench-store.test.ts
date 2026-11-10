import { rebuild, type ProjectEvent } from "@loomina/ir";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setEventLog, type EventLog } from "./event-log";
import { claimWriter, releaseWriter } from "./writer-lock";
import { toStageView } from "./read-model";
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
