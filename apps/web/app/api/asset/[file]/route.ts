import { readFile, stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { ASSET_STORE_PREFIX, mimeForExtension, storedAssetRef, storedAssetUri } from "@/lib/asset-uri";
import { localPathOf } from "@/lib/asset-store";

/**
 * 读本机资产库（H3 / ADR-0128）。
 *
 * `GET /api/asset/<sha256>.<ext>` —— 按内容寻址，所以内容永远不会变，
 * 可以让浏览器一直缓存（`immutable`）。
 *
 * 只认 64 位十六进制 + 已知扩展名：文件名不会拼出目录穿越，
 * 也读不到 `.loomina/` 里的配置与日志。
 */
export const runtime = "nodejs";

/** 缓存一年：地址里带内容哈希，内容变了地址就变了 */
const IMMUTABLE = "public, max-age=31536000, immutable";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
) {
  const { file } = await params;
  const ref = storedAssetRef(`${ASSET_STORE_PREFIX}${file}`);
  if (!ref) {
    return NextResponse.json({ error: "资产地址不认识" }, { status: 400 });
  }

  const uri = storedAssetUri(ref.hash, ref.extension);
  const path = localPathOf(uri);
  if (!path) {
    return NextResponse.json({ error: "资产地址不认识" }, { status: 400 });
  }

  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    return NextResponse.json({ error: "这个素材不在本机资产库里" }, { status: 404 });
  }

  const bytes = await readFile(path).catch(() => null);
  if (!bytes) {
    return NextResponse.json({ error: "这个素材读不出来" }, { status: 500 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mimeForExtension(ref.extension),
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": IMMUTABLE,
    },
  });
}
