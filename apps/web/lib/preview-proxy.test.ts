import { describe, expect, it } from "vitest";
import {
  PROXY_WIDTH,
  canProxy,
  parseProxyRequest,
  planProxyEviction,
  proxyArgsOf,
  proxyCacheName,
  proxyCacheOf,
  proxyRangeOf,
  proxyUrlOf,
  type ProxyFile,
} from "./preview-proxy";

const HASH = (value: string) => `h${value[17] ?? "?"}${value.length}`;

describe("540p 代理（E7）", () => {
  it("只认资产库里的片子；data 与 https 不行", () => {
    expect(canProxy("loomina://assets/" + "a".repeat(64) + ".mp4")).toBe(true);
    expect(canProxy("s3://bucket/proxy.mp4")).toBe(true);
    expect(canProxy("data:video/mp4;base64,QUJD")).toBe(false);
    expect(canProxy("https://cdn.example.com/x.mp4")).toBe(false);
    expect(canProxy(undefined)).toBe(false);
  });

  it("缓存名按地址哈希，同一地址稳定、不同地址分开", () => {
    const a = "loomina://assets/" + "a".repeat(64) + ".mp4";
    const b = "loomina://assets/" + "b".repeat(64) + ".mp4";
    expect(proxyCacheName(a, HASH)).toBe(proxyCacheName(a, HASH));
    expect(proxyCacheName(a, HASH)).not.toBe(proxyCacheName(b, HASH));
    expect(proxyCacheName(a, HASH)).toMatch(new RegExp(`\\.${PROXY_WIDTH}\\.mp4$`));
  });

  it("请求校验：没给地址或不认识的地址都拒绝", () => {
    expect(parseProxyRequest(new URLSearchParams())).toEqual({ ok: false, error: "没给素材地址" });
    const bad = parseProxyRequest(new URLSearchParams({ asset: "ftp://nope/x.mp4" }));
    expect(bad.ok).toBe(false);
    const good = parseProxyRequest(
      new URLSearchParams({ asset: "s3://bucket/p.mp4" }),
    );
    expect(good.ok).toBe(true);
  });

  it("浏览器地址带上素材参数", () => {
    expect(proxyUrlOf("s3://bucket/p.mp4")).toBe("/api/preview/proxy?asset=s3%3A%2F%2Fbucket%2Fp.mp4");
  });

  it("浏览器拖动只回它问的那一段", () => {
    expect(proxyRangeOf("bytes=100-", 500)).toEqual({ start: 100, end: 499 });
    expect(proxyRangeOf("bytes=0-99", 500)).toEqual({ start: 0, end: 99 });
    expect(proxyRangeOf("bytes=-100", 500)).toEqual({ start: 400, end: 499 });
    expect(proxyRangeOf("bytes=900-", 500)).toBeNull();
    expect(proxyRangeOf(null, 500)).toBeNull();
  });

  it("ffmpeg 参数：540 宽、24fps、去音轨、faststart", () => {
    const args = proxyArgsOf({ src: "/tmp/a.mp4", out: "/tmp/a-proxy.mp4" });
    const joined = args.join(" ");
    expect(joined).toContain(`scale=${PROXY_WIDTH}:-2`);
    expect(joined).toContain("-r 24");
    expect(joined).toContain("-an");
    expect(joined).toContain("+faststart");
    // 输入在前、输出在后
    expect(args.indexOf("/tmp/a.mp4")).toBeLessThan(args.indexOf("/tmp/a-proxy.mp4"));
  });
});

describe("代理缓存上限（E7 / ADR-0178）", () => {
  const MB = 1024 * 1024;
  const file = (name: string, mb: number, age: number): ProxyFile => ({
    name,
    bytes: mb * MB,
    mtimeMs: 1_000_000 - age,
  });

  it("没超上限就一份都不删", () => {
    const plan = planProxyEviction([file("a.mp4", 100, 5), file("b.mp4", 100, 1)], undefined, 400 * MB);
    expect(plan.evict).toEqual([]);
    expect(plan.freedBytes).toBe(0);
    expect(plan.bytes).toBe(200 * MB);
  });

  it("超了就按最久没用的先删，删到不超为止", () => {
    const files = [file("old.mp4", 100, 50), file("mid.mp4", 100, 30), file("new.mp4", 100, 10)];
    const plan = planProxyEviction(files, "new.mp4", 250 * MB);
    expect(plan.evict).toEqual(["old.mp4"]);
    expect(plan.bytes).toBe(200 * MB);
  });

  it("刚写好的那份永远不删，哪怕它最旧", () => {
    const files = [file("fresh.mp4", 100, 999), file("mid.mp4", 100, 30), file("new.mp4", 100, 10)];
    const plan = planProxyEviction(files, "fresh.mp4", 150 * MB);
    expect(plan.evict).not.toContain("fresh.mp4");
    expect(plan.bytes).toBeLessThanOrEqual(150 * MB);
  });

  it("清点里带上超了多少", () => {
    expect(proxyCacheOf([file("a.mp4", 100, 1)]).over).toBe(0);
    expect(proxyCacheOf([file("a.mp4", 300, 1)], 200 * MB).over).toBe(100 * MB);
  });
});
