import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/app-config";
import { resolveStorage } from "@/lib/storage-config";
import { describeS3, listS3Objects, putS3Object, readS3Object } from "@/lib/s3-store";
import { loadEnvFile } from "@loomina/gateway";
import { envPath } from "@/lib/server-env";
import { MAX_ASSET_BYTES } from "@/lib/asset-uri";

/**
 * 对象存储（H3 / ADR-0128 / ADR-0129 §3）。
 *
 * `GET  ?probe=1`  探测：能不能列桶、几个对象、共多少字节。**不回凭据**。
 * `GET  ?uri=s3://…` 读一个对象，直接流回字节。
 * `POST { uri }`    把一段 data URI 传上去，回 `s3://` 地址。
 *
 * 只读探针 + 显式上传：没有自动同步，也没有后台任务。
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

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  if (params.get("probe") === "1") {
    const storage = await currentStorage();
    if (!storage.config) {
      return NextResponse.json(
        {
          configured: false,
          active: storage.active,
          note: storage.note ?? "还没配置对象存储：素材都在这台机器上",
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const started = Date.now();
    try {
      const objects = await listS3Objects(storage.config, { prefix: "assets/" });
      return NextResponse.json(
        {
          configured: true,
          active: storage.active,
          target: describeS3(storage.config),
          objects: objects.length,
          bytes: objects.reduce((sum, item) => sum + item.bytes, 0),
          ms: Date.now() - started,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return NextResponse.json(
        {
          configured: true,
          active: storage.active,
          target: describeS3(storage.config),
          error: error instanceof Error ? error.message : "列桶失败",
        },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  const uri = params.get("uri")?.trim() ?? "";
  if (!uri.startsWith("s3://")) {
    return NextResponse.json({ error: "只认 s3:// 地址" }, { status: 400 });
  }
  const storage = await currentStorage();
  if (!storage.config) {
    return NextResponse.json({ error: "还没配置对象存储" }, { status: 503 });
  }
  const object = await readS3Object(storage.config, uri);
  if (!object) {
    return NextResponse.json({ error: "这个对象读不出来" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(object.bytes), {
    headers: {
      "Content-Type": object.mime,
      "Content-Length": String(object.bytes.byteLength),
      "Cache-Control": "private, max-age=60",
    },
  });
}

export async function POST(request: Request) {
  const storage = await currentStorage();
  if (!storage.config) {
    return NextResponse.json({ error: "还没配置对象存储：先在设置页填 Endpoint 与密钥" }, { status: 503 });
  }

  const body = (await request.json().catch(() => null)) as { uri?: unknown } | null;
  const uri = typeof body?.uri === "string" ? body.uri.trim() : "";
  if (!uri) return NextResponse.json({ error: "缺少素材地址" }, { status: 400 });

  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(uri);
  if (!match) {
    return NextResponse.json({ error: "只收 data URI（data:image/…;base64,…）" }, { status: 400 });
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
    const stored = await putS3Object(storage.config, { bytes, mime: match[1]!.toLowerCase() });
    return NextResponse.json(stored, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "传不上去" },
      { status: 502 },
    );
  }
}

/**
 * `PUT { storage }` 只改对象存储这一段，不动供应商与模型。
 *
 * 单独一条路是因为设置页的存储区与模型区是两块：模型区保存时不该
 * 要求作者重填一遍桶与密钥，存储区保存也不该把模型整份再发一遍。
 * `storage: null` 表示清掉配置、回到本机资产库。
 */
export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as { storage?: unknown } | null;
  if (!body || !("storage" in body)) {
    return NextResponse.json({ error: "缺少 storage 字段" }, { status: 400 });
  }
  try {
    const { loadConfig, saveConfig, toPublicConfig } = await import("@/lib/app-config");
    const current = await loadConfig();
    const saved = await saveConfig({
      providers: current.config.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        ...(provider.videoApi ? { videoApi: provider.videoApi } : {}),
      })),
      models: current.config.models,
      defaults: current.config.defaults,
      storage: body.storage as never,
    });
    return NextResponse.json(
      { storage: toPublicConfig({ ...saved, saved: true }, readEnv()).storage },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const { ConfigError } = await import("@loomina/gateway");
    const message = error instanceof Error ? error.message : "保存失败";
    return NextResponse.json(
      { error: message },
      { status: error instanceof ConfigError ? 400 : 500 },
    );
  }
}
