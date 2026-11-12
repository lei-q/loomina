import { NextResponse } from "next/server";
import { MAX_ASSET_BYTES, isStoredAssetUri, storedAssetRef } from "@/lib/asset-uri";
import { assetStore } from "@/lib/asset-store";

/**
 * 本机资产库的写入与统计（H3 / ADR-0128）。
 *
 * `GET`    统计：库里几个文件、共多少字节
 * `POST`   把一段 data URI 搬进库，回 `loomina://` 地址（内容相同则复用）
 * `DELETE` 清掉库里没人引用的文件；调用方要带上「还在用的地址」
 *
 * 迁移是显式动作：一次几十兆的读写 + 几十条事件，不能自动跑。
 */
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  try {
    const files = await assetStore().list();
    return NextResponse.json(
      {
        count: files.length,
        bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        // 地址与大小一起回：设置页要在浏览器里做跨项目孤儿检查（H3），
        // 只给数量不够；这里仍然只有本机库的地址，不碰项目内容。
        files: files.map((file) => ({ uri: file.uri, bytes: file.bytes })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读不到本机资产库" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { uri?: unknown } | null;
  const uri = typeof body?.uri === "string" ? body.uri.trim() : "";
  if (!uri) return NextResponse.json({ error: "缺少素材地址" }, { status: 400 });
  // 已经是资产库地址：重复搬一次没有意义，直接回原地址
  if (isStoredAssetUri(uri)) {
    const ref = storedAssetRef(uri);
    return NextResponse.json({ uri, stored: true, ...(ref ? { extension: ref.extension } : {}) });
  }

  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(uri);
  if (!match) {
    return NextResponse.json(
      { error: "只收 data URI（data:image/…;base64,…）" },
      { status: 400 },
    );
  }
  const bytes = Buffer.from(match[2]!.replace(/\s+/g, ""), "base64");
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "这段素材是空的" }, { status: 400 });
  }
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    return NextResponse.json(
      { error: `单个素材不能超过 ${MAX_ASSET_BYTES / 1024 / 1024} MB` },
      { status: 413 },
    );
  }

  try {
    const stored = await assetStore().put({ bytes, mime: match[1]!.toLowerCase() });
    return NextResponse.json(stored, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "写不进本机资产库" },
      { status: 500 },
    );
  }
}

/**
 * 只删「地址不在 keep 里」的文件。
 *
 * 按内容寻址意味着一个文件可能被多个资产共用，所以判断依据是地址而不是资产 id；
 * 客户端把当前项目里所有资产地址送上来，剩下的才算孤立。
 *
 * `dryRun: true` 只回「会删几个、多少字节」，用于两步确认的第一句人话。
 */
export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { keep?: unknown; dryRun?: unknown }
    | null;
  if (!Array.isArray(body?.keep)) {
    return NextResponse.json({ error: "缺少「还在用的地址」清单" }, { status: 400 });
  }
  const keep = new Set(
    body.keep.filter((item): item is string => typeof item === "string").map((item) => item.trim()),
  );
  const dryRun = body.dryRun === true;

  try {
    const files = await assetStore().list();
    const orphans = files.filter((file) => !keep.has(file.uri));
    if (dryRun) {
      return NextResponse.json(
        {
          wouldRemove: orphans.length,
          bytes: orphans.reduce((sum, file) => sum + file.bytes, 0),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    let removed = 0;
    let bytes = 0;
    for (const file of orphans) {
      if (await assetStore().remove(file.uri)) {
        removed += 1;
        bytes += file.bytes;
      }
    }
    return NextResponse.json({ removed, bytes }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "清理失败" },
      { status: 500 },
    );
  }
}
