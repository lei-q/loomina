import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { localPathOf } from "@/lib/asset-store";
import {
  frameArgsOf,
  parseFrameRequest,
} from "@/lib/preview-frame";

/**
 * 帧级找点（E7.2 / ADR-0129）。
 *
 * `GET /api/preview/frame?asset=<loomina://…>&at=<ms>&w=<px>` → 一张 JPEG。
 * 服务端用 ffmpeg 精确 seek，浏览器只显示一张图，不需要 WebCodecs 或解封装库。
 *
 * `GET /api/preview/frame?probe=1` → 这台机器能不能切帧。
 *
 * 这一层只读：不写事件、不生成新素材、不进 IR。切不出来就如实报错，
 * 界面退回 E7.1 的近似（ADR-0127 §6）。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 单帧上限：正常一帧 60–120 KB，超过 8 MB 说明 ffmpeg 吐了别的东西 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** 切一帧的时限：本地 ffmpeg 通常 20–60ms，给到 15 秒只可能是卡死了 */
const FRAME_TIMEOUT_MS = 15_000;

let ffmpegVersion: { ok: boolean; version: string; reason: string } | undefined;

/** `ffmpeg -version` 只探一次：装没装、什么版本，进程活多久都不会变 */
async function probeFfmpeg(): Promise<{ ok: boolean; version: string; reason: string }> {
  if (ffmpegVersion) return ffmpegVersion;
  ffmpegVersion = await new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (value: { ok: boolean; version: string; reason: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const child = spawn("ffmpeg", ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
    timer = setTimeout(
      () => {
        child.kill("SIGKILL");
        done({ ok: false, version: "", reason: "ffmpeg 15 秒没回话" });
      },
      FRAME_TIMEOUT_MS,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 4096) stdout = stdout.slice(0, 4096);
    });
    child.on("error", (error) => {
      done({
        ok: false,
        version: "",
        reason: `这台机器上没有可用的 ffmpeg（${error.message}）`,
      });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        done({ ok: false, version: "", reason: `ffmpeg 退出码 ${code}` });
        return;
      }
      const line = stdout.split("\n")[0]?.trim() ?? "";
      // `ffmpeg version 9.0.2 Copyright …` → `9.0.2`
      const version = /version\s+(\S+)/.exec(line)?.[1] ?? "";
      done({ ok: true, version, reason: "" });
    });
  });
  return ffmpegVersion ?? { ok: false, version: "", reason: "ffmpeg 探测没有结果" };
}

/** 切一帧；失败时把 ffmpeg 的 stderr 尾部带回来说人话 */
function extractFrame(
  src: string,
  atMs: number,
  width: number,
): Promise<{ ok: true; jpeg: Buffer } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: { ok: true; jpeg: Buffer } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn("ffmpeg", frameArgsOf({ src, atMs, width }), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, error: "切这一帧超时了" });
    }, FRAME_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_FRAME_BYTES) {
        child.kill("SIGKILL");
        done({ ok: false, error: "这一帧大得不对劲，先别切了" });
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (error) => {
      done({ ok: false, error: `起不了 ffmpeg：${error.message}` });
    });
    child.on("close", (code) => {
      const jpeg = Buffer.concat(chunks);
      if (code !== 0 || jpeg.byteLength === 0) {
        const tail = stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
        // ffmpeg 找不到帧时只吐一句「Nothing was written into output file」，
        // 对着它猜不出原因；这里按最可能的两种情况说人话
        const nothing = /received no packets|Nothing was written/i.test(stderr);
        done({
          ok: false,
          error: nothing
            ? "这个时刻没有画面：多半已经超过片子的时长"
            : tail
              ? `这一帧切不出来：${tail}`
              : `这一帧切不出来（ffmpeg 退出码 ${code}）`,
        });
        return;
      }
      done({ ok: true, jpeg });
    });
  });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  if (params.get("probe") === "1") {
    const probe = await probeFfmpeg();
    return NextResponse.json(
      probe.ok
        ? { tier: "frame", ffmpeg: probe.version }
        : { tier: "approx", reason: probe.reason },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const parsed = parseFrameRequest(params);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { asset, atMs, width } = parsed.value;

  const src = localPathOf(asset);
  if (!src) {
    return NextResponse.json({ error: "资产地址不认识" }, { status: 400 });
  }
  const info = await stat(src).catch(() => null);
  if (!info?.isFile()) {
    return NextResponse.json({ error: "这个素材不在本机资产库里" }, { status: 404 });
  }

  const probe = await probeFfmpeg();
  if (!probe.ok) {
    return NextResponse.json({ error: probe.reason }, { status: 503 });
  }

  const frame = await extractFrame(src, atMs, width);
  if (!frame.ok) {
    return NextResponse.json({ error: frame.error }, { status: 422 });
  }

  // 同一段素材的同一毫秒永远是同一帧：让浏览器缓存，拖动来回不重复切
  return new NextResponse(new Uint8Array(frame.jpeg), {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(frame.jpeg.byteLength),
      "Cache-Control": "private, max-age=300",
    },
  });
}
