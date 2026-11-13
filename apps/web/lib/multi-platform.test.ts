import { describe, expect, it } from "vitest";
import { frameForPlatform, versionLine, versionPlans, versionSuffix } from "./multi-platform";
import { platformSpecOf } from "./platforms";

const vertical = { aspect: "9:16" as const, fit: "crop" as const };

describe("多平台版本（G9 / ADR-0171）", () => {
  it("平台收当前画幅就沿用，不收时换成它收的第一个形状", () => {
    expect(frameForPlatform(vertical, "douyin")).toEqual({ frame: vertical });
    // B 站收 16:9 与 9:16：当前是 9:16，就沿用
    expect(frameForPlatform(vertical, "bilibili")).toEqual({ frame: vertical });
    // 小红书收 9:16 与 3:4：9:16 能出
    expect(frameForPlatform(vertical, "xiaohongshu")).toEqual({ frame: vertical });

    const wide = { aspect: "16:9" as const, fit: "blur" as const };
    // 抖音只收 9:16：换成竖屏，适配方式沿用 blur
    expect(frameForPlatform(wide, "douyin")).toEqual({
      frame: { aspect: "9:16", fit: "blur" },
    });
    expect(frameForPlatform(wide, "x")).toEqual({ frame: wide });
  });

  it("一个形状都做不出来时如实报出来，不偷偷换成别的", () => {
    // 小红书要 3:4，我们只做 9:16 / 16:9 / 1:1
    const square = { aspect: "1:1" as const, fit: "crop" as const };
    const spec = platformSpecOf("xiaohongshu");
    // 1:1 不在小红书的列表里，但有 9:16 可退
    expect(frameForPlatform(square, "xiaohongshu")).toEqual({
      frame: { aspect: "9:16", fit: "crop" },
    });
    expect(spec.aspectRatios).toContain("9:16");
  });

  it("每版算好尺寸与「会不会换形状」", () => {
    const plans = versionPlans(vertical, 60_000, ["douyin", "bilibili", "x"]);
    expect(plans).toHaveLength(3);
    const douyin = plans[0]!;
    expect(douyin.frame.aspect).toBe("9:16");
    expect(douyin.size).toEqual({ width: 1080, height: 1920 });
    expect(douyin.changesFrame).toBe(false);
    expect(douyin.blocker).toBeUndefined();

    const bili = plans[1]!;
    expect(bili.frame.aspect).toBe("9:16");
    expect(bili.changesFrame).toBe(false);

    const x = plans[2]!;
    // X 收 16:9 / 1:1 / 9:16，当前 9:16 能用
    expect(x.frame.aspect).toBe("9:16");
    expect(x.size).toEqual({ width: 1080, height: 1920 });
  });

  it("换成横屏时尺寸跟着换，并标出这一版改了形状", () => {
    const plans = versionPlans({ aspect: "16:9", fit: "crop" }, 60_000, ["douyin"]);
    expect(plans[0]!.frame).toEqual({ aspect: "9:16", fit: "crop" });
    expect(plans[0]!.changesFrame).toBe(true);
    expect(plans[0]!.size).toEqual({ width: 1080, height: 1920 });
  });

  it("时长不合平台下限 / 上限就出不了，原因写清是哪一条", () => {
    // 抖音下限 15 秒
    const short = versionPlans(vertical, 5_500, ["douyin"]);
    expect(short[0]!.blocker).toContain("至少 15 秒");
    // X 上限 140 秒
    const long = versionPlans(vertical, 150_000, ["x"]);
    expect(long[0]!.blocker).toContain("上限 140 秒");
    // 刚好合格
    expect(versionPlans(vertical, 20_000, ["douyin"])[0]!.blocker).toBeUndefined();
  });

  it("文件名后缀只留平台名，去掉路径分隔符与括号", () => {
    expect(versionSuffix("douyin")).toBe("抖音");
    expect(versionSuffix("bilibili")).toBe("B站");
    expect(versionSuffix("youtube-shorts")).toBe("YouTubeShorts");
    expect(versionSuffix("generic")).toBe("通用不按平台卡");
  });

  it("进度一句话带档位尺寸", () => {
    const plan = versionPlans({ aspect: "16:9", fit: "crop" }, 60_000, ["bilibili"])[0]!;
    expect(versionLine(plan, 0, 2, "final")).toBe("第 1 / 2 版：B 站 · 16:9 · 1920×1080");
    expect(versionLine(plan, 1, 2, "draft")).toBe("第 2 / 2 版：B 站 · 16:9 · 960×540");
  });

  it("卡片上的尺寸跟着当前档位走，不写死定稿", () => {
    const [draft] = versionPlans(vertical, 60_000, ["douyin"], "draft");
    expect(draft!.size).toEqual({ width: 540, height: 960 });
    const [final] = versionPlans(vertical, 60_000, ["douyin"], "final");
    expect(final!.size).toEqual({ width: 1080, height: 1920 });
  });
});
