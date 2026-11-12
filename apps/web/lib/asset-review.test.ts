import { ProjectSchema } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import { reviewSubjectsOf, reviewSummaryOf, withReview } from "./asset-review";

const AT = "2026-11-12T10:00:00+08:00";

/**
 * 一份最小的片子：两镜上画面轨、一镜有首帧、一句有配音，外加一张不进成片的定妆图。
 * 示例项目里没有真资产，这一层要的是「谁会被审」，所以自己摆一份。
 */
function fixture(overrides: Record<string, unknown> = {}) {
  return ProjectSchema.parse({
    id: "p-review",
    title: "夜班",
    version: 1,
    createdAt: AT,
    scenes: [
      { id: "sc-1", index: 0, locationId: "loc-1", shotIds: ["s-01", "s-02"] },
    ],
    locations: [{ id: "loc-1", name: "走廊" }],
    characters: [{ id: "c-1", name: "林" }],
    props: [],
    dialogue: [{ id: "d-01", characterId: "c-1", text: "灯是我关的。", durationMs: 1800, audioAssetId: "a-voice" }],
    shots: [
      {
        id: "s-01",
        sceneId: "sc-1",
        index: 0,
        durationMs: 2000,
        description: "走廊",
        shotSize: "wide",
        camera: { angle: "eye", movement: "static", focalMm: 24 },
        characterIds: [],
        dialogueIds: [],
        takeIds: ["t-01"],
        keyframes: { firstAssetId: "a-first" },
        locked: false,
      },
      {
        id: "s-02",
        sceneId: "sc-1",
        index: 1,
        durationMs: 2000,
        description: "门口",
        shotSize: "wide",
        camera: { angle: "eye", movement: "static", focalMm: 24 },
        characterIds: [],
        dialogueIds: ["d-01"],
        takeIds: ["t-02"],
        locked: false,
      },
    ],
    takes: [
      { id: "t-01", shotId: "s-01", assetId: "a-video-1", status: "approved", costCny: 0, provenance: { modelId: "m", createdAt: AT } },
      { id: "t-02", shotId: "s-02", assetId: "a-video-2", status: "draft", costCny: 0, provenance: { modelId: "m", createdAt: AT } },
    ],
    assets: [
      { id: "a-video-1", kind: "video", uri: "loomina://assets/1.mp4", source: "generated", createdAt: AT },
      { id: "a-video-2", kind: "video", uri: "loomina://assets/2.mp4", source: "generated", createdAt: AT },
      { id: "a-first", kind: "image", uri: "loomina://assets/3.png", source: "generated", createdAt: AT },
      { id: "a-voice", kind: "audio", uri: "loomina://assets/4.mp3", source: "generated", createdAt: AT },
      // 定妆图：不进成片，不该出现在复核清单里
      { id: "a-sheet", kind: "image", uri: "loomina://assets/5.png", source: "generated", createdAt: AT },
    ],
    timeline: {
      items: [
        { id: "tl-1", shotId: "s-01", takeId: "t-01", startMs: 0, durationMs: 2000 },
        { id: "tl-2", shotId: "s-02", takeId: "t-02", startMs: 2000, durationMs: 2000 },
      ],
    },
    ...overrides,
  });
}

function reviewed(ids: string[], status: "passed" | "rejected" = "passed", base = fixture()) {
  return ProjectSchema.parse({
    ...base,
    assets: base.assets.map((asset) =>
      ids.includes(asset.id) ? { ...asset, review: { status, at: AT } } : asset,
    ),
  });
}

describe("生成结果复核（H6 / ADR-0132）", () => {
  it("只列会进成片的资产：画面轨、首尾帧、配音", () => {
    const ids = reviewSubjectsOf(fixture()).map((item) => item.assetId);
    expect(ids).toEqual(["a-video-1", "a-video-2", "a-first", "a-voice"]);
    // 定妆图不进成片，不审
    expect(ids).not.toContain("a-sheet");
  });

  it("位置写成人话：第几镜、哪一种", () => {
    const subjects = reviewSubjectsOf(fixture());
    expect(subjects[0]!.where).toBe("第 1 镜 画面");
    expect(subjects[2]!.where).toBe("第 1 镜 首帧");
    expect(subjects[3]!.where).toContain("配音");
  });

  it("同一资产只算一次，位置取第一次出现的", () => {
    const shared = fixture({
      shots: [
        { ...fixture().shots[0]!, keyframes: { firstAssetId: "a-video-1" } },
        fixture().shots[1]!,
      ],
    });
    const ids = reviewSubjectsOf(shared).map((item) => item.assetId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === "a-video-1")).toHaveLength(1);
  });

  it("没有复核记录时是 review，不是 block", () => {
    const summary = reviewSummaryOf(fixture());
    expect(summary.status).toBe("review");
    expect(summary.unreviewed).toBe(4);
    expect(summary.rejected).toBe(0);
  });

  it("标成不可用就是 block，并点名是哪一条", () => {
    const summary = reviewSummaryOf(reviewed(["a-video-1"], "rejected"));
    expect(summary.status).toBe("block");
    expect(summary.rejected).toBe(1);
    expect(summary.rejectedSubjects[0]!.where).toBe("第 1 镜 画面");
    expect(summary.summary).toContain("不能进成片");
  });

  it("全部复核过就是 pass", () => {
    const all = reviewSubjectsOf(fixture()).map((item) => item.assetId);
    const summary = reviewSummaryOf(reviewed(all));
    expect(summary.status).toBe("pass");
    expect(summary.unreviewed).toBe(0);
    expect(summary.summary).toContain("都复核过了");
  });

  it("没有地址的资产不算没看，也不算看过，单独数出来并如实写进摘要", () => {
    const bare = fixture({
      assets: fixture().assets.map((asset) =>
        asset.id === "a-video-1" ? { ...asset, uri: undefined } : asset,
      ),
    });
    const summary = reviewSummaryOf(bare);
    expect(summary.missing).toBe(1);
    expect(summary.unreviewedSubjects.some((item) => item.assetId === "a-video-1")).toBe(false);
    expect(summary.missingSubjects[0]!.assetId).toBe("a-video-1");
    // 剩下的都看过之后也不能说「都复核过了」：有一条根本看不了
    const rest = reviewSubjectsOf(bare)
      .map((item) => item.assetId)
      .filter((id) => id !== "a-video-1");
    const done = reviewSummaryOf(reviewed(rest, "passed", bare));
    // 看不了的条目仍算「待确认」：成片里那一格是空的，得有人认下来
    expect(done.status).toBe("review");
    expect(done.summary).toContain("没有文件");
  });

  it("列出来的顺序：不可用 → 没看 → 看不了 → 已看", () => {
    const base = fixture({
      assets: fixture().assets.map((asset) =>
        asset.id === "a-voice" ? { ...asset, uri: undefined } : asset,
      ),
    });
    const mixed = ProjectSchema.parse({
      ...base,
      assets: base.assets.map((asset) =>
        asset.id === "a-video-1"
          ? { ...asset, review: { status: "rejected", at: AT } }
          : asset.id === "a-video-2"
            ? { ...asset, review: { status: "passed", at: AT } }
            : asset,
      ),
    });
    const summary = reviewSummaryOf(mixed);
    expect(summary.subjects.map((item) => item.assetId)).toEqual([
      "a-video-1", // 不可用
      "a-first", // 还没看
      "a-voice", // 看不了
      "a-video-2", // 已看
    ]);
  });

  it("withReview 不改别的字段；传 undefined 删掉字段而不是留 undefined", () => {
    const asset = fixture().assets.find((item) => item.id === "a-video-1")!;
    const marked = withReview(asset, { status: "passed", at: AT });
    expect(marked.review).toEqual({ status: "passed", at: AT });
    expect(marked.id).toBe(asset.id);
    expect(marked.uri).toBe(asset.uri);
    const cleared = withReview(marked, undefined);
    expect("review" in cleared).toBe(false);
  });

  it("资产丢了也照样点名：成片里那一格会是空的", () => {
    const broken = fixture({
      takes: [{ id: "t-01", shotId: "s-01", assetId: "a-gone", status: "approved", costCny: 0, provenance: { modelId: "m", createdAt: AT } }],
      shots: [{ ...fixture().shots[0]!, takeIds: ["t-01"] }, fixture().shots[1]!],
      timeline: {
        items: [
          { id: "tl-1", shotId: "s-01", takeId: "t-01", startMs: 0, durationMs: 2000 },
          { id: "tl-2", shotId: "s-02", takeId: "t-02", startMs: 2000, durationMs: 2000 },
        ],
      },
    });
    const subject = reviewSubjectsOf(broken).find((item) => item.assetId === "a-gone");
    expect(subject?.hasMedia).toBe(false);
    expect(subject?.where).toBe("第 1 镜 画面");
  });
});
