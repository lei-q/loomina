import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ConfigError,
  TreecloudClient,
  TreecloudImageAdapter,
  imageCostCny,
  loadEnvFile,
  treecloudEnvFrom,
} from "@loomina/gateway";
import {
  buildMasterPrompt,
  buildPropPrompt,
  buildSheetPrompt,
} from "@loomina/pipeline";
import type { Character, Id, Location, Prop, SheetView } from "@loomina/ir";

/**
 * 服务端出图（ADR-0031 / ADR-0032）。
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
    // 候选路径是运行时拼出来的，别让打包器把整个仓库当成静态资源依赖
    const full = resolve(/* turbopackIgnore: true */ process.cwd(), candidate);
    if (existsSync(full)) return full;
  }
  throw new ConfigError(
    "找不到 secrity.env：放到仓库根目录，或用 LOOMINA_ENV 指定路径",
  );
}

export type CastImageRequest =
  | {
      kind: "sheet";
      character: Pick<Character, "name" | "appearance" | "mustNotChange">;
      angle: SheetView;
    }
  | { kind: "master"; location: Pick<Location, "name"> }
  | { kind: "prop"; prop: Pick<Prop, "name" | "description"> };

export type GeneratedImage = {
  uri: string;
  model: string;
  prompt: string;
  /** 价目表里的单价（元）；没有这个模型就不给，界面上显示"无价目"（ADR-0033） */
  cny?: number;
};

/** 提示词与占位 shotId 都按资产语义走，不按"这一格是哪个角色的"走。 */
function plan(request: CastImageRequest): { prompt: string; label: string } {
  if (request.kind === "sheet") {
    return {
      prompt: buildSheetPrompt(request.character, request.angle),
      label: `sheet-${request.character.name}-${request.angle}`,
    };
  }
  if (request.kind === "master") {
    return {
      prompt: buildMasterPrompt(request.location),
      label: `master-${request.location.name}`,
    };
  }
  return {
    prompt: buildPropPrompt(request.prop),
    label: `prop-${request.prop.name}`,
  };
}

export async function generateCastImage(
  request: CastImageRequest,
): Promise<GeneratedImage> {
  const config = treecloudEnvFrom(loadEnvFile(envPath()));
  const client = new TreecloudClient({ ...config, timeoutMs: 120_000 });
  const adapter = new TreecloudImageAdapter(client);

  const { prompt, label } = plan(request);
  const output = await adapter.generate({
    // 定妆资产还不属于某一镜，用语义 id 占位，保证溯源能对上是什么东西
    shotId: label as Id,
    prompt,
    size: "1024x1536",
  });

  return {
    uri: output.uri,
    model: output.provenance.modelId,
    prompt,
    cny: imageCostCny(output.provenance.modelId),
  };
}
