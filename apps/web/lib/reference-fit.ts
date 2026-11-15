/**
 * 参考图出图前压缩与裁剪（B2 / ADR-0206）。
 *
 * 网关有一条 8 MB 的硬上限，超了的参考图会被静默过滤；手机直出与截图
 * 动辄 4K。这里给出两个数字与一段 ffmpeg 参数：长边压到 1536、超过 1.5 MB
 * 才动手，**等比缩放、不裁剪**——参考图约束的是「同一个人 / 同一个地方」，
 * 裁掉边角等于把「不许变」的部分裁掉（准则 P3）。
 *
 * 纯函数：不碰文件、不起进程，测试直接断言参数。
 */

/** 长边上限：与出图尺寸 `1024x1536` 同一量级 */
export const REFERENCE_MAX_EDGE = 1536;
/** 超过这个大小就压；低于它原样发，别为了几 KB 起一次 ffmpeg */
export const REFERENCE_SOFT_BYTES = 1_500_000;
/** 网关的硬上限（B2 / ADR-0162）：超过它的参考图会被过滤 */
export const REFERENCE_HARD_BYTES = 8 * 1024 * 1024;
/**
 * 视频提交时首帧内联的硬上限（2026-11-15 实测）。
 *
 * 首帧以 `image_url` 的 data URI 塞进 `POST /v1/videos`，代理按「单个 part」
 * 限 1024 KB——base64 会膨胀 4/3，所以**原始字节**要压到约 768 KB 以内。
 * 超了就是 400 `Part exceeded maximum size of 1024KB.`。
 */
export const VIDEO_FRAME_PART_BYTES = 1024 * 1024;
/** base64 膨胀后的安全余量：留 1/4 给编码膨胀 */
export const VIDEO_FRAME_SOFT_BYTES = Math.floor(VIDEO_FRAME_PART_BYTES * 0.72);
/** MJPEG 质量：2–5 肉眼几乎无差，4 在体积与细节之间比较稳 */
export const REFERENCE_JPEG_QUALITY = 4;

/**
 * 竖屏 9:16 的画幅（ADR-0250）。
 *
 * 关键帧按这个尺寸出、视频首帧按这个尺寸对齐：视频输出比例跟随首帧，
 * 键帧出成 2:3（1024×1536）会让成片也变成 2:3，平台那边还要再裁。
 * 720 / 1280 都是 16 的整数倍——供应商只收能被 16 整除的尺寸。
 */
export const VIDEO_FRAME_WIDTH = 720;
export const VIDEO_FRAME_HEIGHT = 1280;
/** 关键帧出图尺寸字符串，供应商直接吃 */
export const KEYFRAME_SIZE = `${VIDEO_FRAME_WIDTH}x${VIDEO_FRAME_HEIGHT}`;

export type ReferenceSize = { bytes: number; known: boolean };

/**
 * 按地址估算字节数。
 *
 * `data:` 能算准（base64 长度 × 0.75）；资产库 / 对象存储地址不知道真实大小，
 * `known: false` 时按「需要压」处理——出图时读到字节还会再判一次，宁可多压一次，
 * 也不要让一张 12 MB 的手机照片被网关静默过滤。
 */
export function estimateBytesOf(uri: string): ReferenceSize {
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/=\s]*)$/i.exec(uri.trim());
  if (match) {
    const length = match[1]!.replace(/\s+/g, "").length;
    return { bytes: Math.floor((length * 3) / 4), known: true };
  }
  return { bytes: 0, known: false };
}

/** 这张要不要压：地址算得出大小就看大小，算不出就当它要压 */
export function shouldFitReference(size: ReferenceSize): boolean {
  return !size.known || size.bytes > REFERENCE_SOFT_BYTES;
}

/**
 * ffmpeg 参数：stdin → 等比缩到长边 1536 → MJPEG 写回 stdout。
 *
 * `force_original_aspect_ratio=decrease` 保证只缩不放、长宽比不变；
 * 短边跟着走，所以不会被拉变形，也不会裁掉任何一边。
 */
export function fitArgsOf(quality = REFERENCE_JPEG_QUALITY): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-vf",
    `scale='min(${REFERENCE_MAX_EDGE},iw)':'min(${REFERENCE_MAX_EDGE},ih)':force_original_aspect_ratio=decrease`,
    "-q:v",
    String(quality),
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "pipe:1",
  ];
}

/** 压完能不能发：仍然超过网关上限就得如实记 missing */
export function fitsHardLimit(bytes: number): boolean {
  return bytes > 0 && bytes <= REFERENCE_HARD_BYTES;
}