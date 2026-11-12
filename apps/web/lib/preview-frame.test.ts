import { describe, expect, it, vi } from "vitest";
import {
  FRAME_STEP_MS,
  FRAME_THROTTLE_MS,
  canPreviewFrames,
  clampFrameWidth,
  createFrameThrottle,
  frameArgsOf,
  frameKeyOf,
  frameMs,
  frameUrlOf,
  parseFrameRequest,
  probeFrameCapability,
  resetFrameProbeForTests,
  stepFrame,
} from "./preview-frame";

const HASH = "a".repeat(64);
const STORED = `loomina://assets/${HASH}.mp4`;

describe("帧级找点：地址与换算（E7.2 / ADR-0129）", () => {
  it("切帧地址带上素材、时刻与宽度", () => {
    const url = frameUrlOf(STORED, 1234.6);
    expect(url.startsWith("/api/preview/frame?")).toBe(true);
    const params = new URLSearchParams(url.slice("/api/preview/frame?".length));
    expect(params.get("asset")).toBe(STORED);
    expect(params.get("at")).toBe("1235");
    expect(params.get("w")).toBe("360");
  });

  it("时刻取整到毫秒并夹住下界", () => {
    expect(frameMs(0)).toBe(0);
    expect(frameMs(-20)).toBe(0);
    expect(frameMs(10.4)).toBe(10);
    expect(frameMs(Number.NaN)).toBe(0);
    expect(frameMs(9000, 5000)).toBe(5000);
  });

  it("宽度夹在 120–720 之间", () => {
    expect(clampFrameWidth(10)).toBe(120);
    expect(clampFrameWidth(2000)).toBe(720);
    expect(clampFrameWidth(360)).toBe(360);
    expect(clampFrameWidth(Number.NaN)).toBe(360);
  });

  it("只有本机资产库里的片子能切帧：data URI 塞不进查询串", () => {
    expect(canPreviewFrames(STORED)).toBe(true);
    expect(canPreviewFrames("data:video/mp4;base64,AAAA")).toBe(false);
    expect(canPreviewFrames("https://cdn.example.com/a.mp4")).toBe(false);
    expect(canPreviewFrames(undefined)).toBe(false);
  });

  it("同一处只切一次：键由素材与时刻组成", () => {
    expect(frameKeyOf(STORED, 1200)).toBe(frameKeyOf(STORED, 1200));
    expect(frameKeyOf(STORED, 1200)).not.toBe(frameKeyOf(STORED, 1233));
  });

  it("逐帧步进一步 33ms，夹在两端", () => {
    expect(stepFrame(1000, 1)).toBe(1000 + FRAME_STEP_MS);
    expect(stepFrame(1000, -1)).toBe(1000 - FRAME_STEP_MS);
    expect(stepFrame(10, -1)).toBe(0);
    expect(stepFrame(9990, 1, 10_000)).toBe(10_000);
  });
});

describe("切帧请求校验", () => {
  const parse = (query: Record<string, string>) =>
    parseFrameRequest(new URLSearchParams(query));

  it("正常请求原样通过", () => {
    const result = parse({ asset: STORED, at: "1500", w: "480" });
    expect(result).toEqual({ ok: true, value: { asset: STORED, atMs: 1500, width: 480 } });
  });

  it("没给宽度就用默认值", () => {
    const result = parse({ asset: STORED, at: "0" });
    expect(result.ok && result.value.width).toBe(360);
  });

  it("data URI 被拒绝，并说清怎么办", () => {
    const result = parse({ asset: "data:video/mp4;base64,AAAA", at: "0" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("本机资产库");
  });

  it("缺时刻、负时刻、离谱的时刻都拒绝", () => {
    expect(parse({ asset: STORED }).ok).toBe(false);
    expect(parse({ asset: STORED, at: "-5" }).ok).toBe(false);
    expect(parse({ asset: STORED, at: "abc" }).ok).toBe(false);
    expect(parse({ asset: STORED, at: String(2 * 60 * 60 * 1000) }).ok).toBe(false);
  });
});

describe("ffmpeg 切帧参数", () => {
  it("-ss 在 -i 之前、只出一帧、输出走管道", () => {
    const args = frameArgsOf({ src: "/tmp/a.mp4", atMs: 1500, width: 360 });
    const ss = args.indexOf("-ss");
    const input = args.indexOf("-i");
    expect(ss).toBeGreaterThan(-1);
    expect(ss).toBeLessThan(input);
    expect(args[ss + 1]).toBe("1.500");
    expect(args[input + 1]).toBe("/tmp/a.mp4");
    expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
    expect(args.at(-1)).toBe("pipe:1");
    // 高度按比例取偶数：mjpeg 不收奇数高度
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=360:-2");
  });

  it("宽度先夹住再写进参数", () => {
    const args = frameArgsOf({ src: "/tmp/a.mp4", atMs: 0, width: 5000 });
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=720:-2");
  });
});

describe("拖动节流", () => {
  function harness() {
    let clock = 0;
    let timer: (() => void) | undefined;
    const throttle = createFrameThrottle({
      throttleMs: FRAME_THROTTLE_MS,
      now: () => clock,
      setTimer: (fn) => {
        timer = fn;
        return 1;
      },
      clearTimer: () => {
        timer = undefined;
      },
    });
    return {
      throttle,
      advance(ms: number) {
        clock += ms;
      },
      fireTimer() {
        const fn = timer;
        timer = undefined;
        fn?.();
      },
      get armed() {
        return timer !== undefined;
      },
    };
  }

  it("第一次立刻发", () => {
    const h = harness();
    const fire = vi.fn();
    h.throttle.request("a@0", fire);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("同一处不重复发", () => {
    const h = harness();
    const fire = vi.fn();
    h.throttle.request("a@0", fire);
    h.throttle.request("a@0", fire);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("60ms 内的多次拖动只发最后一次", () => {
    const h = harness();
    const first = vi.fn();
    const mid = vi.fn();
    const last = vi.fn();
    h.throttle.request("a@0", first);
    h.advance(10);
    h.throttle.request("a@100", mid);
    h.advance(10);
    h.throttle.request("a@200", last);
    expect(h.armed).toBe(true);
    h.advance(FRAME_THROTTLE_MS);
    h.fireTimer();
    expect(first).toHaveBeenCalledTimes(1);
    expect(mid).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledTimes(1);
  });

  it("过了节流窗口，下一次立刻发", () => {
    const h = harness();
    const first = vi.fn();
    const second = vi.fn();
    h.throttle.request("a@0", first);
    h.advance(FRAME_THROTTLE_MS + 1);
    h.throttle.request("a@500", second);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("失败后 forget 让同一处能重试", () => {
    const h = harness();
    const fire = vi.fn();
    h.throttle.request("a@0", fire);
    h.throttle.request("a@0", fire);
    expect(fire).toHaveBeenCalledTimes(1);
    h.throttle.forget();
    h.throttle.request("a@0", fire);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("cancel 丢掉待发的那一次", () => {
    const h = harness();
    const first = vi.fn();
    const pending = vi.fn();
    h.throttle.request("a@0", first);
    h.advance(5);
    h.throttle.request("a@1", pending);
    h.throttle.cancel();
    expect(h.armed).toBe(false);
    h.advance(100);
    expect(pending).not.toHaveBeenCalled();
  });
});

describe("能力探测", () => {
  it("服务端能切帧：报 frame 与 ffmpeg 版本", async () => {
    resetFrameProbeForTests();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ tier: "frame", ffmpeg: "9.0.2" })));
    const capability = await probeFrameCapability({ fetcher: fetcher as unknown as typeof fetch });
    expect(capability).toEqual({ tier: "frame", ffmpeg: "9.0.2" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("结果缓存 5 分钟，不反复问", async () => {
    resetFrameProbeForTests();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ tier: "frame", ffmpeg: "9" })));
    await probeFrameCapability({ fetcher: fetcher as unknown as typeof fetch, now: 1000 });
    await probeFrameCapability({ fetcher: fetcher as unknown as typeof fetch, now: 2000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await probeFrameCapability({
      fetcher: fetcher as unknown as typeof fetch,
      now: 1000 + 5 * 60 * 1000 + 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("服务端说切不了：退回近似，并带上原因", async () => {
    resetFrameProbeForTests();
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ tier: "approx", reason: "没有 ffmpeg" })),
    );
    const capability = await probeFrameCapability({ fetcher: fetcher as unknown as typeof fetch });
    expect(capability).toEqual({ tier: "approx", reason: "没有 ffmpeg" });
  });

  it("请求本身失败也退回近似，不抛错", async () => {
    resetFrameProbeForTests();
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    });
    const capability = await probeFrameCapability({ fetcher: fetcher as unknown as typeof fetch });
    expect(capability.tier).toBe("approx");
  });
});
