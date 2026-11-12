import type { AILabel } from "@loomina/ir";
import { fnv1a } from "./fnv";
import { DEFAULT_BADGE, PLATFORM_SPECS, type BadgeCorner, type BadgePlacement } from "./platforms";

/**
 * AI 生成内容的标识（H5 / ADR-0090）。
 *
 * 显式标识是画面上的角标，隐式标识是文件里的元数据。ADR-0090 定下「两者都要、
 * 不可关闭」；这里补的是它「跟进」里剩下的两条：
 *
 * 1. **按平台安全区摆角标**：右下角正是多数平台点赞 / 评论栏的位置，
 *    角标被压在按钮下面等于没有。位置跟着发布目标走（表在 `platforms.ts`），
 *    不给作者自己挪——挪一次就可能挪进平台 UI 里，而作者看不出那是什么。
 * 2. **把标识与内容绑在一起**：只写一句 `AI生成`，任何人把它抄到别的视频上也没人发现。
 *    所以再写一枚**内容指纹**：同一份内容重算得出同一个 8 位十六进制，换一条片子就变。
 *
 * 指纹用 FNV-1a 32 位，和阶段闸门、导出预检同一套（`fnv.ts` 里写明了它不是安全哈希）。
 * 它证明的是「这份标识属于这份产物」，不是「谁生成的」——防伪要密钥分发与验签，
 * 像素级数字水印也没做；两条都记在 ADR-0138 的「未做」里。
 */

/** 显式标识的文案：短、稳定，不被裁掉 */
export const AI_LABEL_TEXT = "AI生成";

/** 基础的 AI 标注，写进 OTIO、发布包与渲染清单 */
export const AI_LABEL: AILabel = {
  explicit: true,
  implicit: true,
  standard: AI_LABEL_TEXT,
};

export { DEFAULT_BADGE };
export type { BadgeCorner, BadgePlacement };

const CORNER_CN: Record<BadgeCorner, string> = {
  br: "右下角",
  bl: "左下角",
  tr: "右上角",
  tl: "左上角",
};

export function badgeCornerLabel(corner: BadgeCorner): string {
  return CORNER_CN[corner];
}

/**
 * 这个发布目标的角标摆在哪。
 *
 * 平台没写就退回默认位置——不是最优，但至少是个确定的位置，
 * 而不是让角标随着界面改版漂移。
 */
export function badgePlacementOf(platform: string): BadgePlacement {
  const spec = PLATFORM_SPECS.find((item) => item.id === platform);
  return spec?.badge ?? DEFAULT_BADGE;
}

/** 角标在画面里的四边偏移，供 HTML / canvas 共用：百分比，落在安全区之内 */
export function badgeOffsets(placement: BadgePlacement): {
  top?: string;
  bottom?: string;
  left?: string;
  right?: string;
} {
  const inset = `${placement.insetPct}%`;
  const vertical = placement.corner === "tl" || placement.corner === "tr" ? { top: inset } : { bottom: inset };
  const horizontal = placement.corner === "tl" || placement.corner === "bl" ? { left: inset } : { right: inset };
  return { ...vertical, ...horizontal };
}

/**
 * 内容指纹的取材。
 *
 * 只取「决定了这份产物长什么样」的字段：标题、总长、每段的时长与素材地址。
 * 换一条 take、改一次时长、增删一镜，指纹都会变；只改字幕文案或配乐则不变——
 * 那两项不改变「这是哪一版画面」。
 */
export type AiLabelMaterial = {
  title: string;
  totalMs: number;
  /** 每段的时长与素材地址的短摘要；没有素材记空串 */
  clips: { durationMs: number; mediaHash: string }[];
};

/** 剪辑层（预览 HTML / OTIO / 发布包）的取材 */
export type LabelView = {
  title: string;
  totalMs: number;
  clips: { durationMs: number; uri?: string; stillUri?: string }[];
};

export function materialOfView(view: LabelView): AiLabelMaterial {
  return {
    title: view.title,
    totalMs: view.totalMs,
    clips: view.clips.map((clip) => ({
      durationMs: clip.durationMs,
      // 地址的短摘要，不是地址长度：两条 take 的地址长度可能一样，
      // 长度相同就分不出换没换素材。内嵌 data URI 也只是哈希一遍地址，不解码。
      mediaHash: mediaKeyOf(clip.uri ?? clip.stillUri ?? ""),
    })),
  };
}

/**
 * 渲染清单的取材：与剪辑层同一套规则，只是地址换成清单里实际要渲染的那一个。
 *
 * 服务端拿到清单后按同一个函数重算，和清单里声明的指纹比对——
 * 改过素材或时长却没更新指纹的清单会被拦下。
 */
export function materialOfManifest(
  manifest: {
    title: string;
    totalMs: number;
    clips: { durationMs: number; media?: string; remote?: string; placeholder?: boolean }[];
  },
): AiLabelMaterial {
  return {
    title: manifest.title,
    totalMs: manifest.totalMs,
    clips: manifest.clips.map((clip) => ({
      durationMs: clip.durationMs,
      // 占位图是渲染器当场画出来的，剪辑层没有对应地址，两边都记空串
      mediaHash: clip.placeholder ? "" : mediaKeyOf((clip.media ?? clip.remote ?? "").trim()),
    })),
  };
}

/** 素材地址的短摘要：空地址记空串，两边（剪辑层与清单）都按同一规则 */
function mediaKeyOf(uri: string): string {
  return uri ? fnv1a(uri) : "";
}

export function aiContentHashOf(material: AiLabelMaterial): string {
  // 标题按清单落盘时的同一规则裁一次，避免两端算出不同的指纹
  const canonical = [
    material.title.trim().slice(0, 80),
    String(material.totalMs),
    ...material.clips.map((clip) => `${clip.durationMs}:${clip.mediaHash}`),
  ].join("\u0000");
  return fnv1a(canonical);
}

/** 清单里的标识记录：显式、隐式、文案、版本与内容指纹 */
export type AiLabelRecord = AILabel & {
  /** 标识记录本身的版本：将来加字段时下游能分辨 */
  version: 1;
  /** 这一份产物的内容指纹（8 位十六进制） */
  contentHash: string;
};

export function aiLabelRecordOf(material: AiLabelMaterial): AiLabelRecord {
  return { ...AI_LABEL, version: 1, contentHash: aiContentHashOf(material) };
}

/** 这一版剪辑的标识记录：预览、OTIO 与发布包用它，指纹才对得上 */
export function aiLabelRecordFor(view: LabelView): AiLabelRecord {
  return aiLabelRecordOf(materialOfView(view));
}
