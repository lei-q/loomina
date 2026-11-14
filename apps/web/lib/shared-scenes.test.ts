import { applyEvent, type Project } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import { sampleProject } from "./sample-project";
import { sceneImportEvents, sceneReadiness, sharedScenesOf } from "./shared-scenes";

const clone = (): Project => structuredClone(sampleProject);

const replay = (start: Project, imported: NonNullable<ReturnType<typeof sceneImportEvents>>) => {
  let next = start;
  for (const event of imported.events) next = applyEvent(next, event);
  return next;
};

describe("跨空间取一场剧本（C1）", () => {
  it("地点与演员都对得上时能整场取：3 镜 2 句", () => {
    const source = clone();
    const current = clone();
    const scene = source.scenes.find((item) => item.id === "sc-1")!;
    const readiness = sceneReadiness(source, current, scene);
    expect(readiness.ready).toBe(true);
    expect(readiness.shots).toBe(3);
    expect(readiness.lines).toBe(2);
    expect(readiness.missing).toEqual([]);
  });

  it("演员改名 / 地点缺失都整场拒绝，并说清缺谁", () => {
    const source = clone();
    const renamed = clone();
    renamed.characters = renamed.characters.map((character) =>
      character.id === "c-lin" ? { ...character, name: "林小姐" } : character,
    );
    const readiness = sceneReadiness(source, renamed, source.scenes[0]!);
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toContain("演员「林」");

    const noLocation = clone();
    noLocation.locations = noLocation.locations.filter((location) => location.id !== "loc-corridor");
    const missing = sceneReadiness(source, noLocation, source.scenes[0]!);
    expect(missing.ready).toBe(false);
    expect(missing.missing).toContain("地点「走廊」");
  });

  it("整场变成事件：先场再逐镜逐句，id 重编、不带 take / 关键帧 / 配音", () => {
    const source = clone();
    const current = clone();
    const imported = sceneImportEvents(source, current, "sc-1", "t1", "2026-11-13T00:00:00Z")!;
    expect(imported.events.map((event) => event.type)).toEqual([
      "scene.added",
      "shot.added",
      "dialogue.added",
      "shot.added",
      "shot.added",
      "dialogue.added",
    ]);

    const next = replay(current, imported);
    const scene = next.scenes.find((item) => item.id === imported.sceneId)!;
    expect(scene.locationId).toBe("loc-corridor");
    expect(scene.shotIds).toHaveLength(3);

    const shots = scene.shotIds.map((id) => next.shots.find((shot) => shot.id === id)!);
    expect(shots.map((shot) => shot.description)).toEqual([
      "走廊尽头，灯管闪了一下",
      "走廊尽头，门缝里透出一条光",
      "她站在门口，没有进来",
    ]);
    expect(shots.every((shot) => shot.takeIds.length === 0)).toBe(true);
    expect(shots.every((shot) => Object.keys(shot.keyframes).length === 0)).toBe(true);
    expect(shots.map((shot) => shot.index)).toEqual([0, 1, 2]);

    const lines = shots.flatMap((shot) => shot.dialogueIds).map((id) => next.dialogue.find((line) => line.id === id)!);
    expect(lines.map((line) => line.text)).toEqual(["你早就知道，对吧。", "知道了又怎样。"]);
    expect(lines.every((line) => line.audioAssetId === undefined)).toBe(true);
  });

  it("锁定的镜头取过来是可改的；对不上的道具只摘引用", () => {
    const source = clone();
    const current = clone();
    current.props = current.props.filter((prop) => prop.id !== "p-lamp");

    const imported = sceneImportEvents(source, current, "sc-2", "t2", "2026-11-13T00:00:00Z")!;
    expect(imported.missingProps).toEqual(["台灯"]);
    const next = replay(current, imported);
    const scene = next.scenes.find((item) => item.id === imported.sceneId)!;
    const shots = scene.shotIds.map((id) => next.shots.find((shot) => shot.id === id)!);
    expect(shots.every((shot) => shot.propIds.every((id) => id !== "p-lamp"))).toBe(true);
    expect(shots.every((shot) => shot.locked === false)).toBe(true);
  });

  it("对不上就返回 null；清单里能取的排前面", () => {
    const source = clone();
    const current = clone();
    current.characters = current.characters.filter((character) => character.id !== "c-zhou");
    expect(sceneImportEvents(source, current, "sc-1", "t3", "2026-11-13T00:00:00Z")).toBeNull();

    const spaces = [
      { id: "w-a", name: "第二集", project: clone() },
      { id: "w-b", name: "夜班", project: source },
    ];
    const list = sharedScenesOf(spaces, current);
    expect(list).toHaveLength(10);
    expect(list[0]!.readiness.ready).toBe(true);
    expect(list.at(-1)!.readiness.ready).toBe(false);
    expect(list.find((item) => item.scene.id === "sc-1")!.brief).toBe("走廊尽头，灯管闪了一下");
  });
});
