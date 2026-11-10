import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError } from "@loomina/gateway";

/**
 * 服务端配置文件的路径（ADR-0031）。
 *
 * 密钥只在 Node 运行时里读：这个文件只能被 route 或其它服务端模块引用，
 * 不要从客户端组件 import，否则打包器会把整段读盘逻辑带进浏览器。
 */

const ENV_CANDIDATES = [
  process.env.LOOMINA_ENV,
  "secrity.env",
  "../../secrity.env",
  "../../../secrity.env",
].filter((item): item is string => Boolean(item));

export function envPath(): string {
  for (const candidate of ENV_CANDIDATES) {
    // 候选路径是运行时拼出来的，别让打包器把整个仓库当成静态资源依赖
    const full = resolve(/* turbopackIgnore: true */ process.cwd(), candidate);
    if (existsSync(full)) return full;
  }
  throw new ConfigError(
    "找不到 secrity.env：放到仓库根目录，或用 LOOMINA_ENV 指定路径",
  );
}
