import { describe, expect, it } from "vitest";
import { clone } from "../src/clone";
import { applyEvent, rebuild, type ProjectEvent } from "../src/events";
import { validateProject } from "../src/invariants";
import { ProjectSchema, type Project, type Take } from "../src/schema";
import minimalJson from "../../../examples/minimal.json";

const AT = "2026-11-09T12:00:00Z";

function load(): Project {
  return ProjectSchema.parse(clone(minimalJson));
}

function created(project: Project): ProjectEvent {
  return { type: "project.created", at: AT, project };
}

function makeTake(): Take {
  return {
    id: "take-3",
    shotId: "sh-1",
    assetId: "asset-3",
    provenance: {
      modelId: "fake-video",
      referenceAssetIds: [],
      createdAt: AT,
    },
    status: "draft",
    costCny: 1.2,
  };
}

describe("事件日志", () => {
  it("由 created 事件重建出等价项目", () => {
    const project = load();
    expect(rebuild([created(project)])).toEqual(project);
  });

  it("take.added 会同时更新 takes 与 shot.takeIds", () => {
    const project = load();
    const take = makeTake();
    const result = rebuild([
      created(project),
      { type: "take.added", at: AT, take },
    ]);

    expect(result.takes).toHaveLength(3);
    expect(result.shots[0]!.takeIds).toContain("take-3");
  });

  it("shot.updated 只改目标镜头", () => {
    const project = load();
    const result = rebuild([
      created(project),
      { type: "shot.updated", at: AT, shotId: "sh-1", patch: { locked: true } },
    ]);

    expect(result.shots[0]!.locked).toBe(true);
    expect(result.shots[1]!.locked).toBe(false);
  });

  it("没有 created 事件时拒绝增量事件", () => {
    expect(() =>
      applyEvent(null, { type: "take.added", at: AT, take: makeTake() }),
    ).toThrow();
  });
});

describe("take.updated", () => {
  const approve: ProjectEvent = {
    type: "take.updated",
    at: AT,
    takeId: "take-1",
    patch: { status: "approved" },
  };

  it("只改目标 take 的状态", () => {
    const project = load();
    const result = rebuild([created(project), approve]);
    const touched = result.takes.find((take) => take.id === "take-1");

    expect(touched?.status).toBe("approved");
    expect(result.takes.filter((take) => take.id !== "take-1")).toEqual(
      project.takes.filter((take) => take.id !== "take-1"),
    );
    expect(result.shots).toEqual(project.shots);
  });

  it("指向不存在的 take 时拒绝，不静默吞掉", () => {
    const project = load();
    expect(() =>
      rebuild([
        created(project),
        { ...approve, takeId: "take-missing" },
      ]),
    ).toThrow(/take-missing/);
  });
});

describe("approval.updated", () => {
  // 示例项目自带三条已通过的闸门，这几条测试从"还没锁"开始。
  const unlockedProject = (): Project => ({ ...load(), approvals: [] });

  const lock: ProjectEvent = {
    type: "approval.updated",
    at: AT,
    approval: {
      id: "ap-character-c-lin",
      targetType: "character",
      targetId: "c-lin",
      status: "approved",
      approvedAt: AT,
      lockedAssetIds: [],
    },
  };

  it("第一次锁定追加一条闸门记录", () => {
    const project = applyEvent(unlockedProject(), lock);
    expect(project.approvals).toHaveLength(1);
    expect(project.approvals[0]!.status).toBe("approved");
  });

  it("同一目标再次写入是覆盖，不是追加", () => {
    const locked = applyEvent(unlockedProject(), lock);
    const unlocked = applyEvent(locked, {
      ...lock,
      approval: { ...lock.approval, status: "pending", approvedAt: undefined },
    });
    expect(unlocked.approvals).toHaveLength(1);
    expect(unlocked.approvals[0]!.status).toBe("pending");
  });
});

describe("asset.updated", () => {
  const generated: Extract<ProjectEvent, { type: "asset.updated" }> = {
    type: "asset.updated",
    at: AT,
    asset: {
      id: "a-lin-front",
      kind: "image",
      source: "generated",
      uri: "data:image/png;base64,AAAA",
      mime: "image/png",
      provenance: {
        modelId: "gemini-2.5-flash-image",
        prompt: "定妆三视图",
        referenceAssetIds: [],
        createdAt: AT,
      },
      createdAt: AT,
    },
  };

  it("已有的占位资产被生成结果覆盖，不新增一条", () => {
    const project = load();
    const before = project.assets.length;
    const next = applyEvent(project, generated);

    expect(next.assets).toHaveLength(before);
    const asset = next.assets.find((item) => item.id === "a-lin-front")!;
    expect(asset.uri).toBe("data:image/png;base64,AAAA");
    expect(asset.provenance?.modelId).toBe("gemini-2.5-flash-image");
  });

  it("没有的资产按 id 追加", () => {
    const next = applyEvent(load(), {
      ...generated,
      asset: { ...generated.asset, id: "a-new-panel" },
    });
    expect(next.assets.some((item) => item.id === "a-new-panel")).toBe(true);
  });
});

describe("project.updated", () => {
  it("改预算只动 budgetCny，其余字段原样保留", () => {
    const project = load();
    const next = applyEvent(project, { type: "project.updated", at: AT, budgetCny: 120 });

    expect(next.budgetCny).toBe(120);
    expect(next.shots).toEqual(project.shots);
    expect(next.title).toBe(project.title);
  });

  it("预算不是正数就拒绝，不写进日志", () => {
    expect(() =>
      applyEvent(load(), { type: "project.updated", at: AT, budgetCny: 0 }),
    ).toThrow();
  });

  it("没有 created 事件时拒绝", () => {
    expect(() =>
      applyEvent(null, { type: "project.updated", at: AT, budgetCny: 100 }),
    ).toThrow();
  });
});

describe("Project.budgetCny", () => {
  it("老快照没有这个字段时，解析成默认预算而不是失败", () => {
    const parsed = ProjectSchema.parse({ ...clone(minimalJson), budgetCny: undefined });
    expect(parsed.budgetCny).toBe(60);
  });

  it("预算必须是正数", () => {
    expect(() => ProjectSchema.parse({ ...clone(minimalJson), budgetCny: -1 })).toThrow();
  });
});

describe("dialogue.updated（ADR-0044）", () => {
  it("改写文本与时长，重放后一致", () => {
    const project = load();
    const event: ProjectEvent = {
      type: "dialogue.updated",
      at: AT,
      lineId: "dl-1",
      patch: { text: "你早就知道了。", durationMs: 1800 },
    };
    const after = applyEvent(project, event);

    expect(after.dialogue.find((line) => line.id === "dl-1")).toMatchObject({
      text: "你早就知道了。",
      durationMs: 1800,
      characterId: "c-lin",
    });
    expect(rebuild([created(project), event])).toEqual(after);
  });

  it("空台词、非正时长、指向不存在的台词都拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "dialogue.updated",
        at: AT,
        lineId: "dl-1",
        patch: { text: "   " },
      }),
    ).toThrow(/空/);
    expect(() =>
      applyEvent(project, {
        type: "dialogue.updated",
        at: AT,
        lineId: "dl-1",
        patch: { durationMs: 0 },
      }),
    ).toThrow(/大于 0/);
    expect(() =>
      applyEvent(project, {
        type: "dialogue.updated",
        at: AT,
        lineId: "dl-404",
        patch: { text: "嗯。" },
      }),
    ).toThrow(/不存在/);
  });
});

describe("台词增删（ADR-0045）", () => {
  it("dialogue.added 同时挂到镜头的 dialogueIds，可回放", () => {
    const project = load();
    const line = {
      id: "dl-3",
      characterId: "c-lin",
      text: "又是我。",
      durationMs: 1200,
    };
    const event: ProjectEvent = { type: "dialogue.added", at: AT, shotId: "sh-1", line };
    const after = applyEvent(project, event);

    expect(after.dialogue.some((item) => item.id === "dl-3")).toBe(true);
    expect(after.shots.find((shot) => shot.id === "sh-1")?.dialogueIds).toContain("dl-3");
    expect(rebuild([created(project), event])).toEqual(after);
  });

  it("dialogue.removed 从项目与所属镜头上一起摘掉", () => {
    const project = load();
    const after = applyEvent(project, { type: "dialogue.removed", at: AT, lineId: "dl-1" });

    expect(after.dialogue.some((line) => line.id === "dl-1")).toBe(false);
    expect(after.shots.find((shot) => shot.id === "sh-1")?.dialogueIds).toEqual([]);
  });

  it("重复 id、不存在的镜头、不存在的台词、空台词都拒绝", () => {
    const project = load();
    const line = { id: "dl-1", characterId: "c-lin", text: "又是我。", durationMs: 1200 };

    expect(() =>
      applyEvent(project, { type: "dialogue.added", at: AT, shotId: "sh-1", line }),
    ).toThrow(/已存在/);
    expect(() =>
      applyEvent(project, {
        type: "dialogue.added",
        at: AT,
        shotId: "sh-404",
        line: { ...line, id: "dl-9" },
      }),
    ).toThrow(/不存在的镜头/);
    expect(() =>
      applyEvent(project, {
        type: "dialogue.added",
        at: AT,
        shotId: "sh-1",
        line: { ...line, id: "dl-9", text: "  " },
      }),
    ).toThrow(/正时长且非空/);
    expect(() =>
      applyEvent(project, { type: "dialogue.removed", at: AT, lineId: "dl-404" }),
    ).toThrow(/不存在/);
  });
});

describe("换说话人（ADR-0046）", () => {
  it("改 characterId，文本与时长不动，可回放", () => {
    const project = load();
    const lineBefore = project.dialogue.find((line) => line.id === "dl-1")!;
    const event: ProjectEvent = {
      type: "dialogue.speaker.updated",
      at: AT,
      lineId: "dl-1",
      characterId: "c-zhou",
    };
    const after = applyEvent(project, event);
    const lineAfter = after.dialogue.find((line) => line.id === "dl-1")!;

    expect(lineAfter.characterId).toBe("c-zhou");
    expect(lineAfter.text).toBe(lineBefore.text);
    expect(lineAfter.durationMs).toBe(lineBefore.durationMs);
    expect(rebuild([created(project), event])).toEqual(after);
  });

  it("同一句话换个不存在的人、不存在的台词、还是同一个人都拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "dialogue.speaker.updated",
        at: AT,
        lineId: "dl-1",
        characterId: "c-404",
      }),
    ).toThrow(/不存在的角色/);
    expect(() =>
      applyEvent(project, {
        type: "dialogue.speaker.updated",
        at: AT,
        lineId: "dl-404",
        characterId: "c-zhou",
      }),
    ).toThrow(/不存在的台词/);
    expect(() =>
      applyEvent(project, {
        type: "dialogue.speaker.updated",
        at: AT,
        lineId: "dl-1",
        characterId: project.dialogue.find((line) => line.id === "dl-1")!.characterId,
      }),
    ).toThrow(/已经是/);
  });
});

describe("scene.updated（ADR-0050）", () => {
  it("改内 / 外景与日夜，重放后一致，别的场不动", () => {
    const project = load();
    const event: ProjectEvent = {
      type: "scene.updated",
      at: AT,
      sceneId: "sc-1",
      patch: { space: "ext", timeOfDay: "dawn" },
    };
    const after = applyEvent(project, event);

    expect(after.scenes[0]).toMatchObject({ space: "ext", timeOfDay: "dawn" });
    expect(rebuild([created(project), event])).toEqual(after);
  });

  it("缺省值是内景 / 日，旧项目回放不用改", () => {
    // minimal.json 没有这两个字段，schema 解析时补上
    const project = load();
    expect(project.scenes[0]).toMatchObject({ space: "int", timeOfDay: "day" });
  });

  it("改地点：重放后场次指向新地点（ADR-0056）", () => {
    // 最小示例只有一个地点，补一个再改过去
    const project: Project = { ...load(), locations: [
      ...load().locations,
      { id: "loc-hall", name: "门厅", referenceImages: [], description: "", templateId: "doorway" },
    ] };
    const target = project.locations.find((item) => item.id === "loc-hall")!;
    const event: ProjectEvent = {
      type: "scene.updated",
      at: AT,
      sceneId: "sc-1",
      patch: { locationId: target.id },
    };
    const after = applyEvent(project, event);
    expect(after.scenes[0]?.locationId).toBe(target.id);
    expect(rebuild([created(project), event])).toEqual(after);
  });

  it("指向不存在的场次、不存在的地点、空 patch 都拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "scene.updated",
        at: AT,
        sceneId: "sc-404",
        patch: { space: "ext" },
      }),
    ).toThrow(/不存在/);
    expect(() =>
      applyEvent(project, {
        type: "scene.updated",
        at: AT,
        sceneId: "sc-1",
        patch: {},
      }),
    ).toThrow(/空/);
    expect(() =>
      applyEvent(project, {
        type: "scene.updated",
        at: AT,
        sceneId: "sc-1",
        patch: { locationId: "loc-404" },
      }),
    ).toThrow(/地点/);
  });
});

describe("调整场序（ADR-0060）", () => {
  const threeScenes = (): Project => {
    const base = load();
    return {
      ...base,
      scenes: [
        base.scenes[0]!,
        { id: "sc-b", index: 1, locationId: "loc-living", space: "int", timeOfDay: "day", shotIds: [] },
        { id: "sc-c", index: 2, locationId: "loc-living", space: "int", timeOfDay: "night", shotIds: [] },
      ],
    };
  };

  it("把第 1 场挪到最后：全场重编号，可回放", () => {
    const project = threeScenes();
    const event: ProjectEvent = { type: "scene.moved", at: AT, sceneId: "sc-1", toIndex: 2 };
    const after = applyEvent(project, event);

    expect(after.scenes.map((scene) => scene.id)).toEqual(["sc-b", "sc-c", "sc-1"]);
    expect(after.scenes.map((scene) => scene.index)).toEqual([0, 1, 2]);
    // 场里的镜头原样跟着场走
    expect(after.scenes.find((scene) => scene.id === "sc-1")?.shotIds).toEqual(
      project.scenes.find((scene) => scene.id === "sc-1")?.shotIds,
    );
    expect(rebuild([created(project), event])).toEqual(after);
  });

  it("越界、原地、不存在的场次都拒绝", () => {
    const project = threeScenes();
    expect(() =>
      applyEvent(project, { type: "scene.moved", at: AT, sceneId: "sc-1", toIndex: 3 }),
    ).toThrow(/越界/);
    expect(() =>
      applyEvent(project, { type: "scene.moved", at: AT, sceneId: "sc-1", toIndex: -1 }),
    ).toThrow(/越界/);
    expect(() =>
      applyEvent(project, { type: "scene.moved", at: AT, sceneId: "sc-1", toIndex: 0 }),
    ).toThrow(/已经在这个位置/);
    expect(() =>
      applyEvent(project, { type: "scene.moved", at: AT, sceneId: "sc-404", toIndex: 1 }),
    ).toThrow(/不存在/);
  });
});

describe("新建场次与镜头（ADR-0064）", () => {
  it("加一场：只能加在末尾，新场没有镜头，可回放", () => {
    const project = load();
    const scene: ProjectEvent = {
      type: "scene.added",
      at: AT,
      scene: {
        id: "sc-2",
        index: 1,
        locationId: "loc-living",
        space: "int",
        timeOfDay: "day",
        shotIds: [],
      },
    };
    const after = applyEvent(project, scene);

    expect(after.scenes.map((item) => item.id)).toEqual(["sc-1", "sc-2"]);
    expect(after.scenes[1]).toMatchObject({ index: 1, shotIds: [] });
    expect(after.shots).toEqual(project.shots);
    expect(rebuild([created(project), scene])).toEqual(after);
  });

  it("加一镜：挂到这一场末尾，镜号连续，可回放", () => {
    const project = load();
    const shot: ProjectEvent = {
      type: "shot.added",
      at: AT,
      shot: {
        id: "sh-3",
        sceneId: "sc-1",
        index: 2,
        durationMs: 3000,
        description: "",
        promptNotes: [],
        shotSize: "medium",
        camera: { angle: "eye", movement: "static", focalMm: 35 },
        characterIds: [],
        propIds: [],
        dialogueIds: [],
        takeIds: [],
        keyframes: {},
        locked: false,
      },
    };
    const after = applyEvent(project, shot);

    expect(after.shots.at(-1)?.id).toBe("sh-3");
    expect(after.scenes[0]?.shotIds).toEqual(["sh-1", "sh-2", "sh-3"]);
    expect(rebuild([created(project), shot])).toEqual(after);
    expect(validateProject(after)).toEqual([]);
  });

  it("位置不对、地点 / 场次不存在、重复 id、夹带镜头或台词都拒绝", () => {
    const project = load();
    const baseScene = {
      id: "sc-9",
      index: 1,
      locationId: "loc-living",
      space: "int" as const,
      timeOfDay: "day" as const,
      shotIds: [],
    };

    expect(() =>
      applyEvent(project, {
        type: "scene.added",
        at: AT,
        scene: { ...baseScene, index: 5 },
      }),
    ).toThrow(/越界/);
    expect(() =>
      applyEvent(project, {
        type: "scene.added",
        at: AT,
        scene: { ...baseScene, locationId: "loc-404" },
      }),
    ).toThrow(/地点/);
    expect(() =>
      applyEvent(project, {
        type: "scene.added",
        at: AT,
        scene: { ...baseScene, id: "sc-1" },
      }),
    ).toThrow(/重复/);
    expect(() =>
      applyEvent(project, {
        type: "scene.added",
        at: AT,
        scene: { ...baseScene, shotIds: ["sh-1"] },
      }),
    ).toThrow(/镜头/);

    const shot = {
      id: "sh-9",
      sceneId: "sc-1",
      index: 2,
      durationMs: 3000,
      description: "",
      promptNotes: [],
      shotSize: "medium" as const,
      camera: { angle: "eye" as const, movement: "static" as const, focalMm: 35 },
      characterIds: [],
      propIds: [],
      dialogueIds: [],
      takeIds: [],
      keyframes: {},
      locked: false,
    };
    expect(() =>
      applyEvent(project, { type: "shot.added", at: AT, shot: { ...shot, index: 5 } }),
    ).toThrow(/越界/);
    expect(() =>
      applyEvent(project, { type: "shot.added", at: AT, shot: { ...shot, sceneId: "sc-404" } }),
    ).toThrow(/场次/);
    expect(() =>
      applyEvent(project, { type: "shot.added", at: AT, shot: { ...shot, id: "sh-1" } }),
    ).toThrow(/重复/);
    expect(() =>
      applyEvent(project, {
        type: "shot.added",
        at: AT,
        shot: { ...shot, dialogueIds: ["d-1"] },
      }),
    ).toThrow(/台词/);
  });
});

describe("中间插入场次与镜头（ADR-0068）", () => {
  it("场次插到指定位置：后面的场号顺次后移，可回放", () => {
    const project = load();
    const scene: ProjectEvent = {
      type: "scene.added",
      at: AT,
      scene: {
        id: "sc-2",
        index: 0,
        locationId: "loc-living",
        space: "ext",
        timeOfDay: "night",
        shotIds: [],
      },
    };
    const after = applyEvent(project, scene);

    expect(after.scenes.map((item) => item.id)).toEqual(["sc-2", "sc-1"]);
    expect(after.scenes.map((item) => item.index)).toEqual([0, 1]);
    expect(after.shots.map((item) => item.id)).toEqual(["sh-1", "sh-2"]);
    expect(rebuild([created(project), scene])).toEqual(after);
    expect(validateProject(after)).toEqual([]);
  });

  it("镜头插到这一场中间：后面的镜号顺次后移，可回放", () => {
    const project = load();
    const shot: ProjectEvent = {
      type: "shot.added",
      at: AT,
      shot: {
        id: "sh-9",
        sceneId: "sc-1",
        index: 1,
        durationMs: 3000,
        description: "插进来的一镜",
        promptNotes: [],
        shotSize: "medium",
        camera: { angle: "eye", movement: "static", focalMm: 35 },
        characterIds: [],
        propIds: [],
        dialogueIds: [],
        takeIds: [],
        keyframes: {},
        locked: false,
      },
    };
    const after = applyEvent(project, shot);

    expect(after.scenes[0]?.shotIds).toEqual(["sh-1", "sh-9", "sh-2"]);
    expect(
      [...after.shots]
        .sort((a, b) => a.index - b.index)
        .map((item) => [item.id, item.index]),
    ).toEqual([
      ["sh-1", 0],
      ["sh-9", 1],
      ["sh-2", 2],
    ]);
    expect(rebuild([created(project), shot])).toEqual(after);
    expect(validateProject(after)).toEqual([]);
  });

  it("位置越界、负数都拒绝", () => {
    const project = load();
    const scene = {
      id: "sc-9",
      index: 5,
      locationId: "loc-living",
      space: "int" as const,
      timeOfDay: "day" as const,
      shotIds: [],
    };
    expect(() =>
      applyEvent(project, { type: "scene.added", at: AT, scene }),
    ).toThrow(/越界/);
    expect(() =>
      applyEvent(project, { type: "scene.added", at: AT, scene: { ...scene, index: -1 } }),
    ).toThrow(/越界/);

    const shot = {
      id: "sh-9",
      sceneId: "sc-1",
      index: 3,
      durationMs: 3000,
      description: "",
      promptNotes: [],
      shotSize: "medium" as const,
      camera: { angle: "eye" as const, movement: "static" as const, focalMm: 35 },
      characterIds: [],
      propIds: [],
      dialogueIds: [],
      takeIds: [],
      keyframes: {},
      locked: false,
    };
    expect(() =>
      applyEvent(project, { type: "shot.added", at: AT, shot }),
    ).toThrow(/越界/);
  });
});

describe("删一场、删一镜（ADR-0067）", () => {
  it("删一镜：台词、take、时间线项一起走，镜号往前补", () => {
    const project = load();
    const removed: ProjectEvent = { type: "shot.removed", at: AT, shotId: "sh-1" };
    const after = applyEvent(project, removed);

    expect(after.shots.map((item) => item.id)).toEqual(["sh-2"]);
    expect(after.shots[0]?.index).toBe(0);
    expect(after.scenes[0]?.shotIds).toEqual(["sh-2"]);
    // 只带走这一镜自己的东西
    expect(after.dialogue.map((item) => item.id)).toEqual(["dl-2"]);
    expect(after.takes.map((item) => item.id)).toEqual(["take-2"]);
    expect(after.timeline.items.map((item) => item.id)).toEqual(["ti-2"]);
    expect(rebuild([created(project), removed])).toEqual(after);
    expect(validateProject(after)).toEqual([]);
  });

  it("删一场：还有镜头时拒绝；镜头删空后删掉，场号重排，可回放", () => {
    const project = load();
    expect(() =>
      applyEvent(project, { type: "scene.removed", at: AT, sceneId: "sc-1" }),
    ).toThrow(/还有 2 镜/);

    const events: ProjectEvent[] = [
      { type: "shot.removed", at: AT, shotId: "sh-1" },
      { type: "shot.removed", at: AT, shotId: "sh-2" },
      { type: "scene.removed", at: AT, sceneId: "sc-1" },
    ];
    const after = rebuild([created(project), ...events]);

    expect(after.scenes).toEqual([]);
    expect(after.shots).toEqual([]);
    expect(after.dialogue).toEqual([]);
    expect(after.takes).toEqual([]);
    expect(after.timeline.items).toEqual([]);
    expect(validateProject(after)).toEqual([]);
  });

  it("陌生场次 / 镜头都拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, { type: "scene.removed", at: AT, sceneId: "sc-404" }),
    ).toThrow(/不存在/);
    expect(() =>
      applyEvent(project, { type: "shot.removed", at: AT, shotId: "sh-404" }),
    ).toThrow(/不存在/);
  });
});

describe("删地点（ADR-0061）", () => {
  it("删掉没被场次占用的地点，重放后一致", () => {
    const project = load();
    const added: ProjectEvent = {
      type: "location.added",
      at: AT,
      location: { id: "loc-balcony", name: "阳台", templateId: "corridor", referenceImages: [], description: "" },
    };
    const removed: ProjectEvent = { type: "location.removed", at: AT, locationId: "loc-balcony" };
    const after = rebuild([created(project), added, removed]);

    expect(after.locations.some((location) => location.id === "loc-balcony")).toBe(false);
    // 原来的地点一个不少
    expect(after.locations.map((location) => location.id)).toEqual(project.locations.map((location) => location.id));
  });

  it("被场次占用、不存在的地点都拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, { type: "location.removed", at: AT, locationId: "loc-living" }),
    ).toThrow(/还有 1 场/);
    expect(() =>
      applyEvent(project, { type: "location.removed", at: AT, locationId: "loc-404" }),
    ).toThrow(/不存在/);
  });
});

describe("character.added / character.updated（ADR-0071）", () => {
  it("加一个人物，重放后一致", () => {
    const project = load();
    const event: ProjectEvent = {
      type: "character.added",
      at: AT,
      character: {
        id: "cha-tang",
        name: "阿棠",
        appearance: "齐耳短发，灰毛衣",
        sheet: {},
        referenceImages: [],
        mustNotChange: [],
      },
    };
    const after = applyEvent(project, event);
    expect(after.characters.at(-1)).toMatchObject({ id: "cha-tang", name: "阿棠" });
    expect(rebuild([created(project), event])).toEqual(after);
    expect(validateProject(after)).toEqual([]);
  });

  it("改名与外形描述：只动 patch 里的字段，重放后一致", () => {
    const project = load();
    const before = project.characters[0]!;
    const edited: ProjectEvent = {
      type: "character.updated",
      at: AT,
      characterId: before.id,
      patch: { name: "小林", appearance: "短发，深色风衣" },
    };
    const after = rebuild([created(project), edited]);
    expect(after.characters[0]).toMatchObject({
      id: before.id,
      name: "小林",
      appearance: "短发，深色风衣",
      mustNotChange: before.mustNotChange,
    });
  });

  it("重名、空名字、指向不存在的人物都拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "character.added",
        at: AT,
        character: {
          id: "cha-blank",
          name: " ",
          appearance: "",
          sheet: {},
          referenceImages: [],
          mustNotChange: [],
        },
      }),
    ).toThrow(/总得有个名字/);
    expect(() =>
      applyEvent(project, {
        type: "character.added",
        at: AT,
        character: project.characters[0]!,
      }),
    ).toThrow(/重复的人物/);
    expect(() =>
      applyEvent(project, {
        type: "character.updated",
        at: AT,
        characterId: "cha-nobody",
        patch: { name: "谁" },
      }),
    ).toThrow(/不存在的人物/);
  });
});

describe("prop.added / prop.updated（ADR-0072）", () => {
  it("加一件道具，重放后一致", () => {
    const project = load();
    const event: ProjectEvent = {
      type: "prop.added",
      at: AT,
      prop: { id: "prop-key", name: "旧钥匙", description: "黄铜钥匙，齿口磨圆", referenceImages: [] },
    };
    const after = applyEvent(project, event);
    expect(after.props.at(-1)).toMatchObject({ id: "prop-key", name: "旧钥匙" });
    expect(rebuild([created(project), event])).toEqual(after);
    expect(validateProject(after)).toEqual([]);
  });

  it("改名与描述：只动 patch 里的字段，重放后一致", () => {
    const project = load();
    const added: ProjectEvent = {
      type: "prop.added",
      at: AT,
      prop: { id: "prop-cup", name: "搪瓷杯", description: "", referenceImages: [] },
    };
    const edited: ProjectEvent = {
      type: "prop.updated",
      at: AT,
      propId: "prop-cup",
      patch: { name: "旧搪瓷缸", description: "白底蓝边，磕掉一块瓷" },
    };
    const after = rebuild([created(project), added, edited]);
    expect(after.props.at(-1)).toMatchObject({
      id: "prop-cup",
      name: "旧搪瓷缸",
      description: "白底蓝边，磕掉一块瓷",
      referenceImages: [],
    });
  });

  it("空名字、重复 id、陌生 id、空 patch 都拒绝", () => {
    const project = load();
    const one: ProjectEvent = {
      type: "prop.added",
      at: AT,
      prop: { id: "prop-cup", name: "搪瓷杯", description: "", referenceImages: [] },
    };
    expect(() =>
      applyEvent(project, {
        type: "prop.added",
        at: AT,
        prop: { id: "prop-blank", name: " ", description: "", referenceImages: [] },
      }),
    ).toThrow(/总得有个名字/);
    expect(() => applyEvent(applyEvent(project, one), one)).toThrow(/重复的道具/);
    expect(() =>
      applyEvent(project, {
        type: "prop.updated",
        at: AT,
        propId: "prop-nobody",
        patch: { name: "谁" },
      }),
    ).toThrow(/不存在的道具/);
    expect(() =>
      applyEvent(applyEvent(project, one), {
        type: "prop.updated",
        at: AT,
        propId: "prop-cup",
        patch: {},
      }),
    ).toThrow(/patch 是空的/);
  });
});

describe("location.added / location.updated（ADR-0059）", () => {
  it("加一个地点，重放后一致", () => {
    const project = load();
    const event: ProjectEvent = {
      type: "location.added",
      at: AT,
      location: { id: "loc-balcony", name: "阳台", templateId: "corridor", referenceImages: [], description: "" },
    };
    const after = applyEvent(project, event);
    expect(after.locations.at(-1)).toMatchObject({ id: "loc-balcony", name: "阳台" });
    expect(rebuild([created(project), event])).toEqual(after);
  });

  it("改名与换模板，别的字段不动；重放后一致", () => {
    const project = load();
    const added: ProjectEvent = {
      type: "location.added",
      at: AT,
      location: { id: "loc-balcony", name: "阳台", templateId: "corridor", referenceImages: [], description: "" },
    };
    const renamed: ProjectEvent = {
      type: "location.updated",
      at: AT,
      locationId: "loc-balcony",
      patch: { name: "阳台外沿", templateId: "doorway" },
    };
    const after = rebuild([created(project), added, renamed]);
    expect(after.locations.at(-1)).toMatchObject({
      id: "loc-balcony",
      name: "阳台外沿",
      templateId: "doorway",
    });
  });

  it("写场景描述：只动 description，重放后一致（ADR-0063）", () => {
    const project = load();
    const before = project.locations[0]!;
    const described: ProjectEvent = {
      type: "location.updated",
      at: AT,
      locationId: before.id,
      patch: { description: "老楼走廊，声控灯，墙皮起了卷" },
    };
    const after = rebuild([created(project), described]);
    const location = after.locations.find((item) => item.id === before.id)!;

    expect(location.description).toBe("老楼走廊，声控灯，墙皮起了卷");
    expect(location.name).toBe(before.name);
    expect(location.templateId).toBe(before.templateId);
  });

  it("旧项目没有 description，解析时补空串", () => {
    // minimal.json 写在这个字段之前：回放不该因为缺字段炸掉
    expect(load().locations[0]!.description).toBe("");
  });

  it("重复的 id、空名字、不存在的地点、空 patch 都拒绝", () => {
    const project = load();
    const existing = project.locations[0]!;
    expect(() =>
      applyEvent(project, {
        type: "location.added",
        at: AT,
        location: { id: existing.id, name: "又一个", referenceImages: [], description: "" },
      }),
    ).toThrow(/重复/);
    expect(() =>
      applyEvent(project, {
        type: "location.added",
        at: AT,
        location: { id: "loc-blank", name: "  ", referenceImages: [], description: "" },
      }),
    ).toThrow(/名字/);
    expect(() =>
      applyEvent(project, {
        type: "location.updated",
        at: AT,
        locationId: "loc-404",
        patch: { name: "门厅" },
      }),
    ).toThrow(/不存在/);
    expect(() =>
      applyEvent(project, {
        type: "location.updated",
        at: AT,
        locationId: existing.id,
        patch: {},
      }),
    ).toThrow(/空/);
    expect(() =>
      applyEvent(project, {
        type: "location.updated",
        at: AT,
        locationId: existing.id,
        patch: { name: "" },
      }),
    ).toThrow(/名字/);
  });
});
