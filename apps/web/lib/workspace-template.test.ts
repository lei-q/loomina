import type { Project } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import type { WorkspaceMeta } from "./event-log";
import { sampleProject } from "./sample-project";
import { projectFromSetup, setupSourceProblem, setupSourcesOf } from "./workspace-template";

const clone = (): Project => structuredClone(sampleProject);

describe("照别的空间开工（C1 / ADR-0197）", () => {
  it("带设定、不带成片：故事 / 演员 / 场景 / 道具 / 技能都在，场次与分镜清空", () => {
    const source = clone();
    source.story.logline = "夜班最后一小时";
    source.skills = [
      {
        id: "sk-1",
        name: "不要现代物品",
        description: "",
        stage: "master",
        body: "场景里不要出现现代物品。",
        enabled: true,
        createdAt: "2026-11-13T00:00:00Z",
      },
    ];
    const next = projectFromSetup(source, { id: "p-new", title: "第二集" });

    expect(next.id).toBe("p-new");
    expect(next.title).toBe("第二集");
    expect(next.version).toBe(1);
    expect(next.story.logline).toBe("夜班最后一小时");
    expect(next.skills).toHaveLength(1);
    // id 原样保留：故事里的弧光 / 关系、场景主镜继续有效
    expect(next.characters.map((item) => item.id)).toEqual(
      source.characters.map((item) => item.id),
    );
    expect(next.locations.map((item) => item.id)).toEqual(
      source.locations.map((item) => item.id),
    );
    expect(next.props.map((item) => item.id)).toEqual(source.props.map((item) => item.id));
    // 成片不跟
    expect(next.scenes).toEqual([]);
    expect(next.shots).toEqual([]);
    expect(next.dialogue).toEqual([]);
    expect(next.takes).toEqual([]);
    expect(next.timeline.items).toEqual([]);
    expect(next.approvals).toEqual([]);
    expect(next.gates).toEqual([]);
    // 复制不是引用：改新项目不动来源
    next.story.logline = "改了";
    expect(source.story.logline).toBe("夜班最后一小时");
  });

  it("只带被设定引用的资产；生成物记 library、不抄花费与复核", () => {
    const source = clone();
    const sheet = source.characters[0]!.sheet.front!;
    const sheetAsset = source.assets.find((asset) => asset.id === sheet)!;
    sheetAsset.costCny = 0.12;
    sheetAsset.review = { status: "passed", at: "2026-11-13T00:00:00Z" };
    // 成片资产不该跟过来
    source.assets.push({
      id: "a-take-only",
      kind: "video",
      source: "generated",
      uri: "loomina://assets/take.mp4",
      costCny: 3.2,
      createdAt: "2026-11-13T00:00:00Z",
    });
    // 调色表跟过来
    source.assets.push({
      id: "a-lut",
      kind: "lut",
      source: "upload",
      uri: "loomina://assets/look.cube",
      createdAt: "2026-11-13T00:00:00Z",
    });
    source.grade.lutAssetId = "a-lut";

    const next = projectFromSetup(source, { id: "p-new", title: "第二集" });
    expect(next.assets.some((asset) => asset.id === "a-take-only")).toBe(false);
    expect(next.assets.some((asset) => asset.id === "a-lut")).toBe(true);

    const copied = next.assets.find((asset) => asset.id === sheet)!;
    expect(copied.source).toBe("library");
    expect(copied.costCny).toBeUndefined();
    expect(copied.review).toBeUndefined();
    // 上传 / 导入的保留原来源
    expect(next.assets.find((asset) => asset.id === "a-lut")?.source).toBe("upload");
  });

  it("没改来源：原项目的资产来源与账目不动", () => {
    const source = clone();
    const before = structuredClone(source);
    projectFromSetup(source, { id: "p-new", title: "第二集" });
    expect(source.assets).toEqual(before.assets);
    expect(source.takes).toEqual(before.takes);
  });
});

describe("任选来源（C22 第二档 / ADR-0213）", () => {
  const meta = (id: string, name: string, extra: Partial<WorkspaceMeta> = {}): WorkspaceMeta => ({
    id,
    name,
    createdAt: "2026-11-13T00:00:00Z",
    lastOpenedAt: "2026-11-13T00:00:00Z",
    ...extra,
  });

  it("列出所有能当来源的空间，归档的不收", () => {
    const list = [
      meta("w-1", "第一集"),
      meta("w-2", "第二集", { seriesId: "s-a", episodeNo: 2 }),
      meta("w-3", "收起来的", { archivedAt: "2026-11-14T00:00:00Z" }),
    ];
    expect(setupSourcesOf(list).map((item) => item.id)).toEqual(["w-1", "w-2"]);
  });

  it("来源找不到、归档了都要说清楚；不给来源不算问题", () => {
    const list = [meta("w-1", "第一集"), meta("w-2", "收起来的", { archivedAt: "x" })];
    expect(setupSourceProblem(list, undefined)).toBeUndefined();
    expect(setupSourceProblem(list, "w-1")).toBeUndefined();
    expect(setupSourceProblem(list, "w-9")).toContain("找不到");
    expect(setupSourceProblem(list, "w-2")).toContain("归档");
    expect(setupSourceProblem(list, "w-2")).toContain("收起来的");
  });
});
