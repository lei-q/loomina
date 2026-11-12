import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { projectRoot } from "@/lib/app-config";
import { materializeAsset } from "@/lib/storage-runtime";
import {
  PROXY_TIMEOUT_MS,
  parseProxyRequest,
  proxyArgsOf,
  proxyCacheName,
  proxyRangeOf,
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
