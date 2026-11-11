import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assetHref,
  extensionForMime,
  isStoredAssetUri,
  mimeForExtension,
  storedAssetRef,
  storedAssetUri,
} from "./asset-uri";
import { assetStoreDir, localAssetStore, readAssetBytes, sha256Of } from "./asset-store";

const bytesOf = (text: string) => new TextEncoder().encode(text);

describe("资产地址（H3 / ADR-0128）", () => {
  it("地址里只有 64 位哈希与扩展名", () => {
    const hash = "a".repeat(64);
    expect(storedAssetUri(hash, "png")).toBe(`loomina://assets/${hash}.png`);
    expect(storedAssetRef(`loomina://assets/${hash}.png`)).toEqual({ hash, extension: "png" });
    expect(isStoredAssetUri(`loomina://assets/${hash}.png`)).toBe(true);
  });

  it("不是资产库地址一律返回 null", () => {
    for (const uri of [
      "data:image/png;base64,AAAA",
      "https://example.com/a.png",
      "loomina://assets/not-a-hash.png",
      "loomina://assets/../config.json",
      "",
    ]) {
      expect(storedAssetRef(uri)).toBeNull();
    }
  });

  it("扩展名与 mime 一一对应：audio/webm 用 weba，不和视频抢 webm", () => {
    expect(extensionForMime("audio/webm")).toBe("weba");
    expect(extensionForMime("video/webm")).toBe("webm");
    expect(mimeForExtension("weba")).toBe("audio/webm");
    expect(mimeForExtension("webm")).toBe("video/webm");
    expect(extensionForMime("image/tiff")).toBe("bin");
    expect(mimeForExtension("bin")).toBe("application/octet-stream");
  });

  it("浏览器地址：资产库换成 /api/asset/…，其余原样", () => {
    const hash = "b".repeat(64);
    expect(assetHref(`loomina://assets/${hash}.mp4`)).toBe(`/api/asset/${hash}.mp4`);
    expect(assetHref("data:image/png;base64,AA")).toBe("data:image/png;base64,AA");
    expect(assetHref("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(assetHref(undefined)).toBeUndefined();
  });
});

describe("本机资产库", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "loomina-assets-"));
    process.env.LOOMINA_ASSET_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.LOOMINA_ASSET_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("同一段字节存两次得到同一个地址，只落一个文件", async () => {
    const first = await localAssetStore.put({ bytes: bytesOf("hello"), mime: "image/png" });
    const second = await localAssetStore.put({ bytes: bytesOf("hello"), mime: "image/png" });

    expect(first.uri).toBe(second.uri);
    expect(first.sha256).toBe(sha256Of(bytesOf("hello")));
    expect(first.uri).toBe(`loomina://assets/${first.sha256}.png`);
    expect(await readdir(assetStoreDir())).toHaveLength(1);
  });

  it("读回来的是原字节与 mime", async () => {
    const stored = await localAssetStore.put({ bytes: bytesOf("world"), mime: "video/mp4" });
    const back = await localAssetStore.read(stored.uri);
    expect(back?.mime).toBe("video/mp4");
    expect(Buffer.from(back!.bytes).toString()).toBe("world");
  });

  it("读不存在的地址返回 null，不抛错", async () => {
    expect(await localAssetStore.read(`loomina://assets/${"c".repeat(64)}.png`)).toBeNull();
    expect(await localAssetStore.read("https://example.com/x.png")).toBeNull();
  });

  it("超过 200 MB 被拒，且不留残文件", async () => {
    const huge = new Uint8Array(200 * 1024 * 1024 + 1);
    await expect(localAssetStore.put({ bytes: huge, mime: "video/mp4" })).rejects.toThrow("200 MB");
    expect(await readdir(assetStoreDir()).catch(() => [])).toHaveLength(0);
  });

  it("空字节被拒", async () => {
    await expect(localAssetStore.put({ bytes: new Uint8Array(0), mime: "image/png" })).rejects.toThrow(
      "空的",
    );
  });

  it("目录 0700、文件 0600", async () => {
    const stored = await localAssetStore.put({ bytes: bytesOf("x"), mime: "image/png" });
    const file = path.join(assetStoreDir(), `${stored.sha256}.png`);
    expect((await stat(assetStoreDir())).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("删掉之后读不到，再 put 会重新写回来", async () => {
    const stored = await localAssetStore.put({ bytes: bytesOf("gone"), mime: "image/jpeg" });
    expect(await localAssetStore.remove(stored.uri)).toBe(true);
    expect(await localAssetStore.read(stored.uri)).toBeNull();
    expect(await localAssetStore.remove(stored.uri)).toBe(false);
    const again = await localAssetStore.put({ bytes: bytesOf("gone"), mime: "image/jpeg" });
    expect(again.uri).toBe(stored.uri);
    expect(await localAssetStore.read(again.uri)).not.toBeNull();
  });

  it("列出来的是地址与字节数，临时文件不算", async () => {
    const stored = await localAssetStore.put({ bytes: bytesOf("abc"), mime: "image/png" });
    await writeFile(path.join(assetStoreDir(), ".leftover.tmp"), "x");
    const files = await localAssetStore.list();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ uri: stored.uri, bytes: 3 });
  });

  it("readAssetBytes 两条路都通：data URI 就地解，资产库读盘", async () => {
    const inline = await readAssetBytes("data:text/plain;base64,aGk=");
    expect(Buffer.from(inline!.bytes).toString()).toBe("hi");
    expect(inline!.mime).toBe("text/plain");

    const stored = await localAssetStore.put({ bytes: bytesOf("from disk"), mime: "audio/mpeg" });
    const fromStore = await readAssetBytes(stored.uri);
    expect(Buffer.from(fromStore!.bytes).toString()).toBe("from disk");
    expect(fromStore!.mime).toBe("audio/mpeg");

    expect(await readAssetBytes("https://example.com/a.png")).toBeNull();
  });
});
