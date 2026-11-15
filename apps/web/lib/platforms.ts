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

/** 角标能放的四个角 */
export type BadgeCorner = "br" | "bl" | "tr" | "tl";

export type BadgePlacement = {
  corner: BadgeCorner;
  /** 离边的距离（画面宽 / 高的百分比）：落在安全区之内 */
  insetPct: number;
};

/** 平台没给位置时的默认：右下角，与 ADR-0090 最初的写法一致 */
export const DEFAULT_BADGE: BadgePlacement = { corner: "br", insetPct: 4 };

export type PlatformSpec = {
  id: PlatformId;
  name: string;
  aspectRatios: string[];
  /** 该平台竖屏 / 横屏的主分辨率；只作参考，校验看画幅与最小边 */
  resolution: { width: number; height: number };
  durationMs: { min?: number; max?: number };
  maxFileBytes?: number;
  /**
   * 文件上限是从哪核出来的（G2 / ADR-0214）。只有逐条读过平台文档才填，
   * 界面把它连同复核日期一起显示；没填就说明这个数还没核验过。
   */
  maxFileSource?: { url: string; checkedAt: string; quote: string };
  /** 上限适用的场景（手机投稿 / web 投稿 / 账号等级），界面照实写 */
  maxFileNote?: string;
  /**
   * 核过了，但官方文档**没有设**文件大小上限（G2 / ADR-0240）。
   *
   * 与「没核过」是两件不同的事：
   * - 没核过 → 面板写「未核验」，作者不知道该不该担心；
   * - 核过但官方没设 → 面板写「官方未设上限」，作者知道不必为此发愁。
   *
   * 有 `maxFileBytes` 时这个字段不生效（有上限就用上限）。
   */
  maxFileUnbounded?: { url: string; checkedAt: string; quote: string };
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
  /**
   * AI 标识角标摆在哪（H5 / ADR-0138）。
   *
   * 显式标识必须看得见，而平台的互动栏会盖住画面的一角：抖音 / 快手的右侧是
   * 点赞评论栏、底部是文案与音乐，右下角恰恰是最容易被遮住的地方。
   * 所以按平台把角标挪到相对空的一角，而不是固定写死。
   *
   * 这些位置是按各平台常见布局定的，平台改版就会失效，所以每一份规格都把
   * 「角标位置」列进 `reference`：它只提示，不是硬校验。
   */
  badge?: BadgePlacement;
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
    badge: { corner: "tl", insetPct: 8 },
    // 官方 SDK 文档逐条列了「文件要求」，只有格式、时长、尺寸，**没有文件大小上限**
    maxFileUnbounded: {
      url: "https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/sdk/mobile-app/share",
      checkedAt: "2026-11-15",
      quote: "视频：要求 mp4 文件…单视频及视频总时长最大值为 60 分钟。视频尺寸需要满足 短边小于2160且长边小于4096。",
    },
    maxFileNote: "官方列的是格式 / 时长 / 尺寸，没有文件大小上限；按体积判断没有意义",
    reference: ["标题字数", "话题数量", "码率", "封面", "AI 角标位置"],
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
    // 官方帮助中心「如何发布长视频」：相册导入最多 31 段、大小不超过 2G、时长不超 15 分钟
    maxFileBytes: 2 * 1024 ** 3,
    maxFileSource: {
      url: "https://www.kuaishou.com/help/feedback",
      checkedAt: "2026-11-14",
      quote: "视频最多可选择 31 段，大小不能超过 2G，时长不能超出 15 分钟。",
    },
    maxFileNote: "这是 App 相册导入长视频的上限；创作者服务平台网页端没有公开的同一口径",
    subtitleMode: "burn-in",
    publishMode: "api",
    badge: { corner: "tl", insetPct: 8 },
    reference: ["时长上限", "标题字数", "话题数量", "码率", "封面", "AI 角标位置"],
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
    badge: { corner: "tl", insetPct: 8 },
    reference: ["时长", "标题字数", "话题数量", "码率", "封面", "AI 角标位置"],
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
    // 官方帮助中心（2026-04-01 更新）：单 P 上限 16G，lv3 以上 web 投稿 64G。
    // 取小的那个当硬上限：超过 16G 的手机投稿路径一定发不了。
    maxFileBytes: 16 * 1024 ** 3,
    maxFileSource: {
      url: "https://www.bilibili.com/blackboard/help.html#/?qid=3845",
      checkedAt: "2026-11-14",
      quote: "文件大小：不超过16G*权益等级lv3以上，则可享受web投稿64G超大文件上限",
    },
    maxFileNote: "手机投稿单 P 上限 16G；权益等级 lv3 以上的 web 投稿可到 64G，这里按 16G 硬拦",
    subtitleMode: "burn-in",
    publishMode: "api",
    badge: { corner: "tl", insetPct: 8 },
    reference: ["时长", "标题字数", "话题数量", "码率", "封面", "AI 角标位置"],
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
    badge: { corner: "tl", insetPct: 8 },
    reference: ["时长", "标题字数", "话题数量", "码率", "封面", "AI 角标位置"],
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
    badge: { corner: "tl", insetPct: 8 },
    reference: ["时长（按地区）", "标题字数", "话题数量", "码率", "封面", "AI 角标位置"],
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
    badge: { corner: "tl", insetPct: 8 },
    reference: ["标题字数", "话题数量", "码率", "封面", "AI 角标位置"],
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
    badge: { corner: "tr", insetPct: 8 },
    reference: ["时长（账号等级）", "标题字数", "话题数量", "码率", "封面", "AI 角标位置"],
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
    badge: { corner: "br", insetPct: 8 },
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
  id:
    | "aspect"
    | "resolution"
    | "duration"
    | "codec"
    | "fps"
    | "bitrate"
    | "file-size"
    | "title"
    | "hashtags";
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

/** 体积写成人读的：不到 1 MB 用 KB，别把 48 KB 写成 0.0 MB */
export function formatSize(fileBytes: number): string {
  if (!Number.isFinite(fileBytes) || fileBytes <= 0) return "0 KB";
  if (fileBytes < 1024 * 1024) return `${Math.max(1, Math.round(fileBytes / 1024))} KB`;
  // 平台上限到了 GB 级（B 站 16G、快手 2G）：写成「2048.0 MB」读不出量级
  if (fileBytes >= 1024 ** 3) return `${(fileBytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(fileBytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 实际码率（Mbps）：字节 × 8 ÷ 秒。
 *
 * 渲染用 CRF，不给目标码率，所以码率只有一个来源——导出后的文件体积。
 * 没有文件就没有码率，别拿档位去猜。
 */
export function bitrateMbpsOf(
  fileBytes: number | undefined,
  durationMs: number,
): number | undefined {
  if (fileBytes === undefined || !Number.isFinite(fileBytes) || fileBytes <= 0) return undefined;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  return (fileBytes * 8) / (durationMs / 1000) / 1_000_000;
}

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

  // 码率只有导出后才知道：用实际体积算，超出参考区间只提醒（平台会二次压缩）
  const actualMbps = bitrateMbpsOf(input.fileBytes, input.durationMs);
  if (spec.bitrateMbps) {
    const [low, high] = spec.bitrateMbps;
    const measured =
      actualMbps === undefined
        ? `导出后按实际体积核算；${spec.name} 的参考区间 ${low}–${high} Mbps`
        : `${actualMbps.toFixed(1)} Mbps（${formatSize(input.fileBytes!)} / ${formatSeconds(input.durationMs)}）· 参考 ${low}–${high} Mbps`;
    const outside = actualMbps !== undefined && (actualMbps < low || actualMbps > high);
    checks.push({
      id: "bitrate",
      label: "码率",
      status: outside ? "review" : "pass",
      detail: outside
        ? `${measured}：超出参考区间，上传后平台多半会再压一次`
        : measured,
      reference: true,
    });
  } else {
    checks.push({
      id: "bitrate",
      label: "码率",
      status: "pass",
      detail:
        actualMbps === undefined
          ? `${spec.name} 没有可引用的公开码率区间；导出后看实际码率`
          : `${actualMbps.toFixed(1)} Mbps；${spec.name} 没有可引用的公开码率区间`,
      reference: true,
    });
  }

  if (spec.maxFileBytes !== undefined) {
    const limit = `上限 ${formatSize(spec.maxFileBytes)}`;
    // 核过的上限带上出处与复核日期（G2 / ADR-0214）：作者能自己去看那句话
    const basis = spec.maxFileSource
      ? `（${spec.maxFileSource.checkedAt} 核：${spec.maxFileSource.quote}）`
      : "";
    if (input.fileBytes !== undefined) {
      const ok = input.fileBytes <= spec.maxFileBytes;
      checks.push({
        id: "file-size",
        label: "文件大小",
        status: ok ? "pass" : "block",
        detail: `${formatSize(input.fileBytes)} · ${limit}${basis}`,
      });
    } else {
      checks.push({
        id: "file-size",
        label: "文件大小",
        status: "pass",
        detail: `${spec.name} ${limit}${basis}；导出后按实际体积核对`,
      });
    }
  } else if (spec.maxFileUnbounded) {
    // 核过了、官方确实没设上限（G2 / ADR-0240）：与「没核过」分开说
    const basis = `${spec.maxFileUnbounded.checkedAt} 核：${spec.maxFileUnbounded.quote}`;
    checks.push({
      id: "file-size",
      label: "文件大小",
      status: "pass",
      detail:
        input.fileBytes !== undefined
          ? `${formatSize(input.fileBytes)}；${spec.name} 官方未设上限（${basis}）`
          : `${spec.name} 官方未设上限（${basis}）`,
    });
  } else {
    checks.push({
      id: "file-size",
      label: "文件大小",
      status: "pass",
      detail:
        input.fileBytes !== undefined
          ? `${formatSize(input.fileBytes)}；${spec.name} 没有可引用的公开上限（未核验）`
          : `${spec.name} 没有可引用的公开上限（未核验）；导出后看实际体积`,
      reference: true,
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
