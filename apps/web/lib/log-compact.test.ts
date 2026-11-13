import { describe, expect, it } from "vitest";
import { rebuild, type Asset, type ProjectEvent } from "@loomina/ir";
import { sampleProject } from "./sample-project";
import {
  compactEvents,
  dataUriBytesOf,
  inlinePayloadsOf,
  logBytesOf,
  replacementsFor,
  sha256OfBytes,
  storedIndexOf,
} from "./log-compact";

const AT = "2026-11-13T08:00:00.000Z";

/** 一段真字节（400 字节，约 536 个 base64 字符）：比 `loomina://assets/<sha256>.png` 长 */
function dataUri(fill: number): string {
  const char = String.fromCharCode(65 + (fill % 26));
  return `data:image/png;base64,${btoa(char.repeat(400))}`;
}
const SMALL = dataUri(1);
const OTHER = dataUri(2);

function asset(id: string, uri: string): Asset {
  return { id, kind: "image", uri, source: "generated", createdAt: AT };
}

function eventOf(assetValue: Asset): ProjectEvent {
  return { type: "asset.updated", at: AT, asset: assetValue };
}

function created(uri: string): ProjectEvent {
  const project = { ...sampleProject, assets: [asset("a-1", uri)] };
  return { type: "project.created", at: AT, project };
}

async function storeNameOf(uri: string): Promise<string> {
  const payload = dataUriBytesOf(uri)!;
  const hash = (await sha256OfBytes(payload.bytes))!;
  return `${hash}.png`;
}

describe("日志压缩（H3 / ADR-0177）", () => {
  it("认得出日志里还在带 base64 的地方：去重、出现次数、字节数", () => {
    const events = [created(SMALL), eventOf(asset("a-1", SMALL)), eventOf(asset("a-2", OTHER))];
    const payloads = inlinePayloadsOf(events);
    expect(payloads.uris).toEqual([SMALL, OTHER]);
    expect(payloads.occurrences).toBe(3);
    // 每段 400 字节，共出现三次
    expect(payloads.bytes).toBe(1200);
  });

  it("库清单按最后一段建索引：本机库与桶共用一份，不猜前缀", () => {
    const index = storedIndexOf([
      { uri: "loomina://assets/aa.png" },
      { uri: "s3://bucket/assets/ab/bb.png" },
      { uri: "loomina://assets/cc.png" },
    ]);
    expect(index.get("aa.png")).toBe("loomina://assets/aa.png");
    expect(index.get("bb.png")).toBe("s3://bucket/assets/ab/bb.png");
    expect(index.size).toBe(3);
  });

  it("按内容指纹认同一段字节，不按资产 id 认", async () => {
    const name = await storeNameOf(SMALL);
    const index = storedIndexOf([{ uri: `loomina://assets/${name}` }]);
    const { map, unmatched } = await replacementsFor([SMALL, OTHER], index);
    expect(map.get(SMALL)).toBe(`loomina://assets/${name}`);
    // 同一类图片、不同字节：不能被认成同一张
    expect(map.has(OTHER)).toBe(false);
    expect(unmatched).toBe(1);
  });

  it("只换地址：事件条数、顺序、时间、其他字段都不动", () => {
    const events = [created(SMALL), eventOf(asset("a-1", SMALL)), eventOf(asset("a-2", OTHER))];
    const to = "loomina://assets/" + "a".repeat(64) + ".png";
    const compaction = compactEvents(events, new Map([[SMALL, to]]));

    expect(compaction.events).toHaveLength(events.length);
    expect(compaction.assets).toBe(2);
    expect(compaction.rewritten).toBe(2);
    expect(compaction.savedChars).toBeGreaterThan(0);
    expect(compaction.events.map((event) => event.at)).toEqual(events.map((event) => event.at));

    // 没有匹配的那条原样返回（同一个对象）
    expect(compaction.events[2]).toBe(events[2]);
    expect(compaction.events[1]).not.toBe(events[1]);
    const updated = compaction.events[1]!;
    expect(updated.type === "asset.updated" && updated.asset.uri).toBe(to);
  });

  it("回放结果只在 uri 上不同，项目其余部分逐字一致", () => {
    const events = [created(SMALL), eventOf(asset("a-2", OTHER))];
    const before = rebuild(events);
    const to = "loomina://assets/" + "b".repeat(64) + ".png";
    const after = rebuild(compactEvents(events, new Map([[SMALL, to]])).events);
    expect(after).toEqual({ ...before, assets: after.assets });
    expect(before.assets[0]?.uri).toBe(SMALL);
    expect(after.assets[0]?.uri).toBe(to);
    expect(after.assets[0]?.id).toBe(before.assets[0]?.id);
  });

  it("整条日志确实变小了", () => {
    const events = [created(SMALL), eventOf(asset("a-1", SMALL))];
    const to = "loomina://assets/" + "c".repeat(64) + ".png";
    const before = logBytesOf(events);
    const after = logBytesOf(compactEvents(events, new Map([[SMALL, to]])).events);
    expect(after).toBeLessThan(before);
  });

  it("不是 base64 的 data URI 与坏数据都不动", () => {
    expect(dataUriBytesOf("data:image/png,abc")).toBeNull();
    expect(dataUriBytesOf("data:image/png;base64,!!!")).toBeNull();
    const compaction = compactEvents([eventOf(asset("a-1", "data:image/png,abc"))], new Map());
    expect(compaction.rewritten).toBe(0);
  });
});
