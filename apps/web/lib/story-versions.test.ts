import { ProjectSchema, StoryBibleSchema, type ProjectEvent } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import { sampleProject } from "./sample-project";
import { storyRestorePatch, storyVersionsOf } from "./story-versions";

const AT = "2026-11-13T10:00:00+08:00";
const [LIN, ZHOU] = sampleProject.characters.map((character) => character.id);

/** 示例项目的故事层是空的：这份测试自己填满，才有弧光与关系可回退 */
const story = StoryBibleSchema.parse({
  logline: "夜班护士撞见不该看见的人。",
  synopsis: "灯灭了，走廊尽头有人。",
  genre: "悬疑",
  audience: "都市女性",
  tone: "压抑",
  hooks: { opening: "灯灭的瞬间", ending: "他手里拿着钥匙" },
  arcs: [
    {
      characterId: LIN,
      want: "拿到监控",
      need: "被看见",
      wound: "",
      flaw: "",
      secret: "",
      agency: "",
      arc: "",
    },
  ],
  relationships: [{ fromCharacterId: LIN!, toCharacterId: ZHOU!, tension: "都想要那卷录像" }],
});
const project = ProjectSchema.parse({ ...sampleProject, story });

function created(): ProjectEvent {
  return { type: "project.created", at: AT, project };
}

describe("故事版本库（C2）", () => {
  it("初版加每一次改字各一版，空改动不算", () => {
    const events: ProjectEvent[] = [
      created(),
      { type: "story.updated", at: "2026-11-13T10:01:00+08:00", patch: { logline: "新的 logline" } },
      {
        type: "story.updated",
        at: "2026-11-13T10:02:00+08:00",
        patch: { synopsis: "新的梗概", openingHook: "第一秒就出事" },
      },
      // 写回同样的字：不该多一版
      { type: "story.updated", at: "2026-11-13T10:03:00+08:00", patch: { logline: "新的 logline" } },
    ];

    const versions = storyVersionsOf(events);
    expect(versions).toHaveLength(3);
    expect(versions[0]?.changed).toEqual(["初版"]);
    expect(versions[1]?.changed).toEqual(["Logline"]);
    expect(versions[1]?.eventIndex).toBe(1);
    expect(versions[2]?.changed).toEqual(["梗概", "开场钩子"]);
    expect(versions[2]?.story.logline).toBe("新的 logline");
    expect(versions[2]?.story.synopsis).toBe("新的梗概");
    expect(versions[2]?.story.hooks.opening).toBe("第一秒就出事");
  });

  it("没有 project.created 就没有版本", () => {
    expect(storyVersionsOf([])).toEqual([]);
    expect(
      storyVersionsOf([
        { type: "story.updated", at: AT, patch: { logline: "孤零零" } },
      ]),
    ).toEqual([]);
  });

  it("恢复一版整份写回：文字、钩子、弧光、关系都回得来", () => {
    const target = story;
    const current = {
      ...target,
      logline: "现在这一版",
      synopsis: "现在这一版梗概",
      hooks: { opening: "现在", ending: "现在" },
      arcs: [],
      relationships: [],
    };

    const restore = storyRestorePatch(current, target, project.characters);
    expect(restore).not.toBeNull();
    expect(restore!.patch.logline).toBe(target.logline);
    expect(restore!.patch.synopsis).toBe(target.synopsis);
    expect(restore!.patch.openingHook).toBe(target.hooks.opening);
    expect(restore!.patch.endingHook).toBe(target.hooks.ending);
    expect(restore!.patch.arcs).toEqual(target.arcs);
    expect(restore!.patch.relationships).toEqual(target.relationships);
    expect(restore!.droppedArcs).toBe(0);
    expect(restore!.droppedRelationships).toBe(0);
  });

  it("角色删掉之后，指向他的弧光与关系不带回来，如实计数", () => {
    const arc = story.arcs[0]!;
    const relation = story.relationships[0]!;
    const characters = project.characters.filter(
      (character) => character.id !== arc.characterId && character.id !== relation.toCharacterId,
    );

    const restore = storyRestorePatch(
      { ...story, logline: "现在这一版", arcs: [], relationships: [] },
      story,
      characters,
    );
    expect(restore).not.toBeNull();
    expect(restore!.patch.arcs).toEqual([]);
    expect(restore!.droppedArcs).toBe(story.arcs.length);
    expect(restore!.droppedRelationships).toBeGreaterThan(0);
    expect(
      restore!.patch.relationships?.every(
        (item) =>
          characters.some((character) => character.id === item.fromCharacterId) &&
          characters.some((character) => character.id === item.toCharacterId),
      ),
    ).toBe(true);
  });

  it("与现在完全一样就不返回 patch：不为一次空点击写事件", () => {
    expect(
      storyRestorePatch(story, story, project.characters),
    ).toBeNull();
  });
});
