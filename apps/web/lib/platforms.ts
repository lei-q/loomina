/**
 * 平台规格库（G7）。
 *
 * 这里只把「能确定的结构」写成硬校验：画幅、时长上限、编码、帧率。
 * 标题字数、话题数量、码率与封面参考值来自公开资料，平台随时会改，
 * 所以标明 `reference`，只提示、不单独拦导出；真要拦，等逐条复核后再升级。
 *
 * 版本号随表一起走：发布包记下 `specVersion`，将来能说清是按哪版校验的。
 */

export const PLATFORM_SPEC_VERSION = "2026-11";

export type PlatformId =
  | "douyin"
  | "kuaishou"
  | "xiaohongshu"
  | "bilibili"
  | "channels"
  | "tiktok"
  | "youtube-shorts"
  | "x"
  | "generic";

export type PlatformSpec = {
  id: PlatformId;
  name: string;
  aspectRatios: string[];
  /** 该平台竖屏 / 横屏的主分辨率；只作参考，校验看画幅与最小边 */
  resolution: { width: number; height: number };
  durationMs: { min?: number; max?: number };
  maxFileBytes?: number;
  codec: "H.264";
  fps: number;
  coverRatio: string;
  /** 平台标题字数参考值；`reference` 里会列出 */
  titleMaxChars?: number;
  /** 话题数量参考值 */
  hashtagMax?: number;
  /** 参考码率区间（Mbps），只展示，不用于拦截 */
  bitrateMbps?: [number, number];
  subtitleMode: "burn-in" | "sidecar" | "both";
  publishMode: "api" | "share" | "export-only";
  /** 哪些字段没逐条复核：界面要标出来 */
  reference: string[];
  note: string;
};

export const PLATFORM_SPECS: PlatformSpec[] = [
  {
    id: "douyin",
    name: "抖音",
    aspectRatios: ["9:16"],
    resolution: { width: 1080, height: 1920 },
    durationMs: { min: 15_000, max: 900_000 },
    codec: "H.264",
    fps: 30,
    coverRatio: "9:16",
    titleMaxChars: 55,
    hashtagMax: 5,
    bitrateMbps: [2, 8],
    subtitleMode: "burn-in",
    publishMode: "api",
    reference: ["标题字数", "话题数量", "码率", "封面"],
    note: "开放平台发布需企业资质与审核；没有资质时走导出包手动发。",
  },
  {
    id: "kuaishou",
    name: "快手",
    aspectRatios: ["9:16"],
    resolution: { width: 1080, height: 1920 },
    durationMs: { min: 15_000 },
    codec: "H.264",
    fps: 30,
    coverRatio: "9:16",
    titleMaxChars: 50,
    hashtagMax: 5,
    bitrateMbps: [2, 8],
    subtitleMode: "burn-in",
    publishMode: "api",
    reference: ["时长上限", "标题字数", "话题数量", "码率", "封面"],
    note: "开放平台能力与资质要求以快手最新文档为准。",
  },
  {
    id: "xiaohongshu",
    name: "小红书",
    aspectRatios: ["9:16", "3:4"],
    resolution: { width: 1080, height: 1440 },
    durationMs: {},
    codec: "H.264",
    fps: 30,
    coverRatio: "3:4 / 9:16",
    titleMaxChars: 20,
    hashtagMax: 10,
    subtitleMode: "burn-in",
    publishMode: "share",
    reference: ["时长", "标题字数", "话题数量", "码率", "封面"],
    note: "没有公开的发布 API；只做导出包与系统分享，不做逆向。",
  },
  {
    id: "bilibili",
    name: "B 站",
    aspectRatios: ["16:9", "9:16"],
    resolution: { width: 1920, height: 1080 },
    durationMs: {},
    codec: "H.264",
    fps: 30,
    coverRatio: "16:9",
    titleMaxChars: 80,
    hashtagMax: 10,
    subtitleMode: "burn-in",
    publishMode: "api",
    reference: ["时长", "标题字数", "话题数量", "码率", "封面"],
    note: "9:16 竖屏可投；横版需要另出 16:9，本片不自动转画幅。",
  },
  {
    id: "channels",
    name: "视频号",
    aspectRatios: ["9:16"],
    resolution: { width: 1080, height: 1920 },
    durationMs: {},
    codec: "H.264",
    fps: 30,
    coverRatio: "9:16",
    titleMaxChars: 16,
    hashtagMax: 10,
    subtitleMode: "burn-in",
    publishMode: "share",
    reference: ["时长", "标题字数", "话题数量", "码率", "封面"],
    note: "无公开发布 API：导出后走微信分享。",
  },
  {
    id: "tiktok",
    name: "TikTok",
    aspectRatios: ["9:16"],
    resolution: { width: 1080, height: 1920 },
    durationMs: {},
    codec: "H.264",
    fps: 30,
    coverRatio: "9:16",
    titleMaxChars: 2_200,
    hashtagMax: 20,
    bitrateMbps: [2, 8],
    subtitleMode: "burn-in",
    publishMode: "api",
    reference: ["时长（按地区）", "标题字数", "话题数量", "码率", "封面"],
    note: "Content Posting API 需审核；时长上限按地区不同，这里不设硬上限。",
  },
  {
    id: "youtube-shorts",
    name: "YouTube Shorts",
    aspectRatios: ["9:16"],
    resolution: { width: 1080, height: 1920 },
    durationMs: { max: 180_000 },
    codec: "H.264",
    fps: 30,
    coverRatio: "9:16",
    titleMaxChars: 100,
    hashtagMax: 15,
    subtitleMode: "burn-in",
    publishMode: "api",
    reference: ["标题字数", "话题数量", "码率", "封面"],
    note: "Shorts 上限按 3 分钟校验；Data API 配额有限。",
  },
  {
    id: "x",
    name: "X",
    aspectRatios: ["16:9", "1:1", "9:16"],
    resolution: { width: 1920, height: 1080 },
    durationMs: { max: 140_000 },
    codec: "H.264",
    fps: 30,
    coverRatio: "16:9",
    titleMaxChars: 280,
    hashtagMax: 10,
    subtitleMode: "burn-in",
    publishMode: "api",
    reference: ["时长（账号等级）", "标题字数", "话题数量", "码率", "封面"],
    note: "普通账号按 2:20 上限校验；付费账号上限更高，不在这里区分。",
  },
  {
    id: "generic",
    name: "通用（不按平台卡）",
    aspectRatios: ["9:16"],
    resolution: { width: 1080, height: 1920 },
    durationMs: {},
    codec: "H.264",
    fps: 30,
    coverRatio: "9:16",
    subtitleMode: "burn-in",
    publishMode: "export-only",
    reference: ["所有平台字段"],
    note: "只做本机导出与自检，不冒充任何平台的正式规格。",
  },
];

export function platformSpecOf(id: PlatformId): PlatformSpec {
  return PLATFORM_SPECS.find((spec) => spec.id === id) ?? PLATFORM_SPECS[0]!;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** 1080×1920 → 9:16；非整数比原样写出，便于一眼看出不符 */
export function aspectRatioOf(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "未知";
  }
  const divisor = gcd(Math.round(width), Math.round(height));
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
}

export type PlatformCheck = {
  id: "aspect" | "resolution" | "duration" | "codec" | "fps" | "file-size" | "title" | "hashtags";
  label: string;
  status: "pass" | "review" | "block";
  detail: string;
  /** 参考值：只提示，不单独拦导出 */
  reference?: boolean;
};

export type PlatformValidation = {
  spec: PlatformSpec;
  ok: boolean;
  blocked: number;
  review: number;
  checks: PlatformCheck[];
};

export type PlatformInput = {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  codec?: string;
  title: string;
  topics: string[];
  fileBytes?: number;
};

const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

/** 按平台规格校验一条成片；只有画幅 / 时长上限 / 编码 / 帧率能硬拦 */
export function validatePlatform(
  spec: PlatformSpec,
  input: PlatformInput,
): PlatformValidation {
  const checks: PlatformCheck[] = [];
  const ratio = aspectRatioOf(input.width, input.height);
  const aspectOk = spec.aspectRatios.includes(ratio);
  checks.push({
    id: "aspect",
    label: "画幅",
    status: aspectOk ? "pass" : "block",
    detail: aspectOk
      ? `${ratio} · 接受 ${spec.aspectRatios.join(" / ")}`
      : `${ratio} 不在 ${spec.name} 接受的 ${spec.aspectRatios.join(" / ")} 里`,
  });

  const minSide = Math.min(input.width, input.height);
  checks.push({
    id: "resolution",
    label: "分辨率",
    status: minSide >= 720 ? "pass" : "block",
    detail:
      minSide >= 720
        ? `${input.width}×${input.height}；${spec.name} 的主分辨率参考 ${spec.resolution.width}×${spec.resolution.height}`
        : `${input.width}×${input.height}：短边小于 720，先换成高清再发`,
  });

  const { min, max } = spec.durationMs;
  let durationStatus: PlatformCheck["status"] = "pass";
  let durationDetail = `${formatSeconds(input.durationMs)}；${spec.name} 未设公开的硬性时长上限`;
  if (min !== undefined && input.durationMs < min) {
    durationStatus = "block";
    durationDetail = `${formatSeconds(input.durationMs)}，短于 ${spec.name} 的下限 ${formatSeconds(min)}`;
  } else if (max !== undefined && input.durationMs > max) {
    durationStatus = "block";
    durationDetail = `${formatSeconds(input.durationMs)}，超过 ${spec.name} 的上限 ${formatSeconds(max)}`;
  } else if (max !== undefined) {
    durationDetail = `${formatSeconds(input.durationMs)} · 上限 ${formatSeconds(max)}`;
  } else if (min !== undefined) {
    durationDetail = `${formatSeconds(input.durationMs)} · 下限 ${formatSeconds(min)}`;
  }
  checks.push({ id: "duration", label: "时长", status: durationStatus, detail: durationDetail });

  const codec = input.codec ?? "H.264";
  checks.push({
    id: "codec",
    label: "编码",
    status: codec === spec.codec ? "pass" : "block",
    detail:
      codec === spec.codec
        ? `${codec} · 成片固定 H.264 + AAC`
        : `${codec}：${spec.name} 这一档要求 ${spec.codec}`,
  });

  checks.push({
    id: "fps",
    label: "帧率",
    status: input.fps === spec.fps ? "pass" : "review",
    detail: `${input.fps}fps${input.fps === spec.fps ? "" : `：${spec.name} 的参考帧率是 ${spec.fps}`}`,
  });

  if (spec.maxFileBytes !== undefined && input.fileBytes !== undefined) {
    const ok = input.fileBytes <= spec.maxFileBytes;
    checks.push({
      id: "file-size",
      label: "文件大小",
      status: ok ? "pass" : "block",
      detail: `${(input.fileBytes / 1024 / 1024).toFixed(1)} MB · 上限 ${(spec.maxFileBytes / 1024 / 1024).toFixed(0)} MB`,
    });
  } else {
    checks.push({
      id: "file-size",
      label: "文件大小",
      status: "pass",
      detail:
        spec.maxFileBytes === undefined
          ? "平台没有可引用的公开上限（未核验）；导出后看实际体积"
          : "导出后按实际文件大小再核对",
      reference: spec.maxFileBytes === undefined,
    });
  }

  if (spec.titleMaxChars !== undefined) {
    const length = input.title.trim().length;
    checks.push({
      id: "title",
      label: "标题字数",
      status: length > spec.titleMaxChars ? "review" : "pass",
      detail:
        length > spec.titleMaxChars
          ? `${length} 字，超过参考上限 ${spec.titleMaxChars} 字：平台可能截断，发布前再确认`
          : `${length} / ${spec.titleMaxChars} 字（参考值，平台可能调整）`,
      reference: true,
    });
  }

  if (spec.hashtagMax !== undefined) {
    const count = input.topics.filter((topic) => topic.trim()).length;
    checks.push({
      id: "hashtags",
      label: "话题数量",
      status: count > spec.hashtagMax ? "review" : "pass",
      detail:
        count > spec.hashtagMax
          ? `${count} 个，超过参考上限 ${spec.hashtagMax} 个`
          : `${count} / ${spec.hashtagMax} 个（参考值）`,
      reference: true,
    });
  }

  const blocked = checks.filter((check) => check.status === "block").length;
  const review = checks.filter((check) => check.status === "review").length;
  return { spec, ok: blocked === 0, blocked, review, checks };
}

/** 给合规预检用的一句话：硬拦几条、参考值几条 */
export function platformCheckDetail(validation: PlatformValidation): string {
  const blocking = validation.checks.filter((check) => check.status === "block");
  if (blocking.length > 0) {
    return `${validation.spec.name}（规格 ${PLATFORM_SPEC_VERSION}）：${blocking
      .map((check) => check.detail)
      .join("；")}`;
  }
  const reference = validation.checks.filter((check) => check.reference).length;
  return `${validation.spec.name}（规格 ${PLATFORM_SPEC_VERSION}）：画幅、时长、编码与帧率通过${
    reference > 0 ? `；${reference} 项参考值只提示` : ""
  }`;
}
