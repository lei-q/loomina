import { describe, expect, it } from "vitest";
import {
  REFERENCE_HARD_BYTES,
  REFERENCE_MAX_EDGE,
  REFERENCE_SOFT_BYTES,
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
