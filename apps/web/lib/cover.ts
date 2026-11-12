/**
 * 封面（G6 / E6 收尾）。
 *
 * 平台要求 9:16 的封面：一张画面 + 一个能一眼读完的标题。这里不做设计工具，
 * 只把「抽哪一帧、标题怎么排、角标摆哪」定下来，让作者按一下就能拿到
 * 1080×1920 的 PNG。
 *
 * 排版是纯函数，画图只依赖 `CanvasRenderingContext2D` 的公共接口，
 * 所以标题折行、字号与角标位置都能单测；真正出图在浏览器里。
 */

import { badgePlacementOf, type BadgePlacement } from "./ai-label";
import { SAFE_AREA } from "./edit";

export const COVER_WIDTH = 1080;
export const COVER_HEIGHT = 1920;

/** 标题最多两行：短视频封面没人读第三行 */
export const COVER_TITLE_MAX_LINES = 2;
/** 标题每行最多几个字（中文按全角算） */
export const COVER_TITLE_MAX_CHARS = 9;
/** 钩子（简介第一行）最多几个字 */
export const COVER_HOOK_MAX_CHARS = 18;

/** 角标在封面上与成片同一套写法 */
export const COVER_BADGE_TEXT = "AI 生成";

const ACCENT = "#E0442E";
const FONT_STACK =
  '"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';

const CLOSE_PUNCT = "，。！？；：、…—·,.!?;:";

/** 可见字数：空白不算，标点算半个字的宽度由字体自己处理，这里只数个数 */
function visibleChars(text: string): number {
  return [...text.replace(/\s+/g, "")].length;
}

/** 按字数硬切；优先切在标点后面 */
function cutAt(text: string, limit: number): [string, string] {
  const chars = [...text];
  if (chars.length <= limit) return [text, ""];
  let cut = limit;
  for (let index = limit; index > Math.max(0, limit - 4); index -= 1) {
    if (CLOSE_PUNCT.includes(chars[index - 1] ?? "")) {
      cut = index;
      break;
    }
  }
  return [chars.slice(0, cut).join("").trim(), chars.slice(cut).join("").trim()];
}

/**
 * 标题折行：最多两行，第二行放不下就省掉尾巴加省略号。
 *
 * 不按 CSS 的宽度折行，因为中文标题短、断在词中间反而难读；
 * 按字数切更像人写封面时会做的选择。
 */
export function coverTitleLines(
  title: string,
  maxChars = COVER_TITLE_MAX_CHARS,
): string[] {
  const clean = title.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const limit = Math.max(4, Math.round(maxChars));
  const [first, rest] = cutAt(clean, limit);
  if (!rest) return [first];
  const [second, tail] = cutAt(rest, limit);
  if (!second) return [first];
  return tail ? [first, second.replace(/[，。！？；：、…—·,.!?;:]+$/u, "") + "…"] : [first, second];
}

/** 字号跟着最长一行缩：字越多越小，但上下都留边界 */
export function coverFontSizeOf(lines: string[], width = COVER_WIDTH): number {
  const longest = lines.reduce((max, line) => Math.max(max, visibleChars(line)), 0);
  const ratio =
    longest <= 4 ? 0.115 : longest <= 6 ? 0.1 : longest <= 8 ? 0.088 : 0.078;
  return Math.max(56, Math.min(140, Math.round(width * ratio)));
}

/** 简介的第一行当钩子；太长就截断 */
export function coverHookOf(description: string, maxChars = COVER_HOOK_MAX_CHARS): string | undefined {
  const first = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) return undefined;
  const chars = [...first.replace(/\s+/g, " ")];
  if (chars.length <= maxChars) return first;
  return chars.slice(0, Math.max(1, maxChars)).join("") + "…";
}

export type CoverTitle = {
  lines: string[];
  fontPx: number;
  lineHeightPx: number;
};

export function coverTitleOf(title: string, width = COVER_WIDTH): CoverTitle {
  const lines = coverTitleLines(title);
  const fontPx = coverFontSizeOf(lines, width);
  return { lines, fontPx, lineHeightPx: Math.round(fontPx * 1.18) };
}

/** 封面画的是一张 PNG：文件名按项目标题来，和成片同一套规则 */
export function coverFileNameOf(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "loomina";
  return `${base}-封面.png`;
}

/** data URL 的字节数：出图之后显示「多大」，不用再解一遍 base64 */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  const payload = dataUrl.slice(comma + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export type CoverArt = {
  fileName: string;
  bytes: number;
  /** 封面用的是第几镜、片内第几毫秒 */
  shotNo: number;
  atMs: number;
  width: number;
  height: number;
  title: string;
  platform: string;
  generatedAt: string;
};

export type CoverArtInput = {
  title: string;
  shotNo: number;
  atMs: number;
  bytes: number;
  platform: string;
  generatedAt?: string;
};

export function coverArtOf(input: CoverArtInput): CoverArt {
  return {
    fileName: coverFileNameOf(input.title),
    bytes: Math.max(0, Math.round(input.bytes)),
    shotNo: input.shotNo,
    atMs: Math.max(0, Math.round(input.atMs)),
    width: COVER_WIDTH,
    height: COVER_HEIGHT,
    title: input.title,
    platform: input.platform,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

/**
 * 选封面用的那一帧。
 *
 * 有视频就从片内取一帧（预览切帧那条路，服务端 ffmpeg 精确 seek）；
 * 只有静态图就直接用图。都没有就出「只有标题」的封面，不拿占位图冒充画面。
 */
export function coverFrameUrlOf(
  uri: string | undefined,
  atMs: number,
  width = COVER_WIDTH,
): string | undefined {
  if (!uri) return undefined;
  const params = new URLSearchParams({
    asset: uri,
    at: String(Math.max(0, Math.round(atMs))),
    w: String(Math.max(120, Math.round(width))),
  });
  return `/api/preview/frame?${params.toString()}`;
}

export type CoverDrawOptions = {
  title: string;
  /** 简介第一行，排在标题上方；没有就不画 */
  hook?: string;
  platform: string;
  /** 封面画面；没有就只画标题 */
  image?: CanvasImageSource | null;
  /** 画面原始像素尺寸，用于 cover 铺满裁切 */
  imageWidth?: number;
  imageHeight?: number;
  /** 标题块离底边多远（%）：默认避开平台底部文案 */
  bottomPct?: number;
};

/** 圆角矩形：优先用 roundRect，没有就退到直角（老浏览器的封面也还能出） */
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, width, height, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.lineTo(x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.lineTo(x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.lineTo(x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.closePath();
}

/**
 * 往 2D 上下文里画一张封面。纯绘制：不加载图片、不出 PNG，
 * 调用方决定画面从哪来、结果存到哪。
 */
export function drawCover(
  ctx: CanvasRenderingContext2D,
  options: CoverDrawOptions,
  width = COVER_WIDTH,
  height = COVER_HEIGHT,
): void {
  ctx.save();
  ctx.fillStyle = "#0B0B0C";
  ctx.fillRect(0, 0, width, height);

  if (options.image && options.imageWidth && options.imageHeight) {
    // cover：按较大的比例铺满，再居中裁掉多出来的部分
    const scale = Math.max(width / options.imageWidth, height / options.imageHeight);
    const drawWidth = options.imageWidth * scale;
    const drawHeight = options.imageHeight * scale;
    ctx.drawImage(
      options.image,
      Math.round((width - drawWidth) / 2),
      Math.round((height - drawHeight) / 2),
      Math.round(drawWidth),
      Math.round(drawHeight),
    );
  } else {
    // 没有画面：一层很轻的斜向纹理，让纯排版封面不至于像纯黑屏
    const backdrop = ctx.createLinearGradient(0, 0, width, height);
    backdrop.addColorStop(0, "#1A1A1D");
    backdrop.addColorStop(1, "#0B0B0C");
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, width, height);
  }

  // 底部压暗：标题压在画面上也要读得清
  const scrim = ctx.createLinearGradient(0, height * 0.36, 0, height);
  scrim.addColorStop(0, "rgba(0,0,0,0)");
  scrim.addColorStop(0.55, "rgba(0,0,0,0.62)");
  scrim.addColorStop(1, "rgba(0,0,0,0.92)");
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, width, height);

  const title = coverTitleOf(options.title, width);
  const hook = options.hook?.trim();
  const side = Math.round((SAFE_AREA.sidePct / 100) * width);
  const bottomPct = options.bottomPct ?? 14;
  if (title.lines.length > 0) {
    const lastBaseline = Math.round(height * (1 - bottomPct / 100));
    // 标题按最后一行贴底边往上排；空标题只画画面与角标
    const titleTop = lastBaseline - (title.lines.length - 1) * title.lineHeightPx - title.fontPx;
    drawCoverTitle(ctx, { side, titleTop, title, hook, width });
  }

  // 角标：与成片同一张平台表（H5 / ADR-0138），封面也是要发出去的内容
  drawCoverBadge(ctx, badgePlacementOf(options.platform), width, height);
  ctx.restore();
}

/** 标题块：色条 + 钩子 + 两行标题，全部落在安全区内 */
function drawCoverTitle(
  ctx: CanvasRenderingContext2D,
  input: { side: number; titleTop: number; title: CoverTitle; hook?: string; width: number },
): void {
  const { side, titleTop, title, hook, width } = input;
  // 小色条：给标题一个起点，也把品牌色带进封面
  ctx.fillStyle = ACCENT;
  ctx.fillRect(
    side,
    titleTop - Math.round(title.fontPx * 0.62),
    Math.round(width * 0.066),
    Math.max(4, Math.round(width * 0.006)),
  );

  if (hook) {
    const hookFont = Math.max(28, Math.round(title.fontPx * 0.4));
    ctx.font = `500 ${hookFont}px ${FONT_STACK}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.fillText(hook, side, titleTop - Math.round(title.fontPx * 0.36));
  }

  ctx.font = `700 ${title.fontPx}px ${FONT_STACK}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#FFFFFF";
  ctx.shadowColor = "rgba(0,0,0,0.65)";
  ctx.shadowBlur = Math.round(title.fontPx * 0.22);
  title.lines.forEach((line, index) => {
    ctx.fillText(line, side, titleTop + index * title.lineHeightPx + title.fontPx);
  });
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
}

function drawCoverBadge(
  ctx: CanvasRenderingContext2D,
  placement: BadgePlacement,
  width: number,
  height: number,
): void {
  const fontPx = Math.max(22, Math.round(width * 0.027));
  ctx.font = `500 ${fontPx}px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const padding = Math.round(fontPx * 0.5);
  const badgeWidth = ctx.measureText(COVER_BADGE_TEXT).width + padding * 2;
  const badgeHeight = fontPx + padding * 1.4;
  const inset = (placement.insetPct / 100) * width;
  const left = placement.corner === "tl" || placement.corner === "bl";
  const top = placement.corner === "tl" || placement.corner === "tr";
  const x = left ? inset : width - inset - badgeWidth;
  const y = top ? inset : height - inset - badgeHeight;

  ctx.fillStyle = "rgba(0,0,0,0.58)";
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 2;
  roundedRect(ctx, x, y, badgeWidth, badgeHeight, Math.round(fontPx * 0.2));
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.fillText(COVER_BADGE_TEXT, x + badgeWidth / 2, y + badgeHeight / 2 + 1);
}

/** 封面出图后立刻下载：不经过服务器 */
export function downloadCover(dataUrl: string, fileName: string): void {
  const [meta, payload = ""] = dataUrl.split(",");
  const mime = /data:([^;]+)/.exec(meta ?? "")?.[1] ?? "image/png";
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
