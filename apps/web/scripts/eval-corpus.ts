/**
 * 评测素材库自检（I9 / DIRECTOR-GRAMMAR.md §十一）。
 *
 * 读一个目录下的 `*.json`（默认 `apps/web/scripts/evals/corpus`），
 * 每份是一段真实短剧片段 + 人工标注，跑一遍分镜检查再与标注比对。
 *
 * 用法：
 *   pnpm eval:corpus
 *   pnpm eval:corpus -- --dir path/to/corpus
 *
 * 素材没凑够 30 段不算失败（这是长期补充的活）；文件读不出来 / 格式不对才算失败。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { corpusText, parseCorpusClip, runCorpus, type CorpusClip } from "../lib/eval-corpus";

const DEFAULT_DIR = resolve(process.cwd(), "apps/web/scripts/evals/corpus");

function dirOf(argv: string[]): string {
  const index = argv.indexOf("--dir");
  if (index < 0) return DEFAULT_DIR;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--dir 需要一个目录");
  return resolve(process.cwd(), value);
}

const dir = dirOf(process.argv.slice(2));
let files: string[];
try {
  files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
} catch {
  console.log(`素材目录还不存在：${dir}`);
  console.log("按 README 建目录并放第一段素材：apps/web/scripts/evals/corpus/README.md");
  process.exit(0);
}

const clips: CorpusClip[] = [];
const bad: string[] = [];
for (const name of files) {
  try {
    const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
    const clip = parseCorpusClip(raw);
    if (`${clip.meta.id}.json` !== name) {
      bad.push(`${name}：meta.id 是 ${clip.meta.id}，应与文件名一致`);
      continue;
    }
    clips.push(clip);
  } catch (error) {
    bad.push(`${name}：${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(corpusText(runCorpus(clips)));
console.log("");

if (bad.length > 0) {
  console.log("读不出来的素材：");
  for (const line of bad) console.log(`  ✗ ${line}`);
  process.exitCode = 1;
} else {
  console.log(`${files.length} 个文件全部通过校验。`);
}
