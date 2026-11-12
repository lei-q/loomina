import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditView } from "./edit";
import { hydrateView } from "./asset-hydrate";

const HASH = "f".repeat(64);
const PNG_BYTES = new Uint8Array([137, 80, 78, 71]);

function view(uri: string): EditView {
  return {
    title: "测试",
    version: 1,
    clips: [
      {
        id: "c1",
        shotId: "s1",
        shotNo: 1,
        takeId: "t1",
        takeNo: 1,
        takeStatus: "approved",
        startMs: 0,
        durationMs: 1000,
        uri,
        stillUri: uri,
        hasPicture: true,
        art: "corridor",
        sceneCode: "1",
        locked: false,
        takes: [],
        lines: [
          {
            id: "d1",
            text: "走",
            characterId: "ch1",
            characterName: "林",
            startMs: 0,
            durationMs: 1000,
            audioStartMs: 0,
            cueStartMs: 0,
            voiceOffsetMs: 0,
            subtitleOffsetMs: 0,
            audioUri: uri,
            cues: [],
          },
        ],
      },
    ],
    music: [
      {
        id: "m1",
        assetId: "a1",
        title: "床",
        mood: "",
        uri,
        startMs: 0,
        durationMs: 1000,
        gainDb: -18,
        duckDb: 15,
        ducking: true,
        loop: true,
        role: "bed",
        licenseRef: "自己录",
      },
    ],
    cues: [],
    maxChars: 12,
    subtitleStyle: { id: "default", label: "默认", fontSizeCqw: 4.6, bottomPct: 14, strokeCqw: 0.55 },
    subtitleCustom: false,
    totalMs: 1000,
    totalSec: 1,
    noPicture: 0,
    withVoice: 1,
    missing: 0,
  };
}

describe("导出前把资产库素材读回内嵌字节（H3 / ADR-0128）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loomina:// 换成 data URI，同一个地址只请求一次", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response(PNG_BYTES, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }),
    );

    const result = await hydrateView(view(`loomina://assets/${HASH}.png`));

    expect(calls).toEqual([`/api/asset/${HASH}.png`]);
    expect(result.failed).toBe(0);
    const clip = result.view.clips[0]!;
    expect(clip.uri).toMatch(/^data:image\/png;base64,/);
    expect(clip.stillUri).toBe(clip.uri);
    expect(clip.lines[0]!.audioUri).toBe(clip.uri);
    expect(result.view.music[0]!.uri).toBe(clip.uri);
  });

  it("读不回来时保留原地址，并数出来", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));

    const result = await hydrateView(view(`loomina://assets/${HASH}.png`));

    expect(result.failed).toBe(1);
    expect(result.view.clips[0]!.uri).toBe(`loomina://assets/${HASH}.png`);
  });

  it("data URI 与 http(s) 原样返回，一次请求都不发", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const inline = await hydrateView(view("data:image/png;base64,AAAA"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inline.view.clips[0]!.uri).toBe("data:image/png;base64,AAAA");

    const remote = await hydrateView(view("https://cdn.example.com/a.png"));
    expect(remote.view.clips[0]!.uri).toBe("https://cdn.example.com/a.png");
    expect(remote.failed).toBe(0);
  });
});

describe("对象存储里的素材也能读回内嵌（H3 / s3://）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("s3:// 走 /api/storage 读字节，mime 由 key 的扩展名反推", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response(PNG_BYTES, { status: 200 });
      }),
    );

    const uri = "s3://loomina/assets/ab/abcd.png";
    const result = await hydrateView(view(uri));

    expect(calls).toEqual([`/api/storage?uri=${encodeURIComponent(uri)}`]);
    expect(result.failed).toBe(0);
    expect(result.view.clips[0]!.uri).toMatch(/^data:image\/png;base64,/);
  });

  it("桶里没有这个对象时保留原地址并计数", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));

    const uri = "s3://loomina/assets/ab/abcd.png";
    const result = await hydrateView(view(uri));
    expect(result.failed).toBe(1);
    expect(result.view.clips[0]!.uri).toBe(uri);
  });
});
