import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  RENDER_PROFILES,
  RENDER_MAX_ASSET_BYTES,
  isAudioMime,
  isImageMime,
  isVideoMime,
  parseDataUri,
  renderFileName,
  validateRenderManifest,
  type RenderManifest,
} from "@/lib/render-manifest";
import {
  buildAudioMixCommand,
  loudnormFilter,
  loudnessVerdict,
  parseLoudnessJson,
  parsePhaseMeter,
  type LoudnessMeasurement,
  type LoudnessReport,
} from "@/lib/render-audio";
import {
  loadRenderJobs,
  saveRenderJobs,
  type PersistedRenderJob,
} from "@/lib/render-job-store";
import { localPathOf } from "@/lib/asset-store";
import { materializeAsset } from "@/lib/storage-runtime";
import { withLongJobSlot, longJobSnapshot } from "@/lib/long-job";

/**
 * 成片渲染任务队列（E6 / H2）。
 *
 * 提交只返回任务号，客户端轮询状态与进度；同一进程内并发固定为 1，
 * 排队的任务不会同时抢 CPU。任务完成后的 MP4 在临时目录里留 30 分钟，
 * 客户端用 `?job=<id>&download=1` 取回，之后目录与记录一起清掉。
 *
 * 队列状态落本机 `.loomina/render-jobs.json`：重启后排队任务继续跑，
 * 正在跑的任务如实标成「重启中断」，已完成且未过期的成品仍可下载。
 */
export const runtime = "nodejs";
export const maxDuration = 300;

const RENDER_TIMEOUT_MS = 240_000;
const REMOTE_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 2;
const MAX_QUEUED = 8;
const JOB_TTL_MS = 30 * 60 * 1000;

type MediaKind = "video" | "image" | "audio";
type ResolvedClip = { path: string; mediaKind: "video" | "image" };
type ResolvedAudio = { path: string; startMs: number; durationMs: number };
type ResolvedMusic = {
  path: string;
  startMs: number;
  endMs: number;
  gainDb: number;
  duckDb: number;
  ducking: boolean;
  loop: boolean;
};
type JobStatus = "queued" | "running" | "done" | "error";

type RenderJob = {
  id: string;
  manifest: RenderManifest;
  status: JobStatus;
  stage: string;
  progress: number;
  attempts: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  fileName: string;
  dir?: string;
  filePath?: string;
  bytes?: number;
  remoteSkipped: number;
  placeholders: number;
  loudness?: LoudnessReport;
};

const jobs = new Map<string, RenderJob>();
const queue: string[] = [];
let activeJobId: string | null = null;
/** 正在跑的 ffmpeg 进程：取消时直接杀掉，不等它自己失败 */
let activeChild: ChildProcess | null = null;
/** 主动取消的任务：失败分支要写「已取消」，不能冒充 ffmpeg 报错 */
const cancelled = new Set<string>();

/** 落盘串行化：慢磁盘也不能让两次快照交错写坏文件。 */
let persistChain: Promise<void> = Promise.resolve();

function snapshotJob(job: RenderJob): PersistedRenderJob {
  return {
    id: job.id,
    manifest: job.manifest,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    attempts: job.attempts,
    createdAt: job.createdAt,
    ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    ...(job.error ? { error: job.error } : {}),
    fileName: job.fileName,
    ...(job.dir ? { dir: job.dir } : {}),
    ...(job.filePath ? { filePath: job.filePath } : {}),
    ...(job.bytes !== undefined ? { bytes: job.bytes } : {}),
    remoteSkipped: job.remoteSkipped,
    placeholders: job.placeholders,
    ...(job.loudness ? { loudness: job.loudness } : {}),
  };
}

/**
 * 只在状态变化时落盘：进度每秒都变，写它没有恢复价值。
 * 写失败不影响渲染本身——这一轮是「尽量活过重启」，不是强一致存储。
 */
function persistJobs(): void {
  const snapshot = [...jobs.values()].map(snapshotJob);
  persistChain = persistChain
    .then(() => saveRenderJobs(snapshot))
    .catch(() => {});
}

let loaded: Promise<void> | undefined;

/** 读回上次进程留下的任务；同一个进程只做一次。 */
function ensureJobsLoaded(): Promise<void> {
  loaded ??= restoreJobs();
  return loaded;
}

async function restoreJobs(): Promise<void> {
  const stored = await loadRenderJobs();
  const now = Date.now();
  for (const record of stored) {
    if (jobs.has(record.id)) continue;
    const job = record as RenderJob;

    if (record.status === "queued") {
      job.stage = "重启后恢复排队";
      jobs.set(job.id, job);
      queue.push(job.id);
      continue;
    }

    if (record.status === "running") {
      // ffmpeg 随进程一起没了；半份文件不能当成品交付
      if (record.dir) void rm(record.dir, { recursive: true, force: true });
      job.status = "error";
      job.stage = "失败";
      job.error = "服务重启，这次渲染中断了：没有交付半成品。重新点导出即可。";
      job.finishedAt = now;
      jobs.set(job.id, job);
      scheduleCleanup(job);
      continue;
    }

    const finished = record.finishedAt ?? now;
    const remain = finished + JOB_TTL_MS - now;
    if (remain <= 0) {
      if (record.dir) void rm(record.dir, { recursive: true, force: true });
      continue;
    }
    if (record.status === "done") {
      if (!record.filePath) continue;
      try {
        await stat(record.filePath);
      } catch {
        if (record.dir) void rm(record.dir, { recursive: true, force: true });
        continue;
      }
    }
    jobs.set(job.id, job);
    scheduleCleanup(job, Math.max(1000, remain));
  }

  if (queue.length > 0) pump();
  persistJobs();
}

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
  // 本机资产库（H3 / ADR-0128）：字节已经在盘上，直接给路径，不再 base64 解码
  const stored = localPathOf(uri);
  if (stored) {
    const info = await stat(stored).catch(() => null);
    if (!info?.isFile()) throw new Error("素材不在本机资产库里");
    // 清单校验只算 data URI 的体积，资产库里的文件要在这里补上同一道上限
    if (info.size > RENDER_MAX_ASSET_BYTES) {
      throw new Error(`素材超过 ${RENDER_MAX_ASSET_BYTES / 1024 / 1024} MB：先换小一点的素材`);
    }
    return stored;
  }
  // 对象存储（H3 / ADR-0129）：先拉到本地缓存，ffmpeg 只吃路径
  const remote = await materializeAsset(uri);
  if (remote) {
    const info = await stat(remote).catch(() => null);
    if (!info?.isFile()) throw new Error("素材没能从对象存储拉下来");
    if (info.size > RENDER_MAX_ASSET_BYTES) {
      throw new Error(`素材超过 ${RENDER_MAX_ASSET_BYTES / 1024 / 1024} MB：先换小一点的素材`);
    }
    return remote;
  }
  const parts = parseDataUri(uri);
  if (!parts) throw new Error("素材既不是 data URI，也不在本机资产库或对象存储里");
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
  audio: { mixPath?: string; loudnorm?: string },
  outFile: string,
): string[] {
  const total = seconds(manifest.totalMs);
  const profile = RENDER_PROFILES[manifest.quality];
  const args: string[] = ["-hide_banner", "-y", "-progress", "pipe:1", "-nostats"];
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
      `[${index}:v]scale=${manifest.width}:${manifest.height}:force_original_aspect_ratio=decrease,` +
        `pad=${manifest.width}:${manifest.height}:(ow-iw)/2:(oh-ih)/2:color=0x0C0C0D,${tail}`,
    );
  });

  overlays.forEach((overlayPath) => {
    args.push("-loop", "1", "-framerate", String(manifest.fps), "-t", total, "-i", overlayPath);
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

  if (audio.mixPath) {
    const mixIndex = clips.length + overlays.length;
    args.push("-i", audio.mixPath);
    filters.push(`[${mixIndex}:a]${audio.loudnorm ?? "anull"}[aout]`);
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
    profile.preset,
    "-crf",
    String(profile.crf),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(manifest.fps),
    "-c:a",
    "aac",
    "-b:a",
    profile.audioBitrate,
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
    // 隐式标识（H5 / ADR-0138）：容器里也写一份指纹，拿到文件的人能核对
    "-metadata",
    `description=${manifest.aiLabel.standard} · 内容指纹 ${manifest.aiLabel.contentHash}`,
    outFile,
  );
  return args;
}

function runFfmpeg(
  args: string[],
  totalMs: number,
  onProgress: (percent: number) => void,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    let stderr = "";
    let stdoutBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const [key, value] = line.split("=");
        if (key !== "out_time_us" || !value) continue;
        const micros = Number(value);
        if (!Number.isFinite(micros) || micros <= 0) continue;
        onProgress(Math.min(99, Math.floor((micros / 1000 / totalMs) * 100)));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, RENDER_TIMEOUT_MS);
    const done = () => {
      if (activeChild === child) activeChild = null;
    };
    child.on("error", (error) => {
      clearTimeout(timer);
      done();
      resolve({ code: -1, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done();
      resolve({ code: code ?? -1, stderr });
    });
  });
}

/** 量集成响度与真峰值：loudnorm 的 JSON 打在 stderr 里 */
async function measureLoudness(
  file: string,
  totalMs: number,
): Promise<LoudnessMeasurement | null> {
  const result = await runFfmpeg(
    [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-af",
      "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json",
      "-f",
      "null",
      "-",
    ],
    totalMs,
    () => {},
  );
  return parseLoudnessJson(result.stderr);
}

/** 单声道兼容：反相段总时长；不拿「音量变小」冒充相位检查 */
async function measurePhase(
  file: string,
  totalMs: number,
): Promise<{ outOfPhaseMs: number | null; monoMs: number | null }> {
  const result = await runFfmpeg(
    [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-af",
      "aphasemeter=video=0:phasing=1:duration=0.5",
      "-f",
      "null",
      "-",
    ],
    totalMs,
    () => {},
  );
  return parsePhaseMeter(result.stderr);
}

function scheduleCleanup(job: RenderJob, ttlMs = JOB_TTL_MS): void {
  const timer = setTimeout(() => {
    if (job.dir) void rm(job.dir, { recursive: true, force: true });
    jobs.delete(job.id);
    persistJobs();
  }, ttlMs);
  // 不要因为一个待清理的任务把进程留活
  timer.unref?.();
}

async function runJob(job: RenderJob): Promise<void> {
  job.status = "running";
  job.stage = "准备素材";
  job.startedAt = Date.now();
  persistJobs();
  try {
    const dir = await mkdtemp(path.join(/* turbopackIgnore: true */ tmpdir(), "loomina-render-"));
    job.dir = dir;

    let remoteSkipped = 0;
    let fallbackClips = 0;

    const clips: ResolvedClip[] = [];
    for (const [index, clip] of job.manifest.clips.entries()) {
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
        clips.push({
          path: await writeAsset(dir, clip.fallback!, `fallback-${index}`),
          mediaKind: "image",
        });
        continue;
      }
      clips.push({
        path: await writeAsset(dir, clip.media!, `clip-${index}`),
        mediaKind: clip.mediaKind!,
      });
    }

    const overlays: string[] = [];
    for (const [index, overlay] of job.manifest.overlays.entries()) {
      overlays.push(await writeAsset(dir, overlay.image, `overlay-${index}`));
    }

    const audio: ResolvedAudio[] = [];
    for (const [index, track] of job.manifest.audio.entries()) {
      const durationMs = Math.max(
        0,
        Math.min(track.durationMs ?? job.manifest.totalMs - track.startMs, job.manifest.totalMs - track.startMs),
      );
      if (track.remote) {
        const downloaded = await downloadRemote(track.remote, dir, `remote-audio-${index}`, "audio");
        if (downloaded) {
          audio.push({ path: downloaded.path, startMs: track.startMs, durationMs });
        } else remoteSkipped += 1;
        continue;
      }
      audio.push({
        path: await writeAsset(dir, track.audio!, `audio-${index}`),
        startMs: track.startMs,
        durationMs,
      });
    }

    const music: ResolvedMusic[] = [];
    for (const [index, track] of job.manifest.music.entries()) {
      if (track.remote) {
        const downloaded = await downloadRemote(
          track.remote,
          dir,
          `remote-music-${index}`,
          "audio",
        );
        if (downloaded) {
          music.push({ ...track, path: downloaded.path });
        } else remoteSkipped += 1;
        continue;
      }
      music.push({
        ...track,
        path: await writeAsset(dir, track.audio!, `music-${index}`),
      });
    }

    job.remoteSkipped = remoteSkipped;
    job.placeholders =
      job.manifest.clips.filter((clip) => clip.placeholder === true).length + fallbackClips;

    let mixPath: string | undefined;
    let measured: LoudnessMeasurement | null = null;
    if (audio.length > 0 || music.length > 0) {
      job.stage = "混音与响度";
      job.progress = 0;
      const mixFile = path.join(/* turbopackIgnore: true */ dir, "mix.wav");
      const mixArgs = buildAudioMixCommand({
        dialogue: audio,
        music,
        totalMs: job.manifest.totalMs,
        outFile: mixFile,
      });
      const mixResult = await runFfmpeg(mixArgs, job.manifest.totalMs, (percent) => {
        job.progress = Math.min(14, Math.floor(percent * 0.14));
      });
      if (mixResult.code !== 0) {
        const tail = mixResult.stderr.trim().split("\n").slice(-6).join("\n");
        throw new Error(`混音没做出来：${tail || "未知错误"}`);
      }
      job.stage = "测量响度";
      measured = await measureLoudness(mixFile, job.manifest.totalMs);
      mixPath = mixFile;
    }

    const outFile = path.join(/* turbopackIgnore: true */ dir, "out.mp4");
    const args = buildCommand(
      job.manifest,
      clips,
      overlays,
      mixPath ? { mixPath, loudnorm: loudnormFilter(measured) } : {},
      outFile,
    );

    let result = { code: -1, stderr: "" };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      job.attempts = attempt;
      job.stage =
        attempt === 1
          ? `编码中（${clips.length} 段）`
          : `第 ${attempt} 次重试（上一次 ffmpeg 失败）`;
      job.progress = mixPath ? 15 : 0;
      result = await runFfmpeg(args, job.manifest.totalMs, (percent) => {
        job.progress = mixPath
          ? 15 + Math.floor(percent * 0.84)
          : percent;
      });
      if (result.code === 0) break;
    }

    if (result.code !== 0) {
      const tail = result.stderr.trim().split("\n").slice(-6).join("\n");
      throw new Error(`ffmpeg 没渲出来：${tail || "未知错误"}`);
    }

    const info = await stat(outFile);
    job.stage = "复核响度与相位";
    const [outputLoudness, phase] = await Promise.all([
      measureLoudness(outFile, job.manifest.totalMs),
      measurePhase(outFile, job.manifest.totalMs),
    ]);
    const verdict = loudnessVerdict({
      integratedLufs: outputLoudness?.inputI ?? null,
      truePeakDb: outputLoudness?.inputTp ?? null,
      outOfPhaseMs: phase.outOfPhaseMs,
    });
    job.loudness = {
      integratedLufs: outputLoudness?.inputI ?? null,
      truePeakDb: outputLoudness?.inputTp ?? null,
      rangeLu: outputLoudness?.inputLra ?? null,
      outOfPhaseMs: phase.outOfPhaseMs,
      monoMs: phase.monoMs,
      checkedAt: new Date().toISOString(),
      verdict: verdict.status,
      detail: verdict.detail,
    };
    if (verdict.status === "fail") {
      throw new Error(`响度检查没通过，没有交付：${verdict.detail}`);
    }

    job.filePath = outFile;
    job.fileName = renderFileName(job.manifest.title);
    job.bytes = info.size;
    job.progress = 100;
    job.status = "done";
    job.stage = "完成";
    job.finishedAt = Date.now();
    persistJobs();
    scheduleCleanup(job);
  } catch (error) {
    const wasCancelled = cancelled.delete(job.id);
    job.status = "error";
    job.stage = wasCancelled ? "已取消" : "失败";
    job.error = wasCancelled
      ? "这一条已经取消：没有交付半成品。要的话重新点导出。"
      : error instanceof Error
        ? error.message
        : "未知错误";
    job.finishedAt = Date.now();
    if (job.dir) await rm(job.dir, { recursive: true, force: true });
    persistJobs();
    scheduleCleanup(job);
  }
}

function pump(): void {
  if (activeJobId) return;
  const nextId = queue.shift();
  if (!nextId) return;
  const job = jobs.get(nextId);
  if (!job) {
    pump();
    return;
  }
  activeJobId = nextId;
  // 渲染也要排进同一条长任务队列（H2 / ADR-0135）：出图 / 出视频正在跑时，
  // ffmpeg 等它跑完再开始，别让三条一起抢 CPU。真排上了队才改阶段。
  void withLongJobSlot(
    "render",
    job.fileName,
    () => runJob(job),
    () => {
      job.stage = "等前面的长任务跑完";
    },
  ).finally(() => {
    activeJobId = null;
    pump();
  });
}

function publicJob(job: RenderJob): Record<string, unknown> {
  return {
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    attempts: job.attempts,
    position: job.status === "queued" ? queue.indexOf(job.id) + 1 : 0,
    fileName: job.fileName,
    bytes: job.bytes,
    remoteSkipped: job.remoteSkipped,
    placeholders: job.placeholders,
    loudness: job.loudness,
    error: job.error,
    /** 同一条长任务队列里谁在占着（H2 / ADR-0135）：等待时界面要说得清在等谁 */
    busyWith: longJobSnapshot().active,
  };
}

export async function POST(request: Request) {
  await ensureJobsLoaded();
  const body = await request.json().catch(() => null);
  const checked = validateRenderManifest(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  if (queue.length >= MAX_QUEUED) {
    return NextResponse.json(
      { error: `渲染队列已满（${MAX_QUEUED} 个等待中），等前面渲完再试` },
      { status: 429 },
    );
  }

  const job: RenderJob = {
    id: randomUUID(),
    manifest: checked.manifest,
    status: "queued",
    stage: activeJobId ? "排队中" : "等待开始",
    progress: 0,
    attempts: 0,
    createdAt: Date.now(),
    fileName: renderFileName(checked.manifest.title),
    remoteSkipped: 0,
    placeholders: 0,
  };
  jobs.set(job.id, job);
  queue.push(job.id);
  persistJobs();
  pump();
  return NextResponse.json(publicJob(job), { status: 202 });
}

/**
 * 取消一条渲染任务（H2）。
 *
 * - 排队中：直接从队列摘掉，状态记「已取消」。
 * - 正在跑：杀掉 ffmpeg，失败分支认 `cancelled` 标记，不把「取消」写成「渲染失败」。
 * - 已完成 / 已失败：返回 409，取消一个已经结束的任务没有意义。
 */
export async function DELETE(request: Request) {
  await ensureJobsLoaded();
  const url = new URL(request.url);
  const jobId = url.searchParams.get("job");
  if (!jobId) return NextResponse.json({ error: "缺少任务号" }, { status: 400 });
  const job = jobs.get(jobId);
  if (!job) return NextResponse.json({ error: "任务不存在或已过期" }, { status: 404 });

  if (job.status === "done" || job.status === "error") {
    return NextResponse.json(
      { error: "这条任务已经结束了，取消不了。", ...publicJob(job) },
      { status: 409 },
    );
  }

  const wasQueued = job.status === "queued";
  if (wasQueued) {
    const at = queue.indexOf(job.id);
    if (at >= 0) queue.splice(at, 1);
  } else {
    // 正在跑：先标记再杀，失败分支才知道这是取消而不是渲染出错
    cancelled.add(job.id);
    activeChild?.kill("SIGKILL");
  }

  job.status = "error";
  job.stage = "已取消";
  job.error = "这一条已经取消：没有交付半成品。要的话重新点导出。";
  job.finishedAt = Date.now();
  if (job.dir) await rm(job.dir, { recursive: true, force: true });
  persistJobs();
  scheduleCleanup(job);
  return NextResponse.json(publicJob(job));
}

export async function GET(request: Request) {
  await ensureJobsLoaded();
  const url = new URL(request.url);
  const jobId = url.searchParams.get("job");
  if (!jobId) return NextResponse.json({ error: "缺少任务号" }, { status: 400 });
  const job = jobs.get(jobId);
  if (!job) return NextResponse.json({ error: "任务不存在或已过期" }, { status: 404 });

  if (url.searchParams.get("download") !== "1") {
    return NextResponse.json(publicJob(job), { headers: { "Cache-Control": "no-store" } });
  }

  if (job.status !== "done" || !job.filePath) {
    return NextResponse.json(
      { error: job.status === "error" ? job.error : "任务还没渲染完", ...publicJob(job) },
      { status: 409 },
    );
  }

  const buffer = await readFile(job.filePath);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(buffer.byteLength),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(job.fileName)}`,
      "Cache-Control": "no-store",
      "X-Loomina-Remote-Skipped": String(job.remoteSkipped),
      "X-Loomina-Placeholders": String(job.placeholders),
    },
  });
}
