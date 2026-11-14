import { describe, expect, it } from "vitest";
import { ProjectSchema, type Project } from "@loomina/ir";
import { shotSheetOf, shotSheetText, shotSheetTsv } from "./shot-sheet";

function makeProject(shots: Partial<Project["shots"][number]>[]): Project {
  return ProjectSchema.parse({
    id: "p-sheet",
    title: "摄影单",
    version: 0,
    locations: [{ id: "loc-1", name: "公寓客厅" }],
    characters: [{ id: "c-a", name: "林晚" }],
    scenes: [
      {
        id: "sc-1",
        index: 0,
        locationId: "loc-1",
        shotIds: shots.map((_, index) => `s-${index + 1}`),
      },
    ],
    shots: shots.map((patch, index) => ({
      id: `s-${index + 1}`,
      sceneId: "sc-1",
      index,
      durationMs: 2000,
      description: `第 ${index + 1} 镜`,
      shotSize: "medium",
      camera: { angle: "eye", movement: "static", focalMm: 35 },
      characterIds: ["c-a"],
      dialogueIds: [],
      ...patch,
    })),
  });
}

describe("摄影单（I7 第二档 / ADR-0222）", () => {
  it("按场分组、场内按镜序，镜号与全片镜号都对", () => {
    const sheet = shotSheetOf(
      makeProject([{ shotSize: "wide" }, { shotSize: "close" }, { shotSize: "medium" }]),
    );
    expect(sheet.groups).toHaveLength(1);
    expect(sheet.groups[0]!.label).toBe("第 1 场");
    expect(sheet.groups[0]!.locationName).toBe("公寓客厅");
    expect(sheet.groups[0]!.rows.map((row) => row.no)).toEqual([1, 2, 3]);
    expect(sheet.groups[0]!.rows.map((row) => row.overall)).toEqual([1, 2, 3]);
  });

  it("景别 / 机位 / 运镜 / 焦段 / 光影 / 构图都翻成中文", () => {
    const sheet = shotSheetOf(
      makeProject([
        {
          shotSize: "close",
          camera: { angle: "low", movement: "push", focalMm: 85 },
          lighting: { source: "window", position: "back", mood: "modeled", note: "" },
          composition: { rule: "thirds", note: "" },
        },
      ]),
    );
    const row = sheet.groups[0]!.rows[0]!;
    expect(row.shotSize).toBe("特写");
    expect(row.angle).toBe("仰拍");
    expect(row.movement).toBe("缓缓推近");
    expect(row.focalMm).toBe(85);
    expect(row.lighting).toBe("逆光");
    expect(row.composition).toBe("三分");
  });

  it("没写光影 / 构图如实留空，不编默认值", () => {
    const sheet = shotSheetOf(makeProject([{}]));
    const row = sheet.groups[0]!.rows[0]!;
    expect(row.lighting).toBeNull();
    expect(row.composition).toBeNull();
    expect(sheet.summary.withoutLighting).toBe(1);
    expect(sheet.summary.withoutComposition).toBe(1);
  });

  it("汇总：景别与机位按固定顺序、焦段去重升序、平均镜长", () => {
    const sheet = shotSheetOf(
      makeProject([
        { shotSize: "wide", camera: { angle: "eye", movement: "static", focalMm: 24 }, durationMs: 1000 },
        { shotSize: "close", camera: { angle: "low", movement: "static", focalMm: 85 }, durationMs: 3000 },
        { shotSize: "close", camera: { angle: "eye", movement: "static", focalMm: 24 }, durationMs: 2000 },
      ]),
    );
    expect(sheet.summary.shots).toBe(3);
    expect(sheet.summary.bySize.map((item) => item.label)).toEqual([
      "全景",
      "中景",
      "特写",
      "大特写",
    ]);
    expect(sheet.summary.bySize.find((item) => item.key === "close")?.count).toBe(2);
    expect(sheet.summary.focals).toEqual([24, 85]);
    expect(sheet.summary.averageSeconds).toBe(2);
  });

  it("没挂进场次的镜头进「未进场次」，不丢", () => {
    const project = makeProject([{}, {}]);
    const orphan = { ...project.shots[1]!, id: "s-orphan", sceneId: "sc-none" };
    const withOrphan = ProjectSchema.parse({
      ...project,
      shots: [project.shots[0]!, orphan],
      scenes: [{ ...project.scenes[0]!, shotIds: ["s-1"] }],
    });
    const sheet = shotSheetOf(withOrphan);
    expect(sheet.groups.map((group) => group.label)).toEqual(["第 1 场", "未进场次"]);
    expect(sheet.summary.shots).toBe(2);
  });

  it("一句话摘要只说事实，不评判景别是否单一", () => {
    const sheet = shotSheetOf(makeProject([{ shotSize: "wide" }, { shotSize: "medium" }]));
    const text = shotSheetText(sheet);
    expect(text).toContain("2 镜");
    expect(text).toContain("全景 1");
    expect(text).toContain("没写光影");
    expect(text).not.toContain("单一");
  });

  it("空项目如实说没有镜头", () => {
    const sheet = shotSheetOf(makeProject([]));
    expect(sheet.summary.shots).toBe(0);
    expect(shotSheetText(sheet)).toBe("还没有镜头。");
  });

  it("导成 TSV：表头齐全，行数与镜数一致", () => {
    const sheet = shotSheetOf(makeProject([{}, {}]));
    const lines = shotSheetTsv(sheet).split("\n");
    expect(lines).toHaveLength(3); // 表头 + 2 行
    expect(lines[0]).toContain("景别");
    expect(lines[0]).toContain("焦段(mm)");
    expect(lines[1]!.split("\t")).toHaveLength(11);
  });
});
