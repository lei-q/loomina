/**
 * 仓库根目录（H3 / H22 共用）。
 *
 * 本机的资产库、配置、渲染队列、健康事件都落在 `<root>/.loomina/` 下，
 * 但「root 在哪」与「配置长什么样」是两件事：前者是纯路径判断，
 * 后者才属于供应商配置（`app-config.ts`）。
 *
 * 单独放一个文件是为了让 assets / render / models 都能只依赖这一个纯函数，
 * 不必为了拿一个路径去引整个配置模块——那会让三个子模块绕成环（M4）。
 *
 * 从 `next dev` / `next start` 与从仓库根跑脚本时 `process.cwd()` 不同，
 * 所以两级都试一次。
 */

import { existsSync } from "node:fs";
import path from "node:path";

export function projectRoot(): string {
  const cwd = process.cwd();
  if (existsSync(path.join(/* turbopackIgnore: true */ cwd, "apps", "web"))) return cwd;
  const up = path.resolve(/* turbopackIgnore: true */ cwd, "..", "..");
  if (existsSync(path.join(/* turbopackIgnore: true */ up, "apps", "web"))) return up;
  return cwd;
}
