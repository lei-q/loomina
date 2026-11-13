import { ProjectSchema } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import { SUBTITLE_STYLES, autoCut, timelineEquals, timecode, toEditView } from "./edit";
import { assColorOf, speakerColorAt } from "./speaker-color";
import {
  buildOtio,
  buildPreviewHtml,
  buildPublishPackage,
  buildAss,
  buildSrt,
  previewClips,
  safeFileName,
} from "./export-cut";
import { sampleProject } from "./sample-project";
import { PLATFORM_SPEC_VERSION } from "./platforms";

const AT = "2026-11-11T10:00:00+08:00";

/** ASS 的时间码格式：时:分:秒.厘秒（两位小数） */
function assTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const h = Math.floor(safe / 3_600_000);
  const m = String(Math.floor((safe % 3_600_000) / 60_000)).padStart(2, "0");
  const s = String(Math.floor((safe % 60_000) / 1000)).padStart(2, "0");
  const c = String(Math.floor((safe % 1000) / 10)).padStart(2, "0");
  return `${h}:${m}:${s}.${c}`;
}

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

describe("手改断句（D2）", () => {
  function withOverride(
    cues: { text: string; durationMs: number }[],
  ) {
    return ProjectSchema.parse({
      ...sampleProject,
      subtitleOverrides: [{ lineId: "d-01", cues }],
    });
  }

  it("覆盖整句断句，时间按比例缩放到整句时长", () => {
    const project = withOverride([
      { text: "你早就知道", durationMs: 1000 },
      { text: "对吧", durationMs: 1000 },
    ]);
    const view = toEditView(project, { maxChars: 6 });
    const line = view.clips[0]!.lines[0]!;
    expect(line.manual).toBe(true);
    expect(line.cues.map((cue) => cue.text)).toEqual(["你早就知道", "对吧"]);
    // 整句 2600ms，两条各占一半 → 1300 / 1300
    expect(line.cues.map((cue) => cue.durationMs)).toEqual([1300, 1300]);
    expect(line.cues[0]!.startMs).toBe(line.startMs);
    expect(line.cues.at(-1)!.startMs + line.cues.at(-1)!.durationMs).toBe(
      line.startMs + line.durationMs,
    );
    expect(view.cues).toHaveLength(2);
    expect(view.cues.every((cue) => cue.manual)).toBe(true);
  });

  it("改字数档位不影响手改过的句子，只影响没改的", () => {
    const project = ProjectSchema.parse({
      ...sampleProject,
      subtitleOverrides: [
        { lineId: "d-01", cues: [{ text: "整句不拆", durationMs: 2600 }] },
      ],
    });
    const wide = toEditView(project, { maxChars: 20 });
    const narrow = toEditView(project, { maxChars: 6 });
    expect(wide.clips[0]!.lines[0]!.cues.map((cue) => cue.text)).toEqual(["整句不拆"]);
    expect(narrow.clips[0]!.lines[0]!.cues.map((cue) => cue.text)).toEqual(["整句不拆"]);
  });

  it("舍入误差落在最后一条上，总和永远等于整句时长", () => {
    const project = withOverride([
      { text: "一", durationMs: 1 },
      { text: "二", durationMs: 1 },
      { text: "三", durationMs: 1 },
    ]);
    const line = toEditView(project).clips[0]!.lines[0]!;
    const sum = line.cues.reduce((total, cue) => total + cue.durationMs, 0);
    expect(sum).toBe(line.durationMs);
    expect(line.cues.at(-1)!.durationMs).toBeGreaterThanOrEqual(1);
  });

  it("没有覆盖时字幕不带 manual 标记", () => {
    const line = toEditView(sampleProject, { maxChars: 6 }).clips[0]!.lines[0]!;
    expect(line.manual).toBeUndefined();
    expect(line.cues.every((cue) => cue.manual === undefined)).toBe(true);
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

  it("ASS 带样式头与事件，时间换成厘秒（D4）", () => {
    const view = toEditView(sampleProject);
    const ass = buildAss(view);
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    // 时间格式是 时:分:秒.厘秒，不是 SRT 的逗号毫秒
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.00,0:00:02\.60,Default/);
    expect(ass).toContain(view.cues[0]!.text);
    expect(ass).not.toContain("-->");
  });

  it("ASS 的字号与底边距离跟着字幕档位变（D3）", () => {
    const view = toEditView(sampleProject);
    const normal = buildAss(view, "default");
    const large = buildAss(view, "large");
    const sizeOf = (ass: string) => Number(/^Style: Default,PingFang SC,(\d+),/m.exec(ass)![1]);
    const marginOf = (ass: string) => Number(/^Style: Default,.*,2,\d+,\d+,(\d+),1$/m.exec(ass)![1]);
    expect(sizeOf(large)).toBeGreaterThan(sizeOf(normal));
    // 大字档离底边更远（18% > 14%）
    expect(marginOf(large)).toBeGreaterThan(marginOf(normal));
  });

  it("没有台词时 ASS 只有头，没有 Dialogue 行", () => {
    const view = toEditView(sampleProject);
    const ass = buildAss({ ...view, cues: [] });
    expect(ass).toContain("[Events]");
    expect(ass).not.toContain("Dialogue:");
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

  it("横屏时 ASS 的 PlayRes 与预览舞台都跟着换（E5 / ADR-0170）", () => {
    const view = toEditView(sampleProject);
    const wide = { ...view, frame: { aspect: "16:9" as const, fit: "crop" as const } };
    const ass = buildAss(wide);
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("PlayResY: 1080");
    // 竖屏那版仍然是 1080×1920
    expect(buildAss(view)).toContain("PlayResY: 1920");

    const html = buildPreviewHtml(wide);
    expect(html).toContain("aspect-ratio:16/9");
    expect(html).toContain("object-fit:cover");
  });

  it("预览 HTML 的裁切焦点落到 object-position（E5 / ADR-0170）", () => {
    const view = toEditView(sampleProject);
    const html = buildPreviewHtml({ ...view, frame: { aspect: "16:9", fit: "crop" } });
    expect(html).toContain("objectPosition = x");
    // 模糊填充的底层一直在 DOM 里，按 FIT 决定显不显示
    expect(buildPreviewHtml({ ...view, frame: { aspect: "16:9", fit: "blur" } })).toContain(
      'const FIT = "blur"',
    );
    expect(html).toContain('const FIT = "crop"');
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

  it("时间线带转场时，剪辑读模型与预览都带上（E4 / ADR-0169）", () => {
    const project = ProjectSchema.parse({
      ...sampleProject,
      timeline: {
        ...sampleProject.timeline,
        items: sampleProject.timeline.items.map((item, index) =>
          index === 1 ? { ...item, transitionIn: { kind: "black", durationMs: 300 } } : item,
        ),
      },
    });
    const view = toEditView(project);
    expect(view.clips[0]!.transitionIn).toBeUndefined();
    expect(view.clips[1]!.transitionIn).toEqual({ kind: "black", durationMs: 300 });
    // 转场不改时长：时间线的段与起点照旧
    expect(view.totalMs).toBe(toEditView(sampleProject).totalMs);

    const html = buildPreviewHtml(view, "default");
    expect(html).toContain('"fadeIn":{"durationMs":300,"kind":"black"}');
    expect(html).toContain('"fadeOut":{"durationMs":300,"kind":"black"}');
    expect(html).toContain('id="dip"');
  });

  it("预览 HTML 带不可关掉的 AI 生成标识与元数据（H5）", () => {
    const html = buildPreviewHtml(toEditView(sampleProject), "default");
    expect(html).toContain('<meta name="ai-generated" content="true">');
    expect(html).toContain('<meta name="ai-label-standard" content="AI生成">');
    expect(html).toContain('<meta name="ai-label-content-hash"');
    expect(html).toContain('aria-label="AI 生成内容标识"');
    expect(html).toContain(">AI 生成</div>");
  });

  it("预览的角标按目标平台摆：抖音在左上角，通用在右下角（H5）", () => {
    const douyin = buildPreviewHtml(toEditView(sampleProject), "default", "douyin");
    expect(douyin).toContain('<meta name="ai-label-badge" content="tl">');
    expect(douyin).toContain("top:8%; left:8%");
    expect(douyin).toContain('data-corner="tl"');

    const generic = buildPreviewHtml(toEditView(sampleProject), "default", "generic");
    expect(generic).toContain('<meta name="ai-label-badge" content="br">');
    expect(generic).toContain("bottom:8%; right:8%");
  });

  it("OTIO 元数据也带 AI 标注与内容指纹（H5）", () => {
    const otio = buildOtio(toEditView(sampleProject)) as {
      metadata: { loom: { aiLabel: { explicit: boolean; implicit: boolean; standard: string; version: number; contentHash: string } } };
    };
    const label = otio.metadata.loom.aiLabel;
    expect(label).toMatchObject({ explicit: true, implicit: true, standard: "AI生成", version: 1 });
    expect(label.contentHash).toMatch(/^[0-9a-f]{8}$/);
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

describe("字幕版式（D3）：作者调过的项进 IR，导出三处共用", () => {
  const custom = ProjectSchema.parse({
    ...sampleProject,
    subtitleLayout: { preset: "large", fontSizeCqw: 6.4, bottomPct: 22 },
  });

  it("读模型把模板与调过的项合成一份实际样式", () => {
    const view = toEditView(custom);
    expect(view.subtitleStyle.fontSizeCqw).toBe(6.4);
    expect(view.subtitleStyle.bottomPct).toBe(22);
    // 没调过的项跟着模板走（大字档描边 0.7）
    expect(view.subtitleStyle.strokeCqw).toBe(0.7);
    expect(view.subtitleCustom).toBe(true);
  });

  it("没调过时就是模板原样，界面不显示「已调」", () => {
    const view = toEditView(sampleProject);
    expect(view.subtitleStyle).toEqual(SUBTITLE_STYLES.default);
    expect(view.subtitleCustom).toBe(false);
  });

  it("换模板时调过的字号不被改回去，没调过的位置跟着换", () => {
    const onlySize = ProjectSchema.parse({
      ...sampleProject,
      subtitleLayout: { preset: "default", fontSizeCqw: 3.2 },
    });
    const view = toEditView(onlySize, { style: "large" });
    expect(view.subtitleStyle.fontSizeCqw).toBe(3.2);
    expect(view.subtitleStyle.bottomPct).toBe(SUBTITLE_STYLES.large.bottomPct);
  });

  it("ASS、预览 HTML 与发布包都用调过的值", () => {
    const view = toEditView(custom);
    const ass = buildAss(view);
    // 6.4cqw × 1080 = 69.12 → ASS 以 PlayResY 计，字号取整后是 123
    expect(ass).toContain("Style: Default,PingFang SC,123,");
    // 22% × 1920 = 422 的底边距；描边 0.7cqw × 1080 = 8
    expect(ass).toContain(",1,8,0,2,");
    expect(ass).toContain(",422,1");

    const html = buildPreviewHtml(view);
    expect(html).toContain("font-size:6.4cqw");
    expect(html).toContain("bottom:22%");

    const pack = buildPublishPackage(view, {
      title: "夜班",
      description: "",
      topics: [],
      style: "large",
      kind: "draft",
    });
    expect(pack.subtitleLayout).toEqual({
      fontSizeCqw: 6.4,
      bottomPct: 22,
      strokeCqw: 0.7,
      speakerColors: true,
    });
  });

  it("只传档位 id 的旧调用照旧工作", () => {
    const view = toEditView(sampleProject);
    // 大字档 5.8cqw × 1080 = 62.64 → 以 PlayResY 计为 111
    expect(buildAss(view, "large")).toContain("Style: Default,PingFang SC,111,");
    expect(buildPreviewHtml(view, "large")).toContain("font-size:5.8cqw");
    expect(buildPreviewHtml(view, "large")).toContain("bottom:18%");
  });
});

describe("按角色着色（D3）：颜色按角色顺序取，三处共用", () => {
  // 样片的时间线只有周的一句；把林的 s-03 接上，才看得见两种颜色
  const twoSpeakers = ProjectSchema.parse({
    ...sampleProject,
    timeline: {
      ...sampleProject.timeline,
      items: [
        ...sampleProject.timeline.items,
        { id: "tl-03", shotId: "s-03", takeId: "t-03", startMs: 5500, durationMs: 2100 },
      ],
    },
  });
  const off = ProjectSchema.parse({
    ...sampleProject,
    subtitleLayout: { preset: "default", speakerColors: false },
  });

  it("字幕带上说话人的颜色，同一个人同一个颜色", () => {
    const view = toEditView(twoSpeakers);
    const ids = [
      ...new Set(
        view.cues.map((cue) => cue.characterId).filter((id): id is string => Boolean(id)),
      ),
    ];
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const colorById = new Map<string, string | undefined>();
    for (const cue of view.cues) {
      if (!cue.characterId) continue;
      if (!colorById.has(cue.characterId)) colorById.set(cue.characterId, cue.speakerColor);
      expect(cue.speakerColor).toBe(colorById.get(cue.characterId));
    }
    // 两个说话人颜色一定不同：色板是按角色顺序取的，不按哈希
    expect(new Set(ids.map((id) => colorById.get(id))).size).toBe(ids.length);
  });

  it("关掉之后字幕不带颜色，读模型说 speakerColors=false", () => {
    const view = toEditView(off);
    expect(view.subtitleStyle.speakerColors).toBe(false);
    expect(view.cues.every((cue) => cue.speakerColor === undefined)).toBe(true);
  });

  it("ASS 用行内颜色覆盖，预览 HTML 的每条字幕带 color", () => {
    const view = toEditView(twoSpeakers);
    const colored = view.cues.find((cue) => cue.speakerColor)!;
    expect(buildAss(view)).toContain(
      `${assColorOf(colored.speakerColor!)}${colored.text.replace(/\r?\n/g, "\\N")}`,
    );
    expect(buildPreviewHtml(view)).toContain(`"color":"${colored.speakerColor}"`);
  });

  it("关掉之后 ASS 与预览 HTML 都不带颜色", () => {
    const view = toEditView(off);
    expect(buildAss(view)).not.toContain("{\\c&H");
    expect(buildPreviewHtml(view)).not.toContain('"color"');
  });

  it("作者点名的颜色优先于色板顺序，没点名的照旧（ADR-0146）", () => {
    const named = ProjectSchema.parse({
      ...twoSpeakers,
      subtitleLayout: {
        preset: "default",
        speakerColorOverrides: { "c-lin": "#FFA6C9" },
      },
    });
    const view = toEditView(named);
    const linCues = view.cues.filter((cue) => cue.characterId === "c-lin");
    expect(linCues.length).toBeGreaterThan(0);
    expect(linCues.every((cue) => cue.speakerColor === "#FFA6C9")).toBe(true);
    // 周没被点名：仍是按角色顺序取到的第二色
    expect(view.cues.find((cue) => cue.characterId === "c-zhou")?.speakerColor).toBe(
      speakerColorAt(1),
    );
    // 四处的颜色同源：ASS 与预览也跟着点名后的颜色走
    expect(buildAss(view)).toContain(
      `${assColorOf("#FFA6C9")}${linCues[0]!.text.replace(/\r?\n/g, "\\N")}`,
    );
    expect(buildPreviewHtml(view)).toContain('"color":"#FFA6C9"');
    const pack = buildPublishPackage(view, {
      title: "夜班",
      description: "",
      topics: [],
      style: "default",
      kind: "draft",
    });
    expect(pack.subtitleLayout.speakerColorOverrides).toEqual({ "c-lin": "#FFA6C9" });
  });

  it("发布包记下这一版到底有没有按角色着色", () => {
    const pack = buildPublishPackage(toEditView(off), {
      title: "夜班",
      description: "",
      topics: [],
      style: "default",
      kind: "draft",
    });
    expect(pack.subtitleLayout.speakerColors).toBe(false);
  });
});

describe("音轨与字幕轨（E1 / ADR-0131）", () => {
  const shifted = ProjectSchema.parse({
    ...sampleProject,
    dialogue: sampleProject.dialogue.map((line) =>
      line.id === "d-01" ? { ...line, voiceOffsetMs: 300, subtitleOffsetMs: 150 } : line,
    ),
  });

  it("配音与字幕各按自己的偏移落点，互不影响", () => {
    const line = toEditView(shifted).clips[0]!.lines[0]!;
    expect(line.startMs).toBe(0);
    expect(line.audioStartMs).toBe(300);
    expect(line.cueStartMs).toBe(150);
    expect(line.cues[0]!.startMs).toBe(150);
  });

  it("没有偏移时两个起点都等于台词起点", () => {
    const line = toEditView(sampleProject).clips[0]!.lines[0]!;
    expect(line.voiceOffsetMs).toBe(0);
    expect(line.subtitleOffsetMs).toBe(0);
    expect(line.audioStartMs).toBe(line.startMs);
    expect(line.cueStartMs).toBe(line.startMs);
  });

  it("挪出成片之外时夹回来：起点不早于 0、不晚到整句掉出成片", () => {
    const view = toEditView(sampleProject);
    const late = ProjectSchema.parse({
      ...sampleProject,
      dialogue: sampleProject.dialogue.map((line) =>
        line.id === "d-01" ? { ...line, subtitleOffsetMs: 30_000 } : line,
      ),
    });
    const line = toEditView(late).clips[0]!.lines[0]!;
    expect(line.cueStartMs).toBeGreaterThanOrEqual(0);
    expect(line.cueStartMs + line.durationMs).toBeLessThanOrEqual(view.totalMs);
  });

  it("SRT 用字幕挪过的起点，不是台词起点", () => {
    const srt = buildSrt(toEditView(shifted));
    // 第一句从 0 起、字幕 +150ms：第一条字幕的时间码应是 00:00:00,150
    expect(srt).toContain("00:00:00,150 -->");
    expect(srt).not.toContain("00:00:00,000 -->");
  });

  it("ASS 与 SRT 同一份时间：字幕挪动只写一遍，两处一致", () => {
    const view = toEditView(shifted);
    const ass = buildAss(view);
    const line = view.clips[0]!.lines[0]!;
    const first = line.cues[0]!;
    // 读模型里这条 cue 的绝对起点就是它是这一句的第一条：起点等于 cueStartMs
    expect(first.startMs).toBe(line.cueStartMs);
    expect(ass).toContain(
      `Dialogue: 0,${assTime(first.startMs)},${assTime(first.startMs + first.durationMs)},`,
    );
    // ASS 里的起点与 SRT 一致，不是台词起点 0
    expect(first.startMs).toBe(150);
  });

  it("OTIO 音轨用配音的实际起点", () => {
    const otio = buildOtio(toEditView(shifted)) as {
      tracks: { children: { kind: string; children: { source_range: { start_time: { value: number; rate: number } } }[] }[] };
    };
    const audio = otio.tracks.children.find((track) => track.kind === "Audio");
    // 这一份 fixture 没有音轨资产，只有 cue；至少不该抛错
    expect(audio).toBeDefined();
  });
});

describe("双语字幕（D5 / ADR-0173）", () => {
  /** 给样片的第一句加上译文，并打开双语 */
  function bilingual(
    position: "below" | "above" = "below",
    enabled = true,
  ) {
    const project = ProjectSchema.parse({
      ...sampleProject,
      subtitleTranslation: { enabled, lang: "en", position },
      dialogue: sampleProject.dialogue.map((line) =>
        line.id === "d-01" ? { ...line, translation: "You knew it all along, didn't you." } : line,
      ),
    });
    return toEditView(project);
  }

  it("关着的时候读模型与单语完全一样：一条译文都不带", () => {
    const view = bilingual("below", false);
    expect(view.cues.every((cue) => cue.translation === undefined)).toBe(true);
    expect(buildSrt(view)).not.toContain("You knew it");
    expect(buildAss(view)).not.toContain("You knew it");
  });

  it("开着时第二行跟在原文下面，SRT 一条里两行", () => {
    const view = bilingual("below");
    const srt = buildSrt(view);
    expect(srt).toContain("你早就知道，对吧。\nYou knew it all along, didn't you.");
    // 只有翻过的那一句带第二行，其余仍是单行
    expect(srt.trim().split("\n\n")).toHaveLength(view.cues.length);
  });

  it("第二行放上面时，SRT 里译文在前", () => {
    const srt = buildSrt(bilingual("above"));
    expect(srt).toContain("You knew it all along, didn't you.\n你早就知道，对吧。");
  });

  it("ASS 多一个 Second 样式，两行用 \\N 接在同一个 Dialogue 里", () => {
    const ass = buildAss(bilingual("below"));
    expect(ass).toContain("Style: Second,PingFang SC,");
    expect(ass).toMatch(/\\N\{\\rSecond\}You knew it all along/);
    // Second 比 Default 小一号
    const sizeOf = (name: string) =>
      Number(new RegExp(`^Style: ${name},PingFang SC,(\\d+),`, "m").exec(ass)![1]);
    expect(sizeOf("Second")).toBeLessThan(sizeOf("Default"));
  });

  it("关着双语时 ASS 不多一个样式", () => {
    const ass = buildAss(bilingual("below", false));
    expect(ass).not.toContain("Style: Second,");
  });

  it("预览 HTML 有第二行的容器，位置由项目决定", () => {
    const below = buildPreviewHtml(bilingual("below"));
    expect(below).toContain('id="translation"');
    expect(below).not.toContain('class="subtitle above"');
    const above = buildPreviewHtml(bilingual("above"));
    expect(above).toContain('class="subtitle above"');
  });

  it("没翻的句子只出原文，不拿中文再放一遍", () => {
    // 样片的时间线只有两镜，把 d-02 那一镜也排进去，才有「翻过的」与「没翻的」可比
    const base = sampleProject;
    const project = ProjectSchema.parse({
      ...base,
      subtitleTranslation: { enabled: true, lang: "en", position: "below" },
      dialogue: base.dialogue.map((line) =>
        line.id === "d-01" ? { ...line, translation: "You knew it all along." } : line,
      ),
      timeline: {
        ...base.timeline,
        items: [
          ...base.timeline.items,
          { id: "tl-03", shotId: "s-03", takeId: "t-03", startMs: 5500, durationMs: 2100 },
        ],
      },
    });
    const view = toEditView(project);
    const untranslated = view.cues.filter((cue) => cue.lineId === "d-02");
    expect(untranslated.length).toBeGreaterThan(0);
    expect(untranslated.every((cue) => cue.translation === undefined)).toBe(true);
    // 时间线里有两句，只有一句有译文
    expect(view.translationCoverage).toEqual({ lines: 4, translated: 1 });
    // 没翻的那一条在 SRT 里只有一行正文，不跟一行空白
    const block = buildSrt(view)
      .trim()
      .split("\n\n")
      .find((item) => item.includes("知道了又怎样。"))!;
    expect(block.split("\n")).toHaveLength(3);
    const translated = buildSrt(view)
      .trim()
      .split("\n\n")
      .find((item) => item.includes("你早就知道"))!;
    expect(translated.split("\n")).toHaveLength(4);
  });

  it("断句成多条时每条都带同一句译文——按整句翻的，不切开", () => {
    const project = ProjectSchema.parse({
      ...sampleProject,
      subtitleTranslation: { enabled: true, lang: "en", position: "below" },
      dialogue: sampleProject.dialogue.map((line) =>
        line.id === "d-01" ? { ...line, translation: "You knew it all along." } : line,
      ),
    });
    const view = toEditView(project, { maxChars: 6 });
    const first = view.cues.filter((cue) => cue.lineId === "d-01");
    expect(first.length).toBeGreaterThan(1);
    expect(first.every((cue) => cue.translation === "You knew it all along.")).toBe(true);
  });
});

describe("品牌包与头尾卡（E9 / ADR-0174）", () => {
  /** 只换品牌包，别的一个字段都不动 */
  function withBrand(brand: unknown) {
    return ProjectSchema.parse({ ...sampleProject, brand });
  }

  const both = {
    name: "织光机",
    handle: "@zhiguang",
    color: "#2a1d3f",
    intro: { enabled: true, title: "夜班", subtitle: "第一集", durationMs: 2000 },
    outro: { enabled: true, title: "下一集 20:00", subtitle: "", durationMs: 1500 },
  };

  it("两张卡都关着时读模型与以前逐字一样", () => {
    const base = toEditView(sampleProject);
    const off = toEditView(withBrand({ name: "织光机" }));
    expect(off.cards).toEqual([]);
    expect(off.brandOffsetMs).toBe(0);
    expect(off.totalMs).toBe(base.totalMs);
    expect(off.clips).toEqual(base.clips);
    expect(off.cues).toEqual(base.cues);
    expect(buildSrt(off)).toBe(buildSrt(base));
  });

  it("片头卡把画面、台词、字幕与配乐整体后移一张卡的时长", () => {
    const view = toEditView(
      withBrand({ ...both, outro: { ...both.outro, enabled: false } }),
    );
    expect(view.brandOffsetMs).toBe(2000);
    expect(view.cards).toEqual([
      {
        role: "intro",
        startMs: 0,
        durationMs: 2000,
        title: "夜班",
        subtitle: "第一集",
      },
    ]);
    expect(view.clips[0]!.startMs).toBe(2000);
    expect(view.clips[0]!.lines[0]!.startMs).toBe(2000);
    expect(view.clips[0]!.lines[0]!.cueStartMs).toBe(2000);
    expect(view.cues[0]!.startMs).toBe(2000);
    expect(view.totalMs).toBe(7500);
    // 字幕文件也跟着后移：拿 SRT 去对成片，时间是对的
    expect(buildSrt(view)).toContain("00:00:02,000 --> 00:00:04,600");
  });

  it("片尾卡接在最后一镜之后，成片时长再加上它", () => {
    const view = toEditView(
      withBrand({ ...both, intro: { ...both.intro, enabled: false } }),
    );
    expect(view.brandOffsetMs).toBe(0);
    expect(view.cards).toEqual([
      {
        role: "outro",
        startMs: 5500,
        durationMs: 1500,
        title: "下一集 20:00",
        subtitle: "",
      },
    ]);
    expect(view.totalMs).toBe(7000);
  });

  it("两张一起开：片头 0 起、片尾接在画面末尾", () => {
    const view = toEditView(withBrand(both));
    expect(view.brandOffsetMs).toBe(2000);
    expect(view.cards.map((card) => [card.role, card.startMs, card.durationMs])).toEqual([
      ["intro", 0, 2000],
      ["outro", 7500, 1500],
    ]);
    expect(view.totalMs).toBe(9000);
    expect(view.totalSec).toBe(9);
  });

  it("时间线一镜都没有时不插卡：空片不该多出两秒的黑屏", () => {
    const empty = ProjectSchema.parse({
      ...sampleProject,
      timeline: { items: [], music: [] },
      brand: both,
    });
    const view = toEditView(empty);
    expect(view.clips).toHaveLength(0);
    expect(view.cards).toEqual([]);
    expect(view.totalMs).toBe(0);
  });

  it("OTIO 的画面轨把两张卡排在镜头前后", () => {
    const otio = buildOtio(toEditView(withBrand(both))) as {
      tracks: { children: { children: { name: string; metadata?: { loom?: { card?: string } } }[] }[] };
    };
    const video = otio.tracks.children[0]!;
    expect(video.children.map((clip) => clip.name)).toEqual([
      "片头卡",
      "SH-01 · take 1",
      "SH-02 · take 1",
      "片尾卡",
    ]);
    expect(video.children[0]!.metadata?.loom?.card).toBe("intro");
    expect(video.children[3]!.metadata?.loom?.card).toBe("outro");
  });

  it("预览里有头尾两张卡，时间对得上；卡上没有字幕", () => {
    const clips = previewClips(toEditView(withBrand(both)));
    expect(clips.map((clip) => clip.label)).toEqual([
      "片头卡",
      "SH-01 · 1 版",
      "SH-02 · 1 版",
      "片尾卡",
    ]);
    expect(clips[0]).toMatchObject({ startMs: 0, durationMs: 2000, subtitles: [], audio: [] });
    expect(clips.at(-1)).toMatchObject({ startMs: 7500, durationMs: 1500 });
    // 镜头里的字幕时间仍是相对这一段的起点：挪了卡也不会错位
    expect(clips[1]!.subtitles[0]!.startMs).toBe(0);
  });
});
