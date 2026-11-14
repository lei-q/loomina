import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RenderManifest } from "@/lib/render-manifest";
import type { LoudnessReport } from "@/lib/render-audio";
import { projectRoot } from "@/lib/project-root";

/**
 * 渲染队列的落盘（H2）。
 *
 * 只存「重开进程以后还需要知道的事」：任务号、状态、阶段、时间、清单、
 * 成品路径与计数。进度每秒都在变，不往磁盘写；写也只按状态变化做节流。
 *
 * 清单里可能带 data URI（本机素材），所以状态文件只落在本机 `.loomina/`，
 * 权限 0600；整个 `.loomina/` 已在 .gitignore 里。
 */

export type PersistedRenderJob = {
  id: string;
  manifest: RenderManifest;
  status: "queued" | "running" | "done" | "error";
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

const MAX_PERSISTED = 32;

export function renderJobStatePath(): string {
  const override = process.env.LOOMINA_RENDER_STATE?.trim();
  if (override) return path.resolve(/* turbopackIgnore: true */ process.cwd(), override);
  return path.join(
    /* turbopackIgnore: true */ projectRoot(),
    ".loomina",
    "render-jobs.json",
  );
}

function looksLikeJob(value: unknown): value is PersistedRenderJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job.id === "string" &&
    job.id.length > 0 &&
    typeof job.fileName === "string" &&
    typeof job.createdAt === "number" &&
    typeof job.progress === "number" &&
    typeof job.remoteSkipped === "number" &&
    typeof job.placeholders === "number" &&
    (job.status === "queued" ||
      job.status === "running" ||
      job.status === "done" ||
      job.status === "error") &&
    Boolean(job.manifest) &&
    typeof job.manifest === "object"
  );
}

/** 读不到或文件坏了都当空队列：渲染可以重来，启动不能因此失败。 */
export async function loadRenderJobs(): Promise<PersistedRenderJob[]> {
  try {
    const raw = await readFile(renderJobStatePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(looksLikeJob).slice(-MAX_PERSISTED);
  } catch {
    return [];
  }
}

export async function saveRenderJobs(jobs: PersistedRenderJob[]): Promise<void> {
  const file = renderJobStatePath();
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(jobs.slice(-MAX_PERSISTED)), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, file);
  await chmod(file, 0o600).catch(() => {});
}
