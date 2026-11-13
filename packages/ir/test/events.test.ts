import { describe, expect, it } from "vitest";
import { clone } from "../src/clone";
import { applyEvent, rebuild, rebuildStates, type ProjectEvent } from "../src/events";
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

  it("改重试上限与超预算处置（H10），其余字段原样保留", () => {
    const project = load();
    const next = applyEvent(project, {
      type: "project.updated",
      at: AT,
      maxAttemptsPerShot: 4,
      onBudgetExceed: "keep",
    });

    expect(next.maxAttemptsPerShot).toBe(4);
    expect(next.onBudgetExceed).toBe("keep");
    expect(next.budgetCny).toBe(project.budgetCny);
    expect(next.shots).toEqual(project.shots);
  });

  it("调色整块替换，不动画面风格与提示词（E4 / ADR-0169）", () => {
    const project = load();
    const next = applyEvent(project, {
      type: "project.updated",
      at: AT,
      grade: {
        presetId: "thriller",
        contrast: "punchy",
        saturation: "muted",
        temperature: "cool",
        vignette: true,
        grain: 0,
        film: "none",
        lutAssetId: "",
        lutName: "",
      },
    });
    expect(next.grade).toEqual({
      presetId: "thriller",
      contrast: "punchy",
      saturation: "muted",
      temperature: "cool",
      vignette: true,
      grain: 0,
      film: "none",
      lutAssetId: "",
      lutName: "",
    });
    // 调色不是风格：look 原样
    expect(next.look).toEqual(project.look);
  });

  it("调色缺省项补齐默认值，越界项拒绝", () => {
    const next = applyEvent(load(), {
      type: "project.updated",
      at: AT,
      grade: {
        presetId: "",
        contrast: "flat",
        saturation: "natural",
        temperature: "neutral",
        vignette: false,
        grain: 0,
        film: "none",
        lutAssetId: "",
        lutName: "",
      },
    });
    expect(next.grade.contrast).toBe("flat");
    expect(() =>
      applyEvent(load(), {
        type: "project.updated",
        at: AT,
        // @ts-expect-error 对比只有三档
        grade: { contrast: "insane" },
      }),
    ).toThrow(/调色不合法/);
  });

  it("画幅整块替换，缺省项补齐默认值（E5 / ADR-0170）", () => {
    const project = load();
    const next = applyEvent(project, {
      type: "project.updated",
      at: AT,
      frame: { aspect: "16:9", fit: "crop" },
    });
    expect(next.frame).toEqual({ aspect: "16:9", fit: "crop" });
    // 画幅不是风格：look 与调色都原样
    expect(next.look).toEqual(project.look);
    expect(next.grade).toEqual(project.grade);

    const partial = applyEvent(project, {
      type: "project.updated",
      at: AT,
      // @ts-expect-error 只给形状，适配方式补默认值
      frame: { aspect: "1:1" },
    });
    expect(partial.frame).toEqual({ aspect: "1:1", fit: "pad" });

    expect(() =>
      applyEvent(load(), {
        type: "project.updated",
        at: AT,
        // @ts-expect-error 画幅只有三种
        frame: { aspect: "4:3" },
      }),
    ).toThrow(/画幅不合法/);
  });

  it("新项目的画幅默认竖屏留边：旧项目重放出来与以前同构", () => {
    expect(load().frame).toEqual({ aspect: "9:16", fit: "pad" });
  });

  it("裁切焦点按镜头存，越界拒绝（E5 / ADR-0170）", () => {
    const project = load();
    const shot = project.shots[0]!;
    const next = applyEvent(project, {
      type: "shot.updated",
      at: AT,
      shotId: shot.id,
      patch: { focus: { x: 0.2, y: 0.8 } },
    });
    expect(next.shots.find((item) => item.id === shot.id)?.focus).toEqual({ x: 0.2, y: 0.8 });
    // 别的镜头不受影响
    expect(next.shots.filter((item) => item.id !== shot.id).every((item) => !item.focus)).toBe(true);

    expect(() =>
      applyEvent(project, {
        type: "shot.updated",
        at: AT,
        shotId: shot.id,
        // 0–1 是运行时的约束，类型上只是个 number：越界要在落库前拦住
        patch: { focus: { x: 1.4, y: 0.5 } },
      }),
    ).toThrow(/裁切焦点不合法/);
  });

  it("重试上限越界或不是整数就拒绝", () => {
    for (const bad of [0, 6, 2.5]) {
      expect(() =>
        applyEvent(load(), { type: "project.updated", at: AT, maxAttemptsPerShot: bad }),
      ).toThrow();
    }
  });

  it("固定模型跟着项目走，取消固定只删那一个模态（H22）", () => {
    const project = load();
    const pinned = applyEvent(project, {
      type: "project.updated",
      at: AT,
      models: { video: "m-video", image: "m-image" },
    });
    expect(pinned.models).toEqual({ video: "m-video", image: "m-image" });
    expect(pinned.shots).toEqual(project.shots);

    const cleared = applyEvent(pinned, {
      type: "project.updated",
      at: AT,
      models: { video: null },
    });
    expect(cleared.models).toEqual({ image: "m-image" });
    expect(pinned.models).toEqual({ video: "m-video", image: "m-image" });
  });

  it("空的模型 id 与不认识的模态都拒绝", () => {
    expect(() =>
      applyEvent(load(), { type: "project.updated", at: AT, models: { video: "" } }),
    ).toThrow();
    expect(() =>
      applyEvent(load(), {
        type: "project.updated",
        at: AT,
        models: { still: "m" } as never,
      }),
    ).toThrow();
  });

  it("超预算处置只接受 block / keep", () => {
    expect(() =>
      applyEvent(load(), {
        type: "project.updated",
        at: AT,
        onBudgetExceed: "ignore" as never,
      }),
    ).toThrow();
  });

  it("什么都没改就拒绝", () => {
    expect(() => applyEvent(load(), { type: "project.updated", at: AT })).toThrow();
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

describe("publish.recorded（G1 / ADR-0102）", () => {
  const pack = {
    id: "pub-1",
    platform: "douyin",
    quality: "final" as const,
    fileName: "夜班-成片.mp4",
    bytes: 8_388_608,
    recordedAt: AT,
    aiLabel: { explicit: true, implicit: true, standard: "AI生成" },
  };

  it("记一条发布记录，回放后还在", () => {
    const base = load();
    const next = applyEvent(base, { type: "publish.recorded", at: AT, package: pack });
    expect(next.publishPackages).toHaveLength(base.publishPackages.length + 1);
    expect(next.publishPackages.at(-1)).toMatchObject({
      id: "pub-1",
      platform: "douyin",
      quality: "final",
      bytes: 8_388_608,
    });
  });

  it("同一 id 不能记两次，缺 AI 标识直接拒绝", () => {
    const once = applyEvent(load(), { type: "publish.recorded", at: AT, package: pack });
    expect(() =>
      applyEvent(once, { type: "publish.recorded", at: AT, package: pack }),
    ).toThrow();
    expect(() =>
      applyEvent(load(), {
        type: "publish.recorded",
        at: AT,
        package: { ...pack, aiLabel: undefined },
      }),
    ).toThrow();
  });

  it("没渲染过成片也可以只有平台与 AI 标识", () => {
    const next = applyEvent(load(), {
      type: "publish.recorded",
      at: AT,
      package: {
        id: "pub-2",
        platform: "generic",
        aiLabel: { explicit: true, implicit: true, standard: "AI生成" },
      },
    });
    expect(next.publishPackages.at(-1)?.fileName).toBeUndefined();
    expect(next.publishPackages.at(-1)?.videoAssetId).toBeUndefined();
  });

  it("渲染耗时随发布记录落进 IR（H4）", () => {
    const next = applyEvent(load(), {
      type: "publish.recorded",
      at: AT,
      package: { ...pack, renderMs: 42_500 },
    });
    expect(next.publishPackages.at(-1)?.renderMs).toBe(42_500);
    // 没记耗时的旧记录读出来照样合法
    expect(
      applyEvent(load(), { type: "publish.recorded", at: AT, package: pack })
        .publishPackages.at(-1)?.renderMs,
    ).toBeUndefined();
  });

  it("内容指纹随 AI 标识落进 IR（H5），旧记录缺它照样合法", () => {
    const next = applyEvent(load(), {
      type: "publish.recorded",
      at: AT,
      package: {
        ...pack,
        aiLabel: { explicit: true, implicit: true, standard: "AI生成", contentHash: "1a2b3c4d" },
      },
    });
    expect(next.publishPackages.at(-1)?.aiLabel?.contentHash).toBe("1a2b3c4d");
    // 不是 8 位十六进制的指纹是坏数据
    expect(() =>
      applyEvent(load(), {
        type: "publish.recorded",
        at: AT,
        package: {
          ...pack,
          aiLabel: { explicit: true, implicit: true, standard: "AI生成", contentHash: "nope" },
        },
      }),
    ).toThrow();
  });
});

describe("publish.updated（G10 / ADR-0166）", () => {
  const pack = {
    id: "pub-ledger",
    platform: "douyin",
    quality: "final" as const,
    fileName: "夜班-成片.mp4",
    bytes: 8_388_608,
    recordedAt: AT,
    aiLabel: { explicit: true, implicit: true, standard: "AI生成", contentHash: "1a2b3c4d" },
  };

  function withPack(): Project {
    return applyEvent(load(), { type: "publish.recorded", at: AT, package: pack });
  }

  it("贴回执只改四项，导出事实原样保留", () => {
    const next = applyEvent(withPack(), {
      type: "publish.updated",
      at: AT,
      packageId: "pub-ledger",
      patch: {
        publishedAt: "2026-11-13 21:04",
        url: "https://www.douyin.com/video/1",
        receipt: "已通过审核",
        note: "主号首发",
      },
    });
    const after = next.publishPackages.at(-1)!;
    expect(after).toMatchObject({
      publishedAt: "2026-11-13 21:04",
      url: "https://www.douyin.com/video/1",
      receipt: "已通过审核",
      note: "主号首发",
    });
    expect(after.platform).toBe("douyin");
    expect(after.quality).toBe("final");
    expect(after.fileName).toBe("夜班-成片.mp4");
    expect(after.bytes).toBe(8_388_608);
    expect(after.aiLabel?.contentHash).toBe("1a2b3c4d");
    // 回放走同一条路径
    expect(rebuild([created(load()), { type: "publish.recorded", at: AT, package: pack }, {
      type: "publish.updated", at: AT, packageId: "pub-ledger", patch: { note: "主号首发" },
    }]).publishPackages.at(-1)?.note).toBe("主号首发");
  });

  it("指向不存在的发布包、空 patch、改别的字段都抛错", () => {
    const base = withPack();
    expect(() =>
      applyEvent(base, { type: "publish.updated", at: AT, packageId: "pub-nope", patch: { note: "x" } }),
    ).toThrow();
    expect(() =>
      applyEvent(base, { type: "publish.updated", at: AT, packageId: "pub-ledger", patch: {} }),
    ).toThrow();
    // 平台与指纹是导出那一刻的事实，不允许回填改
    expect(() =>
      applyEvent(base, {
        type: "publish.updated",
        at: AT,
        packageId: "pub-ledger",
        // @ts-expect-error 故意越界
        patch: { platform: "kuaishou" },
      }),
    ).toThrow();
  });

  it("回执超长在落库前被挡掉", () => {
    expect(() =>
      applyEvent(withPack(), {
        type: "publish.updated",
        at: AT,
        packageId: "pub-ledger",
        patch: { receipt: "x".repeat(201) },
      }),
    ).toThrow();
  });
});

describe("授权记录（H7 / ADR-0167）", () => {
  const record = {
    id: "rights-1",
    subject: "林晚的肖像",
    kind: "portrait" as const,
    targetId: "c-1",
    grantor: "本人",
    grantedAt: "2026-11-01",
    expiresAt: "2027-11-01",
    evidence: "合同 2026-A-07",
    note: "仅本片",
  };

  it("新增一条授权，回放后还在", () => {
    const next = applyEvent(load(), { type: "rights.updated", at: AT, record });
    expect(next.authorizations).toHaveLength(1);
    expect(next.authorizations[0]).toMatchObject({ subject: "林晚的肖像", kind: "portrait" });
    expect(
      rebuild([created(load()), { type: "rights.updated", at: AT, record }]).authorizations,
    ).toHaveLength(1);
  });

  it("同一个 id 再写一次是替换，不追加", () => {
    const once = applyEvent(load(), { type: "rights.updated", at: AT, record });
    const twice = applyEvent(once, {
      type: "rights.updated",
      at: AT,
      record: { ...record, note: "续到 2028" },
    });
    expect(twice.authorizations).toHaveLength(1);
    expect(twice.authorizations[0]?.note).toBe("续到 2028");
  });

  it("缺对象名或字段越界直接拒绝", () => {
    expect(() =>
      applyEvent(load(), { type: "rights.updated", at: AT, record: { ...record, subject: "" } }),
    ).toThrow();
    expect(() =>
      applyEvent(load(), {
        type: "rights.updated",
        at: AT,
        record: { ...record, evidence: "x".repeat(201) },
      }),
    ).toThrow();
    expect(() =>
      applyEvent(load(), {
        type: "rights.updated",
        at: AT,
        // @ts-expect-error 故意用不认识的类型
        record: { ...record, kind: "likeness" },
      }),
    ).toThrow();
  });

  it("删一条只删留档；删不存在的直接拒绝", () => {
    const once = applyEvent(load(), { type: "rights.updated", at: AT, record });
    const removed = applyEvent(once, { type: "rights.removed", at: AT, rightsId: "rights-1" });
    expect(removed.authorizations).toHaveLength(0);
    // 角色与素材不动
    expect(removed.characters).toEqual(once.characters);
    expect(removed.assets).toEqual(once.assets);
    expect(() =>
      applyEvent(once, { type: "rights.removed", at: AT, rightsId: "rights-nope" }),
    ).toThrow();
  });
});

describe("Provenance 的用量与金额（H4）", () => {
  it("故事溯源能带 token 用量与这一笔的钱", () => {
    const base = load();
    const next = ProjectSchema.parse({
      ...base,
      story: {
        ...base.story,
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
    expect(next.story.provenance?.costCny).toBe(0.03);
    expect(next.story.provenance?.usage).toEqual({ units: 15_000, unit: "tokens" });
  });

  it("金额与用量缺省时合法：不知道多少钱不是错误", () => {
    const base = load();
    const next = ProjectSchema.parse({
      ...base,
      story: {
        ...base.story,
        provenance: {
          modelId: "m",
          referenceAssetIds: [],
          createdAt: AT,
        },
      },
    });
    expect(next.story.provenance?.costCny).toBeUndefined();
    expect(next.story.provenance?.usage).toBeUndefined();
  });
});

describe("Project.maxAttemptsPerShot / onBudgetExceed（H10）", () => {
  it("老快照没有这两个字段时取默认值：最多试 3 次、超预算阻断", () => {
    const parsed = ProjectSchema.parse({
      ...clone(minimalJson),
      maxAttemptsPerShot: undefined,
      onBudgetExceed: undefined,
    });
    expect(parsed.maxAttemptsPerShot).toBe(3);
    expect(parsed.onBudgetExceed).toBe("block");
  });

  it("重试上限只能是 1–5 的整数", () => {
    expect(() =>
      ProjectSchema.parse({ ...clone(minimalJson), maxAttemptsPerShot: 6 }),
    ).toThrow();
    expect(() =>
      ProjectSchema.parse({ ...clone(minimalJson), maxAttemptsPerShot: 0 }),
    ).toThrow();
  });

  it("超预算处置只接受 block / keep", () => {
    expect(() =>
      ProjectSchema.parse({ ...clone(minimalJson), onBudgetExceed: "retry" }),
    ).toThrow();
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

describe("配音（ADR-0085）", () => {
  const audioAsset = {
    id: "a-voice-dl-1",
    kind: "audio" as const,
    source: "generated" as const,
    uri: "data:audio/mpeg;base64,SUQz",
    mime: "audio/mpeg",
    durationMs: 1400,
    createdAt: AT,
  };

  it("挂上配音资产：重放后台词指向它，时长仍在", () => {
    const project = load();
    const event: ProjectEvent = {
      type: "dialogue.updated",
      at: AT,
      lineId: "dl-1",
      patch: { audioAssetId: audioAsset.id },
    };
    const after = rebuild([
      created(project),
      { type: "asset.updated", at: AT, asset: audioAsset },
      event,
    ]);

    expect(after.dialogue.find((line) => line.id === "dl-1")).toMatchObject({
      audioAssetId: "a-voice-dl-1",
      durationMs: 2000,
    });
  });

  it("挂一个不存在或不是音频的资产都拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "dialogue.updated",
        at: AT,
        lineId: "dl-1",
        patch: { audioAssetId: "a-nope" },
      }),
    ).toThrow(/不存在的配音资产/);

    // 现有的第一张图不是音频
    const imageId = project.assets[0]?.id;
    expect(imageId).toBeTruthy();
    expect(() =>
      applyEvent(project, {
        type: "dialogue.updated",
        at: AT,
        lineId: "dl-1",
        patch: { audioAssetId: imageId },
      }),
    ).toThrow(/不是音频/);
  });

  it("给人物指定音色；空串表示用回默认音色", () => {
    const project = load();
    const picked = applyEvent(project, {
      type: "character.updated",
      at: AT,
      characterId: "c-zhou",
      patch: { voiceProfileId: "Cherry" },
    });
    expect(picked.characters.find((item) => item.id === "c-zhou")?.voiceProfileId).toBe(
      "Cherry",
    );

    const cleared = applyEvent(picked, {
      type: "character.updated",
      at: AT,
      characterId: "c-lin",
      patch: { voiceProfileId: "" },
    });
    expect(cleared.characters.find((item) => item.id === "c-lin")).not.toHaveProperty(
      "voiceProfileId",
    );
    expect(rebuild([created(project), {
      type: "character.updated",
      at: AT,
      characterId: "c-zhou",
      patch: { voiceProfileId: "Cherry" },
    }])).toEqual(picked);
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
        { id: "sc-b", index: 1, locationId: "loc-living", space: "int", timeOfDay: "day", shotIds: [], code: "" },
        { id: "sc-c", index: 2, locationId: "loc-living", space: "int", timeOfDay: "night", shotIds: [], code: "" },
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

describe("显式场号（ADR-0080）", () => {
  const twoScenes = (): Project => {
    const base = load();
    return {
      ...base,
      scenes: [
        base.scenes[0]!,
        {
          id: "sc-b",
          index: 1,
          locationId: "loc-living",
          space: "int",
          timeOfDay: "day",
          shotIds: [],
          code: "",
        },
      ],
    };
  };

  it("写一个显式场号：重放后一致；空串表示回到顺序号", () => {
    const project = twoScenes();
    const set: ProjectEvent = {
      type: "scene.updated",
      at: AT,
      sceneId: "sc-1",
      patch: { code: "2A" },
    };
    const after = applyEvent(project, set);
    expect(after.scenes[0]?.code).toBe("2A");
    expect(rebuild([created(project), set])).toEqual(after);

    const cleared = applyEvent(after, {
      type: "scene.updated",
      at: AT,
      sceneId: "sc-1",
      patch: { code: "" },
    });
    expect(cleared.scenes[0]?.code).toBe("");
  });

  it("不合法的场号、重复的场号都拒绝", () => {
    const project = applyEvent(twoScenes(), {
      type: "scene.updated",
      at: AT,
      sceneId: "sc-b",
      patch: { code: "3" },
    });
    for (const code of ["2A场", "ABCDE", "2 A", "-1"]) {
      expect(() =>
        applyEvent(project, {
          type: "scene.updated",
          at: AT,
          sceneId: "sc-1",
          patch: { code },
        }),
      ).toThrow(/场号/);
    }
    expect(() =>
      applyEvent(project, {
        type: "scene.updated",
        at: AT,
        sceneId: "sc-1",
        patch: { code: "3" },
      }),
    ).toThrow(/重复/);
  });

  it("旧项目没有 code：回放补成空串", () => {
    const project = load();
    expect(project.scenes[0]?.code).toBe("");
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
        code: "",
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
        staging: [],
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
      code: "",
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
      staging: [],
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
        code: "",
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
        staging: [],
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
      code: "",
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
      staging: [],
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

describe("character.removed / prop.removed（ADR-0073）", () => {
  it("删掉没被引用的人物，重放后一致", () => {
    const project = load();
    const added: ProjectEvent = {
      type: "character.added",
      at: AT,
      character: {
        id: "cha-tang",
        name: "阿棠",
        appearance: "",
        sheet: {},
        referenceImages: [],
        mustNotChange: [],
      },
    };
    const removed: ProjectEvent = { type: "character.removed", at: AT, characterId: "cha-tang" };
    const after = rebuild([created(project), added, removed]);
    expect(after.characters.map((item) => item.id)).toEqual(project.characters.map((item) => item.id));
    expect(validateProject(after)).toEqual([]);
  });

  it("还点着这个人、或还有台词属于他时拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, { type: "character.removed", at: AT, characterId: "c-lin" }),
    ).toThrow(/点着这个人/);

    const withoutCast: ProjectEvent = {
      type: "shot.updated",
      at: AT,
      shotId: "sh-1",
      patch: { characterIds: [] },
    };
    const noCast = applyEvent(project, withoutCast);
    expect(() =>
      applyEvent(noCast, { type: "character.removed", at: AT, characterId: "c-lin" }),
    ).toThrow(/句台词属于这个人/);
  });

  it("删一件没被镜头用着的道具；被用着时拒绝", () => {
    const project = load();
    const added: ProjectEvent = {
      type: "prop.added",
      at: AT,
      prop: { id: "prop-key", name: "旧钥匙", description: "", referenceImages: [] },
    };
    const removed: ProjectEvent = { type: "prop.removed", at: AT, propId: "prop-key" };
    const after = rebuild([created(project), added, removed]);
    expect(after.props).toEqual(project.props);
    expect(validateProject(after)).toEqual([]);

    const used: ProjectEvent = {
      type: "shot.updated",
      at: AT,
      shotId: "sh-1",
      patch: { propIds: ["prop-key"] },
    };
    const inUse = rebuild([created(project), added, used]);
    expect(() =>
      applyEvent(inUse, { type: "prop.removed", at: AT, propId: "prop-key" }),
    ).toThrow(/用着这件道具/);
  });
});

describe("shot.updated 携带表演与调度（B16 / B17 / ADR-0103）", () => {
  it("写入表演设计：补默认值，重放后一致", () => {
    const project = load();
    const event: ProjectEvent = {
      type: "shot.updated",
      at: AT,
      shotId: "sh-1",
      patch: {
        performance: {
          objective: "让她留下来",
          gaze: { target: "character", targetId: "c-zhou", direction: "left" },
        } as never,
      },
    };
    const after = applyEvent(project, event);
    const performance = after.shots.find((shot) => shot.id === "sh-1")?.performance;
    expect(performance).toMatchObject({
      objective: "让她留下来",
      emotion: { surface: "", subtext: "" },
      intensity: 3,
      avoid: [],
      beats: [],
      gaze: { target: "character", targetId: "c-zhou", direction: "left" },
    });
    expect(rebuild([created(project), event])).toEqual(after);
  });

  it("看人却没给 id：拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "shot.updated",
        at: AT,
        shotId: "sh-1",
        patch: { performance: { objective: "x", gaze: { target: "character", direction: "left" } } as never },
      }),
    ).toThrow(/看人 \/ 看道具/);
  });

  it("看镜头却带了 id：拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "shot.updated",
        at: AT,
        shotId: "sh-1",
        patch: {
          performance: {
            objective: "x",
            gaze: { target: "camera", targetId: "c-lin", direction: "center" },
          } as never,
        },
      }),
    ).toThrow(/不该带 id/);
  });

  it("表演节拍结束时间早于开始：拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "shot.updated",
        at: AT,
        shotId: "sh-1",
        patch: {
          performance: {
            objective: "x",
            gaze: { target: "camera", direction: "center" },
            beats: [
              { phase: "before", micro: "", body: "", startMs: 900, endMs: 300 },
            ],
          } as never,
        },
      }),
    ).toThrow(/结束时间/);
  });

  it("写入镜头调度并重放；角色与道具同时挂：拒绝", () => {
    const project = load();
    const event: ProjectEvent = {
      type: "shot.updated",
      at: AT,
      shotId: "sh-1",
      patch: {
        staging: [{ characterId: "c-lin", side: "left", depth: "foreground", note: "" }],
      },
    };
    const after = applyEvent(project, event);
    expect(after.shots.find((shot) => shot.id === "sh-1")?.staging).toEqual([
      { characterId: "c-lin", side: "left", depth: "foreground", note: "" },
    ]);
    expect(rebuild([created(project), event])).toEqual(after);

    expect(() =>
      applyEvent(project, {
        type: "shot.updated",
        at: AT,
        shotId: "sh-1",
        patch: {
          staging: [{ characterId: "c-lin", propId: "p-x", side: "left", depth: "foreground", note: "" }],
        },
      }),
    ).toThrow(/只挂一个/);
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

  it("挂参考图：写进 referenceImages，重复与不存在的资产都拒绝（B8）", () => {
    const project = load();
    const locationId = project.locations[0]!.id;
    const assetId = project.assets.find((asset) => asset.kind === "image")?.id;
    expect(assetId).toBeTruthy();
    const after = applyEvent(project, {
      type: "location.updated",
      at: AT,
      locationId,
      patch: { referenceImages: [assetId!] },
    });
    expect(after.locations.find((item) => item.id === locationId)?.referenceImages).toEqual([
      assetId,
    ]);

    expect(() =>
      applyEvent(project, {
        type: "location.updated",
        at: AT,
        locationId,
        patch: { referenceImages: [assetId!, assetId!] },
      }),
    ).toThrow();
    expect(() =>
      applyEvent(project, {
        type: "location.updated",
        at: AT,
        locationId,
        patch: { referenceImages: ["a-nope"] },
      }),
    ).toThrow();
  });

  it("旧项目没有 description，解析时补空串", () => {
    // minimal.json 写在这个字段之前：回放不该因为缺字段炸掉
    expect(load().locations[0]!.description).toBe("");
  });

  it("重复的 id、空名字、不存在的地点、空 patch 都拒绝", () => {
    const project = load();
    const existing = project.locations[0]!;    expect(() =>
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

describe("character.updated · mustNotChange（ADR-0074）", () => {
  it("整份替换清单：重放后一致，其它字段不动", () => {
    const project = load();
    const before = project.characters[0]!;
    const event: ProjectEvent = {
      type: "character.updated",
      at: AT,
      characterId: before.id,
      patch: { mustNotChange: ["左眼下的痣", "左手腕一道旧疤"] },
    };
    const after = rebuild([created(project), event]);
    expect(after.characters[0]).toMatchObject({
      name: before.name,
      appearance: before.appearance,
      mustNotChange: ["左眼下的痣", "左手腕一道旧疤"],
    });
    expect(validateProject(after)).toEqual([]);
  });

  it("清空清单是合法的", () => {
    const project = load();
    const before = project.characters[0]!;
    const after = rebuild([
      created(project),
      {
        type: "character.updated",
        at: AT,
        characterId: before.id,
        patch: { mustNotChange: [] },
      },
    ]);
    expect(after.characters[0]!.mustNotChange).toEqual([]);
  });

  it("空条目、重复条目、过长、过多都拒绝", () => {
    const project = load();
    const characterId = project.characters[0]!.id;
    const update = (mustNotChange: string[]): ProjectEvent => ({
      type: "character.updated",
      at: AT,
      characterId,
      patch: { mustNotChange },
    });
    expect(() => applyEvent(project, update([" "]))).toThrow(/空条目/);
    expect(() => applyEvent(project, update(["痣", "痣"]))).toThrow(/重复条目/);
    expect(() => applyEvent(project, update(["字".repeat(61)]))).toThrow(/超过 60 字/);
    expect(() =>
      applyEvent(project, update(Array.from({ length: 21 }, (_, i) => `第 ${i} 条`))),
    ).toThrow(/超过 20 条/);
  });
});

describe("referenceImages（ADR-0079）", () => {
  it("人物：整份替换参考图，重放一致", () => {
    const project = load();
    const events = [
      created(project),
      {
        type: "character.updated" as const,
        at: AT,
        characterId: "c-lin",
        patch: { referenceImages: ["a-zhou-front", "a-lin-34"] },
      },
    ];
    const next = rebuild(events);
    const lin = next.characters.find((item) => item.id === "c-lin")!;
    expect(lin.referenceImages).toEqual(["a-zhou-front", "a-lin-34"]);
    expect(rebuild(events)).toEqual(next);
  });

  it("道具：同样整份写回，清空也允许", () => {
    // minimal 里没有道具，先补一个空的 props 表
    const base = ProjectSchema.parse({ ...clone(minimalJson), props: [] });
    const events = [
      created(base),
      {
        type: "prop.added" as const,
        at: AT,
        prop: {
          id: "p-1",
          name: "台灯",
          description: "",
          referenceImages: ["a-lin-34"],
        },
      },
      { type: "prop.updated" as const, at: AT, propId: "p-1", patch: { referenceImages: [] } },
    ];
    const lamp = rebuild(events).props.find((item) => item.id === "p-1")!;
    expect(lamp.referenceImages).toEqual([]);
  });

  it("不存在的资产、重复的资产都拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "character.updated",
        at: AT,
        characterId: "c-lin",
        patch: { referenceImages: ["a-nope"] },
      }),
    ).toThrow(/不存在的资产/);
    expect(() =>
      applyEvent(project, {
        type: "character.updated",
        at: AT,
        characterId: "c-lin",
        patch: { referenceImages: ["a-cup", "a-cup"] },
      }),
    ).toThrow(/重复/);
  });
});

describe("时间线（ADR-0086）", () => {
  it("整条替换：重放后与写入一致", () => {
    const project = load();
    const events = [
      created(project),
      {
        type: "timeline.updated" as const,
        at: AT,
        items: [
          { id: "ti-2", shotId: "sh-2", takeId: "take-2", startMs: 0, durationMs: 3500 },
          { id: "ti-1", shotId: "sh-1", takeId: "take-1", startMs: 3500, durationMs: 2500 },
        ],
      },
    ];
    const next = rebuild(events);
    expect(next.timeline.items.map((item) => item.id)).toEqual(["ti-2", "ti-1"]);
    expect(rebuild(events)).toEqual(next);
  });

  it("take 必须存在且属于这一镜", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "timeline.updated",
        at: AT,
        items: [{ id: "ti-x", shotId: "sh-1", takeId: "take-2", startMs: 0, durationMs: 2500 }],
      }),
    ).toThrow(/不属于镜头/);
    expect(() =>
      applyEvent(project, {
        type: "timeline.updated",
        at: AT,
        items: [{ id: "ti-x", shotId: "sh-1", takeId: "take-nope", startMs: 0, durationMs: 2500 }],
      }),
    ).toThrow(/不存在或不属于/);
  });

  it("片段不得重叠，id 不得重复", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "timeline.updated",
        at: AT,
        items: [
          { id: "ti-1", shotId: "sh-1", takeId: "take-1", startMs: 0, durationMs: 2500 },
          { id: "ti-2", shotId: "sh-2", takeId: "take-2", startMs: 2400, durationMs: 3500 },
        ],
      }),
    ).toThrow(/重叠/);
    expect(() =>
      applyEvent(project, {
        type: "timeline.updated",
        at: AT,
        items: [
          { id: "ti-1", shotId: "sh-1", takeId: "take-1", startMs: 0, durationMs: 2500 },
          { id: "ti-1", shotId: "sh-2", takeId: "take-2", startMs: 2500, durationMs: 3500 },
        ],
      }),
    ).toThrow(/重复/);
  });

  it("转场挂在后一段上，重放后逐项一致（E4 / ADR-0169）", () => {
    const project = load();
    const next = applyEvent(project, {
      type: "timeline.updated",
      at: AT,
      items: [
        { id: "ti-1", shotId: "sh-1", takeId: "take-1", startMs: 0, durationMs: 2500 },
        {
          id: "ti-2",
          shotId: "sh-2",
          takeId: "take-2",
          startMs: 2500,
          durationMs: 3500,
          transitionIn: { kind: "white", durationMs: 300 },
        },
      ],
    });
    expect(next.timeline.items[1]!.transitionIn).toEqual({ kind: "white", durationMs: 300 });
    expect(next.timeline.items[0]!.transitionIn).toBeUndefined();
  });

  it("转场颜色不认识、或比这一段的一半还长，都拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "timeline.updated",
        at: AT,
        items: [
          { id: "ti-1", shotId: "sh-1", takeId: "take-1", startMs: 0, durationMs: 2500 },
          {
            id: "ti-2",
            shotId: "sh-2",
            takeId: "take-2",
            startMs: 2500,
            durationMs: 3500,
            // @ts-expect-error 颜色只有黑白两种
            transitionIn: { kind: "rainbow", durationMs: 300 },
          },
        ],
      }),
    ).toThrow(/转场不合法/);

    expect(() =>
      applyEvent(project, {
        type: "timeline.updated",
        at: AT,
        items: [
          { id: "ti-1", shotId: "sh-1", takeId: "take-1", startMs: 0, durationMs: 2500 },
          {
            id: "ti-2",
            shotId: "sh-2",
            takeId: "take-2",
            startMs: 2500,
            durationMs: 500,
            transitionIn: { kind: "black", durationMs: 400 },
          },
        ],
      }),
    ).toThrow(/一半/);
  });

  it("时长必须为正、起点不得为负", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "timeline.updated",
        at: AT,
        items: [{ id: "ti-1", shotId: "sh-1", takeId: "take-1", startMs: -1, durationMs: 2500 }],
      }),
    ).toThrow(/起点/);
    expect(() =>
      applyEvent(project, {
        type: "timeline.updated",
        at: AT,
        items: [{ id: "ti-1", shotId: "sh-1", takeId: "take-1", startMs: 0, durationMs: 0 }],
      }),
    ).toThrow(/时长/);
  });
});

describe("配乐（C4 / C12）", () => {
  const musicAsset = {
    id: "a-music-bed",
    kind: "audio" as const,
    source: "upload" as const,
    uri: "data:audio/mpeg;base64,SUQz",
    mime: "audio/mpeg",
    durationMs: 30_000,
    createdAt: AT,
  };

  const cue = {
    id: "mc-1",
    assetId: musicAsset.id,
    title: "夜班主题",
    mood: "克制",
    startMs: 0,
    durationMs: 6000,
    gainDb: -18,
    duckDb: 15,
    ducking: true,
    loop: true,
    role: "bed" as const,
    licenseRef: "自有素材",
  };

  function withMusic(): Project {
    return rebuild([
      created(load()),
      { type: "asset.updated", at: AT, asset: musicAsset },
    ]);
  }

  it("整条替换：重放后与写入一致，清空也走同一条事件", () => {
    const project = withMusic();
    const events: ProjectEvent[] = [
      created(load()),
      { type: "asset.updated", at: AT, asset: musicAsset },
      { type: "timeline.music.updated", at: AT, music: [cue] },
    ];
    const next = rebuild(events);
    expect(next.timeline.music).toEqual([cue]);
    expect(rebuild(events)).toEqual(next);

    const cleared = applyEvent(next, {
      type: "timeline.music.updated",
      at: AT,
      music: [],
    });
    expect(cleared.timeline.music).toEqual([]);
    expect(cleared.timeline.items).toEqual(project.timeline.items);
  });

  it("换 take 不顺手清掉配乐", () => {
    const project = withMusic();
    const withCue = applyEvent(project, {
      type: "timeline.music.updated",
      at: AT,
      music: [cue],
    });
    const reordered = applyEvent(withCue, {
      type: "timeline.updated",
      at: AT,
      items: [
        { id: "ti-2", shotId: "sh-2", takeId: "take-2", startMs: 0, durationMs: 3500 },
        { id: "ti-1", shotId: "sh-1", takeId: "take-1", startMs: 3500, durationMs: 2500 },
      ],
    });
    expect(reordered.timeline.music).toEqual([cue]);
  });

  it("必须挂到存在的音频资产；图片与不存在的资产都拒绝", () => {
    const project = withMusic();
    const imageId = project.assets.find((asset) => asset.kind === "image")!.id;
    expect(() =>
      applyEvent(project, {
        type: "timeline.music.updated",
        at: AT,
        music: [{ ...cue, assetId: imageId }],
      }),
    ).toThrow(/没有挂到音频资产/);
    expect(() =>
      applyEvent(project, {
        type: "timeline.music.updated",
        at: AT,
        music: [{ ...cue, assetId: "a-nope" }],
      }),
    ).toThrow(/没有挂到音频资产/);
  });

  it("授权备注不能空着", () => {
    const project = withMusic();
    expect(() =>
      applyEvent(project, {
        type: "timeline.music.updated",
        at: AT,
        music: [{ ...cue, licenseRef: "   " }],
      }),
    ).toThrow(/缺少授权备注/);
  });

  it("id 不得重复，起点必须在成片之内", () => {
    const project = withMusic();
    expect(() =>
      applyEvent(project, {
        type: "timeline.music.updated",
        at: AT,
        music: [cue, { ...cue }],
      }),
    ).toThrow(/重复/);
    expect(() =>
      applyEvent(project, {
        type: "timeline.music.updated",
        at: AT,
        music: [{ ...cue, startMs: 6000 }],
      }),
    ).toThrow(/成片之外/);
  });

  it("起点、时长、增益与 ducking 深度都按混音口径卡住", () => {
    const project = withMusic();
    expect(() =>
      applyEvent(project, {
        type: "timeline.music.updated",
        at: AT,
        music: [{ ...cue, startMs: -1 }],
      }),
    ).toThrow(/起点不合法/);
    expect(() =>
      applyEvent(project, {
        type: "timeline.music.updated",
        at: AT,
        music: [{ ...cue, durationMs: 0 }],
      }),
    ).toThrow(/时长不合法/);
    expect(() =>
      applyEvent(project, {
        type: "timeline.music.updated",
        at: AT,
        music: [{ ...cue, gainDb: 3 }],
      }),
    ).toThrow(/增益/);
    expect(() =>
      applyEvent(project, {
        type: "timeline.music.updated",
        at: AT,
        music: [{ ...cue, duckDb: 20 }],
      }),
    ).toThrow(/ducking/);
  });
});

describe("音效层与三路平衡（C7 / ADR-0184）", () => {
  const sfxAsset = {
    id: "a-sfx-door",
    kind: "audio" as const,
    source: "upload" as const,
    uri: "data:audio/wav;base64,UklGRg==",
    mime: "audio/wav",
    durationMs: 900,
    createdAt: AT,
  };

  const cue = {
    id: "sfx-1",
    assetId: sfxAsset.id,
    title: "关门",
    startMs: 1200,
    durationMs: 900,
    gainDb: -10,
    loop: false,
    role: "foley" as const,
    licenseRef: "自己录制",
  };

  function withSfx(): Project {
    return rebuild([
      created(load()),
      { type: "asset.updated", at: AT, asset: sfxAsset },
    ]);
  }

  it("整条替换：重放后与写入一致，缺省项补齐", () => {
    const project = withSfx();
    const next = applyEvent(project, {
      type: "timeline.sfx.updated",
      at: AT,
      // @ts-expect-error 只给必要项，增益 / 循环 / 类型靠 schema 补默认值
      sfx: [{ id: cue.id, assetId: cue.assetId, title: cue.title, startMs: cue.startMs, durationMs: cue.durationMs, licenseRef: cue.licenseRef }],
    });
    expect(next.timeline.sfx).toEqual([
      {
        id: cue.id,
        assetId: cue.assetId,
        title: cue.title,
        startMs: cue.startMs,
        durationMs: cue.durationMs,
        gainDb: -12,
        loop: false,
        role: "foley",
        licenseRef: cue.licenseRef,
      },
    ]);
    expect(next.timeline.music).toEqual(project.timeline.music);
  });

  it("音效与配乐互不覆盖", () => {
    const project = withSfx();
    const withCue = applyEvent(project, {
      type: "timeline.sfx.updated",
      at: AT,
      sfx: [cue],
    });
    const musicAsset = {
      id: "a-music-bed-2",
      kind: "audio" as const,
      source: "upload" as const,
      uri: "data:audio/mpeg;base64,SUQz",
      mime: "audio/mpeg",
      durationMs: 30_000,
      createdAt: AT,
    };
    const withAsset = applyEvent(withCue, { type: "asset.updated", at: AT, asset: musicAsset });
    const withMusic = applyEvent(withAsset, {
      type: "timeline.music.updated",
      at: AT,
      music: [
        {
          id: "mc-9",
          assetId: musicAsset.id,
          title: "床",
          mood: "",
          startMs: 0,
          durationMs: 6000,
          gainDb: -18,
          duckDb: 15,
          ducking: true,
          loop: true,
          role: "bed",
          licenseRef: "自有",
        },
      ],
    });
    expect(withMusic.timeline.sfx).toEqual([cue]);
    expect(withMusic.timeline.music).toHaveLength(1);
  });

  it("挂音频资产、写授权、起点在成片内、增益在 −40–0 dB", () => {
    const project = withSfx();
    const imageId = project.assets.find((asset) => asset.kind === "image")!.id;
    expect(() =>
      applyEvent(project, {
        type: "timeline.sfx.updated",
        at: AT,
        sfx: [{ ...cue, assetId: imageId }],
      }),
    ).toThrow(/没有挂到音频资产/);
    expect(() =>
      applyEvent(project, {
        type: "timeline.sfx.updated",
        at: AT,
        sfx: [{ ...cue, licenseRef: " " }],
      }),
    ).toThrow(/缺少授权备注/);
    expect(() =>
      applyEvent(project, {
        type: "timeline.sfx.updated",
        at: AT,
        sfx: [{ ...cue, startMs: 6000 }],
      }),
    ).toThrow(/成片之外/);
    expect(() =>
      applyEvent(project, {
        type: "timeline.sfx.updated",
        at: AT,
        sfx: [{ ...cue, gainDb: 2 }],
      }),
    ).toThrow(/增益/);
  });

  it("三路平衡整块替换，越界拒绝", () => {
    const project = load();
    const next = applyEvent(project, {
      type: "timeline.mix.updated",
      at: AT,
      mix: { dialogueDb: 2, musicDb: -6, sfxDb: 0 },
    });
    expect(next.timeline.mix).toEqual({ dialogueDb: 2, musicDb: -6, sfxDb: 0 });
    expect(() =>
      applyEvent(project, {
        type: "timeline.mix.updated",
        at: AT,
        // @ts-expect-error 三路都只有 ±12 dB
        mix: { dialogueDb: 13, musicDb: 0, sfxDb: 0 },
      }),
    ).toThrow(/三路平衡不合法/);
  });

  it("旧日志重放出来的音效层与平衡是空 / 0", () => {
    const project = load();
    expect(project.timeline.sfx).toEqual([]);
    expect(project.timeline.mix).toEqual({ dialogueDb: 0, musicDb: 0, sfxDb: 0 });
  });
});

describe("阶段闸门与单镜预算（F8 / F9 / H10）", () => {
  it("旧项目没有 gates 时按空数组补齐", () => {
    const project = load();
    expect(project.gates).toEqual([]);
  });

  it("确认一个阶段写一条记录，同阶段再确认按阶段覆盖", () => {
    const project = load();
    const first = applyEvent(project, {
      type: "gate.confirmed",
      at: AT,
      stage: "story",
      signature: "1a2b3c4d",
      note: "故事定了",
    });
    expect(first.gates).toEqual([
      { stage: "story", signature: "1a2b3c4d", at: AT, note: "故事定了", override: false },
    ]);

    const second = applyEvent(first, {
      type: "gate.confirmed",
      at: "2026-11-10T09:00:00Z",
      stage: "story",
      signature: "deadbeef",
    });
    expect(second.gates).toHaveLength(1);
    expect(second.gates[0]!.signature).toBe("deadbeef");
    expect(second.gates[0]!.note).toBe("");
  });

  it("回退阶段只删这一阶段的记录", () => {
    const project = load();
    const confirmed = rebuild([
      created(project),
      { type: "gate.confirmed", at: AT, stage: "story", signature: "1a2b3c4d" },
      { type: "gate.confirmed", at: AT, stage: "script", signature: "0f0f0f0f" },
      { type: "gate.reopened", at: AT, stage: "story" },
    ]);
    expect(confirmed.gates.map((gate) => gate.stage)).toEqual(["script"]);
  });

  it("签名必须像 8 位十六进制，备注不超过 240 字", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "gate.confirmed",
        at: AT,
        stage: "story",
        signature: "nope",
      }),
    ).toThrow(/8 位十六进制/);
    expect(() =>
      applyEvent(project, {
        type: "gate.confirmed",
        at: AT,
        stage: "story",
        signature: "1a2b3c4d",
        note: "长".repeat(241),
      }),
    ).toThrow(/240/);
  });

  it("带条件确认记下 override，缺省是 false（A12）", () => {
    const project = load();
    const plain = applyEvent(project, {
      type: "gate.confirmed",
      at: AT,
      stage: "storyboard",
      signature: "1a2b3c4d",
    });
    expect(plain.gates[0]!.override).toBe(false);

    const overridden = applyEvent(project, {
      type: "gate.confirmed",
      at: AT,
      stage: "storyboard",
      signature: "1a2b3c4d",
      override: true,
    });
    expect(overridden.gates[0]!.override).toBe(true);
  });

  it("单镜预算必须是正数；可以清空回默认", () => {
    const project = load();
    const capped = applyEvent(project, {
      type: "shot.updated",
      at: AT,
      shotId: "sh-1",
      patch: { budgetCny: 8 },
    });
    expect(capped.shots[0]!.budgetCny).toBe(8);

    const cleared = applyEvent(capped, {
      type: "shot.updated",
      at: AT,
      shotId: "sh-1",
      patch: { budgetCny: undefined },
    });
    expect(cleared.shots[0]!.budgetCny).toBeUndefined();
  });

  it("0 或负数不是「取消上限」，直接拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "shot.updated",
        at: AT,
        shotId: "sh-1",
        patch: { budgetCny: 0 },
      }),
    ).toThrow(/大于 0/);
  });
});

describe("全局回滚（F2 / ADR-0109）", () => {
  it("rebuild 回到前缀那一步，预算跟着回去", () => {
    const project = load();
    const original = project.budgetCny;
    const events: ProjectEvent[] = [
      created(project),
      { type: "project.updated", at: AT, budgetCny: 120 },
      { type: "project.restored", at: AT, toEventCount: 1, label: "回到起点" },
    ];
    expect(rebuild(events).budgetCny).toBe(original);
  });

  it("回滚之后还能继续改：新事件写在新状态上，再回滚还能回到中间那一步", () => {
    const project = load();
    const events: ProjectEvent[] = [
      created(project),
      { type: "project.updated", at: AT, budgetCny: 120 },
      { type: "project.restored", at: AT, toEventCount: 1 },
      { type: "project.updated", at: AT, budgetCny: 90 },
      // 回滚到「第 3 条之后」＝ 已经回滚过的那个状态
      { type: "project.restored", at: AT, toEventCount: 3 },
    ];
    expect(rebuild(events).budgetCny).toBe(project.budgetCny);

    const reopened: ProjectEvent[] = events.slice(0, 3);
    expect(rebuild(reopened).budgetCny).toBe(project.budgetCny);
    const latest: ProjectEvent[] = [...events.slice(0, 4)];
    expect(rebuild(latest).budgetCny).toBe(90);
  });

  it("回滚之后按镜头改的东西一并回去，镜头数不变", () => {
    const project = load();
    const before = project.shots[0]!;
    const events: ProjectEvent[] = [
      created(project),
      { type: "shot.updated", at: AT, shotId: "sh-1", patch: { description: "改过的动作" } },
      { type: "project.restored", at: AT, toEventCount: 1 },
    ];
    const restored = rebuild(events);
    expect(restored.shots).toHaveLength(project.shots.length);
    expect(restored.shots[0]!.description).toBe(before.description);
  });

  it("目标越界或指向未来都直接报错", () => {
    const project = load();
    expect(() =>
      rebuild([
        created(project),
        { type: "project.restored", at: AT, toEventCount: 0 },
      ]),
    ).toThrow(/目标不合法/);
    expect(() =>
      rebuild([
        created(project),
        { type: "project.restored", at: AT, toEventCount: 2 },
      ]),
    ).toThrow(/目标不合法/);
    expect(() =>
      rebuild([
        created(project),
        { type: "project.restored", at: AT, toEventCount: 1.5 },
      ]),
    ).toThrow(/目标不合法/);
  });

  it("单条 applyEvent 应用不了回滚：必须整条日志", () => {
    expect(() =>
      applyEvent(load(), { type: "project.restored", at: AT, toEventCount: 1 }),
    ).toThrow(/rebuild/);
  });
});

describe("删一拍 take（B5）", () => {
  it("摘掉 take、镜头上的引用与时间线片段，资产留着", () => {
    const project = load();
    const take = makeTake();
    const before = project.assets.length;
    const withTake = rebuild([
      created(project),
      { type: "take.added", at: AT, take },
    ]);
    // 先给它排进时间线，验证片段一起被摘掉
    const timed: ProjectEvent = {
      type: "timeline.updated",
      at: AT,
      items: [{ id: "ti-1", shotId: take.shotId, takeId: take.id, startMs: 0, durationMs: 1000 }],
    };
    const after = rebuild([
      created(project),
      { type: "take.added", at: AT, take },
      timed,
      { type: "take.removed", at: AT, takeId: take.id },
    ]);

    expect(withTake.shots[0]!.takeIds).toContain(take.id);
    // 示例项目自带的 take 不受影响，只少掉刚删的那一拍
    expect(after.takes.map((item) => item.id)).not.toContain(take.id);
    expect(after.takes).toHaveLength(project.takes.length);
    expect(after.shots[0]!.takeIds).not.toContain(take.id);
    expect(after.timeline.items).toHaveLength(0);
    // 资产是另一件事：删 take 不回收素材（F4）
    expect(after.assets).toHaveLength(before);
  });

  it("指向不存在的 take 直接报错", () => {
    expect(() =>
      applyEvent(load(), { type: "take.removed", at: AT, takeId: "take-nope" }),
    ).toThrow(/不存在的 take/);
  });

  it("只删指定的一拍，同镜其他 take 不动", () => {
    const project = load();
    const a = makeTake();
    const b = { ...makeTake(), id: "take-4" };
    const after = rebuild([
      created(project),
      { type: "take.added", at: AT, take: a },
      { type: "take.added", at: AT, take: b },
      { type: "take.removed", at: AT, takeId: a.id },
    ]);
    const ids = after.takes.map((item) => item.id);
    expect(ids).not.toContain(a.id);
    expect(ids).toContain(b.id);
    expect(after.shots[0]!.takeIds).not.toContain(a.id);
    expect(after.shots[0]!.takeIds).toContain(b.id);
  });
});

describe("项目版本随事件递增（F1 / ADR-0113）", () => {
  it("created 带来自己的起始版本，不再加一", () => {
    const project = load();
    expect(rebuild([created(project)]).version).toBe(project.version);
  });

  it("每应用一条事件版本 +1：改预算、改重试上限、记一条资产都算", () => {
    const project = load();
    const start = project.version;
    expect(
      applyEvent(project, {
        type: "project.updated",
        at: AT,
        budgetCny: 120,
      }).version,
    ).toBe(start + 1);

    const states = rebuildStates([
      created(project),
      { type: "project.updated", at: AT, budgetCny: 120 },
      { type: "project.updated", at: AT, maxAttemptsPerShot: 3 },
      { type: "shot.updated", at: AT, shotId: "sh-1", patch: { description: "改过的动作" } },
    ]);
    expect(states.map((state) => state.version)).toEqual([
      start,
      start + 1,
      start + 2,
      start + 3,
    ]);
  });

  it("回滚也是一版：内容回到旧状态，版本继续往上走", () => {
    const project = load();
    const start = project.version;
    const states = rebuildStates([
      created(project),
      { type: "project.updated", at: AT, budgetCny: 120 },
      { type: "project.restored", at: AT, toEventCount: 1 },
    ]);
    expect(states[2]!.budgetCny).toBe(project.budgetCny);
    expect(states[2]!.version).toBe(start + 2);
  });

  it("版本只增不减：连续回滚不会让数字往回跳", () => {
    const project = load();
    const start = project.version;
    const states = rebuildStates([
      created(project),
      { type: "project.updated", at: AT, budgetCny: 120 },
      { type: "project.restored", at: AT, toEventCount: 1 },
      { type: "project.updated", at: AT, budgetCny: 90 },
      { type: "project.restored", at: AT, toEventCount: 3 },
    ]);
    const versions = states.map((state) => state.version);
    expect(versions).toEqual([start, start + 1, start + 2, start + 3, start + 4]);
  });
});

describe("手改断句（D2）", () => {
  it("按整句覆盖，重复写覆盖同一句而不是叠加", () => {
    const project = load();
    const lineId = project.dialogue[0]!.id;
    const cues = [
      { text: "前半句", durationMs: 800 },
      { text: "后半句", durationMs: 1200 },
    ];
    const once = rebuild([
      created(project),
      { type: "subtitle.updated", at: AT, lineId, cues },
    ]);
    expect(once.subtitleOverrides).toEqual([{ lineId, cues }]);

    const twice = rebuild([
      created(project),
      { type: "subtitle.updated", at: AT, lineId, cues },
      {
        type: "subtitle.updated",
        at: AT,
        lineId,
        cues: [{ text: "整句", durationMs: 2000 }],
      },
    ]);
    expect(twice.subtitleOverrides).toEqual([
      { lineId, cues: [{ text: "整句", durationMs: 2000 }] },
    ]);
  });

  it("cues 为 null 恢复自动断句", () => {
    const project = load();
    const lineId = project.dialogue[0]!.id;
    const after = rebuild([
      created(project),
      {
        type: "subtitle.updated",
        at: AT,
        lineId,
        cues: [{ text: "改过", durationMs: 1000 }],
      },
      { type: "subtitle.updated", at: AT, lineId, cues: null },
    ]);
    expect(after.subtitleOverrides).toHaveLength(0);
  });

  it("空字或非正时长被拒绝", () => {
    const project = load();
    const lineId = project.dialogue[0]!.id;
    expect(() =>
      rebuild([
        created(project),
        {
          type: "subtitle.updated",
          at: AT,
          lineId,
          cues: [{ text: "   ", durationMs: 500 }],
        },
      ]),
    ).toThrow(/要有字/);
    expect(() =>
      rebuild([
        created(project),
        {
          type: "subtitle.updated",
          at: AT,
          lineId,
          cues: [{ text: "有字", durationMs: 0 }],
        },
      ]),
    ).toThrow(/正时长/);
  });

  it("指向不存在的台词被拒绝", () => {
    const project = load();
    expect(() =>
      rebuild([
        created(project),
        {
          type: "subtitle.updated",
          at: AT,
          lineId: "line-nope",
          cues: [{ text: "有字", durationMs: 500 }],
        },
      ]),
    ).toThrow(/不存在的台词/);
  });

  it("台词被删时它的手动断句一起摘掉", () => {
    const project = load();
    const lineId = project.dialogue[0]!.id;
    const after = rebuild([
      created(project),
      {
        type: "subtitle.updated",
        at: AT,
        lineId,
        cues: [{ text: "改过", durationMs: 1000 }],
      },
      { type: "dialogue.removed", at: AT, lineId },
    ]);
    expect(after.subtitleOverrides).toHaveLength(0);
  });
});

describe("生成结果复核（H6 / ADR-0132）", () => {
  const asset = {
    id: "a-1",
    kind: "video" as const,
    uri: "loomina://assets/1.mp4",
    source: "generated" as const,
    createdAt: AT,
  };

  function withAsset() {
    const project = load();
    return rebuild([
      created(project),
      { type: "asset.updated", at: AT, asset },
    ]);
  }

  it("标「已看」：资产上带复核记录", () => {
    const after = rebuild([
      created(load()),
      { type: "asset.updated", at: AT, asset },
      { type: "asset.reviewed", at: AT, assetId: "a-1", status: "passed" },
    ]);
    expect(after.assets.find((item) => item.id === "a-1")!.review).toEqual({
      status: "passed",
      at: AT,
    });
  });

  it("标「不可用」带上原因；原因为空不写空串", () => {
    const after = rebuild([
      created(load()),
      { type: "asset.updated", at: AT, asset },
      { type: "asset.reviewed", at: AT, assetId: "a-1", status: "rejected", note: "  手  " },
    ]);
    expect(after.assets.find((item) => item.id === "a-1")!.review).toEqual({
      status: "rejected",
      at: AT,
      note: "手",
    });

    const blank = rebuild([
      created(load()),
      { type: "asset.updated", at: AT, asset },
      { type: "asset.reviewed", at: AT, assetId: "a-1", status: "rejected", note: "   " },
    ]);
    expect("note" in blank.assets.find((item) => item.id === "a-1")!.review!).toBe(false);
  });

  it("null 收回复核：字段真的消失", () => {
    const after = rebuild([
      created(load()),
      { type: "asset.updated", at: AT, asset },
      { type: "asset.reviewed", at: AT, assetId: "a-1", status: "passed" },
      { type: "asset.reviewed", at: AT, assetId: "a-1", status: null },
    ]);
    expect("review" in after.assets.find((item) => item.id === "a-1")!).toBe(false);
  });

  it("指向不存在的资产被拒", () => {
    expect(() =>
      rebuild([
        created(load()),
        { type: "asset.reviewed", at: AT, assetId: "a-gone", status: "passed" },
      ]),
    ).toThrow(/不存在/);
  });

  it("复核不碰资产的其它字段", () => {
    const before = withAsset();
    const after = rebuild([
      created(load()),
      { type: "asset.updated", at: AT, asset },
      { type: "asset.reviewed", at: AT, assetId: "a-1", status: "passed" },
    ]);
    const a = before.assets.find((item) => item.id === "a-1")!;
    const b = after.assets.find((item) => item.id === "a-1")!;
    expect(b.uri).toBe(a.uri);
    expect(b.kind).toBe(a.kind);
    expect(b.createdAt).toBe(a.createdAt);
  });
});

describe("音轨与字幕轨偏移（E1 / ADR-0131）", () => {
  it("默认没有这两个字段；旧日志读出来按 0 处理", () => {
    const project = load();
    const line = project.dialogue[0]!;
    expect(line.voiceOffsetMs).toBeUndefined();
    expect(line.subtitleOffsetMs).toBeUndefined();
  });

  it("配音与字幕各写各的，互不覆盖", () => {
    const project = load();
    const lineId = project.dialogue[0]!.id;
    const after = rebuild([
      created(project),
      { type: "dialogue.updated", at: AT, lineId, patch: { voiceOffsetMs: 300 } },
      { type: "dialogue.updated", at: AT, lineId, patch: { subtitleOffsetMs: -200 } },
    ]);
    const line = after.dialogue.find((item) => item.id === lineId)!;
    expect(line.voiceOffsetMs).toBe(300);
    expect(line.subtitleOffsetMs).toBe(-200);
  });

  it("null 归零；归零后字段还在但值为 0", () => {
    const project = load();
    const lineId = project.dialogue[0]!.id;
    const after = rebuild([
      created(project),
      { type: "dialogue.updated", at: AT, lineId, patch: { voiceOffsetMs: 500 } },
      { type: "dialogue.updated", at: AT, lineId, patch: { voiceOffsetMs: null } },
    ]);
    expect(after.dialogue.find((item) => item.id === lineId)!.voiceOffsetMs).toBe(0);
  });

  it("超过 ±30 秒被拒", () => {
    const project = load();
    const lineId = project.dialogue[0]!.id;
    expect(() =>
      rebuild([
        created(project),
        { type: "dialogue.updated", at: AT, lineId, patch: { voiceOffsetMs: 30_001 } },
      ]),
    ).toThrow(/voiceOffsetMs/);
    expect(() =>
      rebuild([
        created(project),
        { type: "dialogue.updated", at: AT, lineId, patch: { subtitleOffsetMs: -30_001 } },
      ]),
    ).toThrow(/subtitleOffsetMs/);
  });

  it("非整数毫秒被拒", () => {
    const project = load();
    const lineId = project.dialogue[0]!.id;
    expect(() =>
      rebuild([
        created(project),
        { type: "dialogue.updated", at: AT, lineId, patch: { voiceOffsetMs: 12.5 } },
      ]),
    ).toThrow(/整数毫秒/);
  });

  it("改文本不会把偏移冲掉", () => {
    const project = load();
    const lineId = project.dialogue[0]!.id;
    const after = rebuild([
      created(project),
      { type: "dialogue.updated", at: AT, lineId, patch: { subtitleOffsetMs: 400 } },
      { type: "dialogue.updated", at: AT, lineId, patch: { text: "改过的台词。" } },
    ]);
    const line = after.dialogue.find((item) => item.id === lineId)!;
    expect(line.text).toBe("改过的台词。");
    expect(line.subtitleOffsetMs).toBe(400);
  });
});

describe("字幕版式（D3）", () => {
  it("默认是默认档，三项都没写", () => {
    const project = load();
    expect(project.subtitleLayout).toEqual({ preset: "default" });
  });

  it("调字号与位置各写一条，没调的项仍是模板值", () => {
    const project = load();
    const after = rebuild([
      created(project),
      { type: "subtitle.layout.updated", at: AT, layout: { fontSizeCqw: 6.4 } },
      { type: "subtitle.layout.updated", at: AT, layout: { bottomPct: 22 } },
    ]);
    expect(after.subtitleLayout).toEqual({
      preset: "default",
      fontSizeCqw: 6.4,
      bottomPct: 22,
    });
    expect(after.subtitleLayout.strokeCqw).toBeUndefined();
  });

  it("null 清掉某一项，回到模板值", () => {
    const project = load();
    const after = rebuild([
      created(project),
      {
        type: "subtitle.layout.updated",
        at: AT,
        layout: { fontSizeCqw: 7, bottomPct: 20, strokeCqw: 1.2 },
      },
      { type: "subtitle.layout.updated", at: AT, layout: { fontSizeCqw: null } },
    ]);
    expect(after.subtitleLayout.fontSizeCqw).toBeUndefined();
    expect(after.subtitleLayout.bottomPct).toBe(20);
    expect(after.subtitleLayout.strokeCqw).toBe(1.2);
  });

  it("按角色着色可以关掉，也能清掉覆盖回到默认开（D3）", () => {
    const project = load();
    const off = rebuild([
      created(project),
      { type: "subtitle.layout.updated", at: AT, layout: { speakerColors: false } },
    ]);
    expect(off.subtitleLayout.speakerColors).toBe(false);

    const cleared = rebuild([
      created(project),
      { type: "subtitle.layout.updated", at: AT, layout: { speakerColors: false } },
      { type: "subtitle.layout.updated", at: AT, layout: { speakerColors: null } },
    ]);
    expect(cleared.subtitleLayout.speakerColors).toBeUndefined();
  });

  it("角色配色整份替换、统一大写，`null` 与空对象都清掉（D3 / ADR-0146）", () => {
    const project = load();
    const after = rebuild([
      created(project),
      {
        type: "subtitle.layout.updated",
        at: AT,
        layout: { speakerColorOverrides: { "c-lin": "#ffd666" } },
      },
      {
        type: "subtitle.layout.updated",
        at: AT,
        layout: { speakerColorOverrides: { "c-zhou": "#7FD8FF" } },
      },
    ]);
    // 整份替换：第二条覆盖掉第一条，而不是合并
    expect(after.subtitleLayout.speakerColorOverrides).toEqual({ "c-zhou": "#7FD8FF" });

    const cleared = rebuild([
      created(project),
      {
        type: "subtitle.layout.updated",
        at: AT,
        layout: { speakerColorOverrides: { "c-lin": "#FFD666" } },
      },
      { type: "subtitle.layout.updated", at: AT, layout: { speakerColorOverrides: null } },
    ]);
    expect(cleared.subtitleLayout.speakerColorOverrides).toBeUndefined();

    const emptied = rebuild([
      created(project),
      { type: "subtitle.layout.updated", at: AT, layout: { speakerColorOverrides: {} } },
    ]);
    expect(emptied.subtitleLayout.speakerColorOverrides).toBeUndefined();
  });

  it("角色配色的非法颜色被拒绝（D3 / ADR-0146）", () => {
    const project = load();
    expect(() =>
      rebuild([
        created(project),
        {
          type: "subtitle.layout.updated",
          at: AT,
          layout: { speakerColorOverrides: { "c-lin": "red" } },
        },
      ]),
    ).toThrow(/字幕颜色必须是 #RRGGBB/);
  });

  it("换模板只改 preset，调过的项留着", () => {
    const project = load();
    const after = rebuild([
      created(project),
      { type: "subtitle.layout.updated", at: AT, layout: { fontSizeCqw: 6.4 } },
      { type: "subtitle.layout.updated", at: AT, layout: { preset: "large" } },
    ]);
    expect(after.subtitleLayout.preset).toBe("large");
    expect(after.subtitleLayout.fontSizeCqw).toBe(6.4);
  });

  it("越界拒绝而不是夹取：填错了要看得见", () => {
    const project = load();
    expect(() =>
      rebuild([
        created(project),
        { type: "subtitle.layout.updated", at: AT, layout: { fontSizeCqw: 20 } },
      ]),
    ).toThrow(/fontSizeCqw/);
    expect(() =>
      rebuild([
        created(project),
        { type: "subtitle.layout.updated", at: AT, layout: { bottomPct: 60 } },
      ]),
    ).toThrow(/bottomPct/);
    expect(() =>
      rebuild([
        created(project),
        { type: "subtitle.layout.updated", at: AT, layout: { strokeCqw: -1 } },
      ]),
    ).toThrow(/strokeCqw/);
  });

  it("没有要改的字段被拒", () => {
    const project = load();
    expect(() =>
      rebuild([created(project), { type: "subtitle.layout.updated", at: AT, layout: {} }]),
    ).toThrow(/没有要改的字段/);
  });
});

describe("双语字幕（D5 / ADR-0173）", () => {
  it("默认关着，第二行是 en、放在下面", () => {
    const project = load();
    expect(project.subtitleTranslation).toEqual({
      enabled: false,
      lang: "en",
      position: "below",
    });
    expect(project.dialogue[0]!.translation).toBeUndefined();
  });

  it("开关、语言、位置各写一次，只改传进来的键", () => {
    const project = load();
    const after = rebuild([
      created(project),
      { type: "subtitle.translation.updated", at: AT, patch: { enabled: true } },
      { type: "subtitle.translation.updated", at: AT, patch: { lang: "ja" } },
      { type: "subtitle.translation.updated", at: AT, patch: { position: "above" } },
    ]);
    expect(after.subtitleTranslation).toEqual({
      enabled: true,
      lang: "ja",
      position: "above",
    });
  });

  it("没有要改的字段被拒", () => {
    const project = load();
    expect(() =>
      rebuild([created(project), { type: "subtitle.translation.updated", at: AT, patch: {} }]),
    ).toThrow(/没有要改的字段/);
  });

  it("语言不能是空的、位置只能是上下", () => {
    const project = load();
    expect(() =>
      rebuild([
        created(project),
        { type: "subtitle.translation.updated", at: AT, patch: { lang: "  " } },
      ]),
    ).toThrow(/不能是空的/);
    expect(() =>
      rebuild([
        created(project),
        {
          type: "subtitle.translation.updated",
          at: AT,
          // 故意写一个 schema 之外的值：回放旧日志时也得拒绝
          patch: { position: "left" as unknown as "below" },
        },
      ]),
    ).toThrow(/below 或 above/);
  });

  it("译文写在那一句台词上，别的句子不动", () => {
    const project = load();
    const [first, second] = project.dialogue;
    const after = rebuild([
      created(project),
      {
        type: "dialogue.translation.updated",
        at: AT,
        lineId: first!.id,
        translation: "  She doesn't believe it.  ",
      },
    ]);
    const line = after.dialogue.find((item) => item.id === first!.id)!;
    expect(line.translation).toBe("She doesn't believe it.");
    expect(after.dialogue.find((item) => item.id === second!.id)!.translation).toBeUndefined();
  });

  it("`null` 与空串都清掉译文，不留一行空白", () => {
    const project = load();
    const lineId = project.dialogue[0]!.id;
    const cleared = rebuild([
      created(project),
      { type: "dialogue.translation.updated", at: AT, lineId, translation: "Hello." },
      { type: "dialogue.translation.updated", at: AT, lineId, translation: null },
    ]);
    expect(cleared.dialogue[0]!.translation).toBeUndefined();

    const blank = rebuild([
      created(project),
      { type: "dialogue.translation.updated", at: AT, lineId, translation: "Hello." },
      { type: "dialogue.translation.updated", at: AT, lineId, translation: "   " },
    ]);
    expect(blank.dialogue[0]!.translation).toBeUndefined();
    // 清掉之后这个键整个不在，回放不会留下 `translation: undefined` 的痕迹
    expect(Object.keys(blank.dialogue[0]!)).not.toContain("translation");
  });

  it("指向不存在的台词被拒", () => {
    const project = load();
    expect(() =>
      rebuild([
        created(project),
        {
          type: "dialogue.translation.updated",
          at: AT,
          lineId: "no-such-line",
          translation: "Hello.",
        },
      ]),
    ).toThrow(/不存在的台词/);
  });
});

describe("故事层改写（A16）", () => {
  it("只改传进来的字段，hooks 的另一个钩子不动", () => {
    const project = load();
    const seeded = applyEvent(project, {
      type: "story.updated",
      at: AT,
      patch: { openingHook: "灯灭了。", endingHook: "他还在。" },
    });
    const next = applyEvent(seeded, {
      type: "story.updated",
      at: AT,
      patch: { logline: "两个夜班保安互相试探。", openingHook: "灯又亮了。" },
    });
    expect(next.story.logline).toBe("两个夜班保安互相试探。");
    expect(next.story.hooks.opening).toBe("灯又亮了。");
    expect(next.story.hooks.ending).toBe("他还在。");
  });

  it("弧光整组替换；同一角色写两份被拒", () => {
    const project = load();
    const characterId = project.characters[0]!.id;
    const next = applyEvent(project, {
      type: "story.updated",
      at: AT,
      patch: {
        arcs: [
          {
            characterId,
            want: "拿到监控",
            need: "被看见",
            wound: "",
            flaw: "",
            secret: "",
            agency: "",
            arc: "",
          },
        ],
      },
    });
    expect(next.story.arcs).toHaveLength(1);
    expect(next.story.arcs[0]!.want).toBe("拿到监控");

    expect(() =>
      applyEvent(project, {
        type: "story.updated",
        at: AT,
        patch: {
          arcs: [
            { characterId, want: "a", need: "", wound: "", flaw: "", secret: "", agency: "", arc: "" },
            { characterId, want: "b", need: "", wound: "", flaw: "", secret: "", agency: "", arc: "" },
          ],
        },
      }),
    ).toThrow(/两份弧光/);
  });

  it("关系两端必须是不同且存在的角色，同一对不能写两遍", () => {
    const project = load();
    const [a, b] = [project.characters[0]!.id, project.characters[1]!.id];
    const relation = (from: string, to: string) => ({
      fromCharacterId: from,
      toCharacterId: to,
      tension: "互相试探",
    });

    expect(() =>
      applyEvent(project, {
        type: "story.updated",
        at: AT,
        patch: { relationships: [relation(a, a)] },
      }),
    ).toThrow(/同一个人/);
    expect(() =>
      applyEvent(project, {
        type: "story.updated",
        at: AT,
        patch: { relationships: [relation(a, "nope")] },
      }),
    ).toThrow(/不存在的角色/);
    expect(() =>
      applyEvent(project, {
        type: "story.updated",
        at: AT,
        patch: { relationships: [relation(a, b), relation(a, b)] },
      }),
    ).toThrow(/两遍/);
  });

  it("没有要改的字段时拒绝；provenance 不被抹掉", () => {
    const project = load();
    expect(() =>
      applyEvent(project, { type: "story.updated", at: AT, patch: {} }),
    ).toThrow(/没有要改的字段/);

    const withProvenance = applyEvent(project, {
      type: "story.updated",
      at: AT,
      patch: { genre: "悬疑" },
    });
    expect(withProvenance.story.provenance).toEqual(project.story.provenance);
  });

  it("文字字段会去掉首尾空白，空串表示清空", () => {
    const project = load();
    const filled = applyEvent(project, {
      type: "story.updated",
      at: AT,
      patch: { tone: "  冷峻  " },
    });
    expect(filled.story.tone).toBe("冷峻");
    const cleared = applyEvent(filled, {
      type: "story.updated",
      at: AT,
      patch: { tone: "" },
    });
    expect(cleared.story.tone).toBe("");
  });
});

describe("坐标进 IR（B13.1 / ADR-0126）", () => {
  const space = {
    dimensions: [5, 4, 2.8] as [number, number, number],
    anchors: [
      { id: "door", kind: "door" as const, position: [2.5, 0, -1.6] as [number, number, number], facingRad: 0, capacity: 0 },
      { id: "sofa", kind: "furniture" as const, position: [-1.2, 0.45, 0.9] as [number, number, number], facingRad: 0, capacity: 3 },
    ],
  };

  it("location.updated 写入几何，重放后一致", () => {
    const project = load();
    const event: ProjectEvent = {
      type: "location.updated",
      at: AT,
      locationId: "loc-living",
      patch: { space },
    };
    const after = applyEvent(project, event);
    expect(after.locations[0]!.space).toEqual(space);
    expect(rebuild([created(project), event])).toEqual(after);
  });

  it("space: null 清掉几何，重放后也真的没有", () => {
    const project = load();
    const withSpace: ProjectEvent = {
      type: "location.updated",
      at: AT,
      locationId: "loc-living",
      patch: { space },
    };
    const cleared: ProjectEvent = {
      type: "location.updated",
      at: AT,
      locationId: "loc-living",
      patch: { space: null },
    };
    const after = rebuild([created(project), withSpace, cleared]);
    expect(after.locations[0]!.space).toBeUndefined();
    // null 不是「改成 null」：回放后字段整个消失，而不是留一个空壳
    expect("space" in after.locations[0]!).toBe(false);
  });

  it("尺寸非正、锚点越界、锚点重复都拒绝", () => {
    const project = load();
    const bad = (patch: Record<string, unknown>) =>
      applyEvent(project, {
        type: "location.updated",
        at: AT,
        locationId: "loc-living",
        patch: patch as never,
      });
    expect(() => bad({ space: { ...space, dimensions: [0, 4, 2.8] } })).toThrow(/尺寸/);
    expect(() =>
      bad({ space: { ...space, anchors: [{ ...space.anchors[0]!, position: [9, 0, 0] }] } }),
    ).toThrow(/超出场地/);
    expect(() =>
      bad({ space: { ...space, anchors: [space.anchors[0]!, space.anchors[0]!] } }),
    ).toThrow(/重复/);
  });

  it("shot.updated 写入走位：坐标落在场地内才收；不在场的人拒绝", () => {
    const project = rebuild([
      created(load()),
      { type: "location.updated", at: AT, locationId: "loc-living", patch: { space } },
    ]);
    const event: ProjectEvent = {
      type: "shot.updated",
      at: AT,
      shotId: "sh-1",
      patch: {
        blocking: {
          actors: [{ characterId: "c-lin", position: [0, 0, 0], facingRad: 0 }],
          props: [],
        },
      },
    };
    const after = applyEvent(project, event);
    expect(after.shots.find((shot) => shot.id === "sh-1")?.blocking).toEqual({
      actors: [{ characterId: "c-lin", position: [0, 0, 0], facingRad: 0 }],
      props: [],
    });
    expect(rebuild([created(project), event])).toEqual(after);

    // sh-2 出场的是 c-zhou，写 c-lin 的走位就是不合法
    expect(() =>
      applyEvent(project, {
        type: "shot.updated",
        at: AT,
        shotId: "sh-2",
        patch: {
          blocking: {
            actors: [{ characterId: "c-lin", position: [0, 0, 0], facingRad: 0 }],
            props: [],
          },
        },
      }),
    ).toThrow(/不在这一镜出场/);

    expect(() =>
      applyEvent(project, {
        type: "shot.updated",
        at: AT,
        shotId: "sh-1",
        patch: {
          blocking: {
            actors: [{ characterId: "c-lin", position: [9, 0, 0], facingRad: 0 }],
            props: [],
          },
        },
      }),
    ).toThrow(/超出场地/);
  });

  it("机位坐标：两点重合拒绝，越界拒绝，合法则落库", () => {
    const project = rebuild([
      created(load()),
      { type: "location.updated", at: AT, locationId: "loc-living", patch: { space } },
    ]);
    const camera = { angle: "eye" as const, movement: "static" as const, focalMm: 35 };
    expect(() =>
      applyEvent(project, {
        type: "shot.updated",
        at: AT,
        shotId: "sh-1",
        patch: { camera: { ...camera, placement: { position: [0, 1.5, 1], target: [0, 1.5, 1] } } },
      }),
    ).toThrow(/同一个点/);
    expect(() =>
      applyEvent(project, {
        type: "shot.updated",
        at: AT,
        shotId: "sh-1",
        patch: { camera: { ...camera, placement: { position: [9, 1.5, 1], target: [0, 1.2, 0] } } },
      }),
    ).toThrow(/超出场地/);

    const placement = { position: [0, 1.5, 1.5] as [number, number, number], target: [0, 1.2, 0] as [number, number, number] };
    const after = applyEvent(project, {
      type: "shot.updated",
      at: AT,
      shotId: "sh-1",
      patch: { camera: { ...camera, placement } },
    });
    expect(after.shots.find((shot) => shot.id === "sh-1")?.camera.placement).toEqual(placement);
    // 角度是意图，不因为坐标自动改写
    expect(after.shots.find((shot) => shot.id === "sh-1")?.camera.angle).toBe("eye");
  });
});

describe("逐句表演参数与配音 take（C2 / C9 / ADR-0124）", () => {
  const performance = {
    rate: 1.2,
    pitch: -2,
    volume: 1,
    breathiness: 0.3,
    emphasis: [{ start: 0, end: 2, strength: 3 as const }],
    pauses: [{ afterChar: 3, ms: 400 }],
    emotion: "克制",
    ending: "fall" as const,
  };

  it("dialogue.updated 写入表演参数，只改这一句", () => {
    const project = load();
    const result = rebuild([
      created(project),
      {
        type: "dialogue.updated",
        at: AT,
        lineId: "dl-1",
        patch: { performance },
      },
    ]);
    expect(result.dialogue[0]!.performance).toMatchObject({ rate: 1.2, ending: "fall" });
    expect(result.dialogue[1]!.performance).toBeUndefined();
    // 时长不受参数影响（P5）
    expect(result.dialogue[0]!.durationMs).toBe(2000);
  });

  it("重音区间越出当前字数被拒", () => {
    const project = load();
    expect(() =>
      rebuild([
        created(project),
        {
          type: "dialogue.updated",
          at: AT,
          lineId: "dl-1",
          patch: { performance: { ...performance, emphasis: [{ start: 0, end: 99, strength: 2 }] } },
        },
      ]),
    ).toThrow(/重音区间越出当前台词/);
  });

  it("停顿位置越出当前字数被拒", () => {
    const project = load();
    expect(() =>
      rebuild([
        created(project),
        {
          type: "dialogue.updated",
          at: AT,
          lineId: "dl-1",
          patch: { performance: { ...performance, pauses: [{ afterChar: 99, ms: 400 }] } },
        },
      ]),
    ).toThrow(/停顿位置越出当前台词/);
  });

  it("rate / pitch 越界被拒", () => {
    const project = load();
    expect(() =>
      rebuild([
        created(project),
        {
          type: "dialogue.updated",
          at: AT,
          lineId: "dl-1",
          patch: { performance: { ...performance, rate: 3 } },
        },
      ]),
    ).toThrow(/表演参数不合法/);
  });

  it("文本改短后越界的重音被确定性地丢弃，回放一致", () => {
    const project = load();
    const events: ProjectEvent[] = [
      created(project),
      { type: "dialogue.updated", at: AT, lineId: "dl-1", patch: { performance } },
      { type: "dialogue.updated", at: AT, lineId: "dl-1", patch: { text: "你" } },
    ];
    const once = rebuild(events);
    const twice = rebuild(events);
    expect(once.dialogue[0]!.performance?.emphasis).toEqual([]);
    expect(once.dialogue[0]!.performance?.pauses).toEqual([]);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
    // 其余参数留着
    expect(once.dialogue[0]!.performance?.rate).toBe(1.2);
  });

  it("voice.take.added 进试听台，不改当前采用的音轨", () => {
    const project = load();
    const audio = {
      id: "a-voice-t1",
      kind: "audio" as const,
      source: "generated" as const,
      uri: "data:audio/mpeg;base64,AAAA",
      createdAt: AT,
    };
    const result = rebuild([
      created(project),
      { type: "asset.updated", at: AT, asset: audio },
      {
        type: "voice.take.added",
        at: AT,
        take: {
          id: "vt-1",
          lineId: "dl-1",
          assetId: "a-voice-t1",
          performance,
          provenance: { modelId: "tts", referenceAssetIds: [], createdAt: AT },
          createdAt: AT,
        },
      },
    ]);
    expect(result.voiceTakes).toHaveLength(1);
    expect(result.dialogue[0]!.audioAssetId).toBeUndefined();
    expect(validateProject(result)).toEqual([]);
  });

  it("voice.take.added 的 id 重复、台词或资产不存在都被拒", () => {
    const project = load();
    const audio = {
      id: "a-voice-t1",
      kind: "audio" as const,
      source: "generated" as const,
      uri: "data:audio/mpeg;base64,AAAA",
      createdAt: AT,
    };
    const base = {
      id: "vt-1",
      lineId: "dl-1",
      assetId: "a-voice-t1",
      performance,
      provenance: { modelId: "tts", referenceAssetIds: [], createdAt: AT },
      createdAt: AT,
    };
    const seeded = rebuild([
      created(project),
      { type: "asset.updated", at: AT, asset: audio },
      { type: "voice.take.added", at: AT, take: base },
    ]);
    expect(() =>
      rebuild([...[created(project), { type: "asset.updated" as const, at: AT, asset: audio }, { type: "voice.take.added" as const, at: AT, take: base }], { type: "voice.take.added", at: AT, take: { ...base, id: "vt-1" } }]),
    ).toThrow(/id 已存在/);
    expect(() =>
      applyEvent(seeded, {
        type: "voice.take.added",
        at: AT,
        take: { ...base, id: "vt-2", lineId: "dl-nope" },
      }),
    ).toThrow(/不存在的台词/);
    expect(() =>
      applyEvent(seeded, {
        type: "voice.take.added",
        at: AT,
        take: { ...base, id: "vt-2", assetId: "a-lin-front" },
      }),
    ).toThrow(/不是音频/);
  });

  it("voice.take.removed 只摘试听台记录，资产不删", () => {
    const project = load();
    const audio = {
      id: "a-voice-t1",
      kind: "audio" as const,
      source: "generated" as const,
      uri: "data:audio/mpeg;base64,AAAA",
      createdAt: AT,
    };
    const seeded = rebuild([
      created(project),
      { type: "asset.updated", at: AT, asset: audio },
      {
        type: "voice.take.added",
        at: AT,
        take: {
          id: "vt-1",
          lineId: "dl-1",
          assetId: "a-voice-t1",
          performance,
          provenance: { modelId: "tts", referenceAssetIds: [], createdAt: AT },
          createdAt: AT,
        },
      },
    ]);
    const removed = applyEvent(seeded, { type: "voice.take.removed", at: AT, takeId: "vt-1" });
    expect(removed.voiceTakes).toHaveLength(0);
    expect(removed.assets.some((asset) => asset.id === "a-voice-t1")).toBe(true);
    expect(() =>
      applyEvent(removed, { type: "voice.take.removed", at: AT, takeId: "vt-1" }),
    ).toThrow(/不存在的配音 take/);
  });

  it("删台词时试听台记录一起摘掉", () => {
    const project = load();
    const audio = {
      id: "a-voice-t1",
      kind: "audio" as const,
      source: "generated" as const,
      uri: "data:audio/mpeg;base64,AAAA",
      createdAt: AT,
    };
    const seeded = rebuild([
      created(project),
      { type: "asset.updated", at: AT, asset: audio },
      {
        type: "voice.take.added",
        at: AT,
        take: {
          id: "vt-1",
          lineId: "dl-1",
          assetId: "a-voice-t1",
          performance,
          provenance: { modelId: "tts", referenceAssetIds: [], createdAt: AT },
          createdAt: AT,
        },
      },
    ]);
    const removed = applyEvent(seeded, { type: "dialogue.removed", at: AT, lineId: "dl-1" });
    expect(removed.voiceTakes).toHaveLength(0);
  });

  it("旧日志没有 performance / voiceTakes 也能回放", () => {
    const project = load();
    const replayed = rebuild([created(project)]);
    expect(replayed.voiceTakes).toEqual([]);
    expect(replayed.dialogue[0]!.performance).toBeUndefined();
  });
});

describe("清空表演参数（C2 / ADR-0124）", () => {
  const performance = {
    rate: 1.5,
    pitch: 0,
    volume: 1,
    breathiness: 0,
    emphasis: [],
    pauses: [],
    emotion: "",
    ending: "flat" as const,
  };

  it("patch.performance = null 把字段整个去掉，回放一致", () => {
    const project = load();
    const events: ProjectEvent[] = [
      created(project),
      { type: "dialogue.updated", at: AT, lineId: "dl-1", patch: { performance } },
      { type: "dialogue.updated", at: AT, lineId: "dl-1", patch: { performance: null } },
    ];
    const once = rebuild(events);
    expect(once.dialogue[0]!.performance).toBeUndefined();
    expect("performance" in once.dialogue[0]!).toBe(false);
    // 事件过一遍 JSON 再回放，结果一样（null 能存下来，undefined 不能）
    const twice = rebuild(JSON.parse(JSON.stringify(events)) as ProjectEvent[]);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("不改 performance 时，改文本不碰参数", () => {
    const project = load();
    const result = rebuild([
      created(project),
      { type: "dialogue.updated", at: AT, lineId: "dl-1", patch: { performance } },
      { type: "dialogue.updated", at: AT, lineId: "dl-1", patch: { text: "你早就知道了" } },
    ]);
    expect(result.dialogue[0]!.performance?.rate).toBe(1.5);
  });
});

describe("四格资产位（ADR-0144）", () => {
  it("character.updated 可以整份补上四格，重放后一致", () => {
    const project = load();
    const sheet = {
      front: "a-sheet-c-new-front",
      threeQuarter: "a-sheet-c-new-threeQuarter",
      side: "a-sheet-c-new-side",
      back: "a-sheet-c-new-back",
    };
    const event: ProjectEvent = {
      type: "character.updated",
      at: AT,
      characterId: "c-lin",
      patch: { sheet },
    };
    const after = applyEvent(project, event);
    expect(after.characters.find((item) => item.id === "c-lin")?.sheet).toEqual(sheet);
    expect(rebuild([created(project), event])).toEqual(after);
  });

  it("有图的资产写回时自动摘掉占位标记", () => {
    const project = load();
    const placeholder = {
      id: "a-sheet-c-lin-front",
      kind: "image" as const,
      source: "generated" as const,
      placeholder: true,
      createdAt: AT,
    };
    const withSlot = applyEvent(project, {
      type: "asset.updated",
      at: AT,
      asset: placeholder,
    });
    const { placeholder: _placeholder, ...real } = placeholder;
    const filled = applyEvent(withSlot, {
      type: "asset.updated",
      at: AT,
      asset: { ...real, uri: "data:image/png;base64,AA" },
    });
    expect(filled.assets.find((item) => item.id === placeholder.id)).not.toHaveProperty(
      "placeholder",
    );
  });

  it("未知角度与空资产位被拒绝", () => {
    const project = load();
    expect(() =>
      applyEvent(project, {
        type: "character.updated",
        at: AT,
        characterId: "c-lin",
        // @ts-expect-error 故意写一个不存在的角度
        patch: { sheet: { top: "a-1" } },
      }),
    ).toThrow(/未知角度/);
    expect(() =>
      applyEvent(project, {
        type: "character.updated",
        at: AT,
        characterId: "c-lin",
        patch: { sheet: { front: "  " } },
      }),
    ).toThrow(/不能是空串/);
  });
});

describe("逐字原文槽位（F6 / ADR-0154）", () => {
  it("旧项目没有 sourceDocument，回放仍然等价", () => {
    const project = load();
    expect(rebuild([created(project)])).toEqual(project);
    expect(project.story.sourceDocument).toBeUndefined();
  });

  it("project.created 可以携带一份逐字原文，回放后指纹与正文都在", () => {
    const project = load();
    const text = "第一章 雨夜\n老楼走廊，声控灯亮了半盏。";
    project.story.sourceDocument = {
      title: "第一章 雨夜",
      chapterIndex: 0,
      chapterCount: 1,
      text,
      sourceChars: text.length,
      importedAt: AT,
      fingerprint: "1a2b3c4d",
    };
    expect(rebuild([created(project)]).story.sourceDocument?.text).toBe(text);
  });

  it("story.updated 不收 sourceDocument：白名单外的字段不进事件", () => {
    const project = load();
    const event = {
      type: "story.updated",
      at: AT,
      patch: { logline: "改一句", sourceDocument: { title: "偷塞的" } },
    } as unknown as ProjectEvent;
    const next = rebuild([created(project), event]);
    expect(next.story.logline).toBe("改一句");
    expect(next.story.sourceDocument).toBeUndefined();
  });
});

describe("品牌包与头尾卡（E9 / ADR-0174）", () => {
  it("默认没有落款、两张卡都关着、时长各 2 秒", () => {
    const project = load();
    expect(project.brand).toEqual({
      name: "",
      handle: "",
      color: "#121215",
      intro: { enabled: false, title: "", subtitle: "", durationMs: 2000 },
      outro: { enabled: false, title: "", subtitle: "", durationMs: 2000 },
    });
  });

  it("落款、账号说明、底色各写一次，只改传进来的键", () => {
    const project = load();
    const after = rebuild([
      created(project),
      { type: "brand.updated", at: AT, patch: { name: "织光机" } },
      { type: "brand.updated", at: AT, patch: { handle: "@zhiguang" } },
      { type: "brand.updated", at: AT, patch: { color: "#2a1d3f" } },
    ]);
    expect(after.brand.name).toBe("织光机");
    expect(after.brand.handle).toBe("@zhiguang");
    expect(after.brand.color).toBe("#2A1D3F");
    // 两张卡没碰过
    expect(after.brand.intro.enabled).toBe(false);
  });

  it("改卡片的时长不会把标题清掉", () => {
    const project = load();
    const after = rebuild([
      created(project),
      {
        type: "brand.updated",
        at: AT,
        patch: { intro: { enabled: true, title: "夜班", subtitle: "第一集" } },
      },
      { type: "brand.updated", at: AT, patch: { intro: { durationMs: 3200 } } },
    ]);
    expect(after.brand.intro).toEqual({
      enabled: true,
      title: "夜班",
      subtitle: "第一集",
      durationMs: 3200,
    });
  });

  it("关掉卡片不会丢字：再打开还是同一张卡", () => {
    const project = load();
    const after = rebuild([
      created(project),
      {
        type: "brand.updated",
        at: AT,
        patch: { outro: { enabled: true, title: "下一集 20:00", subtitle: "关注不迷路" } },
      },
      { type: "brand.updated", at: AT, patch: { outro: { enabled: false } } },
    ]);
    expect(after.brand.outro).toEqual({
      enabled: false,
      title: "下一集 20:00",
      subtitle: "关注不迷路",
      durationMs: 2000,
    });
  });

  it("空 patch、空卡片 patch 与坏颜色都被拒", () => {
    const project = load();
    expect(() =>
      rebuild([created(project), { type: "brand.updated", at: AT, patch: {} }]),
    ).toThrow(/没有要改的字段/);
    expect(() =>
      rebuild([
        created(project),
        { type: "brand.updated", at: AT, patch: { intro: {} } },
      ]),
    ).toThrow(/intro 没有要改的字段/);
    expect(() =>
      rebuild([
        created(project),
        { type: "brand.updated", at: AT, patch: { color: "红色" } },
      ]),
    ).toThrow(/#RRGGBB/);
  });

  it("卡片时长必须在 0.5–10 秒之间，且是整数毫秒", () => {
    const project = load();
    for (const durationMs of [200, 12_000, 1500.5]) {
      expect(() =>
        rebuild([
          created(project),
          { type: "brand.updated", at: AT, patch: { outro: { durationMs } } },
        ]),
      ).toThrow(/500–10000/);
    }
  });

  it("文字上限 60 字", () => {
    const project = load();
    expect(() =>
      rebuild([
        created(project),
        {
          type: "brand.updated",
          at: AT,
          patch: { intro: { title: "字".repeat(61) } },
        },
      ]),
    ).toThrow(/最多 60 个字符/);
  });

  it("回放之后仍然是同一份品牌包", () => {
    const project = load();
    const events: ProjectEvent[] = [
      created(project),
      {
        type: "brand.updated",
        at: AT,
        patch: {
          name: "织光机",
          color: "#000000",
          intro: { enabled: true, title: "夜班", durationMs: 1500 },
          outro: { enabled: true, title: "下一集" },
        },
      },
    ];
    const states = rebuildStates(events);
    expect(states.at(-1)!.brand).toEqual(rebuild(events).brand);
  });
});
