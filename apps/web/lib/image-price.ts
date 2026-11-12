"use client";

import type { ImagePrice } from "@/lib/generate-image";
import type { VideoPriceInfo } from "@/lib/generate-video";
import { modelIdFor } from "@/lib/model-choice";
import { useWorkbench } from "@/lib/workbench-store";

export type PriceInfo = ImagePrice & {
  /** 出视频的价目（ADR-0083）；服务端没给这一层就当作不知道 */
  video?: VideoPriceInfo;
};

/**
 * 问一次服务端的价目（ADR-0035）。
 *
 * 单价在服务端（ADR-0033），客户端只接收一个数；取不到就返回 null，
 * 界面不显示单价、也不拦生成——报不出价的时候，宁可不猜也不要假拦。
 */
const pending = new Map<string, Promise<PriceInfo | null>>();

export function fetchPrice(): Promise<PriceInfo | null> {
  // 项目固定了模型就用固定的（H22）；没固定才看这台浏览器的选择
  const pins = useWorkbench.getState().project.models;
  const imageModelId = modelIdFor("image", pins) ?? "";
  const videoModelId = modelIdFor("video", pins) ?? "";
  const key = `${imageModelId}|${videoModelId}`;
  let request = pending.get(key);
  if (!request) {
    const query = new URLSearchParams();
    if (imageModelId) query.set("imageModelId", imageModelId);
    if (videoModelId) query.set("videoModelId", videoModelId);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    request = fetch(`/api/price${suffix}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as PriceInfo;
      })
      .catch(() => {
        pending.delete(key); // 失败不记忆：下次进页面再问一次
        return null;
      });
    pending.set(key, request);
  }
  return request;
}

export function fetchImagePrice(): Promise<ImagePrice | null> {
  return fetchPrice();
}
