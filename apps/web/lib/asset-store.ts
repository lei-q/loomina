import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "@/lib/app-config";
import {
  MAX_ASSET_BYTES,
  extensionForMime,
  mimeForExtension,
  storedAssetRef,
  storedAssetUri,
  type StoredAssetRef,
} from "@/lib/asset-uri";

/**
 * 本机资产库（H3 / ADR-0128）。
 *
 * 素材不再以 base64 躺在事件日志里：按内容寻址落成
 * `.loomina/assets/<sha256>.<ext>`（目录 0700、文件 0600），IR 里只存
 * `loomina://assets/<sha256>.<ext>`。同一段字节存两次只占一份。
 *
 * 这个文件只在 Node 运行时里用（浏览器拿地址走 `assetHref`），
 * 别从客户端组件 import。
 */

export type StoredAsset = {
  /** 稳定地址，进 IR 的就是它 */
  uri: string;
  bytes: number;
  sha256: string;
  mime: string;
};

export type AssetStore = {
  /** 读：地址不存在、扩展名不认识、文件读不出来都返回 null，不抛错 */
  read(uri: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
  /** 写：内容相同则复用同一份；超过上限直接拒绝 */
  put(input: { bytes: Uint8Array; mime: string }): Promise<StoredAsset>;
  /** 删：只删没人引用的；调用方保证引用已清 */
  remove(uri: string): Promise<boolean>;
  /** 列：库里所有文件（回收站与迁移统计用） */
  list(): Promise<{ uri: string; bytes: number; mtimeMs: number }[]>;
};

/** 本机资产库目录：与 config.json / render-jobs.json 同一处（`.loomina/`） */
export function assetStoreDir(): string {
  const override = process.env.LOOMINA_ASSET_DIR?.trim();
  if (override) return path.resolve(/* turbopackIgnore: true */ process.cwd(), override);
  return path.join(/* turbopackIgnore: true */ projectRoot(), ".loomina", "assets");
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 把地址解析成盘上的绝对路径；不是资产库地址返回 null */
export function localPathOf(uri: string): string | null {
  const ref = storedAssetRef(uri);
  return ref ? filePathOf(ref) : null;
}

function filePathOf(ref: StoredAssetRef): string {
  return path.join(/* turbopackIgnore: true */ assetStoreDir(), `${ref.hash}.${ref.extension}`);
}

export const localAssetStore: AssetStore = {
  async read(uri) {
    const ref = storedAssetRef(uri);
    if (!ref) return null;
    try {
      const bytes = await readFile(filePathOf(ref));
      return { bytes, mime: mimeForExtension(ref.extension) };
    } catch {
      return null;
    }
  },

  async put({ bytes, mime }) {
    if (bytes.byteLength === 0) throw new Error("素材是空的");
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw new Error(`素材超过 ${MAX_ASSET_BYTES / 1024 / 1024} MB 上限`);
    }
    const sha256 = sha256Of(bytes);
    const extension = extensionForMime(mime);
    const uri = storedAssetUri(sha256, extension);
    const dir = assetStoreDir();
    const file = filePathOf({ hash: sha256, extension });

    // 已存在就是同一段字节：直接复用，不重写（也顺手把权限纠正回来）
    const exists = await stat(file).then(
      (info) => info.isFile(),
      () => false,
    );
    if (exists) {
      await chmod(file, 0o600).catch(() => {});
      return { uri, bytes: bytes.byteLength, sha256, mime };
    }

    await mkdir(dir, { recursive: true, mode: 0o700 });
    // 先写临时文件再 rename：写到一半失败不会留下半个"存在的"素材
    const temp = path.join(/* turbopackIgnore: true */ dir, `.${sha256}.${process.pid}.tmp`);
    await writeFile(temp, bytes, { mode: 0o600 });
    await chmod(temp, 0o600).catch(() => {});
    await rename(temp, file);
    return { uri, bytes: bytes.byteLength, sha256, mime };
  },

  async remove(uri) {
    const ref = storedAssetRef(uri);
    if (!ref) return false;
    try {
      await unlink(filePathOf(ref));
      return true;
    } catch {
      return false;
    }
  },

  async list() {
    const dir = assetStoreDir();
    const names = await readdir(dir).catch(() => [] as string[]);
    const found: { uri: string; bytes: number; mtimeMs: number }[] = [];
    for (const name of names) {
      const uri = nameToUri(name);
      if (!uri) continue;
      const info = await stat(path.join(/* turbopackIgnore: true */ dir, name)).catch(() => null);
      if (!info?.isFile()) continue;
      found.push({ uri, bytes: info.size, mtimeMs: info.mtimeMs });
    }
    return found.sort((a, b) => a.mtimeMs - b.mtimeMs);
  },
};

function nameToUri(name: string): string | null {
  const match = /^([0-9a-f]{64})\.([a-z0-9]{1,8})$/.exec(name);
  return match ? storedAssetUri(match[1]!, match[2]!) : null;
}

/**
 * 本机资产库的读写入口。
 *
 * **只返回本机实现**：设置页的「本机资产库」区讲的就是这一份，对象存储
 * 另有 `storage-runtime.ts`。想「当前实际用哪个」用那边，别在这里做选择——
 * 混在一起会让「清掉没人引用的文件」删错东西（那一条只该动 `.loomina/assets/`）。
 */
export function assetStore(): AssetStore {
  return localAssetStore;
}

/** 地址 → 字节：`loomina://` 读盘，`s3://` 走对象存储，`data:` 就地解 base64 */
export async function readAssetBytes(
  uri: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const trimmed = uri.trim();
  if (storedAssetRef(trimmed)) return localAssetStore.read(trimmed);
  if (trimmed.startsWith("s3://")) {
    const { activeStore } = await import("@/lib/storage-runtime");
    return (await activeStore()).read(trimmed);
  }
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
  if (!match) return null;
  return {
    bytes: Buffer.from(match[2]!.replace(/\s+/g, ""), "base64"),
    mime: match[1]!.toLowerCase(),
  };
}
