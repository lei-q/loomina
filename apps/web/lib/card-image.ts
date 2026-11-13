import type { Brand } from "@loomina/ir";

/**
 * 头 / 尾卡的画法（E9 / ADR-0174）。
 *
 * 卡片只有一张静帧：底色 + 标题 + 副标题 + 落款。这里只管怎么把它画到
 * 一块画布上——成片、预览 HTML、OTIO 与界面里的预览都调这一个函数，
 * 所以四处的卡片是同一张，不会「导出跟界面长得不一样」。
 *
 * 只用 Canvas 2D：不引图片处理依赖，也不需要服务端。
 */

export type BrandCardRole = "intro" | "outro";

export type BrandCardArt = {
  role: BrandCardRole;
  /** 卡片底色，`#RRGGBB` */
  color: string;
  title: string;
  subtitle: string;
  /** 落款名；空着就不画 */
  name: string;
  /** 账号 / 期数说明；空着就不画 */
  handle: string;
};

const FONT_STACK =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

const DARK_TEXT = "#F4F4F5";
const DARK_MUTED = "rgba(244,244,245,0.62)";
const LIGHT_TEXT = "#17171A";
const LIGHT_MUTED = "rgba(23,23,26,0.60)";

/** `#RRGGBB` → 相对亮度；判断深底还是浅底 */
export function luminanceOf(color: string): number {
  const value = color.replace("#", "");
  const channels = [0, 2, 4].map((start) => {
    const raw = Number.parseInt(value.slice(start, start + 2), 16);
    const channel = Number.isFinite(raw) ? raw / 255 : 0;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** 字色跟着底色走：深底配浅字。作者只挑一个颜色，看不见的字不该靠运气 */
export function textColorsOf(color: string): { text: string; muted: string } {
  return luminanceOf(color) > 0.45
    ? { text: LIGHT_TEXT, muted: LIGHT_MUTED }
    : { text: DARK_TEXT, muted: DARK_MUTED };
}

/** 一段文字按宽度折行；中文按字断，英文尽量按空格断 */
export function wrapText(
  measure: (text: string) => number,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    let current = "";
    for (const char of [...trimmed]) {
      const candidate = current + char;
      if (current && measure(candidate) > maxWidth) {
        lines.push(current);
        current = char === " " ? "" : char;
      } else {
        current = candidate;
      }
    }
    if (current.trim()) lines.push(current);
  }
  return lines;
}

/**
 * 把一张卡画到画布上。
 *
 * `ctx` 只要求有 Canvas 2D 里最小的那几个方法（`fillStyle` / `font` /
 * `fillText` / `measureText` …）——测试里可以塞一个记账的假上下文。
 */
export function drawBrandCard(
  ctx: CanvasRenderingContext2D,
  art: BrandCardArt,
  size: { width: number; height: number },
): void {
  const { width, height } = size;
  const unit = width / 1080;
  const { text, muted } = textColorsOf(art.color);
  const cx = width / 2;

  ctx.fillStyle = art.color;
  ctx.fillRect(0, 0, width, height);

  // 中间一块：标题 → 细线 → 副标题。整块垂直居中，落款单独钉在底部
  const titleSize = Math.round(96 * unit);
  const subtitleSize = Math.round(46 * unit);
  const ruleWidth = Math.round(96 * unit);

  const titleLines = art.title.trim()
    ? wrapText(
        (value) => ctx.measureText(value).width,
        art.title.trim(),
        width * 0.72,
      )
    : [];
  const subtitleLines = art.subtitle.trim()
    ? wrapText(
        (value) => ctx.measureText(value).width,
        art.subtitle.trim(),
        width * 0.68,
      )
    : [];

  const titleLineHeight = titleSize * 1.32;
  const subtitleLineHeight = subtitleSize * 1.55;
  const ruleGap = Math.round(46 * unit);
  const ruleHeight = Math.max(2, Math.round(2 * unit));
  const hasRule = titleLines.length > 0 && subtitleLines.length > 0;

  // 主体：标题 → 细线 → 副标题，整块垂直居中
  const blockHeight =
    titleLines.length * titleLineHeight +
    (hasRule ? ruleGap * 2 + ruleHeight : 0) +
    subtitleLines.length * subtitleLineHeight;

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  let y = height / 2 - blockHeight / 2;
  ctx.fillStyle = text;
  ctx.font = `600 ${titleSize}px ${FONT_STACK}`;
  for (const line of titleLines) {
    ctx.fillText(line, cx, y + titleSize);
    y += titleLineHeight;
  }

  if (hasRule) {
    y += ruleGap;
    ctx.fillStyle = muted;
    ctx.fillRect(cx - ruleWidth / 2, y, ruleWidth, ruleHeight);
    y += ruleHeight + ruleGap;
  }

  ctx.fillStyle = muted;
  ctx.font = `400 ${subtitleSize}px ${FONT_STACK}`;
  for (const line of subtitleLines) {
    ctx.fillText(line, cx, y + subtitleSize);
    y += subtitleLineHeight;
  }

  // 落款：卡上只有落款时也要落在右下角，不占主体那块
  const nameSize = Math.round(36 * unit);
  const handleSize = Math.round(30 * unit);
  let footY = height - Math.round(120 * unit);
  ctx.textAlign = "left";
  if (art.handle.trim()) {
    ctx.fillStyle = muted;
    ctx.font = `400 ${handleSize}px ${FONT_STACK}`;
    ctx.fillText(art.handle.trim(), Math.round(width * 0.08), footY);
    footY -= handleSize * 1.5;
  }
  if (art.name.trim()) {
    ctx.fillStyle = text;
    ctx.font = `600 ${nameSize}px ${FONT_STACK}`;
    ctx.fillText(art.name.trim(), Math.round(width * 0.08), footY);
  }

  // 左下角一条短竖线，标明这是「卡」而不是某一镜
  ctx.fillStyle = muted;
  ctx.fillRect(
    Math.round(width * 0.08),
    Math.round(height * 0.08),
    Math.max(3, Math.round(4 * unit)),
    Math.round(72 * unit),
  );
}

/** 从品牌里取出一张画的素材：不关心开没开，开关由调用方判 */
export function brandArtOf(
  brand: Brand,
  role: BrandCardRole,
  card: { title: string; subtitle: string },
): BrandCardArt {
  return {
    role,
    color: brand.color,
    title: card.title,
    subtitle: card.subtitle,
    name: brand.name,
    handle: brand.handle,
  };
}

/**
 * 画成 PNG data URI。没有 DOM（服务端渲染、Node 测试）或画布不可用时返回
 * `undefined`——调用方退回占位画面，界面照旧能开。
 */
export function cardImage(
  art: BrandCardArt,
  size: { width: number; height: number },
): string | undefined {
  if (typeof document === "undefined") return undefined;
  const el = document.createElement("canvas");
  el.width = Math.max(1, Math.round(size.width));
  el.height = Math.max(1, Math.round(size.height));
  const ctx = el.getContext("2d");
  if (!ctx) return undefined;
  try {
    drawBrandCard(ctx, art, { width: el.width, height: el.height });
    return el.toDataURL("image/png");
  } catch {
    return undefined;
  }
}
