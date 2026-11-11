import {
  TreecloudClient,
  TreecloudImageAdapter,
  imageCostCny,
} from "@loomina/gateway";
import {
  buildKeyframePrompt,
  buildMasterPrompt,
  buildPropPrompt,
  buildSheetPrompt,
  type ShotPromptMaterial,
} from "@loomina/pipeline";
import type { Character, Id, Location, Prop, SheetView } from "@loomina/ir";
import { gatewayConfigOf, resolveModel } from "@/lib/app-config";

/**
 * 服务端出图（ADR-0031 / ADR-0032）。
 *
 * 密钥只在服务端：浏览器永远拿不到 `API_KEY`，只拿到一张图的 data URI。
 * 这个文件只能在 Node 运行时里 import，不要被客户端组件直接引用。
 */

export type CastImageRequest =
  | {
      kind: "sheet";
      character: Pick<Character, "name" | "appearance" | "mustNotChange">;
      angle: SheetView;
    }
  | { kind: "master"; location: Pick<Location, "name" | "description"> }
  | { kind: "prop"; prop: Pick<Prop, "name" | "description"> }
  | { kind: "keyframe"; shot: ShotPromptMaterial; frame?: "first" | "last" };

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
  if (request.kind === "prop") {
    return {
      prompt: buildPropPrompt(request.prop),
      label: `prop-${request.prop.name}`,
    };
  }
  // 关键帧是某一镜的静帧：用描述当标签，方便在溯源里认出是哪一格（ADR-0038 起分首尾）
  const frame = request.frame ?? "first";
  return {
    prompt: buildKeyframePrompt(request.shot, frame),
    label: `${frame === "last" ? "lastframe" : "keyframe"}-${request.shot.description.slice(0, 16) || "shot"}`,
  };
}

export type ImagePrice = {
  model: string;
  /** 价目表里的单价（元 / 张）；没有这个模型就不给 */
  cny?: number;
  /** 配置页里的模型 id */
  modelId?: string;
};

/**
 * 当前出图模型的价目（元 / 张），给"提交前报价"用：只读配置与价目表，
 * 不调接口、不花钱。价目表里没有这个模型时 `cny` 缺省——报不出的价不编造。
 */
export async function imagePrice(modelId?: string): Promise<ImagePrice> {
  const { model } = await resolveModel("image", modelId);
  return { model: model.model, cny: imageCostCny(model.model), modelId: model.id };
}

export async function generateCastImage(
  request: CastImageRequest,
  modelId?: string,
): Promise<GeneratedImage> {
  const config = gatewayConfigOf(await resolveModel("image", modelId));
  // 路由的 maxDuration 是 180 秒：客户端超时留在它之内，别让上游把路由先掐掉。
  // 出图实测 48 秒到 2 分钟不等，120 秒会误杀慢样本（2026-11-10）。
  const client = new TreecloudClient({ ...config, timeoutMs: 170_000 });
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
