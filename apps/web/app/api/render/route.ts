import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  RENDER_HEIGHT,
  RENDER_MAX_ASSET_BYTES,
  RENDER_WIDTH,
  isAudioMime,
  isImageMime,
  isVideoMime,
  parseDataUri,
  renderFileName,
  validateRenderManifest,
  type RenderManifest,
} from "@/lib/render-manifest";

/**
 * 成片渲染（E6）。
 *
 * 浏览器把字幕、占位图与 AI 角标画成 PNG，这里只负责校验、受控下载远端素材、
 * 拼滤镜与编码。本机 ffmpeg 没编进 drawtext / subtitles，中文排版必须在浏览器里完成。
 *
 * 远端素材（E6.1）：只有列在 RENDER_ALLOWED_HOSTS 里的域名才会下载，超时 / 超限 /
 * 类型不符一律当作「跳过」，改用清单里的兜底图，并在响应头里如实计数。
 */
export const runtime = "nodejs";
export const maxDuration = 300;

const RENDER_TIMEOUT_MS = 240_000;
const REMOTE_TIMEOUT_MS = 20_000;

type MediaKind = "video" | "image" | "audio";
type ResolvedClip = { path: string; mediaKind: "video" | "image" };
type ResolvedAudio = { path: string; startMs: number };

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function extensionFor(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
  };
  return map[mime] ?? "bin";
}

async function writeAsset(dir: string, uri: string, name: string): Promise<string> {
  const parts = parseDataUri(uri);
  if (!parts) throw new Error("素材不是 data URI");
  const file = path.join(/* turbopackIgnore: true */ dir, `${name}.${extensionFor(parts.mime)}`);
  await writeFile(file, Buffer.from(parts.base64, "base64"));
  return file;
}

/** 逗号分隔；支持 `host:port`、裸域名与 `*.example.com` */
const ALLOWED_HOSTS = (process.env.RENDER_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

function hostAllowed(rawUrl: string): boolean {
  if (!ALLOWED_HOSTS.length) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((entry) => {
    if (entry === host || entry === hostname) return true;
    if (!entry.startsWith("*.")) return false;
    const suffix = entry.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  });
}

function mimeKind(mime: string): MediaKind | null {
  if (isVideoMime(mime)) return "video";
  if (isImageMime(mime)) return "image";
  if (isAudioMime(mime)) return "audio";
  return null;
}

/**
 * 受控下载：白名单（重定向后再查一次）、20 秒超时、30 MB 上限、内容类型必须匹配用途。
 * 任何一项不满足都返回 null，由调用方退回兜底图并计数——不抛错，不把整条渲染拖死。
 */
async function downloadRemote(
  rawUrl: string,
  dir: string,
  name: string,
  expected: MediaKind,
): Promise<{ path: string; kind: MediaKind } | null> {
  if (!hostAllowed(rawUrl)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const response = await fetch(rawUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "video/*,image/*,audio/*;q=0.9,*/*;q=0.1" },
    });
    if (!response.ok || !response.body) return null;
    // 重定向后的最终地址也要在白名单里，防止 302 绕过
    if (!hostAllowed(response.url)) return null;

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > RENDER_MAX_ASSET_BYTES) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > RENDER_MAX_ASSET_BYTES) return null;

    const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const kind = mimeKind(mime);
    if (!kind || kind !== expected) return null;

    const file = path.join(/* turbopackIgnore: true */ dir, `${name}.${extensionFor(mime)}`);
    await writeFile(file, buffer);
    return { path: file, kind };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildCommand(
  manifest: RenderManifest,
  clips: ResolvedClip[],
  overlays: string[],
  audio: ResolvedAudio[],
  outFile: string,
): string[] {
  const total = seconds(manifest.totalMs);
  const args: string[] = ["-hide_banner", "-y"];
  const filters: string[] = [];

  clips.forEach((clip, index) => {
    const duration = seconds(manifest.clips[index]!.durationMs);
    if (clip.mediaKind === "video") {
      args.push("-i", clip.path);
    } else {
      args.push("-loop", "1", "-framerate", String(manifest.fps), "-t", duration, "-i", clip.path);
    }
    const tail = `fps=${manifest.fps},setsar=1,${
      clip.mediaKind === "video"
        ? `tpad=stop_mode=clone:stop_duration=${duration},`
        : ""
    }trim=duration=${duration},setpts=PTS-STARTPTS,format=yuv420p[v${index}]`;
    filters.push(
      `[${index}:v]scale=${RENDER_WIDTH}:${RENDER_HEIGHT}:force_original_aspect_ratio=decrease,` +
        `pad=${RENDER_WIDTH}:${RENDER_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x0C0C0D,${tail}`,
    );
  });

  overlays.forEach((overlayPath) => {
    args.push("-loop", "1", "-framerate", String(manifest.fps), "-t", total, "-i", overlayPath);
  });

  audio.forEach((track) => {
    args.push("-i", track.path);
  });

  if (clips.length === 1) {
    filters.push(`[v0]null[vbase]`);
  } else {
    const labels = clips.map((_, index) => `[v${index}]`).join("");
    filters.push(`${labels}concat=n=${clips.length}:v=1:a=0[vbase]`);
  }

  let videoLabel = "vbase";
  manifest.overlays.forEach((overlay, index) => {
    const inputIndex = clips.length + index;
    const next = index === manifest.overlays.length - 1 ? "vout" : `vov${index}`;
    filters.push(
      `[${videoLabel}][${inputIndex}:v]overlay=0:0:format=auto:` +
        `enable='between(t,${seconds(overlay.startMs)},${seconds(overlay.endMs)})'[${next}]`,
    );
    videoLabel = next;
  });
  if (!manifest.overlays.length) filters.push(`[vbase]null[vout]`);

  if (audio.length) {
    const base = clips.length + overlays.length;
    const audioLabels: string[] = [];
    audio.forEach((track, index) => {
      const inputIndex = base + index;
      filters.push(
        `[${inputIndex}:a]aresample=48000,adelay=${track.startMs}|${track.startMs}[au${index}]`,
      );
      audioLabels.push(`[au${index}]`);
    });
    if (audio.length === 1) {
      filters.push(`[au0]apad,atrim=duration=${total},asetpts=PTS-STARTPTS[aout]`);
    } else {
      filters.push(
        `${audioLabels.join("")}amix=inputs=${audio.length}:duration=longest:normalize=0,` +
          `apad,atrim=duration=${total},asetpts=PTS-STARTPTS[aout]`,
      );
    }
  } else {
    const silentIndex = clips.length + overlays.length;
    args.push("-f", "lavfi", "-t", total, "-i", "anullsrc=r=48000:cl=stereo");
    filters.push(`[${silentIndex}:a]atrim=duration=${total},asetpts=PTS-STARTPTS[aout]`);
  }

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(manifest.fps),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-t",
    total,
    "-movflags",
    "+faststart",
    "-metadata",
    `title=${manifest.title}`,
    "-metadata",
    `comment=${manifest.aiLabel.standard}`,
    outFile,
  );
  return args;
}

function runFfmpeg(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, RENDER_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const checked = validateRenderManifest(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  const manifest = checked.manifest;

  const dir = await mkdtemp(path.join(/* turbopackIgnore: true */ tmpdir(), "loomina-render-"));
  try {
    let remoteSkipped = 0;
    let fallbackClips = 0;

    const clips: ResolvedClip[] = [];
    for (const [index, clip] of manifest.clips.entries()) {
      if (clip.remote) {
        const downloaded = await downloadRemote(
          clip.remote,
          dir,
          `remote-clip-${index}`,
          clip.mediaKind ?? "video",
        );
        if (downloaded) {
          clips.push({
            path: downloaded.path,
            mediaKind: downloaded.kind === "video" ? "video" : "image",
          });
          continue;
        }
        remoteSkipped += 1;
        fallbackClips += 1;
        clips.push({ path: await writeAsset(dir, clip.fallback!, `fallback-${index}`), mediaKind: "image" });
        continue;
      }
      clips.push({ path: await writeAsset(dir, clip.media!, `clip-${index}`), mediaKind: clip.mediaKind! });
    }

    const overlays: string[] = [];
    for (const [index, overlay] of manifest.overlays.entries()) {
      overlays.push(await writeAsset(dir, overlay.image, `overlay-${index}`));
    }

    const audio: ResolvedAudio[] = [];
    for (const [index, track] of manifest.audio.entries()) {
      if (track.remote) {
        const downloaded = await downloadRemote(track.remote, dir, `remote-audio-${index}`, "audio");
        if (downloaded) audio.push({ path: downloaded.path, startMs: track.startMs });
        else remoteSkipped += 1;
        continue;
      }
      audio.push({
        path: await writeAsset(dir, track.audio!, `audio-${index}`),
        startMs: track.startMs,
      });
    }

    const outFile = path.join(/* turbopackIgnore: true */ dir, "out.mp4");
    const args = buildCommand(manifest, clips, overlays, audio, outFile);
    const result = await runFfmpeg(args);
    if (result.code !== 0) {
      const tail = result.stderr.trim().split("\n").slice(-6).join("\n");
      return NextResponse.json(
        { error: `ffmpeg 没渲出来：${tail || "未知错误"}` },
        { status: 500 },
      );
    }

    const buffer = await readFile(outFile);
    const fileName = renderFileName(manifest.title);
    const placeholderClips =
      manifest.clips.filter((clip) => clip.placeholder === true).length + fallbackClips;
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(buffer.byteLength),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Cache-Control": "no-store",
        "X-Loomina-Remote-Skipped": String(remoteSkipped),
        "X-Loomina-Placeholders": String(placeholderClips),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ error: `渲染失败：${message}` }, { status: 500 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
