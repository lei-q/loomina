"use client";

import type { EditView } from "@/lib/edit";
import { isStoredAssetUri, storedAssetRef, mimeForExtension } from "@/lib/asset-uri";

/**
 * 把资产库地址换回内嵌字节（H3 / ADR-0128）。
 *
 * 导出包、预览 HTML 与 OTIO 都要求「自包含」（准则 P20）：双击打开就能用，
 * 不依赖本机服务在跑。资产库里的素材只有地址，所以导出前要读回字节、
 * 换成 `data:` URI。
 *
 * 读不回来的素材保留原地址，并计入 `failed`——界面如实说「这几个没内嵌」，
 * 不假装导出包是完整的。
 */
export type Hydrated = { view: EditView; failed: number };

async function bytesToDataUri(uri: string): Promise<string | null> {
  const ref = storedAssetRef(uri);
  if (!ref) return null;
  try {
    const response = await fetch(`/api/asset/${ref.hash}.${ref.extension}`);
    if (!response.ok) return null;
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength === 0) return null;
    // 不用 FileReader：它只活在浏览器里，这一层在单测与将来服务端复用都要跑
    let binary = "";
    const chunk = 0x8000;
    for (let at = 0; at < buffer.length; at += chunk) {
      binary += String.fromCharCode(...buffer.subarray(at, at + chunk));
    }
    return `data:${mimeForExtension(ref.extension)};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

export async function hydrateView(view: EditView): Promise<Hydrated> {
  const cache = new Map<string, string | null>();
  // 按地址数，不按引用次数：同一段素材被四处引用时，坏一次只说「一个没读回来」
  const failedUris = new Set<string>();

  const swap = async (uri?: string): Promise<string | undefined> => {
    if (!uri || !isStoredAssetUri(uri)) return uri;
    if (!cache.has(uri)) cache.set(uri, await bytesToDataUri(uri));
    const inline = cache.get(uri);
    if (!inline) {
      failedUris.add(uri);
      return uri;
    }
    return inline;
  };

  const clips = await Promise.all(
    view.clips.map(async (clip) => {
      const uri = await swap(clip.uri);
      const stillUri = await swap(clip.stillUri);
      const lines = await Promise.all(
        clip.lines.map(async (line) => ({ ...line, audioUri: await swap(line.audioUri) })),
      );
      return { ...clip, uri, stillUri, lines };
    }),
  );
  const music = await Promise.all(
    view.music.map(async (cue) => ({ ...cue, uri: await swap(cue.uri) })),
  );

  return { view: { ...view, clips, music }, failed: failedUris.size };
}
