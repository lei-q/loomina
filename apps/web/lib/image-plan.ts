import {
  buildKeyframePrompt,
  buildMasterPrompt,
  buildPropPrompt,
  buildSheetPrompt,
} from "@loomina/pipeline";
import type { CastImageRequest } from "@/lib/generate-image";

/**
 * 一次出图请求最终会发出去的提示词与标签（B2 / H14 / ADR-0208）。
 *
 * 从 `generate-image.ts` 里抽出来：服务端用它拼提示词，客户端用同一份算
 * **结果缓存的键**。两处各写一遍的话，客户端认为「输入一样」而服务端实际
 * 发了另一段提示词，缓存就会把一张不对的图当成命中。
 *
 * 纯函数：不读盘、不发请求。
 */
export function imagePlanOf(request: CastImageRequest): { prompt: string; label: string } {
  if (request.kind === "sheet") {
    return {
      prompt: buildSheetPrompt(request.character, request.angle, request.look, request.skills),
      label: `sheet-${request.character.name}-${request.angle}`,
    };
  }
  if (request.kind === "master") {
    return {
      prompt: buildMasterPrompt(request.location, request.look, request.skills),
      label: `master-${request.location.name}`,
    };
  }
  if (request.kind === "prop") {
    return {
      prompt: buildPropPrompt(request.prop, request.look, request.skills),
      label: `prop-${request.prop.name}`,
    };
  }
  // 关键帧是某一镜的静帧：用描述当标签，方便在溯源里认出是哪一格
  const frame = request.frame ?? "first";
  return {
    prompt: buildKeyframePrompt(request.shot, frame, request.skills),
    label: `${frame === "last" ? "lastframe" : "keyframe"}-${request.shot.description.slice(0, 16) || "shot"}`,
  };
}