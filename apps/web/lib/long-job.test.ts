import { afterEach, describe, expect, it } from "vitest";
import {
  longJobSnapshot,
  resetLongJobQueueForTests,
  withLongJobSlot,
} from "./long-job";

afterEach(() => {
  resetLongJobQueueForTests();
});

/** 一个能手动放行的任务：测「同时只跑一个」必须能控制谁还没结束 */
function gate() {
  let open: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { done, open };
}

describe("长任务队列（H2 / ADR-0135）", () => {
  it("同时只跑一个：后到的等前一个让位", async () => {
    const order: string[] = [];
    const first = gate();
    const second = gate();

    const a = withLongJobSlot("render", "夜班", async () => {
      order.push("a:start");
      await first.done;
      order.push("a:end");
    });
    const b = withLongJobSlot("image", "林 的三视图", async () => {
      order.push("b:start");
      await second.done;
      order.push("b:end");
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["a:start"]);
    expect(longJobSnapshot().active?.kind).toBe("render");
    expect(longJobSnapshot().waiting).toHaveLength(1);

    first.open();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
    expect(longJobSnapshot().active?.kind).toBe("image");

    second.open();
    await Promise.all([a, b]);
    expect(longJobSnapshot().active).toBeNull();
  });

  it("按先来后到放行，不插队", async () => {
    const order: string[] = [];
    const first = gate();
    const other = gate();

    const a = withLongJobSlot("render", "第一条", async () => {
      await first.done;
    });
    const b = withLongJobSlot("image", "第二", async () => {
      order.push("b");
    });
    const c = withLongJobSlot("video", "第三", async () => {
      order.push("c");
      await other.done;
    });

    first.open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 第二跑完立刻让位给第三：两条都启动过，但 b 一定在 c 前面
    expect(order).toEqual(["b", "c"]);

    other.open();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["b", "c"]);
  });

  it("真排上队才回调 onWait：第一个任务不回调", async () => {
    const waits: string[] = [];
    const first = gate();
    const a = withLongJobSlot("render", "第一条", async () => {
      await first.done;
    }, () => waits.push("a"));
    const b = withLongJobSlot("image", "第二条", async () => {}, () => waits.push("b"));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(waits).toEqual(["b"]);

    first.open();
    await Promise.all([a, b]);
  });

  it("任务抛错也让位：一次失败不能把整条队列卡死", async () => {
    await expect(
      withLongJobSlot("image", "炸了", async () => {
        throw new Error("供应商 502");
      }),
    ).rejects.toThrow("供应商 502");

    const result = await withLongJobSlot("video", "下一个", async () => "ok");
    expect(result).toBe("ok");
    expect(longJobSnapshot().active).toBeNull();
  });

  it("快照说清在跑什么、等了多久", async () => {
    const gateA = gate();
    const running = withLongJobSlot("render", "夜班 成片", async () => {
      await gateA.done;
    });
    const queued = withLongJobSlot("image", "林 的三视图", async () => {});

    await new Promise((resolve) => setTimeout(resolve, 10));
    const snapshot = longJobSnapshot();
    expect(snapshot.active?.label).toBe("夜班 成片");
    expect(snapshot.active?.kind).toBe("render");
    expect(snapshot.active?.seconds).toBeGreaterThanOrEqual(0);
    expect(snapshot.waiting[0]?.label).toBe("林 的三视图");

    gateA.open();
    await Promise.all([running, queued]);
  });
});
