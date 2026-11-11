import { ProjectSchema } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import { autoCut, timelineEquals, timecode, toEditView } from "./edit";
import {
  buildOtio,
  buildPreviewHtml,
  buildPublishPackage,
  buildSrt,
  safeFileName,
} from "./export-cut";
import { sampleProject } from "./sample-project";
import { PLATFORM_SPEC_VERSION } from "./platforms";

const AT = "2026-11-11T10:00:00+08:00";

describe("自动初剪（ADR-0086）", () => {
  it("按剧本顺序排列，优先留用 take", () => {
    const cut = autoCut(sampleProject);
    // s-01 与 s-10 只有被淘汰的 take：跳过并报出来
    expect(cut.items).toHaveLength(10);
    expect(cut.skipped.map((item) => item.shotId)).toEqual(["s-01", "s-10"]);
    expect(cut.items[0]).toMatchObject({
      shotId: "s-02",
      takeId: "t-02",
      startMs: 0,
      durationMs: 2400,
    });
    // 起点接着上一镜的终点
    expect(cut.items[1]).toMatchObject({ shotId: "s-03", startMs: 2400 });
  });

  it("跳过被淘汰的唯一 take，不拿它顶数", () => {
    const cut = autoCut(sampleProject);
    expect(cut.items.some((item) => item.shotId === "s-01")).toBe(false);
    expect(cut.skipped[0]?.reason).toContain("淘汰");
  });

  it("同一条时间线重复生成时判等，不写重复事件", () => {
    const cut = autoCut(sampleProject);
    expect(timelineEquals(cut.items, [...cut.items].reverse())).toBe(true);
    expect(
      timelineEquals(cut.items, cut.items.map((item) => ({ ...item, startMs: item.startMs + 1 }))),
    ).toBe(false);
  });
});

describe("成片读模型（ADR-0086）", () => {
  it("片段按起点排，台词换算成绝对时间", () => {
    const view = toEditView(sampleProject);
    expect(view.clips.map((clip) => clip.shotId)).toEqual(["s-01", "s-02"]);
    expect(view.totalMs).toBe(5500);
    expect(view.totalSec).toBe(5.5);
    expect(view.clips[0]?.lines).toHaveLength(1);
    expect(view.clips[0]?.lines[0]).toMatchObject({
      id: "d-01",
      characterName: "周",
      startMs: 0,
      durationMs: 2600,
    });
    // 示例里 take 的资产不存在：位置留着，画面空着
    expect(view.noPicture).toBe(2);
    expect(view.missing).toBe(10);
    expect(view.withVoice).toBe(0);
  });

  it("有音轨时按台词带出 uri，并计入有配音的镜头", () => {
    const project = ProjectSchema.parse({
      ...sampleProject,
      assets: [
        ...sampleProject.assets,
        {
          id: "a-voice-d-01",
          kind: "audio",
          source: "upload",
          uri: "https://example.com/d-01.mp3",
          createdAt: AT,
        },
      ],
      dialogue: sampleProject.dialogue.map((line) =>
        line.id === "d-01" ? { ...line, audioAssetId: "a-voice-d-01" } : line,
      ),
    });
    const view = toEditView(project);
    expect(view.withVoice).toBe(1);
    expect(view.clips[0]?.lines[0]?.audioUri).toBe("https://example.com/d-01.mp3");
  });

  it("时间码按 mm:ss.mmm 显示", () => {
    expect(timecode(0)).toBe("00:00.000");
    expect(timecode(65_200)).toBe("01:05.200");
  });

  it("台词按字数断成多条字幕，时间首尾相接、总和不变（D2）", () => {
    const view = toEditView(sampleProject, { maxChars: 6 });
    const line = view.clips[0]!.lines[0]!;
    expect(line.cues.length).toBeGreaterThan(1);
    expect(line.cues[0]!.startMs).toBe(line.startMs);
    const last = line.cues.at(-1)!;
    expect(last.startMs + last.durationMs).toBe(line.startMs + line.durationMs);
    // 读模型里的字幕是拍平的、按时间排好
    expect(view.cues.every((cue) => cue.lineId === "d-01")).toBe(true);
    for (let index = 1; index < view.cues.length; index += 1) {
      expect(view.cues[index]!.startMs).toBeGreaterThanOrEqual(
        view.cues[index - 1]!.startMs,
      );
    }
  });
});

describe("导出（E6 / D3 / G1）", () => {
  it("SRT 一句一条，起止按绝对时间", () => {
    const srt = buildSrt(toEditView(sampleProject));
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:02,600\n你早就知道，对吧。");
    expect(srt.trim().split("\n\n")).toHaveLength(1);
  });

  it("SRT 按断句后的字幕出，一条一行（D2）", () => {
    const view = toEditView(sampleProject, { maxChars: 6 });
    const blocks = buildSrt(view).trim().split("\n\n");
    expect(blocks).toHaveLength(view.cues.length);
    expect(blocks[0]).toContain(view.cues[0]!.text);
  });

  it("预览 HTML 自包含，带字幕与安全区样式", () => {
    const view = toEditView(sampleProject);
    const html = buildPreviewHtml(view, "large");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("你早就知道，对吧。");
    expect(html).toContain("font-size:5.8cqw");
    expect(html).toContain('aspect-ratio:9/16');
    // 标题里的尖括号会被转义，而不是直接塞进标签
    expect(buildPreviewHtml({ ...view, title: "<夜班>" })).toContain("&lt;夜班&gt;");
  });

  it("OTIO 有视频轨与音轨，音轨按台词落片段", () => {
    const project = ProjectSchema.parse({
      ...sampleProject,
      assets: [
        ...sampleProject.assets,
        {
          id: "a-voice-d-01",
          kind: "audio",
          source: "upload",
          uri: "https://example.com/d-01.mp3",
          createdAt: AT,
        },
      ],
      dialogue: sampleProject.dialogue.map((line) =>
        line.id === "d-01" ? { ...line, audioAssetId: "a-voice-d-01" } : line,
      ),
    });
    const otio = buildOtio(toEditView(project)) as {
      OTIO_SCHEMA: string;
      tracks: { children: { kind: string; children: unknown[] }[] };
    };
    expect(otio.OTIO_SCHEMA).toBe("Timeline.1");
    const video = otio.tracks.children.find((track) => track.kind === "Video")!;
    const audio = otio.tracks.children.find((track) => track.kind === "Audio")!;
    expect(video.children).toHaveLength(2);
    expect(audio.children).toHaveLength(1);
  });

  it("预览 HTML 带不可关掉的 AI 生成标识与元数据（H5）", () => {
    const html = buildPreviewHtml(toEditView(sampleProject), "default");
    expect(html).toContain('<meta name="ai-generated" content="true">');
    expect(html).toContain('<meta name="ai-label-standard" content="AI生成">');
    expect(html).toContain('aria-label="AI 生成内容标识"');
    expect(html).toContain(">AI 生成</div>");
  });

  it("OTIO 元数据也带 AI 标注（H5）", () => {
    const otio = buildOtio(toEditView(sampleProject)) as {
      metadata: { loom: { aiLabel: unknown } };
    };
    expect(otio.metadata.loom.aiLabel).toEqual({
      explicit: true,
      implicit: true,
      standard: "AI生成",
    });
  });

  it("发布包带 AI 标注、字幕与未完成项；视频位如实为空", () => {
    const view = toEditView(sampleProject);
    const pack = buildPublishPackage(view, {
      title: " 夜班 ",
      description: "两个人的夜班。",
      topics: ["短剧", " ", "夜班"],
      style: "default",
      kind: "draft",
      platform: "generic",
    });
    expect(pack.title).toBe("夜班");
    expect(pack.topics).toEqual(["短剧", "夜班"]);
    expect(pack.aiLabel).toEqual({
      explicit: true,
      implicit: true,
      standard: "AI生成",
    });
    expect(pack.video).toBeNull();
    expect(pack.videoNote).toContain("先在成片页导出一次 MP4");
    expect(pack.subtitles).toContain("你早就知道，对吧。");
    expect(pack.warnings).toEqual([
      "2 个片段没有画面",
      "整条片子还没有配音",
      "剧本里还有 10 镜没进时间线",
      "还没有导出过成片 MP4：发布包的视频位是空的",
    ]);
  });

  it("导出过成片后，发布包带上文件名、字节数与档位（G1）", () => {
    const pack = buildPublishPackage(toEditView(sampleProject), {
      title: "夜班",
      description: "",
      topics: [],
      style: "default",
      kind: "final",
      platform: "generic",
      video: {
        fileName: "夜班-成片.mp4",
        bytes: 8_388_608,
        quality: "final",
        renderedAt: "2026-11-11T10:00:00+08:00",
      },
    });
    expect(pack.kind).toBe("final");
    expect(pack.video).toEqual({
      fileName: "夜班-成片.mp4",
      bytes: 8_388_608,
      quality: "final",
      renderedAt: "2026-11-11T10:00:00+08:00",
    });
    expect(pack.videoNote).toContain("定稿成片 夜班-成片.mp4");
    expect(pack.videoNote).toContain("8.0 MB");
    expect(
      pack.warnings.some((warning) => warning.includes("还没有导出过成片")),
    ).toBe(false);
  });

  it("发布包按实际成片体积核码率与文件大小", () => {
    const pack = buildPublishPackage(toEditView(sampleProject), {
      title: "夜班",
      description: "两个人的夜班。",
      topics: [],
      style: "default",
      kind: "final",
      platform: "douyin",
      video: {
        fileName: "夜班-成片.mp4",
        bytes: 90 * 1024 * 1024,
        quality: "final",
        renderedAt: "2026-11-11T10:00:00+08:00",
      },
    });
    const bitrate = pack.platformChecks.find((check) => check.id === "bitrate")!;
    expect(bitrate.reference).toBe(true);
    expect(bitrate.detail).toContain("Mbps");
    expect(pack.platformChecks.find((check) => check.id === "file-size")!.detail).toContain(
      "90.0 MB",
    );
  });

  it("发布包默认按抖音规格校验，短于下限时如实警告", () => {
    const pack = buildPublishPackage(toEditView(sampleProject), {
      title: "夜班",
      description: "两个人的夜班。",
      topics: [],
      style: "default",
      kind: "draft",
    });
    expect(pack.platform).toBe("douyin");
    expect(pack.platformName).toBe("抖音");
    expect(pack.specVersion).toBe(PLATFORM_SPEC_VERSION);
    expect(pack.platformChecks.some((check) => check.id === "duration")).toBe(true);
    expect(
      pack.warnings.some(
        (warning) => warning.includes("抖音") && warning.includes("下限"),
      ),
    ).toBe(true);
  });

  it("文件名去掉路径分隔符与空白", () => {
    expect(safeFileName("夜班 / 第一集", "预览.html")).toBe("夜班-第一集-预览.html");
    expect(safeFileName("   ", "x.json")).toBe("loomina-x.json");
  });
});
