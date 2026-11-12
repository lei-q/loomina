import { describe, expect, it } from "vitest";
import { ProjectSchema, rebuild, type ProjectEvent, type ProjectInput } from "@loomina/ir";
import {
  actionHistory,
  castTextHistory,
  dialogueHistory,
  dialogueOrderHistory,
  downstreamGap,
  filterKeyframeCells,
  keyframeTally,
  previousActionText,
  previousDialogueText,
  previousSceneHead,
  removedLines,
  sceneHead,
  sceneHeadHistory,
  scriptToText,
  shotLedger,
  spendByStage,
  spendOf,
  staleFrames,
  sheetAssetHistory,
  staleMasters,
  staleSheetCells,
  toCastView,
  toAnimaticView,
  toKeyframeView,
  toScriptView,
  toStageView,
  toVoiceView,
  undoableRemoval,
} from "./read-model";
import { sampleProject } from "./sample-project";

describe("toStageView", () => {
  it("按场次顺序、场内镜序排，镜号从 1 开始", () => {
    const view = toStageView(sampleProject);
    expect(view.shots.map((shot) => shot.id)).toEqual([
      "s-01", "s-02", "s-03", "s-04", "s-05", "s-06",
      "s-07", "s-08", "s-09", "s-10", "s-11", "s-12",
    ]);
    expect(view.shots[0]?.no).toBe(1);
    expect(view.shots[11]?.no).toBe(12);
  });

  it("固定镜头不因 take 状态而丢失", () => {
    const view = toStageView(sampleProject);
    expect(view.shots).toHaveLength(12);
  });

  it("take 状态映射成留用 / 淘汰 / 待定", () => {
    const view = toStageView(sampleProject);
    const stateById = new Map(view.shots.map((shot) => [shot.id, shot.state]));
    expect(stateById.get("s-01")).toBe("reject"); // t-01 rejected
    expect(stateById.get("s-02")).toBe("pick"); // t-02 approved
    expect(stateById.get("s-03")).toBe("open"); // t-03 draft
    expect(stateById.get("s-08")).toBe("pick"); // approved + locked
  });

  it("已花是全部 take 的成本之和（示例资产没有像素也没有价目）", () => {
    const view = toStageView(sampleProject);
    expect(view.spent).toBeCloseTo(18.96, 2);
    expect(view.unpriced).toBe(0);
  });

  it("出图成本加进已花，没有价目的图单独数出来", () => {
    const project = ProjectSchema.parse({
      ...sampleProject,
      assets: sampleProject.assets.map((asset) =>
        asset.id === "a-lin-front"
          ? { ...asset, uri: "data:image/png;base64,AA", costCny: 0.12 }
          : asset.id === "a-lin-34"
            ? { ...asset, uri: "data:image/png;base64,BB" }
            : asset,
      ),
    });

    const view = toStageView(project);
    expect(view.spent).toBeCloseTo(19.08, 2);
    expect(view.unpriced).toBe(1);
    expect(view.spend.assets).toBeCloseTo(0.12, 2);
    expect(view.spend.takes).toBeCloseTo(18.96, 2);
  });

  it("重做报价跟着当前镜头的时长走，不再是一个写死的数", () => {
    const short = toStageView(sampleProject, { currentShotId: "s-03" }); // 2.4s
    const long = toStageView(sampleProject, { currentShotId: "s-09" }); // 3.0s
    expect(short.requote.totalCny).toBeCloseTo(1.32, 2);
    expect(long.requote.totalCny).toBeCloseTo(1.62, 2);
    expect(short.requote.basis).toContain("2.4s");
  });

  it("整片重做一遍：12 镜逐镜相加，不是拿平均时长乘", () => {
    const view = toStageView(sampleProject);
    expect(view.requoteAll.shots).toBe(12);
    expect(view.requoteAll.totalCny).toBeCloseTo(17.74, 2); // 32.6s × 0.5 + 12 × 0.12
    expect(view.requoteAll.basis).toContain("12 镜");
  });

  it("不指定当前镜时，落在第一个还没定的镜头上", () => {
    const view = toStageView(sampleProject);
    expect(view.shots[view.current]?.id).toBe("s-03");
  });

  it("字幕取当前镜的台词，没有台词就是空串", () => {
    const withDialogue = toStageView(sampleProject, { currentShotId: "s-04" });
    expect(withDialogue.subtitle).toBe("灯是我关的。");

    const withoutDialogue = toStageView(sampleProject, { currentShotId: "s-05" });
    expect(withoutDialogue.subtitle).toBe("");
  });

  it("同一镜头多条 take 时取最新的一条", () => {
    const input: ProjectInput = {
      id: "p-1",
      title: "测试",
      version: 1,
      scenes: [{ id: "sc-1", index: 0, locationId: "loc-1", shotIds: ["s-1"] }],
      locations: [{ id: "loc-1", name: "门口", templateId: "doorway" }],
      shots: [
        {
          id: "s-1",
          sceneId: "sc-1",
          index: 0,
          durationMs: 2000,
          shotSize: "close",
          camera: { angle: "eye", movement: "static", focalMm: 50 },
          takeIds: ["t-old", "t-new"],
        },
      ],
      takes: [
        {
          id: "t-old",
          shotId: "s-1",
          assetId: "a-old",
          status: "approved",
          provenance: { modelId: "m", createdAt: "2026-11-09T10:00:00+08:00" },
        },
        {
          id: "t-new",
          shotId: "s-1",
          assetId: "a-new",
          status: "draft",
          provenance: { modelId: "m", createdAt: "2026-11-09T12:00:00+08:00" },
        },
      ],
    };

    const view = toStageView(ProjectSchema.parse(input));
    expect(view.shots[0]?.state).toBe("open"); // 最新一版是 draft
    expect(view.shots[0]?.take).toBe(2);
  });

  it("每拍 take 都读出来，最近一拍有片就是当前视频（ADR-0083）", () => {
    const project = ProjectSchema.parse({
      ...sampleProject,
      assets: [
        ...sampleProject.assets,
        {
          id: "a-02-new",
          kind: "video",
          source: "generated",
          uri: "data:video/mp4;base64,AAAA",
          mime: "video/mp4",
          durationMs: 2400,
          provenance: { modelId: "seedance", createdAt: "2026-11-10T10:00:00+08:00" },
          createdAt: "2026-11-10T10:00:00+08:00",
        },
      ],
      shots: sampleProject.shots.map((shot) =>
        shot.id === "s-02" ? { ...shot, takeIds: [...shot.takeIds, "t-02b"] } : shot,
      ),
      takes: [
        ...sampleProject.takes,
        {
          id: "t-02b",
          shotId: "s-02",
          assetId: "a-02-new",
          status: "draft",
          costCny: 1.2,
          provenance: { modelId: "seedance", createdAt: "2026-11-10T10:00:00+08:00" },
        },
      ],
    });

    const view = toStageView(project);
    const shot = view.shots.find((item) => item.id === "s-02")!;
    // 旧的 t-02 样例资产没有 uri：它在，但不算"有片"
    expect(shot.takes.map((take) => [take.no, take.status, Boolean(take.uri)])).toEqual([
      [1, "approved", false],
      [2, "draft", true],
    ]);
    expect(shot.videoUri).toBe("data:video/mp4;base64,AAAA");
    expect(shot.hasVideo).toBe(true);
    expect(shot.state).toBe("open"); // 最近一拍还是待定

    const frames = toKeyframeView(project);
    expect(frames.videoCount).toBe(1);
    expect(frames.cells.find((cell) => cell.id === "s-02")?.hasVideo).toBe(true);
    expect(frames.cells.find((cell) => cell.id === "s-02")?.dur).toBe(shot.dur);
  });

  it("预演按镜头顺序铺满：时长相加、字幕跟着台词、没画面记缺（ADR-0084）", () => {
    const project = ProjectSchema.parse({
      ...sampleProject,
      assets: [
        ...sampleProject.assets,
        {
          id: "a-kf-s-01",
          kind: "image",
          source: "generated",
          uri: "data:image/svg+xml;utf8,<svg/>",
          createdAt: "2026-11-10T10:00:00+08:00",
        },
        {
          id: "a-kf-s-02-last",
          kind: "image",
          source: "generated",
          uri: "data:image/svg+xml;utf8,<svg/>",
          createdAt: "2026-11-10T10:00:00+08:00",
        },
      ],
      shots: sampleProject.shots.map((shot) => {
        if (shot.id === "s-01") return { ...shot, keyframes: { firstAssetId: "a-kf-s-01" } };
        // 只有尾帧也算有画可看
        if (shot.id === "s-02") return { ...shot, keyframes: { lastAssetId: "a-kf-s-02-last" } };
        return shot;
      }),
    });

    const animatic = toAnimaticView(project);
    expect(animatic.segments).toHaveLength(12);
    expect(animatic.segments[0]).toMatchObject({
      id: "s-01",
      no: 1,
      dur: 3.1,
      hasPicture: true,
      imageUri: "data:image/svg+xml;utf8,<svg/>",
      subtitle: "你早就知道，对吧。",
    });
    expect(animatic.segments[1]?.no).toBe(2);
    expect(animatic.segments[1]?.imageUri).toBe("data:image/svg+xml;utf8,<svg/>");
    expect(animatic.segments[1]?.subtitle).toBe("");
    expect(animatic.missing).toBe(10);
    expect(animatic.withVideo).toBe(0);
    // 12 镜的秒数相加，保留一位小数
    const total = sampleProject.shots.reduce((sum, shot) => sum + shot.durationMs / 1000, 0);
    expect(animatic.totalSec).toBe(Math.round(total * 10) / 10);
  });

  it("台词拼成这一镜的字幕；两句话用空格分开（ADR-0084）", () => {
    const project = ProjectSchema.parse({
      ...sampleProject,
      shots: sampleProject.shots.map((shot) =>
        shot.id === "s-01" ? { ...shot, dialogueIds: ["d-01", "d-03"] } : shot,
      ),
    });
    const animatic = toAnimaticView(project);
    expect(animatic.segments[0]?.subtitle).toBe("你早就知道，对吧。 灯是我关的。");
  });

  it("挂上音轨的镜头带着 clips 进预演，没配的镜头是空的（ADR-0085）", () => {
    const project = ProjectSchema.parse({
      ...sampleProject,
      dialogue: sampleProject.dialogue.map((line) =>
        line.id === "d-01" ? { ...line, audioAssetId: "a-voice-d-01" } : line,
      ),
      assets: [
        ...sampleProject.assets,
        {
          id: "a-voice-d-01",
          kind: "audio",
          source: "upload",
          uri: "data:audio/mpeg;base64,SUQz",
          durationMs: 2600,
          createdAt: "2026-11-11T09:00:00Z",
        },
      ],
    });

    const animatic = toAnimaticView(project);
    expect(animatic.segments[0]?.clips).toEqual([
      { id: "d-01", text: "你早就知道，对吧。", uri: "data:audio/mpeg;base64,SUQz" },
    ]);
    expect(animatic.segments[1]?.clips).toEqual([]);
    expect(animatic.withVoice).toBe(1);
  });

  it("配乐进预演：带 uri 与换算后的音量，没有文件就不出现（E10）", () => {
    const withMusic = ProjectSchema.parse({
      ...sampleProject,
      assets: [
        ...sampleProject.assets,
        {
          id: "a-music-1",
          kind: "audio",
          source: "upload",
          uri: "data:audio/mpeg;base64,TU5VUw==",
          durationMs: 90_000,
          createdAt: "2026-11-11T09:00:00Z",
        },
      ],
      timeline: {
        ...sampleProject.timeline,
        music: [
          {
            id: "mu-1",
            assetId: "a-music-1",
            title: "夜巡",
            mood: "紧张",
            startMs: 0,
            durationMs: 30_000,
            gainDb: -18,
            duckDb: 15,
            ducking: true,
            loop: true,
            licenseRef: "自录",
          },
        ],
      },
    });
    const animatic = toAnimaticView(withMusic);
    expect(animatic.music).toHaveLength(1);
    expect(animatic.music[0]).toMatchObject({
      id: "mu-1",
      title: "夜巡",
      uri: "data:audio/mpeg;base64,TU5VUw==",
      loop: true,
    });
    // -18 dB ≈ 0.126
    expect(animatic.music[0]!.volume).toBeCloseTo(10 ** (-18 / 20), 5);

    // 资产不存在时配乐不出现，但 cue 本身还在 IR 里
    const missingAsset = ProjectSchema.parse({
      ...withMusic,
      assets: sampleProject.assets,
    });
    expect(toAnimaticView(missingAsset).music).toEqual([]);
  });

  it("配音页带出表演参数与试听台版本数（C2 / C9）", () => {
    const project = ProjectSchema.parse({
      ...sampleProject,
      dialogue: sampleProject.dialogue.map((line) =>
        line.id === "d-01"
          ? {
              ...line,
              performance: { rate: 1.3, emotion: "克制", ending: "fall" },
              audioAssetId: "a-voice-d-01-t1",
            }
          : line,
      ),
      voiceTakes: [
        {
          id: "vt-1",
          lineId: "d-01",
          assetId: "a-voice-d-01-t1",
          performance: { rate: 1.3, emotion: "克制", ending: "fall" },
          provenance: { modelId: "tts", referenceAssetIds: [], createdAt: "2026-11-11T09:00:00Z" },
          createdAt: "2026-11-11T09:00:00Z",
        },
        {
          id: "vt-2",
          lineId: "d-01",
          assetId: "a-voice-d-01-t2",
          performance: {},
          provenance: { modelId: "tts", referenceAssetIds: [], createdAt: "2026-11-11T09:01:00Z" },
          createdAt: "2026-11-11T09:01:00Z",
        },
      ],
      assets: [
        ...sampleProject.assets,
        {
          id: "a-voice-d-01-t1",
          kind: "audio",
          source: "generated",
          uri: "data:audio/mpeg;base64,SUQz",
          createdAt: "2026-11-11T09:00:00Z",
        },
        {
          id: "a-voice-d-01-t2",
          kind: "audio",
          source: "generated",
          uri: "data:audio/mpeg;base64,SUQz",
          createdAt: "2026-11-11T09:01:00Z",
        },
      ],
    });
    const view = toVoiceView(project);
    const first = view.lines.find((line) => line.id === "d-01")!;
    expect(first.performance).toMatchObject({ rate: 1.3, emotion: "克制" });
    expect(first.takes).toBe(2);
    expect(first.adoptedTakeId).toBe("vt-1");
    expect(view.lines.find((line) => line.id === "d-02")!.takes).toBe(0);
    expect(view.lines.find((line) => line.id === "d-02")!.performance).toBeUndefined();
    expect(view.takes).toBe(2);
  });

  it("配音页按镜头顺序铺开台词，角色与已配时长对得上（ADR-0085）", () => {
    const project = ProjectSchema.parse({
      ...sampleProject,
      dialogue: sampleProject.dialogue.map((line) =>
        line.id === "d-02" ? { ...line, audioAssetId: "a-voice-d-02" } : line,
      ),
      assets: [
        ...sampleProject.assets,
        {
          id: "a-voice-d-02",
          kind: "audio",
          source: "generated",
          uri: "data:audio/mpeg;base64,SUQz",
          durationMs: 1900,
          createdAt: "2026-11-11T09:00:00Z",
        },
      ],
    });

    const view = toVoiceView(project);
    expect(view.lines.map((line) => line.id)).toEqual(["d-01", "d-02", "d-03", "d-04"]);
    expect(view.lines[0]).toMatchObject({
      no: 1,
      sceneNo: 1,
      characterName: "周",
      dur: 2.6,
      state: "missing",
    });
    expect(view.lines[1]).toMatchObject({
      no: 3,
      characterName: "林",
      dur: 2.1,
      audioDur: 1.9,
      state: "voiced",
    });
    expect(view.total).toBe(4);
    expect(view.voiced).toBe(1);
    // 已配时长按音轨量出来的算，没配的只数不进 voicedSec
    expect(view.totalSec).toBeCloseTo(8.8, 1);
    expect(view.voicedSec).toBeCloseTo(1.9, 1);

    const lin = view.roles.find((role) => role.id === "c-lin");
    expect(lin).toMatchObject({ voice: "voice-lin", lines: 2, voiced: 1 });
    const zhou = view.roles.find((role) => role.id === "c-zhou");
    expect(zhou).toMatchObject({ lines: 2, voiced: 0 });
  });

  it("定妆台：两个角色四格齐全，三个场景各一主镜，两个道具各一张参考", () => {
    const cast = toCastView(sampleProject);
    expect(cast.characters).toHaveLength(2);
    expect(cast.locations).toHaveLength(3);
    expect(cast.props).toHaveLength(2);
    expect(cast.totalRequired).toBe(7);
    expect(cast.lockedCount).toBe(0);
    expect(cast.complete).toBe(false);

    const lin = cast.characters.find((item) => item.id === "c-lin")!;
    expect(lin.panels.map((panel) => panel.label)).toEqual([
      "正面", "3/4", "侧面", "背面",
    ]);
    expect(lin.panels.every((panel) => panel.assetId)).toBe(true);
    expect(lin.status).toBe("ready");
    expect(lin.required).toBe(true);
    expect(cast.locations.every((item) => item.masterAssetId)).toBe(true);
    // 模板带进读模型：改名表单要回填它（ADR-0059）
    expect(cast.locations.find((item) => item.id === "loc-corridor")?.templateId).toBe("corridor");
    // 示例项目没有场景描述：读模型给空串，不塞占位文案（ADR-0063）
    expect(cast.locations.find((item) => item.id === "loc-corridor")?.description).toBe("");

    const cup = cast.props.find((item) => item.id === "p-cup")!;
    expect(cup.art).toBe("cup");
    expect(cup.required).toBe(true);
    expect(cup.referenceAssetId).toBe("a-cup");
  });

  it("每个镜头带出参考锚点：人物按景别取格，再加场景主镜", () => {
    const view = toStageView(sampleProject);
    const close = view.shots.find((shot) => shot.id === "s-03")!;
    expect(close.anchors.missing).toEqual([]);
    expect(close.anchors.labels).toEqual(["林 · 正面", "林 · 3/4", "走廊 · 主镜"]);

    const two = view.shots.find((shot) => shot.id === "s-04")!;
    expect(two.anchors.labels).toEqual(["林 · 正面", "周 · 正面", "桌边 · 主镜"]);

    const propShot = view.shots.find((shot) => shot.id === "s-09")!;
    expect(propShot.anchors.labels).toEqual(["桌边 · 主镜", "搪瓷杯 · 参考图"]);
  });

  it("两个及以上角色用双人剪影，否则按场景模板", () => {
    const view = toStageView(sampleProject);
    const artById = new Map(view.shots.map((shot) => [shot.id, shot.art]));
    expect(artById.get("s-04")).toBe("two"); // 林 + 周
    expect(artById.get("s-06")).toBe("corridor"); // 走廊
    expect(artById.get("s-09")).toBe("table");
  });
});

describe("预算来自项目（ADR-0035）", () => {
  it("budget 取项目自己的上限，不再是写死的 60", () => {
    const view = toStageView({ ...sampleProject, budgetCny: 120 });
    expect(view.budget).toBe(120);
  });
});

describe("已花的构成（ADR-0036）", () => {
  it("淘汰掉的 take 的钱单独算出来，不藏在总数里", () => {
    const view = toStageView(sampleProject);
    const rejected = sampleProject.takes
      .filter((take) => take.status === "rejected")
      .reduce((sum, take) => sum + take.costCny, 0);

    expect(view.spend.rejected).toBeCloseTo(rejected, 2);
    expect(view.spend.rejected).toBeLessThanOrEqual(view.spend.spent);
  });

  it("没有淘汰时是 0，不是缺省 undefined", () => {
    const cleared = {
      ...sampleProject,
      takes: sampleProject.takes.map((take) => ({ ...take, status: "approved" as const })),
    };
    expect(toStageView(cleared).spend.rejected).toBe(0);
  });
});

describe("首帧进读模型（ADR-0037）", () => {
  it("shot.keyframes 指向有图资产时，当前镜有 keyframeUri", () => {
    const project = {
      ...sampleProject,
      shots: sampleProject.shots.map((shot) =>
        shot.id === "s-03"
          ? { ...shot, keyframes: { firstAssetId: "a-key-03" } }
          : shot,
      ),
      assets: [
        ...sampleProject.assets,
        {
          id: "a-key-03",
          kind: "image" as const,
          source: "generated" as const,
          uri: "data:image/png;base64,RkFLRQ==",
          createdAt: "2026-11-10T00:00:00+08:00",
        },
      ],
    };
    const view = toStageView(project, { currentShotId: "s-03" });

    expect(view.shots[view.current]?.keyframeUri).toContain("RkFLRQ");
    expect(view.shots[view.current]?.hasKeyframe).toBe(true);
  });

  it("没有首帧时 hasKeyframe 是 false，不是缺省 undefined", () => {
    const view = toStageView(sampleProject, { currentShotId: "s-03" });
    expect(view.shots[view.current]?.hasKeyframe).toBe(false);
  });

  it("尾帧（ADR-0038）：lastAssetId 指向有图资产时给 lastKeyframeUri，两帧互不影响", () => {
    const project = {
      ...sampleProject,
      shots: sampleProject.shots.map((shot) =>
        shot.id === "s-03"
          ? { ...shot, keyframes: { firstAssetId: "a-key-03", lastAssetId: "a-last-03" } }
          : shot,
      ),
      assets: [
        ...sampleProject.assets,
        {
          id: "a-key-03",
          kind: "image" as const,
          source: "generated" as const,
          uri: "data:image/png;base64,RkFLRQ==",
          createdAt: "2026-11-10T00:00:00+08:00",
        },
        {
          id: "a-last-03",
          kind: "image" as const,
          source: "generated" as const,
          uri: "data:image/png;base64,TEFTVEY=",
          createdAt: "2026-11-10T00:00:00+08:00",
        },
      ],
    };
    const view = toStageView(project, { currentShotId: "s-03" });
    const shot = view.shots[view.current];

    expect(shot?.hasKeyframe).toBe(true);
    expect(shot?.hasLastFrame).toBe(true);
    expect(shot?.lastKeyframeUri).toContain("TEFTVEY");
    expect(shot?.keyframeUri).toContain("RkFLRQ");
  });
});

describe("一句话指令进读模型（ADR-0039）", () => {
  it("景别与机位是中文，补充要求原样带上", () => {
    const project = {
      ...sampleProject,
      shots: sampleProject.shots.map((shot) =>
        shot.id === "s-03"
          ? {
              ...shot,
              shotSize: "close" as const,
              camera: { ...shot.camera, angle: "low" as const },
              promptNotes: ["整体提亮，补足曝光，阴影保留细节"],
            }
          : shot,
      ),
    };
    const view = toStageView(project, { currentShotId: "s-03" });
    const shot = view.shots[view.current];

    expect(shot?.size).toBe("特写");
    expect(shot?.angle).toBe("仰拍");
    expect(shot?.notes).toEqual(["整体提亮，补足曝光，阴影保留细节"]);
  });

  it("首尾两帧的提示词都在读模型里，带补充、带机位、互不相同（ADR-0040）", () => {
    const project = {
      ...sampleProject,
      shots: sampleProject.shots.map((shot) =>
        shot.id === "s-03"
          ? { ...shot, promptNotes: ["整体提亮，补足曝光，阴影保留细节"] }
          : shot,
      ),
    };
    const shot = toStageView(project, { currentShotId: "s-03" }).shots.find(
      (item) => item.id === "s-03",
    )!;

    expect(shot.prompts.first).toContain("补充：整体提亮，补足曝光，阴影保留细节");
    expect(shot.prompts.first).toContain("mm");
    expect(shot.prompts.first).toContain("动作起势");
    expect(shot.prompts.last).toContain("动作收势");
    expect(shot.prompts.first).not.toBe(shot.prompts.last);
  });
});

describe("关键帧页读模型（ADR-0042）", () => {
  it("一格一镜，数出首尾帧覆盖，关键帧的钱单独算", () => {
    const project = {
      ...sampleProject,
      shots: sampleProject.shots.map((shot) =>
        shot.id === "s-03"
          ? { ...shot, keyframes: { firstAssetId: "a-keyframe-s-03", lastAssetId: "a-lastframe-s-03" } }
          : shot,
      ),
      assets: [
        ...sampleProject.assets,
        {
          id: "a-keyframe-s-03",
          kind: "image" as const,
          source: "generated" as const,
          uri: "data:image/png;base64,RkFLRQ==",
          costCny: 0.12,
          createdAt: "2026-11-10T00:00:00+08:00",
        },
        {
          id: "a-lastframe-s-03",
          kind: "image" as const,
          source: "generated" as const,
          uri: "data:image/png;base64,TEFTVEY=",
          costCny: 0.12,
          createdAt: "2026-11-10T00:00:00+08:00",
        },
      ],
    };
    const view = toKeyframeView(project);

    expect(view.cells).toHaveLength(12);
    expect(view.firstCount).toBe(1);
    expect(view.lastCount).toBe(1);
    expect(view.keyframeSpend).toBe(0.24);
    expect(view.keyframeUnpriced).toBe(0);
    const cell = view.cells.find((item) => item.id === "s-03")!;
    expect(cell.firstUri).toContain("RkFLRQ");
    expect(cell.lastUri).toContain("TEFTVEY");
    expect(cell.size.length).toBeGreaterThan(0);
    expect(cell.art).toBeTruthy();
  });

  it("没价目的关键帧单独计数，不算成 0", () => {
    const project = {
      ...sampleProject,
      assets: [
        ...sampleProject.assets,
        {
          id: "a-keyframe-s-04",
          kind: "image" as const,
          source: "generated" as const,
          uri: "data:image/png;base64,RkFLRQ==",
          createdAt: "2026-11-10T00:00:00+08:00",
        },
      ],
    };
    const view = toKeyframeView(project);

    expect(view.keyframeSpend).toBe(0);
    expect(view.keyframeUnpriced).toBe(1);
  });

  it("筛子按缺哪一帧分，计数与格子一致", () => {
    const cells = toKeyframeView(sampleProject).cells;
    // 示例项目里没有生成的帧，十二镜都缺
    expect(keyframeTally(cells)).toEqual({
      all: 12,
      "missing-first": 12,
      "missing-last": 12,
      complete: 0,
    });
    expect(filterKeyframeCells(cells, "complete")).toHaveLength(0);
    expect(filterKeyframeCells(cells, "missing-first")).toHaveLength(12);
  });
});

describe("剧本页读模型（只读）", () => {
  it("按场次与场内镜序摊平，台词带说话人", () => {
    const view = toScriptView(sampleProject);

    expect(view.scenes).toHaveLength(5);
    expect(view.shotCount).toBe(12);
    expect(view.scenes[0]!.place).toBe("走廊");
    expect(view.scenes[0]!.shots.map((shot) => shot.id)).toEqual(["s-01", "s-02", "s-03"]);
    expect(view.scenes[1]!.shots.map((shot) => shot.id)).toEqual(["s-04", "s-05"]);

    const line = view.scenes[0]!.shots[0]!.lines[0]!;
    expect(line.character).toBe("周");
    expect(line.characterId).toBe("c-zhou");
    expect(line.text).toContain("你早就知道");
    expect(line.dur).toBeGreaterThan(0);
    expect(view.dialogueCount).toBe(4);
    expect(view.totalDur).toBeGreaterThan(30);
  });

  it("没有台词的镜头不编台词，镜号用整片顺序", () => {
    const view = toScriptView(sampleProject);
    const s05 = view.scenes[1]!.shots.find((shot) => shot.id === "s-05")!;

    expect(s05.lines).toEqual([]);
    // s-05 是第二场的第一镜，整片是第五镜
    expect(s05.no).toBe(5);
  });
});

describe("显式场号进剧本页（ADR-0080）", () => {
  const coded = {
    ...sampleProject,
    scenes: sampleProject.scenes.map((scene) =>
      scene.id === "sc-2" ? { ...scene, code: "2A" } : scene,
    ),
  };

  it("有场号写场号，没有按顺序编号；顺序号不变", () => {
    const view = toScriptView(coded);
    expect(view.scenes.map((scene) => scene.label)).toEqual(["1", "2A", "3", "4", "5"]);
    expect(view.scenes.map((scene) => scene.no)).toEqual([1, 2, 3, 4, 5]);
    expect(view.scenes[1]?.code).toBe("2A");
  });

  it("导出跟着换：第 2A 场，后面没有第 2 场", () => {
    const text = scriptToText(toScriptView(coded));
    expect(text).toContain("第 2A 场");
    expect(text).toContain("第 3 场");
    expect(text).not.toContain("第 2 场");
  });
});

describe("台词版本（ADR-0044 附记）", () => {
  const at = (h: number) => `2026-11-10T${String(h).padStart(2, "0")}:00:00+08:00`;
  const events = [
    { type: "project.created" as const, at: at(0), project: sampleProject },
    { type: "dialogue.updated" as const, at: at(9), lineId: "d-01", patch: { text: "你早就知道了。", durationMs: 2100 } },
    { type: "dialogue.updated" as const, at: at(10), lineId: "d-01", patch: { text: "你早就知道了吧。", durationMs: 2400 } },
    { type: "dialogue.updated" as const, at: at(11), lineId: "d-02", patch: { text: "知道了又怎样呢。", durationMs: 2400 } },
  ];

  it("最初一版从引导事件取，改写按先后排好", () => {
    const history = dialogueHistory(events, "d-01");
    expect(history.original?.text).toBe("你早就知道，对吧。");
    expect(history.original?.dur).toBe(2.6);
    expect(history.edits.map((edit) => edit.text)).toEqual([
      "你早就知道了。",
      "你早就知道了吧。",
    ]);
    expect(history.edits[0]?.dur).toBe(2.1);
  });

  it("上一版：改过一次是最初那版，改过多次是倒数第二版", () => {
    expect(previousDialogueText(dialogueHistory(events.slice(0, 2), "d-01"))).toBe(
      "你早就知道，对吧。",
    );
    expect(previousDialogueText(dialogueHistory(events, "d-01"))).toBe("你早就知道了。");
  });

  it("没改过的台词没有版本，别人的改写不算进来", () => {
    const untouched = dialogueHistory(events, "d-03");
    expect(untouched.original?.text).toBe("灯是我关的。");
    expect(untouched.edits).toEqual([]);
    expect(previousDialogueText(untouched)).toBeUndefined();
    expect(dialogueHistory(events, "d-01").edits).toHaveLength(2);
  });
});

describe("剧本页的说话人与选角（ADR-0045）", () => {
  it("带出说话人候选，以及每镜里有谁", () => {
    const view = toScriptView(sampleProject);
    expect(view.characters.map((item) => item.name)).toEqual(["林", "周"]);

    const s04 = view.scenes[1]!.shots.find((shot) => shot.id === "s-04")!;
    expect(s04.characterIds).toEqual(["c-lin", "c-zhou"]);
    expect(s04.locked).toBe(false);
    const s08 = view.scenes.flatMap((scene) => scene.shots).find((shot) => shot.id === "s-08")!;
    expect(s08.locked).toBe(true);
  });
});

describe("剧本导出（ADR-0048）", () => {
  it("标题、页头四个数、场头、镜号、台词与技术行都在", () => {
    const text = scriptToText(toScriptView(sampleProject));

    expect(text).toContain("夜班 v3");
    expect(text).toContain("5 场 · 12 镜 · 4 句台词 · 32.6s");
    expect(text).toContain("第 1 场 · 内 · 夜 · 走廊（7.9s · 3 镜）");
    expect(text).toContain("SH-01 · 全景 · 平视 · 3.1s");
    expect(text).toContain("周：你早就知道，对吧。");
    // 十二镜、四处台词都在，行数不是三两行
    expect(text.trimEnd().split("\n").length).toBeGreaterThan(20);
    expect(text.match(/SH-\d\d/g)).toHaveLength(12);
  });

  it("场头带内 / 外景与日夜，第四场在门外", () => {
    const view = toScriptView(sampleProject);
    expect(view.scenes.map(sceneHead)).toEqual(["内 · 夜", "内 · 夜", "内 · 夜", "外 · 夜", "内 · 夜"]);
  });
});

describe("动作版本（ADR-0051）", () => {
  const at = (h: number) => `2026-11-10T${String(h).padStart(2, "0")}:00:00+08:00`;
  const events = [
    { type: "project.created" as const, at: at(0), project: sampleProject },
    { type: "shot.updated" as const, at: at(9), shotId: "s-01", patch: { description: "走廊尽头，灯管闪了两下。" } },
    { type: "shot.updated" as const, at: at(10), shotId: "s-01", patch: { description: "走廊尽头，灯管彻底灭了。" } },
    { type: "shot.updated" as const, at: at(11), shotId: "s-02", patch: { description: "门缝里透出一条光。" } },
    { type: "shot.updated" as const, at: at(12), shotId: "s-01", patch: { locked: true } },
  ];

  it("最初一版从引导事件取，只收带 description 的改写", () => {
    const history = actionHistory(events, "s-01");
    expect(history.original).toBe("走廊尽头，灯管闪了一下");
    expect(history.edits.map((edit) => edit.text)).toEqual([
      "走廊尽头，灯管闪了两下。",
      "走廊尽头，灯管彻底灭了。",
    ]);
  });

  it("上一版：改过一次是最初那版，改过多次是倒数第二版", () => {
    expect(previousActionText(actionHistory(events.slice(0, 2), "s-01"))).toBe(
      "走廊尽头，灯管闪了一下",
    );
    expect(previousActionText(actionHistory(events, "s-01"))).toBe("走廊尽头，灯管闪了两下。");
  });

  it("没改过的镜头没有版本，别的镜头与锁定事件都不算进来", () => {
    const untouched = actionHistory(events, "s-03");
    expect(untouched.original).toBe("她站在门口，没有进来");
    expect(untouched.edits).toEqual([]);
    expect(previousActionText(untouched)).toBeUndefined();
    expect(actionHistory(events, "s-01").edits).toHaveLength(2);
  });
});

describe("场头版本（ADR-0058）", () => {
  const at = (h: number) => `2026-11-10T${String(h).padStart(2, "0")}:00:00+08:00`;
  const events = [
    { type: "project.created" as const, at: at(0), project: sampleProject },
    { type: "scene.updated" as const, at: at(9), sceneId: "sc-1", patch: { timeOfDay: "day" as const } },
    { type: "scene.updated" as const, at: at(10), sceneId: "sc-1", patch: { locationId: "loc-table" } },
    { type: "scene.updated" as const, at: at(11), sceneId: "sc-2", patch: { space: "ext" as const } },
    { type: "shot.updated" as const, at: at(12), shotId: "s-01", patch: { description: "灯灭了" } },
  ];

  it("最初一版从引导事件取；每条改动叠成完整的场头", () => {
    const history = sceneHeadHistory(events, "sc-1");
    expect(history.original).toEqual({ space: "int", timeOfDay: "night", locationId: "loc-corridor" });
    expect(history.edits).toEqual([
      { at: at(9), head: { space: "int", timeOfDay: "day", locationId: "loc-corridor" } },
      { at: at(10), head: { space: "int", timeOfDay: "day", locationId: "loc-table" } },
    ]);
  });

  it("上一版：改过一次是最初那版，改过多次是倒数第二版", () => {
    expect(previousSceneHead(sceneHeadHistory(events.slice(0, 2), "sc-1"))).toEqual({
      space: "int",
      timeOfDay: "night",
      locationId: "loc-corridor",
    });
    expect(previousSceneHead(sceneHeadHistory(events, "sc-1"))).toEqual({
      space: "int",
      timeOfDay: "day",
      locationId: "loc-corridor",
    });
  });

  it("没改过的场没有版本；别的场与镜头事件都不算进来", () => {
    const untouched = sceneHeadHistory(events, "sc-3");
    expect(untouched.original).toEqual({
      space: "int",
      timeOfDay: "night",
      locationId: "loc-corridor",
    });
    expect(untouched.edits).toEqual([]);
    expect(previousSceneHead(untouched)).toBeUndefined();
    expect(sceneHeadHistory(events, "sc-2").edits).toHaveLength(1);
  });
});

describe("台词历史里的换人（ADR-0052）", () => {
  const at = (h: number) => `2026-11-10T${String(h).padStart(2, "0")}:00:00+08:00`;
  const events = [
    { type: "project.created" as const, at: at(0), project: sampleProject },
    { type: "dialogue.speaker.updated" as const, at: at(12), lineId: "d-01", characterId: "c-lin" },
    { type: "dialogue.speaker.updated" as const, at: at(13), lineId: "d-01", characterId: "c-zhou" },
    { type: "dialogue.speaker.updated" as const, at: at(14), lineId: "d-02", characterId: "c-zhou" },
  ];

  it("从最初那位开始，一条换人接着一条记，文本版本不受影响", () => {
    const history = dialogueHistory(events, "d-01");
    expect(history.original?.characterId).toBe("c-zhou");
    expect(history.speakers.map((rev) => [rev.from, rev.to])).toEqual([
      ["c-zhou", "c-lin"],
      ["c-lin", "c-zhou"],
    ]);
    expect(history.edits).toEqual([]);
  });

  it("别的台词的换人不算进来", () => {
    expect(dialogueHistory(events, "d-02").speakers).toHaveLength(1);
    expect(dialogueHistory(events, "d-03").speakers).toEqual([]);
    expect(dialogueHistory(events.slice(0, 2), "d-01").speakers).toHaveLength(1);
  });
});

describe("台词顺序的变更记录（ADR-0053）", () => {
  const at = (h: number) => `2026-11-10T${String(h).padStart(2, "0")}:00:00+08:00`;
  // 示例里 s-02 没有台词；给这一镜先挂上两句，排序才有可排的东西。
  const project = {
    ...sampleProject,
    shots: sampleProject.shots.map((shot) =>
      shot.id === "s-02" ? { ...shot, dialogueIds: ["d-01", "d-03"] } : shot,
    ),
  };
  const events = [
    { type: "project.created" as const, at: at(0), project },
    { type: "shot.updated" as const, at: at(9), shotId: "s-02", patch: { dialogueIds: ["d-03", "d-01"] } },
    { type: "shot.updated" as const, at: at(10), shotId: "s-02", patch: { dialogueIds: ["d-01", "d-03"] } },
    { type: "shot.updated" as const, at: at(11), shotId: "s-02", patch: { description: "换了动作" } },
    { type: "shot.updated" as const, at: at(12), shotId: "s-03", patch: { dialogueIds: ["d-02"] } },
  ];

  it("只收显式换了 dialogueIds 的镜头改写，按先后排", () => {
    const revisions = dialogueOrderHistory(events, "s-02");
    expect(revisions.map((rev) => rev.lineIds)).toEqual([
      ["d-03", "d-01"],
      ["d-01", "d-03"],
    ]);
    expect(revisions[0]?.at).toBe(at(9));
  });

  it("别的镜头、改动作的 shot.updated 都不算", () => {
    expect(dialogueOrderHistory(events, "s-03")).toHaveLength(1);
    expect(dialogueOrderHistory(events, "s-04")).toEqual([]);
    expect(dialogueOrderHistory(events.slice(0, 1), "s-02")).toEqual([]);
  });

  it("跨镜头挪台词改了句子集合，不算一次「换顺序」", () => {
    const moved = [
      ...events,
      { type: "shot.updated" as const, at: at(13), shotId: "s-02", patch: { dialogueIds: ["d-01", "d-03", "d-04"] } },
      { type: "shot.updated" as const, at: at(13), shotId: "s-03", patch: { dialogueIds: [] } },
      { type: "shot.updated" as const, at: at(14), shotId: "s-02", patch: { dialogueIds: ["d-04", "d-03", "d-01"] } },
    ];
    // SH-02：两条真排序 + 挪进来那条不算；挪完再排序仍算。
    expect(dialogueOrderHistory(moved, "s-02").map((rev) => rev.lineIds)).toEqual([
      ["d-03", "d-01"],
      ["d-01", "d-03"],
      ["d-04", "d-03", "d-01"],
    ]);
    // SH-03：原本一条排序；挪走清空台词不算。
    expect(dialogueOrderHistory(moved, "s-03")).toHaveLength(1);
  });
});

describe("被删的台词（ADR-0055）", () => {
  const at = (h: number) => `2026-11-10T${String(h).padStart(2, "0")}:00:00+08:00`;
  const line = {
    id: "d-01",
    characterId: "c-zhou",
    text: "你早就知道，对吧。",
    durationMs: 2600,
    voiceOffsetMs: 0,
    subtitleOffsetMs: 0,
  };
  const events = [
    { type: "project.created" as const, at: at(0), project: sampleProject },
    { type: "dialogue.removed" as const, at: at(9), lineId: "d-01" },
    {
      type: "dialogue.added" as const,
      at: at(10),
      shotId: "s-05",
      line: { ...line, id: "d-new", text: "新加的" },
    },
    { type: "shot.updated" as const, at: at(11), shotId: "s-06", patch: { dialogueIds: ["d-new"] } },
    { type: "dialogue.removed" as const, at: at(12), lineId: "d-new" },
  ];

  it("删掉的台词带当时的正文、说话人、时长与所属镜头", () => {
    expect(removedLines(events)).toEqual([
      { at: at(9), lineId: "d-01", shotId: "s-01", text: "你早就知道，对吧。", characterId: "c-zhou", durationMs: 2600 },
      { at: at(12), lineId: "d-new", shotId: "s-06", text: "新加的", characterId: "c-zhou", durationMs: 2600 },
    ]);
  });

  it("按镜头筛：删掉之前挪到哪一镜，就记到哪一镜", () => {
    expect(removedLines(events, "s-01").map((rec) => rec.lineId)).toEqual(["d-01"]);
    expect(removedLines(events, "s-05")).toEqual([]);
    expect(removedLines(events, "s-06").map((rec) => rec.lineId)).toEqual(["d-new"]);
  });

  it("恢复过的句子删第二次，会有两条记录", () => {
    const twice = [
      ...events,
      { type: "dialogue.added" as const, at: at(13), shotId: "s-01", line },
      { type: "dialogue.removed" as const, at: at(14), lineId: "d-01" },
    ];
    expect(removedLines(twice, "s-01").map((rec) => rec.at)).toEqual([at(9), at(14)]);
  });
});

describe("出图后改了画面：帧过期（ADR-0057）", () => {
  const at = (h: number) => `2026-11-10T${String(h).padStart(2, "0")}:00:00+08:00`;
  const frameAt = "2026-11-09T21:00:00+08:00";
  const withFrames = ProjectSchema.parse({
    ...sampleProject,
    assets: [
      ...sampleProject.assets,
      { id: "a-keyframe-s-01", kind: "image", source: "generated", createdAt: frameAt },
      { id: "a-keyframe-s-02", kind: "image", source: "generated", createdAt: frameAt },
    ],
    shots: sampleProject.shots.map((shot) =>
      shot.id === "s-01"
        ? { ...shot, keyframes: { firstAssetId: "a-keyframe-s-01" } }
        : shot.id === "s-02"
          ? { ...shot, keyframes: { firstAssetId: "a-keyframe-s-02" } }
          : shot,
    ),
  });
  const base = [{ type: "project.created" as const, at: at(0), project: withFrames }];

  it("改过动作：首帧过期；没改过的镜头不算", () => {
    const events = [
      ...base,
      { type: "shot.updated" as const, at: at(9), shotId: "s-01", patch: { description: "灯灭了" } },
    ];
    const stale = staleFrames(events, withFrames);
    expect(stale.get("s-01")).toEqual({ first: { at: at(9), reasons: ["动作"] } });
    expect(stale.has("s-02")).toBe(false);
  });

  it("场头改了：这一场有帧的镜头都过期", () => {
    const events = [
      ...base,
      { type: "scene.updated" as const, at: at(10), sceneId: "sc-1", patch: { timeOfDay: "day" as const } },
    ];
    const stale = staleFrames(events, withFrames);
    expect(stale.get("s-01")?.first).toEqual({ at: at(10), reasons: ["场头"] });
    expect(stale.get("s-02")?.first).toEqual({ at: at(10), reasons: ["场头"] });
  });

  it("改过好几处：原因去重，时刻取最后一次", () => {
    const events = [
      ...base,
      { type: "shot.updated" as const, at: at(9), shotId: "s-01", patch: { description: "灯灭了" } },
      { type: "shot.updated" as const, at: at(12), shotId: "s-01", patch: { shotSize: "close" as const } },
      { type: "shot.updated" as const, at: at(13), shotId: "s-01", patch: { description: "又亮了" } },
    ];
    expect(staleFrames(events, withFrames).get("s-01")).toEqual({
      first: { at: at(13), reasons: ["动作", "景别"] },
    });
  });

  it("换人：这一镜的帧过期，原因是人物；剧本页也标出有帧（ADR-0081）", () => {
    const events = [
      ...base,
      {
        type: "shot.updated" as const,
        at: at(9),
        shotId: "s-01",
        patch: { characterIds: ["c-lin", "c-zhou"] },
      },
    ];
    expect(staleFrames(events, withFrames).get("s-01")).toEqual({
      first: { at: at(9), reasons: ["人物"] },
    });

    const script = toScriptView(withFrames);
    const shots = script.scenes.flatMap((scene) => scene.shots);
    expect(shots.find((shot) => shot.id === "s-01")?.hasFrames).toBe(true);
    expect(shots.find((shot) => shot.id === "s-03")?.hasFrames).toBe(false);
  });

  it("只改台词、或者帧是在改动之后出的，都不算过期", () => {
    const dialogueOnly = [
      ...base,
      { type: "dialogue.updated" as const, at: at(9), lineId: "d-01", patch: { text: "换个说法" } },
    ];
    expect(staleFrames(dialogueOnly, withFrames).size).toBe(0);

    const edited: ProjectEvent[] = [
      ...base,
      { type: "shot.updated", at: at(9), shotId: "s-01", patch: { description: "灯灭了" } },
      {
        type: "asset.updated",
        at: at(11),
        asset: { id: "a-keyframe-s-01", kind: "image", source: "generated", createdAt: at(11) },
      },
    ];
    // 重生成之后，资产的时间晚于改动：不再过期
    expect(staleFrames(edited, rebuild(edited)).has("s-01")).toBe(false);
  });

  it("剧本页与关键帧页连起来：toKeyframeView 把过期写进格子", () => {
    const events = [
      ...base,
      { type: "shot.updated" as const, at: at(9), shotId: "s-01", patch: { description: "灯灭了" } },
    ];
    const view = toKeyframeView(withFrames, { events });
    expect(view.cells.find((cell) => cell.id === "s-01")?.staleFirst).toEqual({
      at: at(9),
      reasons: ["动作"],
    });
    expect(view.cells.find((cell) => cell.id === "s-02")?.staleFirst).toBeUndefined();

    // 分镜页的 StageShot 也带同样的标记
    const stage = toStageView(withFrames, { events });
    expect(stage.shots.find((shot) => shot.id === "s-01")?.staleFirst).toEqual({
      at: at(9),
      reasons: ["动作"],
    });
    expect(stage.shots.find((shot) => shot.id === "s-02")?.staleFirst).toBeUndefined();
    // 不给日志就不算
    expect(toStageView(withFrames).shots.find((shot) => shot.id === "s-01")?.staleFirst).toBeUndefined();
  });
});

describe("改过场景描述：主镜过期（ADR-0075）", () => {
  const at = (h: number) => `2026-11-10T${String(h).padStart(2, "0")}:00:00+08:00`;
  const masterAt = "2026-11-09T21:00:00+08:00";
  const withMaster = ProjectSchema.parse({
    ...sampleProject,
    assets: [
      ...sampleProject.assets,
      { id: "a-corridor", kind: "image", source: "generated", createdAt: masterAt },
      { id: "a-door", kind: "image", source: "generated", createdAt: masterAt },
    ],
    locations: sampleProject.locations.map((location, index) =>
      index < 2 ? { ...location, masterShotId: `a-${["corridor", "door"][index]}` } : location,
    ),
  });
  const base = [{ type: "project.created" as const, at: at(0), project: withMaster }];

  it("改了描述：只标这一张主镜过期", () => {
    const events = [
      ...base,
      {
        type: "location.updated" as const,
        at: at(9),
        locationId: "loc-corridor",
        patch: { description: "走廊尽头多了一扇窗" },
      },
    ];
    const stale = staleMasters(events, withMaster);
    expect(stale.get("loc-corridor")).toEqual({ at: at(9), reasons: ["场景描述"] });
    expect(stale.has("loc-door")).toBe(false);
  });

  it("改名字、改模板不算过期：它们不进主镜提示词", () => {
    const events = [
      ...base,
      { type: "location.updated" as const, at: at(9), locationId: "loc-corridor", patch: { name: "长走廊" } },
      {
        type: "location.updated" as const,
        at: at(10),
        locationId: "loc-door",
        patch: { templateId: "doorway" },
      },
    ];
    expect(staleMasters(events, withMaster).size).toBe(0);
  });

  it("主镜是在改动之后出的：不再过期", () => {
    const events = [
      ...base,
      {
        type: "location.updated" as const,
        at: at(9),
        locationId: "loc-corridor",
        patch: { description: "走廊尽头多了一扇窗" },
      },
      {
        type: "asset.updated" as const,
        at: at(11),
        asset: {
          id: "a-corridor",
          kind: "image" as const,
          source: "generated" as const,
          createdAt: at(11),
        },
      },
    ];
    // 重生成之后，资产的时间晚于改动：不再过期
    expect(staleMasters(events, rebuild(events)).has("loc-corridor")).toBe(false);
  });

  it("toCastView 带上日志时，卡片拿到过期标记", () => {
    const events = [
      ...base,
      {
        type: "location.updated" as const,
        at: at(9),
        locationId: "loc-corridor",
        patch: { description: "走廊尽头多了一扇窗" },
      },
    ];
    const view = toCastView(withMaster, events);
    expect(view.locations.find((item) => item.id === "loc-corridor")?.masterStale).toEqual({
      at: at(9),
      reasons: ["场景描述"],
    });
    expect(toCastView(withMaster).locations.find((item) => item.id === "loc-corridor")?.masterStale).toBeUndefined();
  });
});

describe("撤销删除（ADR-0076）", () => {
  const at = (h: number) => `2026-11-10T${String(h).padStart(2, "0")}:00:00+08:00`;
  const head = { type: "project.created" as const, at: at(0), project: sampleProject };
  const lin = sampleProject.characters.find((item) => item.id === "c-lin")!;
  const s01 = sampleProject.shots.find((item) => item.id === "s-01")!;
  /** 试验人物没有被任何镜头点着，删得掉 */
  const trial = { ...lin, id: "c-trial", name: "阿棠", mustNotChange: [] };
  const trialHead = {
    type: "project.created" as const,
    at: at(0),
    project: ProjectSchema.parse({
      ...sampleProject,
      characters: [...sampleProject.characters, trial],
    }),
  };
  /** 空场次：没有镜头，删得掉 */
  const emptyScene = {
    id: "sc-empty",
    index: sampleProject.scenes.length,
    locationId: "loc-corridor",
    space: "int" as const,
    timeOfDay: "night" as const,
    shotIds: [],
  };
  const emptyHead = {
    type: "project.created" as const,
    at: at(0),
    project: ProjectSchema.parse({
      ...sampleProject,
      scenes: [...sampleProject.scenes, emptyScene],
    }),
  };

  it("没有删除时没有可撤销的", () => {
    expect(undoableRemoval([head], sampleProject)).toBeUndefined();
  });

  it("人物：名字用删除之前那一份，索引指向那条事件", () => {
    const events = [
      trialHead,
      { type: "character.removed" as const, at: at(9), characterId: "c-trial" },
    ];
    const project = rebuild(events);
    expect(undoableRemoval(events, project)).toEqual({
      index: 1,
      kind: "character",
      id: "c-trial",
      label: "阿棠",
      at: at(9),
    });
  });

  it("恢复过又删一次：两条都记，取最近一条", () => {
    const events = [
      trialHead,
      { type: "character.removed" as const, at: at(9), characterId: "c-trial" },
      { type: "character.added" as const, at: at(10), character: trial },
      { type: "character.removed" as const, at: at(11), characterId: "c-trial" },
    ];
    expect(undoableRemoval(events, rebuild(events))).toMatchObject({ index: 3, at: at(11) });
  });

  it("已经放回来的删除跳过，去找更早的一条", () => {
    const events = [
      trialHead,
      { type: "character.removed" as const, at: at(9), characterId: "c-trial" },
      { type: "character.added" as const, at: at(10), character: trial },
    ];
    expect(undoableRemoval(events, rebuild(events))).toBeUndefined();
  });

  it("镜头用删除之前的镜号，场次用第几场", () => {
    const shotEvents = [
      head,
      { type: "shot.removed" as const, at: at(9), shotId: "s-01" },
    ];
    expect(undoableRemoval(shotEvents, rebuild(shotEvents))).toMatchObject({
      kind: "shot",
      id: "s-01",
      label: "SH-01",
    });
    expect(s01.id).toBe("s-01");

    const sceneEvents = [
      emptyHead,
      { type: "scene.removed" as const, at: at(9), sceneId: emptyScene.id },
    ];
    expect(undoableRemoval(sceneEvents, rebuild(sceneEvents))).toMatchObject({
      kind: "scene",
      id: emptyScene.id,
      label: `第 ${emptyScene.index + 1} 场`,
    });
  });
});

describe("道具签按场筛选（ADR-0078）", () => {
  it("每一镜带着它所在的场次，同一场的镜头能按场挑出来", () => {
    const view = toStageView(sampleProject);
    expect(view.shots.find((shot) => shot.id === "s-01")?.sceneId).toBe("sc-1");
    expect(view.shots.find((shot) => shot.id === "s-05")?.sceneId).toBe("sc-2");

    const inScene = view.shots
      .filter((shot) => shot.sceneId === "sc-1")
      .map((shot) => shot.id);
    expect(inScene).toEqual(["s-01", "s-02", "s-03"]);
  });

  it("一场里用过的道具去重后是这个集合", () => {
    const view = toStageView(sampleProject);
    const props = [
      ...new Set(
        view.shots
          .filter((shot) => shot.sceneId === "sc-2")
          .flatMap((shot) => shot.propIds),
      ),
    ];
    expect(props).toEqual(["p-lamp"]);
  });
});

describe("参考图进读模型（ADR-0079）", () => {
  it("人物带着全部参考图，道具的第一张同时是 referenceAssetId", () => {
    const view = toCastView(sampleProject);
    const lin = view.characters.find((item) => item.id === "c-lin")!;
    expect(lin.references).toEqual([{ assetId: "a-lin-expr", uri: undefined }]);

    const lamp = view.props.find((item) => item.id === "p-lamp")!;
    expect(lamp.referenceAssetId).toBe("a-lamp");
    expect(lamp.references).toEqual([{ assetId: "a-lamp", uri: undefined }]);
  });
});

describe("名字与描述的历史（ADR-0082）", () => {
  const at = (h: number) => `2026-11-11T${String(h).padStart(2, "0")}:00:00+08:00`;
  const events = [
    { type: "project.created" as const, at: at(0), project: sampleProject },
    { type: "character.updated" as const, at: at(9), characterId: "c-lin", patch: { name: "林小雨" } },
    { type: "character.updated" as const, at: at(10), characterId: "c-lin", patch: { appearance: "短发，黑色风衣" } },
    { type: "character.updated" as const, at: at(11), characterId: "c-lin", patch: { mustNotChange: ["左眼下的痣"] } },
    { type: "character.updated" as const, at: at(12), characterId: "c-zhou", patch: { name: "周默" } },
    { type: "prop.updated" as const, at: at(13), propId: "p-cup", patch: { name: "蓝边搪瓷杯", description: "杯沿磕掉一块瓷" } },
    { type: "location.added" as const, at: at(14), location: { id: "loc-roof", name: "天台", description: "", referenceImages: [], templateId: "rooftop", masterShotId: "a-roof" } },
    { type: "location.updated" as const, at: at(15), locationId: "loc-roof", patch: { description: "水箱在左边，远处是城市的灯" } },
  ];

  it("人物：最初一版从引导事件取，每次改名 / 改外形是一版，只改不许变不算", () => {
    const history = castTextHistory(events, "character", "c-lin")!;
    expect(history.original).toEqual({ at: at(0), name: "林", body: "短发，深色外套" });
    expect(history.edits).toEqual([
      { at: at(9), name: "林小雨", body: "短发，深色外套" },
      { at: at(10), name: "林小雨", body: "短发，黑色风衣" },
    ]);
  });

  it("道具：名字与描述同一条改动合成一版，仍是完整的两个值", () => {
    const history = castTextHistory(events, "prop", "p-cup")!;
    expect(history.original).toEqual({ at: at(0), name: "搪瓷杯", body: "白底蓝边搪瓷缸，杯沿有一道旧磕痕" });
    expect(history.edits).toEqual([
      { at: at(13), name: "蓝边搪瓷杯", body: "杯沿磕掉一块瓷" },
    ]);
  });

  it("地点：后加的地点从 location.added 取最初一版", () => {
    const history = castTextHistory(events, "location", "loc-roof")!;
    expect(history.original).toEqual({ at: at(14), name: "天台", body: "" });
    expect(history.edits).toEqual([
      { at: at(15), name: "天台", body: "水箱在左边，远处是城市的灯" },
    ]);
  });

  it("没改过的人是空历史，没出现过的人是 undefined，别的人的事件不算进来", () => {
    expect(castTextHistory(events, "character", "c-lin")!.edits).toHaveLength(2);
    expect(castTextHistory(events, "character", "c-zhou")!.edits).toHaveLength(1);
    expect(castTextHistory(events, "character", "c-none")).toBeUndefined();
    expect(castTextHistory(events.slice(0, 1), "character", "c-lin")!.edits).toEqual([]);
  });
});

describe("按阶段 / 按镜记账（H4）", () => {
  const AT = "2026-11-11T10:00:00+08:00";
  const project = ProjectSchema.parse({
    ...sampleProject,
    assets: [
      ...sampleProject.assets,
      {
        id: "a-first",
        kind: "image",
        source: "generated",
        uri: "data:image/png;base64,AA==",
        costCny: 0.12,
        createdAt: AT,
      },
      {
        id: "a-voice",
        kind: "audio",
        source: "generated",
        uri: "data:audio/mpeg;base64,AA==",
        costCny: 0.05,
        createdAt: AT,
      },
      {
        id: "a-music",
        kind: "audio",
        source: "upload",
        createdAt: AT,
      },
    ],
    dialogue: sampleProject.dialogue.map((line, index) =>
      index === 0 ? { ...line, audioAssetId: "a-voice" } : line,
    ),
    shots: sampleProject.shots.map((shot, index) =>
      index === 0 ? { ...shot, keyframes: { firstAssetId: "a-first" } } : shot,
    ),
    timeline: {
      ...sampleProject.timeline,
      music: [
        {
          id: "m-1",
          assetId: "a-music",
          title: "夜巡",
          licenseRef: "曲库授权",
          startMs: 0,
          durationMs: 3000,
        },
      ],
    },
  });

  it("按阶段拆账，合计与已花一致", () => {
    const spend = spendOf(project);
    const stages = spendByStage(project);
    expect(stages.map((stage) => stage.id)).toEqual([
      "story",
      "cast",
      "storyboard",
      "voice",
      "edit",
    ]);
    const sum = Math.round(stages.reduce((total, stage) => total + stage.spent, 0) * 100) / 100;
    expect(sum).toBe(spend.spent);
    expect(stages.find((stage) => stage.id === "storyboard")?.spent).toBe(
      Math.round((spend.takes + 0.12) * 100) / 100,
    );
    expect(stages.find((stage) => stage.id === "voice")?.spent).toBe(0.05);
    expect(stages.find((stage) => stage.id === "edit")?.spent).toBe(0);
  });

  it("take 的视频资产不重复计费", () => {
    const stages = spendByStage(project);
    expect(stages.find((stage) => stage.id === "storyboard")?.spent).toBe(
      Math.round(
        (project.takes.reduce((sum, take) => sum + take.costCny, 0) + 0.12) * 100,
      ) / 100,
    );

    // 视频生成会同时写 take.costCny 和资产 costCny：已花只认 take 的那一笔
    const doubled = ProjectSchema.parse({
      ...project,
      assets: [
        ...project.assets,
        {
          id: "a-01",
          kind: "video",
          source: "generated",
          uri: "data:video/mp4;base64,AA==",
          costCny: 1.58,
          createdAt: AT,
        },
      ],
    });
    expect(spendOf(doubled).spent).toBe(spendOf(project).spent);
    expect(
      spendByStage(doubled).reduce((sum, stage) => sum + stage.spent, 0),
    ).toBe(spendOf(doubled).spent);
  });

  it("按镜拆账，首尾帧算进这一镜，淘汰单独列出", () => {
    const rows = shotLedger(project);
    expect(rows).toHaveLength(project.shots.length);
    expect(rows[0]).toMatchObject({
      shotId: "s-01",
      label: "SH-01",
      takes: 1,
      spent: 1.7,
      rejected: 1.58,
    });
    expect(rows[1]?.spent).toBe(2.12);
    expect(rows[2]?.spent).toBe(2.12);
  });

  it("没有价目的生成资产只数出来，不当 0 算", () => {
    const withUnpriced = ProjectSchema.parse({
      ...project,
      assets: [
        ...project.assets,
        {
          id: "a-unpriced",
          kind: "image",
          source: "generated",
          uri: "data:image/png;base64,AA==",
          createdAt: AT,
        },
      ],
    });
    const cast = spendByStage(withUnpriced).find((stage) => stage.id === "cast");
    expect(cast?.unpriced).toBe(1);
    expect(cast?.spent).toBe(0);
  });

  it("文本生成的钱记在故事阶段，配音的钱单独拆出来（H4）", () => {
    const withText = ProjectSchema.parse({
      ...project,
      story: {
        ...project.story,
        provenance: {
          modelId: "deepseek-v4.1-flash-1017",
          prompt: "一句想法",
          referenceAssetIds: [],
          createdAt: AT,
          costCny: 0.03,
          usage: { units: 15_000, unit: "tokens" },
        },
      },
    });
    const story = spendByStage(withText).find((stage) => stage.id === "story");
    expect(story?.spent).toBe(0.03);
    expect(story?.unpricedCalls).toBe(0);
    expect(story?.detail).toContain("15.0k token");

    // 文本的钱进「已花」，配音的钱同时进「已花」与单独的 voice 一栏
    expect(spendOf(withText).text).toBe(0.03);
    expect(spendOf(withText).spent).toBe(Math.round((spendOf(project).spent + 0.03) * 100) / 100);
    expect(spendOf(withText).voice).toBe(0.05);
  });

  it("生成过却没单价：按调用次数数，不混进张数", () => {
    const withUnpricedStory = ProjectSchema.parse({
      ...project,
      story: {
        ...project.story,
        provenance: {
          modelId: "deepseek-v4.1-flash-1017",
          prompt: "一句想法",
          referenceAssetIds: [],
          createdAt: AT,
        },
      },
    });
    const spend = spendOf(withUnpricedStory);
    // 一个未定价的故事调用：不进已花，只进 unpricedCalls
    expect(spend.text).toBe(0);
    expect(spend.unpricedCalls).toBe(1);
    const story = spendByStage(withUnpricedStory).find((stage) => stage.id === "story");
    expect(story?.unpricedCalls).toBe(1);
    expect(story?.spent).toBe(0);
  });
});

describe("台词下游同步（A5 / ADR-0107）", () => {
  const AT = "2026-11-11T09:00:00Z";

  function withPrompts(prompt: string | undefined, voicePrompt?: string) {
    return ProjectSchema.parse({
      ...sampleProject,
      takes: sampleProject.takes.map((take) =>
        take.id === "t-01"
          ? { ...take, provenance: { ...take.provenance, ...(prompt ? { prompt } : {}) } }
          : take,
      ),
      dialogue: sampleProject.dialogue.map((line) =>
        line.id === "d-01" && voicePrompt !== undefined
          ? { ...line, audioAssetId: "a-voice-d-01" }
          : line,
      ),
      assets:
        voicePrompt === undefined
          ? sampleProject.assets
          : [
              ...sampleProject.assets,
              {
                id: "a-voice-d-01",
                kind: "audio",
                source: "generated",
                uri: "data:audio/mpeg;base64,SUQz",
                createdAt: AT,
                provenance: {
                  modelId: "tts",
                  prompt: voicePrompt,
                  referenceAssetIds: [],
                  createdAt: AT,
                },
              },
            ],
    });
  }

  it("出片提示词不含当前台词时，take 标成旧词", () => {
    const project = withPrompts("人物：周；镜头平稳");
    expect(downstreamGap(project, "s-01")).toMatchObject({ lines: 1, takes: 1, voices: 0 });
    const view = toStageView(project);
    const shot = view.shots.find((item) => item.id === "s-01");
    expect(shot?.staleTakes).toBe(1);
    expect(shot?.takes[0]?.stalePrompt).toBe(true);
    expect(shot?.prompts.video).toContain("你早就知道，对吧。");
  });

  it("提示词里已经有当前台词就不算旧，没有提示词的导入片也不冒充", () => {
    const fresh = withPrompts("台词（口型对齐）：周「你早就知道，对吧。」");
    expect(downstreamGap(fresh, "s-01").takes).toBe(0);
    const imported = withPrompts(undefined);
    expect(downstreamGap(imported, "s-01").takes).toBe(0);
  });

  it("配音念的是旧台词时单独计数，并在声音页标出", () => {
    const project = withPrompts(undefined, "你早就知道了。");
    expect(downstreamGap(project, "s-01")).toMatchObject({ lines: 1, takes: 0, voices: 1 });
    const voice = toVoiceView(project);
    expect(voice.lines.find((line) => line.id === "d-01")?.stale).toBe(true);
    expect(toStageView(project).shots[0]?.staleVoices).toBe(1);
  });

  it("音轨没有溯源时不冒充旧台词", () => {
    const project = ProjectSchema.parse({
      ...sampleProject,
      dialogue: sampleProject.dialogue.map((line) =>
        line.id === "d-01" ? { ...line, audioAssetId: "a-voice-d-01" } : line,
      ),
      assets: [
        ...sampleProject.assets,
        {
          id: "a-voice-d-01",
          kind: "audio",
          source: "generated",
          uri: "data:audio/mpeg;base64,SUQz",
          createdAt: AT,
        },
      ],
    });
    expect(downstreamGap(project, "s-01").voices).toBe(0);
    expect(toVoiceView(project).lines.find((line) => line.id === "d-01")?.stale).toBeUndefined();
  });
});

describe("四格过期与旧版（B1）", () => {
  const at = (h: number) => `2026-11-10T${String(h).padStart(2, "0")}:00:00+08:00`;
  const sheetAsset = (
    id: string,
    createdAt: string,
    modelId: string,
    uri = `data:image/png;base64,${id}`,
  ) => ({
    id,
    kind: "image" as const,
    source: "generated" as const,
    uri,
    createdAt,
    provenance: { modelId, createdAt, referenceAssetIds: [] },
  });

  const project = ProjectSchema.parse({
    ...sampleProject,
    assets: [
      ...sampleProject.assets.filter((asset) => !asset.id.startsWith("a-lin-")),
      sheetAsset("a-lin-front", "2026-11-09T20:10:00+08:00", "model-a"),
      sheetAsset("a-lin-34", "2026-11-09T20:10:00+08:00", "model-a"),
      sheetAsset("a-lin-side", "2026-11-09T20:10:00+08:00", "model-a"),
      sheetAsset("a-lin-back", "2026-11-09T20:10:00+08:00", "model-a"),
    ],
  });
  const base = [{ type: "project.created" as const, at: at(0), project }];

  it("没改过设定：四格都不过期", () => {
    expect(staleSheetCells(base, project).size).toBe(0);
  });

  it("改外形 / 名字 / 不许变：只标改动之前出的那几格", () => {
    const events = [
      ...base,
      {
        type: "character.updated" as const,
        at: at(9),
        characterId: "c-lin",
        patch: { appearance: "剪了短发" },
      },
      {
        type: "character.updated" as const,
        at: at(10),
        characterId: "c-lin",
        patch: { name: "小林", mustNotChange: ["左眼下的痣"] },
      },
    ];
    const stale = staleSheetCells(events, project);
    expect(stale.get("a-lin-front")).toEqual({
      at: at(10),
      reasons: ["外形描述", "名字", "不许变"],
    });
    expect(stale.has("a-lin-back")).toBe(true);
    expect(stale.has("a-zhou-front")).toBe(false);
  });

  it("改动之后重出的那一格不过期；换模型的那一格标出来", () => {
    const events = [
      ...base,
      {
        type: "character.updated" as const,
        at: at(9),
        characterId: "c-lin",
        patch: { appearance: "剪了短发" },
      },
      {
        type: "asset.updated" as const,
        at: at(11),
        asset: sheetAsset("a-lin-front", at(11), "model-b"),
      },
    ];
    const stale = staleSheetCells(events, rebuild(events));
    // 正面是改动之后重出的，但换成 model-b，四格不再是一个模型
    expect(stale.get("a-lin-front")).toEqual({
      at: at(11),
      reasons: ["四格生成模型不一致"],
    });
    // 其余三格仍是多数派 model-a，只因为改动之前出图而过期
    expect(stale.get("a-lin-34")?.reasons).toEqual(["外形描述"]);
  });

  it("toCastView 把过期标记挂到对应的格子上", () => {
    const events = [
      ...base,
      {
        type: "character.updated" as const,
        at: at(9),
        characterId: "c-lin",
        patch: { appearance: "剪了短发" },
      },
    ];
    const view = toCastView(project, events);
    const lin = view.characters.find((item) => item.id === "c-lin")!;
    expect(lin.panels.find((panel) => panel.angle === "front")?.stale).toEqual({
      at: at(9),
      reasons: ["外形描述"],
    });
    const zhou = view.characters.find((item) => item.id === "c-zhou")!;
    expect(zhou.panels.every((panel) => panel.stale === undefined)).toBe(true);
    // 不给日志就不算
    expect(
      toCastView(project).characters
        .find((item) => item.id === "c-lin")!
        .panels.every((panel) => panel.stale === undefined),
    ).toBe(true);
  });

  it("旧版按日志回放：当前版不算，按 uri 去重，新的在前", () => {
    const events = [
      ...base,
      {
        type: "asset.updated" as const,
        at: at(9),
        asset: sheetAsset("a-lin-front", at(9), "model-a", "data:image/png;base64,v2"),
      },
      {
        type: "asset.updated" as const,
        at: at(10),
        asset: sheetAsset("a-lin-front", at(10), "model-a", "data:image/png;base64,v3"),
      },
    ];
    const history = sheetAssetHistory(events).get("a-lin-front")!;
    expect(history.map((item) => item.asset.uri)).toEqual([
      "data:image/png;base64,v2",
      "data:image/png;base64,a-lin-front",
    ]);
    expect(history[0]?.modelId).toBe("model-a");

    // 换回旧版之后再回放：当前是 v2，旧版只剩 v3 与最初那张
    const restored = [
      ...events,
      {
        type: "asset.updated" as const,
        at: at(11),
        asset: sheetAsset("a-lin-front", "2026-11-09T20:10:00+08:00", "model-a", "data:image/png;base64,a-lin-front"),
      },
    ];
    expect(
      sheetAssetHistory(restored)
        .get("a-lin-front")!
        .map((item) => item.asset.uri),
    ).toEqual(["data:image/png;base64,v3", "data:image/png;base64,v2"]);
    // 没有 uri 的格子（示例占位）没有历史
    expect(sheetAssetHistory(base).get("a-zhou-front")).toBeUndefined();
  });
});
