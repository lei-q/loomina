import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/app-config";
import { resolveStorage } from "@/lib/storage-config";
import { listS3Objects, removeS3Object } from "@/lib/s3-store";
import { loadEnvFile } from "@loomina/gateway";
import { envPath } from "@/lib/server-env";

/**
 * 桶里孤儿对象的清点与清理（H3 / ADR-0158 的远端那一半）。
 *
 * `GET`   列 `assets/` 前缀下的对象（地址 + 字节），只读。
 * `DELETE { keep, dryRun }` 删掉「地址不在 keep 里」的对象；
 *         `dryRun: true` 只回会删几个、多少字节，给两步确认的第一句人话。
 *
 * 白名单由浏览器送上来（当前项目 + 所有能回放项目的地址并集，ADR-0158）；
 * 有日志段回放不了时页面不会发这个请求。凭据只在服务端，回给浏览器的
 * 只有对象地址与大小。
 */
export const runtime = "nodejs";
export const maxDuration = 120;

function readEnv() {
  try {
    return loadEnvFile(envPath());
  } catch {
    return {};
  }
}

async function currentStorage() {
  const loaded = await loadConfig();
  return resolveStorage(loaded.config.storage, readEnv());
}

export async function GET() {
  const storage = await currentStorage();
  if (!storage.config) {
    return NextResponse.json(
      { error: "还没配置对象存储：没有桶可清", configured: false },
      { status: 409 },
    );
  }
  try {
    const files = await listS3Objects(storage.config, { prefix: "assets/" });
    return NextResponse.json(
      {
        configured: true,
        count: files.length,
        bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        files: files.map((file) => ({ uri: file.uri, bytes: file.bytes })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "列桶失败" },
      { status: 502 },
    );
  }
}

export async function DELETE(request: Request) {
  const storage = await currentStorage();
  if (!storage.config) {
    return NextResponse.json(
      { error: "还没配置对象存储：没有桶可清", configured: false },
      { status: 409 },
    );
  }
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
    const files = await listS3Objects(storage.config, { prefix: "assets/" });
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
    const failed: string[] = [];
    for (const file of orphans) {
      if (await removeS3Object(storage.config, file.uri)) {
        removed += 1;
        bytes += file.bytes;
      } else {
        failed.push(file.uri);
      }
    }
    return NextResponse.json(
      { removed, bytes, failed: failed.length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "清理失败" },
      { status: 502 },
    );
  }
}
