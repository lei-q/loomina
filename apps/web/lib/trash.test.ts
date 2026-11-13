import { VoiceTakeSchema, type Project, type ProjectEvent } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import { sampleProject } from "./sample-project";
import { takeFromLog, trashOf } from "./trash";

const clone = (): Project => structuredClone(sampleProject);

describe("废片库（C14 / ADR-0193）", () => {
  it("淘汰的拍列出来：哪一镜、原文件、花了多少", () => {
    const project = clone();
    const take = project.takes.find((item) => item.id === "t-03")!;
    take.status = "rejected";
    project.assets.push({
      id: take.assetId,
      kind: "video",
      source: "generated",
      uri: "loomina://assets/take-03.mp4",
      createdAt: "2026-11-09T21:11:00+08:00",
    });

    const item = trashOf(project, []).find((entry) => entry.key === "take:t-03");
    expect(item).toMatchObject({
      key: "take:t-03",
      kind: "take",
      state: "rejected",
      shotId: "s-03",
      uri: "loomina://assets/take-03.mp4",
      costCny: 2.12,
      modelId: "minimax-h3",
    });
    expect(item!.shotLabel).toContain("第 1 场");
    expect(item!.shotLabel).toContain("第 3 镜");
    expect(item!.shotDescription).toBe("她站在门口，没有进来");
  });

  it("已经删掉的拍从日志里找回来；取回过的不重复列", () => {
    const project = clone();
    const take = project.takes.find((item) => item.id === "t-04")!;
    project.assets.push({
      id: take.assetId,
      kind: "video",
      source: "generated",
      uri: "loomina://assets/take-04.mp4",
      createdAt: "2026-11-09T21:18:00+08:00",
    });
    const events: ProjectEvent[] = [
      { type: "take.added", at: "2026-11-13T10:00:00.000Z", take },
      { type: "take.removed", at: "2026-11-13T10:05:00.000Z", takeId: "t-04" },
    ];
    const stripped: Project = {
      ...project,
      takes: project.takes.filter((item) => item.id !== "t-04"),
      shots: project.shots.map((shot) => ({
        ...shot,
        takeIds: shot.takeIds.filter((id) => id !== "t-04"),
      })),
    };

    const item = trashOf(stripped, events).find((entry) => entry.key === "take:t-04");
    expect(item).toMatchObject({
      state: "removed",
      shotId: "s-04",
      at: "2026-11-13T10:05:00.000Z",
      uri: "loomina://assets/take-04.mp4",
    });
    expect(takeFromLog(events, "t-04")?.status).toBe("draft");

    // 原地「取回」后（项目里又有这一拍了）就不该再算废片
    const restored: Project = {
      ...project,
      takes: [...project.takes],
      shots: project.shots.map((shot) =>
        shot.id === "s-04" ? { ...shot, takeIds: ["t-04"] } : shot,
      ),
    };
    expect(trashOf(restored, events).some((item) => item.key === "take:t-04")).toBe(false);

    // 资产记录也删了就找不回来：不列点不动的空卡片
    const noAsset: Project = {
      ...stripped,
      assets: stripped.assets.filter((asset) => asset.id !== take.assetId),
    };
    expect(trashOf(noAsset, events).some((item) => item.key === "take:t-04")).toBe(false);
  });

  it("关键帧旧版列出来；当前这一张与重复地址不列", () => {
    const project = clone();
    const shot = project.shots.find((item) => item.id === "s-03")!;
    project.assets.push({
      id: "a-03",
      kind: "image",
      source: "generated",
      uri: "loomina://assets/current.png",
      createdAt: "2026-11-09T21:11:00+08:00",
    });
    project.assets.find((asset) => asset.id === "a-lin-expr")!.uri =
      "loomina://assets/old.png";
    shot.keyframes = {
      ...shot.keyframes,
      firstAssetId: "a-03",
      history: { first: ["a-lin-expr", "a-lin-expr"], last: [] },
    };

    const items = trashOf(project, []).filter((item) => item.kind === "keyframe");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "keyframe",
      state: "old",
      frame: "first",
      assetId: "a-lin-expr",
      uri: "loomina://assets/old.png",
      shotId: "s-03",
    });
    // 历史复制件不抄 costCny：钱仍记在当前资产位
    expect(items[0]!.costCny).toBeUndefined();

    // 历史里存着与当前同一张图（换回后可能出现）：不重复列
    project.assets.find((asset) => asset.id === "a-lin-expr")!.uri = "loomina://assets/current.png";
    expect(trashOf(project, []).filter((item) => item.kind === "keyframe")).toHaveLength(0);
  });

  it("删掉的配音列出来：哪句台词、原音轨；恢复后或资产 / 台词没了就不列", () => {
    const project = clone();
    project.assets.push({
      id: "a-voice-x",
      kind: "audio",
      source: "upload",
      uri: "loomina://assets/voice.mp3",
      createdAt: "2026-11-13T10:00:00.000Z",
    });
    const take = VoiceTakeSchema.parse({
      id: "vt-1",
      lineId: "d-01",
      assetId: "a-voice-x",
      performance: {},
      provenance: { modelId: "tts-x", createdAt: "2026-11-13T10:00:00.000Z" },
      createdAt: "2026-11-13T10:00:00.000Z",
    });
    const events: ProjectEvent[] = [
      { type: "voice.take.added", at: "2026-11-13T10:00:00.000Z", take },
      { type: "voice.take.removed", at: "2026-11-13T10:05:00.000Z", takeId: "vt-1" },
    ];

    const item = trashOf(project, events).find((entry) => entry.key === "voice:vt-1");
    expect(item).toMatchObject({
      kind: "voice",
      state: "removed",
      at: "2026-11-13T10:05:00.000Z",
      uri: "loomina://assets/voice.mp3",
      lineId: "d-01",
      lineText: "你早就知道，对吧。",
      modelId: "tts-x",
    });
    expect(item!.shotLabel).toContain("第 1 镜");

    // 被取回后（试听台里又有这一版）不再算废片
    expect(
      trashOf({ ...project, voiceTakes: [take] }, events).some((entry) => entry.key === "voice:vt-1"),
    ).toBe(false);
    // 台词删了：挂不回去，不列
    expect(
      trashOf(
        { ...project, dialogue: project.dialogue.filter((line) => line.id !== "d-01") },
        events,
      ).some((entry) => entry.key === "voice:vt-1"),
    ).toBe(false);
  });

  it("新的排前面", () => {
    const project = clone();
    project.takes.find((item) => item.id === "t-03")!.status = "rejected";
    const shot = project.shots.find((item) => item.id === "s-03")!;
    project.assets.find((asset) => asset.id === "a-lin-expr")!.uri = "loomina://assets/old.png";
    project.assets.find((asset) => asset.id === "a-lin-expr")!.createdAt = "2027-01-01T00:00:00.000Z";
    shot.keyframes = {
      ...shot.keyframes,
      firstAssetId: "a-03",
      history: { first: ["a-lin-expr"], last: [] },
    };

    const items = trashOf(project, []);
    expect(items[0]?.kind).toBe("keyframe");
    expect(items[1]?.kind).toBe("take");
  });
});
