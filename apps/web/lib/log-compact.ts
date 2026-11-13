import type { ProjectEvent } from "@loomina/ir";
import { extensionForMime } from "@/lib/asset-uri";
import { inlineBytesOf } from "@/lib/asset-inventory";

/**
 * 日志压缩（H3 / ADR-0177）。
 *
 * 素材搬进资产库之后，**旧事件里那份 base64 还在**：迁移只追加一条新的
 * `asset.updated`，从不改旧事件（ADR-0128）。所以日志不会因为迁移而变小，
 * 一个改过几版定妆图的项目能到几十兆。
 *
 * 压缩做的事只有一件：把事件里那段 base64 换成**库里同一段字节的地址**。
 * 判定靠内容指纹——只有哈希对得上才算同一段字节，不按资产 id 猜：
 * 同一个资产位换过图，旧事件里的那张与现在的这张不是一张。
 *
 * 不变量：事件条数、顺序、`at`、其他字段一个都不动；回放出来的项目
 * 与压缩前只在 `uri` 这个字符串上不同，指向的字节一模一样。
 */

/** data URI 解出来的内容：mime + 原始字节。不是 base64 的 data URI 返回 null */
export function dataUriBytesOf(uri: string): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(uri.trim());
  if (!match) return null;
  try {
    const binary = atob(match[2]!.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return { mime: match[1]!, bytes };
  } catch {
    return null;
  }
}

/** 内容指纹。环境没有 `crypto.subtle`（非安全上下文）时返回 null：那就不压 */
export async function sha256OfBytes(bytes: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  // 复制到一段独立的 ArrayBuffer：把视图直接交给 digest 时，
  // 类型上可能带着 SharedArrayBuffer，TS 与浏览器都不收
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await subtle.digest("SHA-256", buffer);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * 库清单 → 「内容文件名 → 地址」。
 *
 * 本机库是 `loomina://assets/<hash>.<ext>`，桶里是 `s3://桶/assets/<前两位>/<hash>.<ext>`：
 * 前缀不一样，但最后一段都是内容寻址的文件名。按最后一段建索引，
 * 两种库共用一份索引，也不用到浏览器里猜桶名与前缀。
 */
export function storedIndexOf(files: { uri: string }[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const file of files) {
    const name = file.uri.slice(file.uri.lastIndexOf("/") + 1);
    if (name) index.set(name, file.uri);
  }
  return index;
}

/** 日志里还在带 base64 的地方：去重后的地址、出现几次、共多少字节 */
export type InlinePayloads = {
  uris: string[];
  occurrences: number;
  bytes: number;
};

export function inlinePayloadsOf(events: ProjectEvent[]): InlinePayloads {
  const uris = new Set<string>();
  let occurrences = 0;
  let bytes = 0;
  const note = (uri: string | undefined) => {
    if (!uri || !uri.startsWith("data:")) return;
    uris.add(uri);
    occurrences += 1;
    bytes += inlineBytesOf(uri);
  };
  for (const event of events) {
    if (event.type === "asset.updated") {
      note(event.asset.uri);
    } else if (event.type === "project.created") {
      for (const asset of event.project.assets) note(asset.uri);
    }
  }
  return { uris: [...uris], occurrences, bytes };
}

/**
 * 给每段 base64 找库里的同一段字节。
 *
 * 先解 base64、算 sha256，再用「内容文件名」去索引里查。查不到就留原样：
 * 没搬进库的、或者库里的文件已经被清掉的，压缩会把字节弄丢。
 */
export async function replacementsFor(
  uris: string[],
  index: Map<string, string>,
): Promise<{ map: Map<string, string>; unmatched: number }> {
  const map = new Map<string, string>();
  let unmatched = 0;
  for (const uri of uris) {
    const payload = dataUriBytesOf(uri);
    if (!payload) {
      unmatched += 1;
      continue;
    }
    const hash = await sha256OfBytes(payload.bytes);
    const name = hash ? `${hash}.${extensionForMime(payload.mime)}` : undefined;
    const to = name ? index.get(name) : undefined;
    if (to) map.set(uri, to);
    else unmatched += 1;
  }
  return { map, unmatched };
}

export type Compaction = {
  events: ProjectEvent[];
  /** 改写了几条事件 */
  rewritten: number;
  /** 改写了几处素材地址（一条事件里可能不止一处，`project.created` 就是一整份） */
  assets: number;
  /** 这些 base64 换掉之后省下的字符数（新地址比 base64 短） */
  savedChars: number;
};

/** 纯替换：只动带 base64 的素材地址，其余事件原样返回（同一个对象，不复制） */
export function compactEvents(
  events: ProjectEvent[],
  replacements: Map<string, string>,
): Compaction {
  let rewritten = 0;
  let assets = 0;
  let savedChars = 0;
  const next = events.map((event) => {
    if (event.type === "asset.updated") {
      const uri = event.asset.uri;
      const to = uri ? replacements.get(uri) : undefined;
      if (!uri || !to) return event;
      rewritten += 1;
      assets += 1;
      savedChars += Math.max(0, uri.length - to.length);
      return { ...event, asset: { ...event.asset, uri: to } };
    }
    if (event.type === "project.created") {
      let touched = 0;
      let saved = 0;
      const nextAssets = event.project.assets.map((asset) => {
        const to = asset.uri ? replacements.get(asset.uri) : undefined;
        if (!asset.uri || !to) return asset;
        touched += 1;
        saved += Math.max(0, asset.uri.length - to.length);
        return { ...asset, uri: to };
      });
      if (touched === 0) return event;
      rewritten += 1;
      assets += touched;
      savedChars += saved;
      return { ...event, project: { ...event.project, assets: nextAssets } };
    }
    return event;
  });
  return { events: next, rewritten, assets, savedChars };
}

/** 整条日志现在的字节数（UTF-8）：界面上给人看的那个数 */
export function logBytesOf(events: ProjectEvent[]): number {
  const json = JSON.stringify(events);
  if (typeof TextEncoder === "undefined") return json.length;
  return new TextEncoder().encode(json).byteLength;
}
