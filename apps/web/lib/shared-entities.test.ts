import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRAND,
  DEFAULT_FRAME,
  DEFAULT_GRADE,
  DEFAULT_LOOK,
  applyEvent,
  sheetSlotsOf,
  type Asset,
  type Character,
  type Location,
  type Project,
  type Prop,
} from "@loomina/ir";
import { sharedEntitiesOf, sharedEntityImport, sharedEntitySummary } from "./shared-entities";

const PORTRAIT = `loomina://assets/${"a".repeat(64)}.png`;
const PROFILE = `loomina://assets/${"b".repeat(64)}.png`;
const MASTER = `loomina://assets/${"c".repeat(64)}.png`;

function asset(id: string, uri: string | undefined, costCny?: number): Asset {
  return {
    id,
    kind: "image",
    ...(uri ? { uri } : {}),
    source: "generated",
    ...(costCny !== undefined ? { costCny } : {}),
    provenance: { modelId: "gpt-image-2", referenceAssetIds: [], createdAt: "2026-11-01T00:00:00Z" },
    createdAt: "2026-11-01T00:00:00Z",
  };
}

function project(fields: Partial<Project> = {}): Project {
  return {
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
    ...fields,
  };
}

const LIN: Character = {
  id: "c-lin",
  name: "林",
  appearance: "短发，灰色风衣",
  sheet: { front: "a-front", side: "a-side" },
  referenceImages: ["a-ref", "a-missing"],
  mustNotChange: ["左眉有疤"],
};

function sourceProject(): Project {
  return project({
    assets: [
      asset("a-front", PORTRAIT, 0.12),
      asset("a-side", PROFILE, 0.12),
      asset("a-ref", PROFILE, 0.12),
      asset("a-master", MASTER, 0.12),
      asset("a-empty", undefined),
    ],
    characters: [LIN],
    locations: [
      {
        id: "l-hall",
        name: "走廊",
        description: "顶灯坏了，一半亮一半暗",
        templateId: "corridor",
        masterShotId: "a-master",
        referenceImages: [],
        space: { dimensions: [4, 2.6, 3], anchors: [{ id: "an-1", kind: "door", position: [1, 0, 0], facingRad: 0, capacity: 0 }] },
      },
    ],
    props: [{ id: "p-cup", name: "搪瓷杯", description: "掉了一块瓷", referenceImages: ["a-ref"] }],
  });
}

describe("跨空间实体清单（C1）", () => {
  it("按类型列出，带缩略图与「带过来多少东西」", () => {
    const list = sharedEntitiesOf([{ id: "w1", name: "第一集", project: sourceProject() }], "character");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "林", workspaceName: "第一集", thumbnail: PORTRAIT });
    expect(sharedEntitySummary(list[0]!)).toBe("2 格定妆 · 1 张参考图");
  });

  it("场景与道具各自成列，没有地址的资产不进清单", () => {
    const spaces = [{ id: "w1", name: "第一集", project: sourceProject() }];
    const locations = sharedEntitiesOf(spaces, "location");
    expect(locations[0]?.assets.map((item) => item.id)).toEqual(["a-master"]);
    expect(sharedEntitySummary(locations[0]!)).toBe("主镜 1 张 · 0 张参考图");
    const props = sharedEntitiesOf(spaces, "prop");
    expect(props[0]?.assets).toHaveLength(1);
  });
});

describe("把一个实体搬进当前项目（C1 / ADR-0190）", () => {
  const source = () => sharedEntitiesOf([{ id: "w1", name: "第一集", project: sourceProject() }], "character")[0]!;

  it("演员：换 id、带定妆与参考图，花费不跟过来", () => {
    const target = project();
    const imported = sharedEntityImport(source(), target, "2026-11-13T12:00:00.000Z");
    const next = imported.events.reduce(applyEvent, target);
    const character = next.characters[0]!;
    expect(character.id).not.toBe("c-lin");
    expect(character.name).toBe("林");
    expect(character.mustNotChange).toEqual(["左眉有疤"]);
    expect(character.sheet.front).toBeDefined();
    expect(character.sheet.front).not.toBe("a-front");
    expect(character.referenceImages).toHaveLength(1);

    const front = next.assets.find((item) => item.id === character.sheet.front)!;
    expect(front.uri).toBe(PORTRAIT);
    expect(front.source).toBe("library");
    expect(front.costCny).toBeUndefined();
    expect(front.provenance?.modelId).toBe("gpt-image-2");
    expect(imported.skipped).toBe(1); // a-missing 在源项目里也没有资产
  });

  it("缺的定妆格补占位，不引用源项目里的 id", () => {
    const target = project();
    const imported = sharedEntityImport(source(), target, "2026-11-13T12:00:00.000Z");
    const next = imported.events.reduce(applyEvent, target);
    const character = next.characters[0]!;
    const slots = sheetSlotsOf(character.id);
    expect(character.sheet.threeQuarter).toBe(slots.threeQuarter);
    expect(next.assets.some((item) => item.id === slots.threeQuarter && item.placeholder)).toBe(true);
  });

  it("同名加「（复用）」，同一地址的资产直接复用", () => {
    const target = project({
      assets: [asset("a-existing", PORTRAIT)],
      characters: [{ ...LIN, id: "c-old", sheet: {}, referenceImages: [] }],
    });
    const imported = sharedEntityImport(source(), target, "2026-11-13T12:00:00.000Z");
    const next = imported.events.reduce(applyEvent, target);
    expect(next.characters[1]?.name).toBe("林（复用）");
    expect(imported.reused).toBe(2); // 正面复用已有的，参考图复用刚登记的侧面（同一地址）
    expect(next.assets.filter((item) => item.uri === PORTRAIT)).toHaveLength(1);
    expect(next.assets.filter((item) => item.uri === PROFILE)).toHaveLength(1);
  });

  it("场景：主镜、描述、模板与几何都带过来", () => {
    const target = project();
    const list = sharedEntitiesOf([{ id: "w1", name: "第一集", project: sourceProject() }], "location");
    const imported = sharedEntityImport(list[0]!, target, "2026-11-13T12:00:00.000Z");
    const next = imported.events.reduce(applyEvent, target);
    const location = next.locations[0] as Location;
    expect(location).toMatchObject({ name: "走廊", description: "顶灯坏了，一半亮一半暗", templateId: "corridor" });
    expect(location.masterShotId).toBeDefined();
    expect(next.assets.find((item) => item.id === location.masterShotId)?.uri).toBe(MASTER);
    expect(location.space?.dimensions).toEqual([4, 2.6, 3]);
    expect(location.space?.anchors[0]?.position).toEqual([1, 0, 0]);
  });

  it("道具：名字、描述与参考图", () => {
    const target = project();
    const list = sharedEntitiesOf([{ id: "w1", name: "第一集", project: sourceProject() }], "prop");
    const imported = sharedEntityImport(list[0]!, target, "2026-11-13T12:00:00.000Z");
    const next = imported.events.reduce(applyEvent, target);
    const prop = next.props[0] as Prop;
    expect(prop).toMatchObject({ name: "搪瓷杯", description: "掉了一块瓷" });
    expect(next.assets.find((item) => item.id === prop.referenceImages[0])?.uri).toBe(PROFILE);
  });
});
