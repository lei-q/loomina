import { describe, expect, it } from "vitest";
import { rebuild, type Project, type ProjectEvent } from "@loomina/ir";
import { inventoryOf, inlineBytesOf, referencedAssetIds, referencedUris } from "./asset-inventory";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const HASH = "d".repeat(64);

function base(): Project {
  const project: Project = {
    id: "p1",
    title: "测试",
    version: 0,
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
    timeline: { items: [], music: [] },
    subtitleOverrides: [],
    publishPackages: [],
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
    dialogue: [{ id: "d1", characterId: "c1", text: "走", durationMs: 1000, audioAssetId: "a-voice" }],
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
        loop: true,
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
