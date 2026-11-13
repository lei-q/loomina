/**
 * 多平台版本渲染（G9 / ADR-0171）。
 *
 * 一条片子要发好几个平台时，每个平台收的形状不一样：抖音 / 快手 / 视频号只要 9:16，
 * B 站与 X 收 16:9，小红书收 9:16 与 3:4。以前只能改一次画幅、导一次、再改回来导一次，
 * 中途还要重挑角标位置。这里把「按平台一次算好每版该是什么形状」做成纯函数：
 * 界面拿它列表，导出循环拿它逐版渲。
 *
 * 不在这里做「平台识别」：只认 `platforms.ts` 那张表，表改了这里跟着改。
 */

import { FRAME_ASPECTS, type Frame, type FrameAspect } from "@loomina/ir";
import { platformSpecOf, type PlatformId, type PlatformSpec } from "./platforms";
import { frameSize, type RenderQuality } from "./render-manifest";

/** 一版的计划：这个平台要什么形状、能不能出 */
export type VersionPlan = {
  platform: PlatformId;
  spec: PlatformSpec;
  /** 这一版实际用的画幅：形状可能被平台逼着换，适配方式沿用项目里的 */
  frame: Frame;
  /** 这一版的成片尺寸（按定稿档算，草稿按同一比例缩） */
  size: { width: number; height: number };
  /** 形状与项目当前设置不同：界面上要说一句「这一版会裁 / 会补边」 */
  changesFrame: boolean;
  /** 出不了的原因；空表示能出 */
  blocker?: string;
};

/** 平台接受的画幅里，我们做得了的那几个 */
function supportedAspects(spec: PlatformSpec): FrameAspect[] {
  return FRAME_ASPECTS.filter((aspect) => spec.aspectRatios.includes(aspect));
}

/**
 * 一个平台该用哪个形状。
 *
 * 优先沿用项目当前的画幅（作者已经挑过焦点、看过预览）；平台不收时，
 * 退到它接受、我们也做得出来的第一个。一个都做不出来就如实报出来，
 * 不偷偷换成 9:16——发上去被平台裁成什么样，比一次失败更难发现。
 */
export function frameForPlatform(frame: Frame, platform: PlatformId): {
  frame: Frame;
  blocker?: string;
} {
  const spec = platformSpecOf(platform);
  const supported = supportedAspects(spec);
  if (supported.includes(frame.aspect)) return { frame };
  const fallback = supported[0];
  if (fallback) return { frame: { aspect: fallback, fit: frame.fit } };
  return {
    frame,
    blocker: `${spec.name}只收 ${spec.aspectRatios.join(" / ")}，这几个形状我们还没有：先在「画幅」里选一个接近的，或按平台手工出`,
  };
}

/** 时长这一项按平台规格单独看：形状对了、时长超了同样发不出去 */
export function versionPlans(
  frame: Frame,
  durationMs: number,
  platforms: PlatformId[],
  /** 按这一档算尺寸：卡片上写 1080×1920 却导出 540×960 是最容易看漏的错 */
  quality: RenderQuality = "final",
): VersionPlan[] {
  return platforms.map((platform) => {
    const spec = platformSpecOf(platform);
    const picked = frameForPlatform(frame, platform);
    const size = frameSize(quality, picked.frame.aspect);
    let blocker = picked.blocker;
    if (!blocker) {
      const { min, max } = spec.durationMs;
      if (min !== undefined && durationMs < min) {
        blocker = `${spec.name}要求至少 ${(min / 1000).toFixed(0)} 秒，这一版只有 ${(durationMs / 1000).toFixed(1)} 秒`;
      } else if (max !== undefined && durationMs > max) {
        blocker = `${spec.name}上限 ${(max / 1000).toFixed(0)} 秒，这一版有 ${(durationMs / 1000).toFixed(1)} 秒`;
      }
    }
    return {
      platform,
      spec,
      frame: picked.frame,
      size,
      changesFrame:
        picked.frame.aspect !== frame.aspect || picked.frame.fit !== frame.fit,
      ...(blocker ? { blocker } : {}),
    };
  });
}

/**
 * 这一版的文件名后缀：同一个标题导出好几版时，下载到同一个文件夹里要分得清。
 * 只留平台名，不带画幅——画幅已经写在 `frame` 里，名字太长反而看不清。
 */
export function versionSuffix(platform: PlatformId): string {
  const name = platformSpecOf(platform).name.replace(/[\\/:*?"<>|\s（）()]+/g, "");
  return name || "版本";
}

/** 导出进度用的一句话：第几版、哪个平台、什么形状（按这一档的真实尺寸） */
export function versionLine(
  plan: VersionPlan,
  index: number,
  total: number,
  quality: RenderQuality = "final",
): string {
  const size = frameSize(quality, plan.frame.aspect);
  return `第 ${index + 1} / ${total} 版：${plan.spec.name} · ${plan.frame.aspect} · ${size.width}×${size.height}`;
}
