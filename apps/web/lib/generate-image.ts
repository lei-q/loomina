import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ConfigError,
  TreecloudClient,
  TreecloudImageAdapter,
  loadEnvFile,
  treecloudEnvFrom,
} from "@loomina/gateway";
import { buildSheetPrompt } from "@loomina/pipeline";
import type { Character, Id, SheetView } from "@loomina/ir";

/**
 * 服务端出图（ADR-0031）。
 *
 * 密钥只在服务端：浏览器永远拿不到 `API_KEY`，只拿到一张图的 data URI。
 * 这个文件只能在 Node 运行时里 import，不要被客户端组件直接引用。
 */

const ENV_CANDIDATES = [
  process.env.LOOMINA_ENV,
  "secrity.env",
  "../../secrity.env",
  "../../../secrity.env",
].filter((item): item is string => Boolean(item));

function envPath(): string {
  for (const candidate of ENV_CANDIDATES) {
    const full = resolve(process.cwd(), candidate);
    if (existsSync(full)) return full;
  }
  throw new ConfigError(
    "找不到 secrity.env：放到仓库根目录，或用 LOOMINA_ENV 指定路径",
  );
}

export type SheetPanelRequest = {
  character: Pick<Character, "name" | "appearance" | "mustNotChange">;
  angle: SheetView;
};

export type GeneratedImage = {
  uri: string;
  model: string;
  prompt: string;
};

export async function generateSheetPanel(
  request: SheetPanelRequest,
): Promise<GeneratedImage> {
  const config = treecloudEnvFrom(loadEnvFile(envPath()));
  const client = new TreecloudClient({ ...config, timeoutMs: 120_000 });
  const adapter = new TreecloudImageAdapter(client);

  const prompt = buildSheetPrompt(request.character, request.angle);
  const output = await adapter.generate({
    // 定妆照还不是某一镜的图，用格子 id 占位，保证溯源能对上是谁的哪一格
    shotId: `sheet-${request.character.name}-${request.angle}` as Id,
    prompt,
    size: "1024x1536",
  });

  return { uri: output.uri, model: output.provenance.modelId, prompt };
}
