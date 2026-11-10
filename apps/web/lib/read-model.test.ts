import { describe, expect, it } from "vitest";
import { ProjectSchema, type ProjectInput } from "@loomina/ir";
import { toCastView, toStageView } from "./read-model";
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
});
