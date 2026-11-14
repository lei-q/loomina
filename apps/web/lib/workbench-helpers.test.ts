import { describe, expect, it } from "vitest";
import { ProjectSchema, type Project, type ProjectEvent, type TimelineItem } from "@loomina/ir";
import {
  appendOnly,
  canonicalSpeakerColors,
  isLocked,
  nextOpenShotId,
  restack,
  removalUndoEvents,
} from "./workbench-helpers";

const item = (id: string, durationMs: number): TimelineItem =>
  ({ id, shotId: `s-${id}`, takeId: `t-${id}`, startMs: 999, durationMs }) as TimelineItem;

describe("工作台纯辅助函数（ADR-0236）", () => {
  it("restack 让起点首尾相接，忽略原来的 startMs", () => {
    const items = restack([item("a", 1000), item("b", 2000), item("c", 500)]);
    expect(items.map((entry) => entry.startMs)).toEqual([0, 1000, 3000]);
    // 时长不动
    expect(items.map((entry) => entry.durationMs)).toEqual([1000, 2000, 500]);
  });

  it("restack 空数组与单条", () => {
    expect(restack([])).toEqual([]);
    expect(restack([item("a", 700)])[0]!.startMs).toBe(0);
  });

  it("角色配色规范成大写、按 id 排序：键序不该决定写不写事件", () => {
    const a = canonicalSpeakerColors({ "c-b": "#ffd666", "c-a": "#7fd8ff" });
    const b = canonicalSpeakerColors({ "c-a": "#7FD8FF", "c-b": "#FFD666" });
    expect(a).toEqual({ "c-a": "#7FD8FF", "c-b": "#FFD666" });
    // 两份写法不同但语义相同的输入，规范后必须逐字节相同
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("角色配色：空值 / 空对象 / 全空白 id 都返回 undefined", () => {
    expect(canonicalSpeakerColors(undefined)).toBeUndefined();
    expect(canonicalSpeakerColors(null)).toBeUndefined();
    expect(canonicalSpeakerColors({})).toBeUndefined();
    expect(canonicalSpeakerColors({ "  ": "#fff" })).toBeUndefined();
  });

  const project = (shots: { id: string; state: string }[]): Project =>
    ProjectSchema.parse({
      id: "p-1",
      title: "测试",
      version: 0,
      scenes: [{ id: "sc-1", index: 0, locationId: "loc-1", shotIds: shots.map((s) => s.id) }],
      shots: shots.map((shot, index) => ({
        id: shot.id,
        sceneId: "sc-1",
        index,
        durationMs: 2000,
        description: shot.id,
        shotSize: "medium",
        camera: { angle: "eye", movement: "static", focalMm: 35 },
        characterIds: [],
        dialogueIds: [],
        ...(shot.state === "approved"
          ? { locked: true, takeIds: [`t-${shot.id}`] }
          : {}),
      })),
      takes:
        shots
          .filter((shot) => shot.state === "approved")
          .map((shot) => ({
            id: `t-${shot.id}`,
            shotId: shot.id,
            assetId: `a-${shot.id}`,
            status: "approved" as const,
            provenance: {
              modelId: "m",
              createdAt: "2026-11-14T00:00:00Z",
            },
          })),
    });

  it("nextOpenShotId：跳到下一格还没定的", () => {
    const p = project([
      { id: "s-1", state: "approved" },
      { id: "s-2", state: "open" },
      { id: "s-3", state: "open" },
    ]);
    expect(nextOpenShotId(p, "s-1")).toBe("s-2");
  });

  it("nextOpenShotId：到末尾就回到开头找；全定完原地不动", () => {
    const p = project([
      { id: "s-1", state: "open" },
      { id: "s-2", state: "approved" },
    ]);
    expect(nextOpenShotId(p, "s-2")).toBe("s-1");
    const allDone = project([{ id: "s-1", state: "approved" }]);
    expect(nextOpenShotId(allDone, "s-1")).toBe("s-1");
  });

  it("nextOpenShotId：找不到这一镜就原样返回", () => {
    expect(nextOpenShotId(project([]), "s-nope")).toBe("s-nope");
  });

  it("isLocked：过了闸门的对象才算锁定", () => {
    const p = ProjectSchema.parse({
      ...project([]),
      approvals: [
        {
          id: "ap-1",
          targetType: "character",
          targetId: "c-1",
          status: "approved",
          approvedAt: "2026-11-14T00:00:00Z",
          lockedAssetIds: [],
        },
        {
          id: "ap-2",
          targetType: "prop",
          targetId: "pr-1",
          status: "pending",
          approvedAt: "2026-11-14T00:00:00Z",
          lockedAssetIds: [],
        },
      ],
    });
    expect(isLocked(p, "character", "c-1")).toBe(true);
    expect(isLocked(p, "prop", "pr-1")).toBe(false);
    expect(isLocked(p, "character", "c-2")).toBe(false);
  });

  it("appendOnly：只在末尾接事件才算（按引用比，不是按内容）", () => {
    const first = { type: "project.created" } as unknown as ProjectEvent;
    const second = { type: "shot.updated" } as unknown as ProjectEvent;
    const a = [first];
    // 同一批对象引用、末尾多一条 → 追加
    expect(appendOnly(a, [first, second])).toBe(true);
    // 变短 / 同长都不算
    expect(appendOnly([first, second], a)).toBe(false);
    expect(appendOnly(a, a)).toBe(false);
    // 同位置换了对象（哪怕内容一样）也不算：日志是整份换掉的
    expect(appendOnly([first, second], [first, { ...second }])).toBe(false);
  });

  it("removalUndoEvents：删掉的人物用删除前那一份补回来", () => {
    const before = ProjectSchema.parse({
      ...project([]),
      characters: [{ id: "c-1", name: "林晚" }],
    });
    const after = project([]);
    const { written } = removalUndoEvents(before, after, { kind: "character", id: "c-1" }, "AT");
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ type: "character.added", at: "AT" });
  });

  it("removalUndoEvents：找不到被删的对象就抛错，不写半份", () => {
    const p = project([]);
    expect(() => removalUndoEvents(p, p, { kind: "character", id: "c-nope" }, "AT")).toThrow(
      "找不到被删的人物",
    );
  });
});
