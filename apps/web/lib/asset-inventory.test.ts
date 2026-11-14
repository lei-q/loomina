import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRAND,
  DEFAULT_FRAME,
  DEFAULT_GRADE,
  DEFAULT_LOOK,
  rebuild,
  type Project,
  type ProjectEvent,
} from "@loomina/ir";
import {
  assetUsageLabels,
  filterLibrary,
  inventoryOf,
  inlineBytesOf,
  libraryOf,
  orphanAssets,
  referencedAssetIds,
  referencedUris,
  referencedUrisOfProjects,
} from "./asset-inventory";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const HASH = "d".repeat(64);

function base(): Project {
  const project: Project = {
    id: "p1",
    title: "测试",
    version: 0,
    models: {},
    look: DEFAULT_LOOK,
    grade: DEFAULT_GRADE,
    frame: DEFAULT_FRAME,
    brand: DEFAULT_BRAND,
    budgetCny: 60,
    maxAttemptsPerShot: 3,
    onBudgetExceed: "block",
    story: {
      logline: "",
      synopsis: "",
      genre: "",
      audience: "",
      tone: "",
      hooks: { opening: "", ending: "" },
      arcs: [],
      relationships: [],
    },
    motifs: [],
    skills: [],
    locations: [],
    characters: [],
    props: [],
    scenes: [],
    shots: [],
    dialogue: [],
    voiceTakes: [],
    takes: [],
    assets: [],
    approvals: [],
    gates: [],
    timeline: { items: [], music: [], sfx: [], mix: { dialogueDb: 0, musicDb: 0, sfxDb: 0 } },
    subtitleOverrides: [],
    subtitleLayout: { preset: "default" },
    subtitleTranslation: { enabled: false, lang: "en", position: "below" },
    publishPackages: [],
    authorizations: [],
  };
  return project;
}

function withAssets(project: Project): Project {
  return {
    ...project,
    characters: [
      {
        id: "c1",
        name: "林",
        appearance: "",
        sheet: { front: "a-sheet" },
        referenceImages: ["a-ref"],
        mustNotChange: [],
      },
    ],
    locations: [{ id: "l1", name: "走廊", description: "", referenceImages: [], masterShotId: "a-master" }],
    shots: [
      {
        id: "s1",
        sceneId: "sc1",
        index: 0,
        durationMs: 3000,
        description: "",
        promptNotes: [],
        shotSize: "medium",
        camera: { angle: "eye", movement: "static", focalMm: 35 },
        staging: [],
        characterIds: [],
        propIds: [],
        dialogueIds: [],
        takeIds: [],
        keyframes: { firstAssetId: "a-frame" },
        locked: false,
      },
    ],
    dialogue: [
      {
        id: "d1",
        characterId: "c1",
        text: "走",
        durationMs: 1000,
        audioAssetId: "a-voice",
        voiceOffsetMs: 0,
        subtitleOffsetMs: 0,
      },
    ],
    assets: [
      { id: "a-sheet", kind: "image", uri: PNG, source: "generated", createdAt: "2026-11-11T00:00:00Z" },
      { id: "a-ref", kind: "image", uri: `loomina://assets/${HASH}.png`, source: "upload", createdAt: "2026-11-11T00:00:00Z" },
      { id: "a-master", kind: "image", uri: PNG, source: "generated", createdAt: "2026-11-11T00:00:00Z" },
      { id: "a-frame", kind: "image", source: "generated", createdAt: "2026-11-11T00:00:00Z" },
      { id: "a-voice", kind: "audio", uri: PNG, source: "generated", createdAt: "2026-11-11T00:00:00Z" },
      { id: "a-orphan", kind: "image", uri: PNG, source: "generated", createdAt: "2026-11-11T00:00:00Z" },
    ],
  };
}

describe("素材清点（H3 / ADR-0128）", () => {
  it("data URI 的字节数按 base64 反算", () => {
    expect(inlineBytesOf(PNG)).toBe(70);
    expect(inlineBytesOf(`loomina://assets/${HASH}.png`)).toBe(0);
    expect(inlineBytesOf(undefined)).toBe(0);
    expect(inlineBytesOf("https://example.com/a.png")).toBe(0);
  });

  it("引用点收全：三视图、参考图、主镜、关键帧、台词音轨、配乐、发布包", () => {
    const project = withAssets(base());
    project.timeline.music = [
      {
        id: "m1",
        assetId: "a-music",
        title: "床",
        mood: "",
        startMs: 0,
        durationMs: 1000,
        gainDb: -18,
        duckDb: 15,
        ducking: true,
        loop: true, fadeInMs: 0, fadeOutMs: 0,
        role: "bed",
        licenseRef: "自己录",
      },
    ];
    project.publishPackages = [{ id: "pub1", platform: "douyin", videoAssetId: "a-pub" }];
    const ids = referencedAssetIds(project);
    for (const id of ["a-sheet", "a-ref", "a-master", "a-frame", "a-voice", "a-music", "a-pub"]) {
      expect(ids.has(id)).toBe(true);
    }
    expect(ids.has("a-orphan")).toBe(false);
  });

  it("清点：几个在日志里、几个在库里、几个没地址、几个没人引用", () => {
    const inventory = inventoryOf(withAssets(base()));
    expect(inventory.total).toBe(6);
    expect(inventory.inline).toBe(4);
    expect(inventory.stored).toBe(1);
    expect(inventory.inlineBytes).toBe(70 * 4);
    expect(inventory.unreferenced.map((item) => item.id)).toEqual(["a-orphan"]);
    expect(inventory.unreferencedBytes).toBe(70);
  });

  it("清理白名单只给「在用的资产库地址」", () => {
    const project = withAssets(base());
    expect(referencedUris(project)).toEqual([`loomina://assets/${HASH}.png`]);
  });

  it("清点跟着事件重放走：迁移后的地址算资产库", () => {
    const project = withAssets(base());
    const events: ProjectEvent[] = [
      { type: "project.created", at: "2026-11-11T00:00:00Z", project },
      {
        type: "asset.updated",
        at: "2026-11-11T00:01:00Z",
        asset: {
          id: "a-sheet",
          kind: "image",
          uri: `loomina://assets/${HASH}.png`,
          source: "generated",
          createdAt: "2026-11-11T00:00:00Z",
        },
      },
    ];
    const inventory = inventoryOf(rebuild(events));
    expect(inventory.inline).toBe(3);
    expect(inventory.stored).toBe(2);
  });
});

describe("对象存储里的素材（H3 / s3://）", () => {
  it("s3:// 算「对象存储」，不算日志内、也不算本机库", () => {
    const project = withAssets(base());
    project.assets.push({
      id: "a-remote",
      kind: "image",
      uri: "s3://loomina-assets/assets/ab/abcd.png",
      source: "generated",
      createdAt: "2026-11-11T00:00:00Z",
    });
    const inventory = inventoryOf(project);
    expect(inventory.total).toBe(7);
    expect(inventory.remote).toBe(1);
    expect(inventory.stored).toBe(1);
    expect(inventory.inline).toBe(4);
    expect(inventory.usage.find((item) => item.id === "a-remote")?.placement).toBe("remote");
  });

  it("清理白名单也带上对象存储地址（两个库都要知道谁在用）", () => {
    const project = withAssets(base());
    project.shots[0]!.keyframes.firstAssetId = "a-remote";
    project.assets.push({
      id: "a-remote",
      kind: "image",
      uri: "s3://loomina-assets/assets/ab/abcd.png",
      source: "generated",
      createdAt: "2026-11-11T00:00:00Z",
    });
    expect(referencedUris(project)).toContain("s3://loomina-assets/assets/ab/abcd.png");
  });
});

describe("资产库视图（F4）", () => {
  it("每一条资产被谁用着，说清位置", () => {
    const project = withAssets(base());
    const labels = assetUsageLabels(project);
    expect(labels.get("a-sheet")).toEqual(["定妆「林」正面"]);
    expect(labels.get("a-ref")).toEqual(["参考图「林」"]);
    expect(labels.get("a-master")).toEqual(["主镜「走廊」"]);
    expect(labels.get("a-frame")).toEqual(["第 1 镜 首帧"]);
    expect(labels.get("a-voice")).toEqual(["配音「走」"]);
    expect(labels.has("a-orphan")).toBe(false);
  });

  it("画面轨上的 take 标出「在成片里」", () => {
    const project = withAssets(base());
    project.takes = [
      { id: "t1", shotId: "s1", assetId: "a-video", provenance: { modelId: "m", referenceAssetIds: [], createdAt: "2026-11-11T00:00:00Z" }, status: "approved", costCny: 0 },
    ];
    project.timeline.items = [
      { id: "tl1", shotId: "s1", takeId: "t1", startMs: 0, durationMs: 3000 },
    ];
    const labels = assetUsageLabels(project);
    expect(labels.get("a-video")).toEqual(["第 1 镜 take（在成片里）"]);
  });

  it("汇总：按 kind / 来源分，日志里与库里的字节分开算", () => {
    const project = withAssets(base());
    const files = new Map([[`loomina://assets/${HASH}.png`, 2048]]);
    const library = libraryOf(project, files);
    expect(library.total).toBe(6);
    expect(library.used).toBe(5);
    expect(library.unused).toBe(1);
    expect(library.inlineBytes).toBe(70 * 4);
    expect(library.storeBytes).toBe(2048);
    expect(library.byKind.find((entry) => entry.kind === "image")).toMatchObject({
      count: 5,
    });
    expect(library.bySource).toContainEqual({ source: "upload", count: 1 });
  });

  it("文件缺失：地址说在库里，但清单里没有它", () => {
    const project = withAssets(base());
    const files = new Map<string, number>();
    const library = libraryOf(project, files);
    expect(library.missing).toBe(1);
    expect(library.rows.find((row) => row.assetId === "a-ref")?.fileMissing).toBe(true);
    // 没给清单时不判缺失：读不到不等于文件没了
    expect(libraryOf(project).missing).toBe(0);
  });

  it("按条件筛：在用 / 没人用 / 文件缺失", () => {
    const project = withAssets(base());
    const library = libraryOf(project, new Map());
    expect(filterLibrary(library.rows, "used").map((row) => row.assetId)).not.toContain("a-orphan");
    expect(filterLibrary(library.rows, "unused").map((row) => row.assetId)).toEqual(["a-orphan"]);
    expect(filterLibrary(library.rows, "missing").map((row) => row.assetId)).toEqual(["a-ref"]);
    expect(filterLibrary(library.rows, "all")).toHaveLength(6);
  });
});

describe("跨项目孤儿检查（H3 / ADR-0158）", () => {
  const OTHER = `loomina://assets/${"e".repeat(64)}.png`;
  const FILE_ORPHAN = `loomina://assets/${"f".repeat(64)}.png`;

  function second(): Project {
    return {
      ...base(),
      id: "p2",
      characters: [],
      locations: [
        {
          id: "l2",
          name: "门口",
          description: "",
          referenceImages: [],
          masterShotId: "a-b",
        },
      ],
      shots: [],
      dialogue: [],
      assets: [
        {
          id: "a-b",
          kind: "image",
          uri: OTHER,
          source: "generated",
          createdAt: "2026-11-13T00:00:00Z",
        },
      ],
    };
  }

  it("白名单取所有项目的并集：别的项目还在用的地址不算孤儿", () => {
    const keep = referencedUrisOfProjects([withAssets(base()), second()]);
    expect(keep).toContain(`loomina://assets/${HASH}.png`);
    expect(keep).toContain(OTHER);

    const report = orphanAssets(
      [
        { uri: `loomina://assets/${HASH}.png`, bytes: 2048 },
        { uri: OTHER, bytes: 100 },
        { uri: FILE_ORPHAN, bytes: 50 },
      ],
      keep,
    );
    expect(report.count).toBe(1);
    expect(report.bytes).toBe(50);
    expect(report.orphans.map((file) => file.uri)).toEqual([FILE_ORPHAN]);
  });

  it("没有白名单时全部算孤儿：只列不删由界面决定", () => {
    const report = orphanAssets([{ uri: OTHER, bytes: 100 }], []);
    expect(report.count).toBe(1);
    expect(report.bytes).toBe(100);
  });
});
