/**
 * 把一份「工作空间导出包」变成评测素材（I9 / ADR-0248）。
 *
 * 收真实素材的卡点不是标注，是「怎么把项目变成素材文件」。两种导出都收：
 * 空间菜单的 `loomina.workspace-export`（回放日志）与 H9 的 `loomina.export`
 * 数据包（直接带 `project`）。按场次切开，就是一段一段的素材。
 *
 * 用法：
 *   pnpm eval:corpus:import -- --in ~/Desktop/夜班-2026-11-15.json \
 *     --source "夜班（自制）" --license self-made
 *
 *   # 整包当一段（不按场切）
 *   pnpm eval:corpus:import -- --in pack.json --source ... --license ... --whole
 *
 * 生成的素材 `expected` 是**空的**：规则该不该报要人看过之后自己标，
 * 工具不替作者下判断。
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectSchema, rebuild, type Project } from "@loomina/ir";
import { LOG_VERSION, migrateLog } from "../lib/event-log";
import { looksLikeWorkspaceExport } from "../lib/workspace-export";
import { clipsByScene } from "../lib/eval-corpus";

interface Args {
  input: string;
  source: string;
  license: string;
  dir: string;
  whole: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { dir: resolve(process.cwd(), "apps/web/scripts/evals/corpus"), whole: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--") continue;
    if (key === "--in") {
      out.input = required(key, value);
      i += 1;
    } else if (key === "--source") {
      out.source = required(key, value);
      i += 1;
    } else if (key === "--license") {
      out.license = required(key, value);
      i += 1;
    } else if (key === "--dir") {
      out.dir = resolve(process.cwd(), required(key, value));
      i += 1;
    } else if (key === "--whole") {
      out.whole = true;
    } else if (key?.startsWith("--")) {
      throw new Error(`未知参数 ${key}`);
    }
  }
  if (!out.input) throw new Error("缺少 --in <工作空间导出包.json>");
  if (!out.source) throw new Error("缺少 --source（片名 / 出处）");
  if (!out.license) throw new Error("缺少 --license（授权说明；没有授权的素材不进库）");
  return out as Args;
}

function required(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) throw new Error(`${flag} 需要一个值`);
  return value;
}

const args = parseArgs(process.argv.slice(2));
const raw: unknown = JSON.parse(readFileSync(resolve(process.cwd(), args.input), "utf8"));

/**
 * 三种入口都收：
 * - `loomina.workspace-export`（空间菜单导出）：只有日志，回放一次；
 * - `loomina.export`（H9 数据包，`:app/api/export` 下载）：直接带 `project`，不用回放；
 * - 裸 Project JSON：手写或从别处拿到的都行。
 */
function projectFrom(value: unknown): Project {
  if (looksLikeWorkspaceExport(value)) {
    const events = migrateLog(value.log);
    if (!events) {
      throw new Error(
        `日志回放不了（版本 ${value.log.version}，当前支持 ≤ ${LOG_VERSION}）。导出包可能来自更新的版本。`,
      );
    }
    return rebuild(events);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (record.format === "loomina.export") return ProjectSchema.parse(record.project);
    if (typeof record.id === "string" && typeof record.title === "string") {
      return ProjectSchema.parse(value);
    }
  }
  throw new Error(
    "认不出这份文件：支持 loomina.workspace-export / loomina.export（数据包）/ 裸 Project JSON。",
  );
}

const project = projectFrom(raw);
const clips = args.whole ? [{ sceneId: "whole", project }] : clipsByScene(project);

if (clips.length === 0) {
  console.log("这个项目没有场次，用 --whole 把整包当一段素材。");
  process.exit(0);
}

mkdirSync(args.dir, { recursive: true });
for (const item of clips) {
  const id = `clip-${project.id}-${item.sceneId}`.replace(/[^\w.-]/g, "-");
  const file = {
    meta: {
      id,
      source: args.source,
      license: args.license,
      note: "导入时未标注：看过这一段之后，把确实该报的规则写进 expected",
    },
    project: item.project,
    expected: [],
  };
  writeFileSync(join(args.dir, `${id}.json`), JSON.stringify(file, null, 2), "utf8");
  console.log(`写入 ${id}.json（${item.project.shots.length} 镜）`);
}

console.log("");
console.log("下一步：逐段看过，把「确实该报」的规则编号写进 expected，再跑 pnpm eval:corpus。");
