import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { projectRoot } from "@/lib/app-config";
import { materializeAsset } from "@/lib/storage-runtime";
import {
  PROXY_CACHE_CAP_BYTES,
  PROXY_TIMEOUT_MS,
  canProxy,
  parseProxyRequest,
  planProxyEviction,
  proxyArgsOf,
  proxyCacheName,
  proxyCacheOf,
  proxyRangeOf,
  type ProxyFile,
} from "@/lib/preview-proxy";

/**
 * 540p 代理视频（E7 / ADR-0127 §3）。
 *
 * `GET /api/preview/proxy?asset=<loomina://…|s3://…>` → 一段 540p H.264。
 * 第一次请求时用 ffmpeg 转一份，落 `.loomina/assets/proxies/`，之后直接命中缓存。
 *
 * 代理是**可删的缓存**：不进 IR、不算资产、不参与导出；删掉目录会按需重建。
 * 原片仍是唯一事实，导出永远走原片。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** 同一地址并发只转一次：预演里换镜快，几个请求会同时打进来 */
const inFlight = new Map<string, Promise<string>>();

function proxyDir(): string {
  return path.join(
    /* turbopackIgnore: true */ projectRoot(),
    ".loomina",
    "assets",
    "proxies",
  );
}

function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * 缓存上限：默认 2 GB，`LOOMINA_PROXY_CACHE_MB` 可以改小（磁盘紧张的机器用）。
 * 不合法或没设就走默认值——清理缓存不该因为一个环境变量写错而失效。
 */
function cacheCapBytes(): number {
  const mb = Number(process.env.LOOMINA_PROXY_CACHE_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : PROXY_CACHE_CAP_BYTES;
}

/** 缓存目录里现在有哪些代理：按 mtime 从旧到新排，好按最久没用先删 */
async function proxyFiles(): Promise<ProxyFile[]> {
  const dir = proxyDir();
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: ProxyFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".mp4")) continue;
    const info = await stat(path.join(/* turbopackIgnore: true */ dir, entry.name)).catch(
      () => null,
    );
    if (!info?.isFile()) continue;
    files.push({ name: entry.name, bytes: info.size, mtimeMs: info.mtimeMs });
  }
  return files.sort((left, right) => left.mtimeMs - right.mtimeMs);
}

/**
 * 写完一份新代理之后把缓存压回上限（E7 / ADR-0178）。
 *
 * 删的是最久没用的那几份；刚写好的那份 `keep` 不删。删失败不报错——
 * 缓存清理失败不该让这次播放失败。
 */
async function evictOverCap(keep: string): Promise<void> {
  const plan = planProxyEviction(await proxyFiles(), keep, cacheCapBytes());
  for (const name of plan.evict) {
    await unlink(path.join(/* turbopackIgnore: true */ proxyDir(), name)).catch(() => {});
  }
}

/** 转一份代理；失败时把 ffmpeg 的 stderr 尾部带回来说人话 */
function transcode(src: string, out: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = "";
    const done = (value: { ok: true } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn("ffmpeg", proxyArgsOf({ src, out }), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, error: "转代理超时了" });
    }, PROXY_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (error) => {
      done({ ok: false, error: `起不了 ffmpeg：${error.message}` });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
        done({
          ok: false,
          error: tail ? `转代理失败：${tail}` : `转代理失败（ffmpeg 退出码 ${code}）`,
        });
        return;
      }
      done({ ok: true });
    });
  });
}

async function ensureProxy(asset: string): Promise<{ ok: true; file: string } | { ok: false; status: number; error: string }> {
  const dir = proxyDir();
  const file = path.join(/* turbopackIgnore: true */ dir, proxyCacheName(asset, hashOf));
  const cached = await stat(file).catch(() => null);
  if (cached?.isFile() && cached.size > 0) return { ok: true, file };

  let running = inFlight.get(file);
  if (!running) {
    running = (async () => {
      const src = await materializeAsset(asset);
      if (!src) throw new Error("资产地址不认识");
      const info = await stat(src).catch(() => null);
      if (!info?.isFile()) throw new Error("这个素材不在资产库里");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // 先写临时文件再 rename：半份代理不能留下来冒充可用缓存
      const temp = `${file}.${process.pid}.tmp`;
      try {
        const result = await transcode(src, temp);
        if (!result.ok) throw new Error(result.error);
        await rename(temp, file);
        await chmod(file, 0o600).catch(() => {});
        await evictOverCap(path.basename(file));
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }
      return file;
    })().finally(() => {
      inFlight.delete(file);
    });
    inFlight.set(file, running);
  }

  try {
    return { ok: true, file: await running };
  } catch (error) {
    return {
      ok: false,
      status: 422,
      error: error instanceof Error ? error.message : "转代理失败",
    };
  }
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  // `?stats=1`：设置页要看这台机器上代理缓存占了多少，不转码、不读字节
  if (params.get("stats") === "1") {
    const files = await proxyFiles();
    const cap = cacheCapBytes();
    const cache = proxyCacheOf(files, cap);
    return NextResponse.json(
      {
        ...cache,
        cap,
        files: files.map((file) => ({ name: file.name, bytes: file.bytes })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const parsed = parseProxyRequest(params);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const proxy = await ensureProxy(parsed.asset);
  if (!proxy.ok) {
    return NextResponse.json({ error: proxy.error }, { status: proxy.status });
  }

  const bytes = await import("node:fs/promises")
    .then((fs) => fs.readFile(proxy.file))
    .catch(() => null);
  if (!bytes) {
    return NextResponse.json({ error: "代理读不出来" }, { status: 500 });
  }

  // `<video>` 拖到哪一毫秒就只问那一段：整段回给它会让 206 变成 200，
  // 每次 seek 都重新拉一遍，代理就白做了。
  const range = proxyRangeOf(request.headers.get("range"), bytes.byteLength);
  const body = range
    ? new Uint8Array(bytes.subarray(range.start, range.end + 1))
    : new Uint8Array(bytes);
  return new NextResponse(body, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(body.byteLength),
      "Accept-Ranges": "bytes",
      ...(range
        ? { "Content-Range": `bytes ${range.start}-${range.end}/${bytes.byteLength}` }
        : {}),
      // 代理内容由地址决定（地址带内容哈希），同一地址永远同一份
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/**
 * 清掉代理缓存（E7 / ADR-0178）。
 *
 * 代理是派生物：原片还在，下一次开预演按需重建。所以这里不需要确认词，
 * 也不碰 `.loomina/assets/` 里的素材本体。
 */
export async function DELETE() {
  const files = await proxyFiles();
  let removed = 0;
  let bytes = 0;
  for (const file of files) {
    try {
      await unlink(path.join(/* turbopackIgnore: true */ proxyDir(), file.name));
      removed += 1;
      bytes += file.bytes;
    } catch {
      // 删不掉的跳过：下一次统计还在，作者能看见
    }
  }
  return NextResponse.json({ removed, bytes }, { headers: { "Cache-Control": "no-store" } });
}

/** 一次最多预生成几条：这个路由的时限是 120 秒，一条 3 秒的片子本地转 1–3 秒 */
const MAX_PREGEN = 24;

/**
 * 预生成代理（E7 / ADR-0178）。
 *
 * 浏览器把「这条片子里用到的、在资产库里的素材地址」送上来，服务端逐个转。
 * 已经转好的直接跳过（不算失败），转不出来的如实报数——预演仍会回原片，
 * 所以这不是致命错误。
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { assets?: unknown } | null;
  if (!Array.isArray(body?.assets)) {
    return NextResponse.json({ error: "缺少素材清单" }, { status: 400 });
  }
  const assets = [
    ...new Set(
      body.assets.filter((item): item is string => typeof item === "string" && canProxy(item)),
    ),
  ].slice(0, MAX_PREGEN);
  if (assets.length === 0) {
    return NextResponse.json({ done: 0, cached: 0, failed: 0, error: "一条能转的素材都没有" });
  }

  let done = 0;
  let cached = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const asset of assets) {
    const name = proxyCacheName(asset, hashOf);
    const existing = await stat(path.join(/* turbopackIgnore: true */ proxyDir(), name)).catch(
      () => null,
    );
    if (existing?.isFile() && existing.size > 0) {
      cached += 1;
      continue;
    }
    const result = await ensureProxy(asset);
    if (result.ok) {
      done += 1;
    } else {
      failed += 1;
      if (errors.length < 3) errors.push(result.error);
    }
  }
  const cache = proxyCacheOf(await proxyFiles(), cacheCapBytes());
  return NextResponse.json(
    { done, cached, failed, errors, bytes: cache.bytes, count: cache.count },
    { headers: { "Cache-Control": "no-store" } },
  );
}
