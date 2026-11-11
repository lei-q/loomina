import { scanText, type ComplianceFinding } from "./compliance";

/**
 * 生成前的提示词审核（H6，ADR-0105）。
 *
 * 出图 / 出视频这一步能控制的只有提示词：先在服务端把将要发给供应商的那句话
 * 扫一遍，硬阻断的规则直接拒发（不花钱、不留一个不该有的画面），
 * 需要人工确认的只回报数量，不替用户改词、也不偷偷放行。
 *
 * 这不是像素级审核：图与视频出来之后的脸、手、构图与真实内容仍需人工看。
 */

export type PromptKind = "image" | "video";

export type PromptModeration = {
  kind: PromptKind;
  status: "pass" | "review" | "block";
  blocked: number;
  review: number;
  /** 命中的合规分类，按首次出现排序 */
  categories: string[];
  findings: ComplianceFinding[];
  summary: string;
};

export class PromptBlockedError extends Error {
  constructor(readonly moderation: PromptModeration) {
    super(
      `提示词命中内容安全硬阻断（${moderation.categories.join("、")}）：先改镜头描述或补充说明，这次没有发出请求，也没有花钱。`,
    );
    this.name = "PromptBlockedError";
  }
}

const KIND_CN: Record<PromptKind, string> = { image: "图片提示词", video: "视频提示词" };

export function moderatePrompt(prompt: string, kind: PromptKind): PromptModeration {
  const findings = prompt.trim() ? scanText(prompt, KIND_CN[kind]) : [];
  const blocked = findings.filter((finding) => finding.severity === "block").length;
  const review = findings.length - blocked;
  const categories = [...new Set(findings.map((finding) => finding.category))];
  const status = blocked > 0 ? "block" : review > 0 ? "review" : "pass";
  return {
    kind,
    status,
    blocked,
    review,
    categories,
    findings,
    summary:
      blocked > 0
        ? `${KIND_CN[kind]}有 ${blocked} 处硬阻断（${categories.join("、")}）：不会发出请求`
        : review > 0
          ? `${KIND_CN[kind]}有 ${review} 处需人工确认（${categories.join("、")}）：出片后自己再看一眼`
          : `${KIND_CN[kind]}没有命中内容安全规则`,
  };
}

/** 命中硬阻断时抛错；review 只随结果返回，不拦生成。 */
export function assertPromptAllowed(prompt: string, kind: PromptKind): PromptModeration {
  const moderation = moderatePrompt(prompt, kind);
  if (moderation.status === "block") throw new PromptBlockedError(moderation);
  return moderation;
}
