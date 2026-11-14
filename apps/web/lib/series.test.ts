import type { Project } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import { sampleProject } from "./sample-project";
import type { WorkspaceMeta } from "./event-log";
import { hooksOverlap, nextEpisodeNo, seriesOf, seriesOfSpace } from "./series";

const AT = "2026-11-14T00:00:00Z";

const meta = (id: string, name: string, over: Partial<WorkspaceMeta> = {}): WorkspaceMeta => ({
  id,
  name,
  createdAt: AT,
  lastOpenedAt: AT,
  ...over,
});

const withHooks = (opening: string, ending: string): Project => {
  const project = structuredClone(sampleProject);
  project.story.hooks = { opening, ending };
  return project;
};

describe("多集连载（A6 / ADR-0209）", () => {
  it("旧数据没有系列字段：各自算一集", () => {
    expect(seriesOfSpace(meta("w-a", "第一集"))).toEqual({ seriesId: "w-a", episodeNo: 1 });
    expect(seriesOfSpace(meta("w-a", "第二集", { seriesId: "s-1", episodeNo: 2 }))).toEqual({
      seriesId: "s-1",
      episodeNo: 2,
    });
  });

  it("按系列分组、按集序排；钩子接力三态", () => {
    const metas = [
      meta("w-2", "第二集", { seriesId: "s-1", episodeNo: 2 }),
      meta("w-1", "第一集", { seriesId: "s-1", episodeNo: 1 }),
      meta("w-3", "第三集", { seriesId: "s-1", episodeNo: 3 }),
      meta("w-x", "番外"),
    ];
    const projects = new Map<string, Project>([
      ["w-1", withHooks("电梯门开，走廊尽头站着一个人", "他按下了下行键")],
      ["w-2", withHooks("下行键亮了，电梯却在往上", "灯灭了")],
      ["w-3", withHooks("完全无关的一句开场", "最后一秒")],
      ["w-x", withHooks("", "")],
    ]);

    const [series, standalone] = seriesOf(metas, projects);
    expect(series!.seriesId).toBe("s-1");
    expect(series!.episodes.map((episode) => episode.episodeNo)).toEqual([1, 2, 3]);
    expect(series!.episodes[0]!.link).toBe("first");
    // 「下行键」三个字在两集里都有
    expect(series!.episodes[1]!.link).toBe("linked");
    expect(series!.episodes[1]!.previousEnding).toContain("下行键");
    expect(series!.episodes[2]!.link).toBe("weak");
    expect(standalone!.seriesId).toBe("w-x");
    expect(standalone!.episodes[0]!.link).toBe("first");
  });

  it("有一侧没写钩子就是 missing", () => {
    const metas = [
      meta("w-1", "一", { seriesId: "s", episodeNo: 1 }),
      meta("w-2", "二", { seriesId: "s", episodeNo: 2 }),
    ];
    const projects = new Map<string, Project>([
      ["w-1", withHooks("开场", "")],
      ["w-2", withHooks("接住", "收尾")],
    ]);
    expect(seriesOf(metas, projects)[0]!.episodes[1]!.link).toBe("missing");
  });

  it("钩子交集：中文按二元组、英文按词；空串不算接上", () => {
    expect(hooksOverlap("他按下了下行键", "下行键亮了")).toBe(true);
    expect(hooksOverlap("他按下了下行键", "电梯往上走")).toBe(false);
    expect(hooksOverlap("", "任何话")).toBe(false);
    expect(hooksOverlap("the door opens", "the door closes")).toBe(true);
  });

  it("下一集集序：同系列最大值 + 1；空系列从 1 开始", () => {
    const metas = [
      meta("w-1", "一", { seriesId: "s", episodeNo: 1 }),
      meta("w-3", "三", { seriesId: "s", episodeNo: 3 }),
      meta("w-x", "别的"),
    ];
    expect(nextEpisodeNo(metas, "s")).toBe(4);
    expect(nextEpisodeNo(metas, "none")).toBe(1);
  });

  it("能回放的集才进概览：projects 里没有的跳过", () => {
    const metas = [meta("w-1", "一", { seriesId: "s", episodeNo: 1 }), meta("w-2", "二", { seriesId: "s", episodeNo: 2 })];
    const projects = new Map<string, Project>([["w-1", structuredClone(sampleProject)]]);
    const [series] = seriesOf(metas, projects);
    expect(series!.episodes.map((episode) => episode.workspaceId)).toEqual(["w-1"]);
  });
});