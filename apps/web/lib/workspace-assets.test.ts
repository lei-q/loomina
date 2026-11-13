import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRAND,
  DEFAULT_FRAME,
  DEFAULT_GRADE,
  DEFAULT_LOOK,
  type Asset,
  type Character,
  type Project,
} from "@loomina/ir";
import { sharedAssetsOf, type WorkspaceProject } from "./workspace-assets";

const STORED = `loomina://assets/${"a".repeat(64)}.png`;
const OTHER = `loomina://assets/${"b".repeat(64)}.png`;
const REMOTE = "s3://loomina/assets/c.png";

function asset(id: string, uri: string | undefined, createdAt = "2026-11-01T00:00:00Z", kind: Asset["kind"] = "image"): Asset {
  return { id, kind, uri, source: "generated", createdAt };
}

function project(id: string, assets: Asset[], characters: Character[] = []): Project {
  return {
    id,
    title: id,
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
    locations: [],
    characters,
    props: [],
    scenes: [],
    shots: [],
    dialogue: [],
    voiceTakes: [],
    takes: [],
    assets,
    approvals: [],
    gates: [],
    timeline: { items: [], music: [], sfx: [], mix: { dialogueDb: 0, musicDb: 0, sfxDb: 0 } },
    subtitleOverrides: [],
    subtitleLayout: { preset: "default" },
    subtitleTranslation: { enabled: false, lang: "en", position: "below" },
    publishPackages: [],
    authorizations: [],
  };
}

function space(id: string, name: string, projectValue: Project): WorkspaceProject {
  return { id, name, project: projectValue };
}

function character(name: string, referenceImages: string[]): Character {
  return { id: `c-${name}`, name, appearance: "", sheet: {}, referenceImages, mustNotChange: [] };
}

describe("跨空间素材清单（C4）", () => {
  it("同一份文件在多个空间用过，只出现一次，使用处合并", () => {
    const spaces = [
      space("w1", "第一集", project("p1", [asset("a1", STORED)], [character("林", ["a1"])])),
      space("w2", "第二集", project("p2", [asset("a2", STORED)], [character("周", ["a2"])])),
    ];
    const list = sharedAssetsOf(spaces);
    expect(list).toHaveLength(1);
    expect(list[0]?.uri).toBe(STORED);
    expect(list[0]?.workspaceName).toBe("第一集");
    expect(list[0]?.usedBy).toEqual(["参考图「林」", "参考图「周」"]);
  });

  it("默认只列图片；视频、音频、调色表不进来", () => {
    const spaces = [
      space(
        "w1",
        "第一集",
        project("p1", [
          asset("a1", STORED),
          asset("a2", OTHER, "2026-11-02T00:00:00Z", "video"),
          asset("a3", REMOTE, "2026-11-03T00:00:00Z", "audio"),
          asset("a4", `loomina://assets/${"c".repeat(64)}.cube`, "2026-11-04T00:00:00Z", "lut"),
        ]),
      ),
    ];
    expect(sharedAssetsOf(spaces).map((item) => item.uri)).toEqual([STORED]);
  });

  it("可以按类型取，图片与视频各跑一遍", () => {
    const spaces = [
      space("w1", "第一集", project("p1", [asset("a1", STORED), asset("a2", OTHER, "2026-11-02T00:00:00Z", "video")])),
    ];
    expect(sharedAssetsOf(spaces, ["video"]).map((item) => item.uri)).toEqual([OTHER]);
  });

  it("新的排前面", () => {
    const spaces = [
      space(
        "w1",
        "第一集",
        project("p1", [
          asset("a1", STORED, "2026-11-01T00:00:00Z"),
          asset("a2", OTHER, "2026-11-09T00:00:00Z"),
        ]),
      ),
    ];
    expect(sharedAssetsOf(spaces).map((item) => item.uri)).toEqual([OTHER, STORED]);
  });

  it("没有地址的资产（还没生成）不进清单", () => {
    const spaces = [space("w1", "第一集", project("p1", [asset("a1", undefined)]))];
    expect(sharedAssetsOf(spaces)).toEqual([]);
  });

  it("没人引用的图片也列出来：还留在资产里就能拿来用", () => {
    const spaces = [space("w1", "第一集", project("p1", [asset("a1", STORED)]))];
    const list = sharedAssetsOf(spaces);
    expect(list).toHaveLength(1);
    expect(list[0]?.usedBy).toEqual([]);
  });
});
