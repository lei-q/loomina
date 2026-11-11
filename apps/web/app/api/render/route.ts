import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  RENDER_HEIGHT,
  RENDER_WIDTH,
  parseDataUri,
  renderFileName,
  validateRenderManifest,
  type RenderManifest,
} from "@/lib/render-manifest";

/**
 * 成片渲染（E6）。
 *
 * 浏览器把字幕、占位图与 AI 角标画成 PNG，这里只负责校验、拼滤镜与编码。
 * 本机 ffmpeg 没编进 drawtext / subtitles，中文排版必须在浏览器里完成；
 * 服务端不准备第二套字体与断行逻辑。
 */
export const runtime = "nodejs";
export const maxDuration = 300;

const RENDER_TIMEOUT_MS = 240_000;

type InputFile = { path: string; kind: "clip" | "overlay" | "audio" };

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

function buildCommand(
  manifest: RenderManifest,
  inputs: InputFile[],
  outFile: string,
): string[] {
  const total = seconds(manifest.totalMs);
  const args: string[] = ["-hide_banner", "-y"];
  const filters: string[] = [];
  let clipIndex = 0;
  for (const input of inputs) {
    if (input.kind === "clip") {
      const clip = manifest.clips[clipIndex]!;
      if (clip.mediaKind === "video") {
        args.push("-i", input.path);
        filters.push(
          `[${clipIndex}:v]scale=${RENDER_WIDTH}:${RENDER_HEIGHT}:force_original_aspect_ratio=decrease,` +
            `pad=${RENDER_WIDTH}:${RENDER_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x0C0C0D,` +
            `fps=${manifest.fps},setsar=1,tpad=stop_mode=clone:stop_duration=${seconds(clip.durationMs)},` +
            `trim=duration=${seconds(clip.durationMs)},setpts=PTS-STARTPTS,format=yuv420p[v${clipIndex}]`,
        );
      } else {
        args.push("-loop", "1", "-framerate", String(manifest.fps), "-t", seconds(clip.durationMs), "-i", input.path);
        filters.push(
          `[${clipIndex}:v]scale=${RENDER_WIDTH}:${RENDER_HEIGHT}:force_original_aspect_ratio=decrease,` +
            `pad=${RENDER_WIDTH}:${RENDER_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x0C0C0D,` +
            `fps=${manifest.fps},setsar=1,trim=duration=${seconds(clip.durationMs)},setpts=PTS-STARTPTS,format=yuv420p[v${clipIndex}]`,
        );
      }
      clipIndex += 1;
      continue;
    }

    if (input.kind === "overlay") {
      args.push("-loop", "1", "-framerate", String(manifest.fps), "-t", total, "-i", input.path);
      continue;
    }

    args.push("-i", input.path);
  }

  if (manifest.clips.length === 1) {
    filters.push(`[v0]null[vbase]`);
  } else {
    const labels = manifest.clips.map((_, index) => `[v${index}]`).join("");
    filters.push(`${labels}concat=n=${manifest.clips.length}:v=1:a=0[vbase]`);
  }

  let videoLabel = "vbase";
  manifest.overlays.forEach((overlay, index) => {
    const inputIndex = manifest.clips.length + index;
    const next = index === manifest.overlays.length - 1 ? "vout" : `vov${index}`;
    filters.push(
      `[${videoLabel}][${inputIndex}:v]overlay=0:0:format=auto:` +
        `enable='between(t,${seconds(overlay.startMs)},${seconds(overlay.endMs)})'[${next}]`,
    );
    videoLabel = next;
  });
  if (!manifest.overlays.length) filters.push(`[vbase]null[vout]`);

  if (manifest.audio.length) {
    const base = manifest.clips.length + manifest.overlays.length;
    const audioLabels: string[] = [];
    manifest.audio.forEach((track, index) => {
      const inputIndex = base + index;
      filters.push(
        `[${inputIndex}:a]aresample=48000,adelay=${track.startMs}|${track.startMs}[au${index}]`,
      );
      audioLabels.push(`[au${index}]`);
    });
    if (manifest.audio.length === 1) {
      filters.push(`[au0]apad,atrim=duration=${total},asetpts=PTS-STARTPTS[aout]`);
    } else {
      filters.push(
        `${audioLabels.join("")}amix=inputs=${manifest.audio.length}:duration=longest:normalize=0,` +
          `apad,atrim=duration=${total},asetpts=PTS-STARTPTS[aout]`,
      );
    }
  } else {
    const silentIndex = manifest.clips.length + manifest.overlays.length;
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
    const inputs: InputFile[] = [];
    for (const [index, clip] of manifest.clips.entries()) {
      const file = await writeAsset(dir, clip.media!, `clip-${index}`);
      inputs.push({ path: file, kind: "clip" });
    }
    for (const [index, overlay] of manifest.overlays.entries()) {
      const file = await writeAsset(dir, overlay.image, `overlay-${index}`);
      inputs.push({ path: file, kind: "overlay" });
    }
    for (const [index, track] of manifest.audio.entries()) {
      const file = await writeAsset(dir, track.audio, `audio-${index}`);
      inputs.push({ path: file, kind: "audio" });
    }

    const outFile = path.join(/* turbopackIgnore: true */ dir, "out.mp4");
    const args = buildCommand(manifest, inputs, outFile);
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
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(buffer.byteLength),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ error: `渲染失败：${message}` }, { status: 500 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
