import { rebuild, type Project, type ProjectEvent } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import { sampleProject } from "./sample-project";
import {
  replayRestore,
  scriptRestoreEvents,
  scriptVersionsOf,
  textDiff,
} from "./script-versions";

const AT = "2026-11-14T00:00:00Z";
const LATER = "2026-11-14T00:01:00Z";

const clone = (): Project => structuredClone(sampleProject);

function logOf(...extra: ProjectEvent[]): ProjectEvent[] {
  return [{ type: "project.created", at: AT, project: clone() }, ...extra];
}

describe("剧本 / 分镜整份版本快照（C14 / ADR-0204）", () => {
  it("初版带整份文本，之后一次改字多一版；同毫秒一组只算一版", () => {
    const versions = scriptVersionsOf(logOf());
    expect(versions).toHaveLength(1);
    expect(versions[0]!.text).toContain("走廊尽头，灯管闪了一下");
    expect(versions[0]!.scenes).toBe(5);
    expect(versions[0]!.shots).toBe(12);
    expect(versions[0]!.lines).toBe(4);

    const batched = scriptVersionsOf(
      logOf(
        { type: "shot.updated", at: LATER, shotId: "s-01", patch: { description: "改过的动作" } },
        { type: "dialogue.updated", at: LATER, lineId: "d-01", patch: { text: "改过的台词" } },
      ),
    );
    expect(batched).toHaveLength(2);
    expect(batched[1]!.text).toContain("改过的动作");
    expect(batched[1]!.text).toContain("改过的台词");
    expect(batched[1]!.labels).toHaveLength(2);
  });

  it("成片字段不算剧本改动：配音 / 关键帧 / 锁定不另起一版", () => {
    const versions = scriptVersionsOf(
      logOf(
        { type: "dialogue.updated", at: LATER, lineId: "d-01", patch: { translation: "You knew it." } },
        { type: "shot.updated", at: LATER, shotId: "s-01", patch: { locked: true } },
      ),
    );
    expect(versions).toHaveLength(1);
  });

  it("回到起点后内容一样不补合成版；非剧本事件改了内容时补一条", () => {
    const versions = scriptVersionsOf(
      logOf({ type: "project.restored", at: LATER, toEventCount: 1, label: "回到起点" }),
    );
    expect(versions).toHaveLength(1);

    const other = clone();
    other.title = "另一份剧本";
    const withNewProject = scriptVersionsOf([
      { type: "project.created", at: AT, project: clone() },
      { type: "project.created", at: LATER, project: other },
    ]);
    expect(withNewProject).toHaveLength(2);
  });

  it("行差异：改一个字同时出现在多 / 少两栏", () => {
    const diff = textDiff("甲\n乙\n丙", "甲\n乙改\n丁");
    expect(diff.added).toEqual(["乙改", "丁"]);
    expect(diff.removed).toEqual(["乙", "丙"]);
  });
});

describe("用这版写回（轻恢复）", () => {
  it("只把当前仍存在的场 / 镜 / 句的剧本字段写回，回放一致", () => {
    const current = clone();
    const target = clone();
    target.scenes[0]!.space = "ext";
    target.scenes[0]!.timeOfDay = "dawn";
    target.shots.find((shot) => shot.id === "s-01")!.description = "旧版动作";
    target.shots.find((shot) => shot.id === "s-01")!.shotSize = "wide";
    target.dialogue.find((line) => line.id === "d-01")!.text = "旧版台词";
    target.dialogue.find((line) => line.id === "d-01")!.characterId = "c-lin";

    const restore = scriptRestoreEvents(current, target, LATER);
    expect(restore.events.length).toBeGreaterThan(0);
    expect(restore.events.every((event) => event.at === LATER)).toBe(true);
    // 不带成片字段 / 非剧本文字
    expect(restore.events.some((event) => event.type === "take.removed")).toBe(false);
    const after = replayRestore(current, restore.events);
    expect(after.scenes[0]!.space).toBe("ext");
    expect(after.scenes[0]!.timeOfDay).toBe("dawn");
    expect(after.shots.find((shot) => shot.id === "s-01")!.description).toBe("旧版动作");
    expect(after.dialogue.find((line) => line.id === "d-01")!.text).toBe("旧版台词");
    expect(after.dialogue.find((line) => line.id === "d-01")!.characterId).toBe("c-lin");
    // take / 关键帧 / 配音 / 时间线不受影响
    expect(after.takes).toEqual(current.takes);
    expect(after.timeline).toEqual(current.timeline);
    expect(after.voiceTakes).toEqual(current.voiceTakes);
    expect(rebuild(logOf(...restore.events))).toEqual(after);
  });

  it("旧版多出来的结构不重建、现在多出来的不删；锁镜与失效地点如实计数", () => {
    const target = clone();
    const current = clone();
    // 目标版里有 s-12 / d-04 / sc-5，当前已经删掉；当前锁住 s-01；地点 loc-door 失效
    current.shots = current.shots.filter((shot) => shot.id !== "s-12");
    current.dialogue = current.dialogue.filter((line) => line.id !== "d-04");
    current.scenes = current.scenes.filter((scene) => scene.id !== "sc-5");
    current.shots.find((shot) => shot.id === "s-01")!.locked = true;
    current.locations = current.locations.filter((location) => location.id !== "loc-door");
    target.scenes.find((scene) => scene.id === "sc-4")!.locationId = "loc-door";
    current.scenes.find((scene) => scene.id === "sc-4")!.locationId = "loc-corridor";

    const restore = scriptRestoreEvents(current, target, LATER);
    expect(restore.missingShots).toBe(1);
    expect(restore.missingLines).toBe(1);
    expect(restore.missingScenes).toBe(1);
    // s-01 与示例里本来就锁着的 s-08 都跳过
    expect(restore.lockedShots).toBe(2);
    expect(restore.droppedLocations).toBe(1);
    const after = replayRestore(current, restore.events);
    // 已删的镜 / 句不重建；仍在的结构一条不少
    expect(after.shots.some((shot) => shot.id === "s-12")).toBe(false);
    expect(after.dialogue.some((line) => line.id === "d-04")).toBe(false);
    expect(after.shots).toHaveLength(current.shots.length);
    // 锁定的镜头动作没动
    expect(after.shots.find((shot) => shot.id === "s-01")!.description).toBe(
      current.shots.find((shot) => shot.id === "s-01")!.description,
    );
  });

  it("与现在完全一致时不写事件", () => {
    const current = clone();
    expect(scriptRestoreEvents(current, clone(), LATER).events).toEqual([]);
  });
});
