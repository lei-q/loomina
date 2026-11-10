import { describe, expect, it } from "vitest";
import { ProjectSchema, rebuild, type ProjectEvent, type ProjectInput } from "@loomina/ir";
import {
  actionHistory,
  dialogueHistory,
  dialogueOrderHistory,
  filterKeyframeCells,
  keyframeTally,
  previousActionText,
  previousDialogueText,
  removedLines,
  sceneHead,
  scriptToText,
  staleFrames,
  toCastView,
  toKeyframeView,
  toScriptView,
  toStageView,
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
  };
  const events = [
    { type: "project.created" as const, at: at(0), project: sampleProject },
    { type: "dialogue.removed" as const, at: at(9), lineId: "d-01" },
    { type: "dialogue.added" as const, at: at(10), shotId: "s-05", line: { ...line, id: "d-new", text: "新加的" } },
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
    expect(stale.get("s-01")).toEqual({ first: at(9) });
    expect(stale.has("s-02")).toBe(false);
  });

  it("场头改了：这一场有帧的镜头都过期", () => {
    const events = [
      ...base,
      { type: "scene.updated" as const, at: at(10), sceneId: "sc-1", patch: { timeOfDay: "day" as const } },
    ];
    const stale = staleFrames(events, withFrames);
    expect(stale.get("s-01")?.first).toBe(at(10));
    expect(stale.get("s-02")?.first).toBe(at(10));
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
    expect(view.cells.find((cell) => cell.id === "s-01")?.staleFirst).toBe(at(9));
    expect(view.cells.find((cell) => cell.id === "s-02")?.staleFirst).toBeUndefined();

    // 分镜页的 StageShot 也带同样的标记
    const stage = toStageView(withFrames, { events });
    expect(stage.shots.find((shot) => shot.id === "s-01")?.staleFirst).toBe(at(9));
    expect(stage.shots.find((shot) => shot.id === "s-02")?.staleFirst).toBeUndefined();
    // 不给日志就不算
    expect(toStageView(withFrames).shots.find((shot) => shot.id === "s-01")?.staleFirst).toBeUndefined();
  });
});
