import { describe, expect, it } from "vitest";
import {
  PROXY_WIDTH,
  canProxy,
  parseProxyRequest,
  proxyArgsOf,
  proxyCacheName,
  proxyRangeOf,
  proxyUrlOf,
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
