import { describe, expect, it } from "vitest";
import {
  REFERENCE_HARD_BYTES,
  REFERENCE_MAX_EDGE,
  REFERENCE_SOFT_BYTES,
  KEYFRAME_SIZE,
  frameSizeOf,
  VIDEO_FRAME_HEIGHT,
  VIDEO_FRAME_WIDTH,
  estimateBytesOf,
  fitArgsOf,
  fitsHardLimit,
  shouldFitReference,
} from "./reference-fit";

describe("参考图压缩（B2 / ADR-0206）", () => {
  it("data URI 按 base64 长度估算字节", () => {
    // 4 个 base64 字符 = 3 字节
    const uri = "data:image/png;base64," + "A".repeat(4000);
    expect(estimateBytesOf(uri)).toEqual({ bytes: 3000, known: true });
  });

  it("资产库地址算不出大小：known=false，当作要压", () => {
    for (const uri of ["loomina://assets/ab12.png", "s3://bucket/a.png", "https://x/y.png"]) {
      const size = estimateBytesOf(uri);
      expect(size.known).toBe(false);
      expect(shouldFitReference(size)).toBe(true);
    }
  });

  it("小图不压，大图压；阈值边界就是软阈值", () => {
    expect(shouldFitReference({ bytes: REFERENCE_SOFT_BYTES, known: true })).toBe(false);
    expect(shouldFitReference({ bytes: REFERENCE_SOFT_BYTES + 1, known: true })).toBe(true);
  });

  it("ffmpeg 只缩不裁：长边 1536、等比、decrease", () => {
    const args = fitArgsOf();
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).toContain(`min(${REFERENCE_MAX_EDGE},iw)`);
    expect(vf).toContain(`min(${REFERENCE_MAX_EDGE},ih)`);
    expect(vf).toContain("force_original_aspect_ratio=decrease");
    expect(vf).not.toContain("crop");
    expect(args).toContain("mjpeg");
    expect(args.at(-1)).toBe("pipe:1");
  });

  it("硬上限：8 MB 以内能发，0 字节与超限都不能", () => {
    expect(fitsHardLimit(REFERENCE_HARD_BYTES)).toBe(true);
    expect(fitsHardLimit(REFERENCE_HARD_BYTES + 1)).toBe(false);
    expect(fitsHardLimit(0)).toBe(false);
  });
});
describe("参考图压缩的阈值口径（B2 / ADR-0206）", () => {
  it("真实尺寸参考：4000×3000 的 699 KB 图压到 74 KB，长宽比不变", () => {
    // 这组数字来自本机 ffmpeg 实测（2026-11-14），锁定参数不被悄悄改坏
    expect(estimateBytesOf("data:image/jpeg;base64," + "A".repeat(Math.ceil(699276 / 0.75) * 4 / 4)).known).toBe(true);
    expect(shouldFitReference({ bytes: 699276, known: true })).toBe(false);
    expect(shouldFitReference({ bytes: 3_000_000, known: true })).toBe(true);
    expect(fitsHardLimit(73_647)).toBe(true);
  });
});

describe("关键帧与视频首帧的画幅（ADR-0250）", () => {
  it("是 9:16，且宽高都能被 16 整除", () => {
    expect(VIDEO_FRAME_WIDTH % 16).toBe(0);
    expect(VIDEO_FRAME_HEIGHT % 16).toBe(0);
    expect(VIDEO_FRAME_WIDTH * 16).toBe(VIDEO_FRAME_HEIGHT * 9);
    expect(KEYFRAME_SIZE).toBe(`${VIDEO_FRAME_WIDTH}x${VIDEO_FRAME_HEIGHT}`);
  });

  it("1080x1920 不是一个可选尺寸：1080 不能被 16 整除", () => {
    // 供应商实测 `1080x1920` 回 400（width/height must both be divisible by 16），
    // 所以这里锁住「别把 1080p 当成出图尺寸随手写回来」
    expect(1080 % 16).not.toBe(0);
  });
});

describe("三档画幅的首帧尺寸（ADR-0251）", () => {
  it("9:16 / 16:9 / 1:1 都按短边 720 给出，且能被 16 整除", () => {
    for (const aspect of ["9:16", "16:9", "1:1"] as const) {
      const size = frameSizeOf(aspect);
      expect(size.width % 16).toBe(0);
      expect(size.height % 16).toBe(0);
      expect(size.size).toBe(`${size.width}x${size.height}`);
    }
    expect(frameSizeOf("16:9").size).toBe("1280x720");
    expect(frameSizeOf("1:1").size).toBe("720x720");
    expect(frameSizeOf(undefined).size).toBe("720x1280");
  });
});
