import type { Project, StoryBible } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import { sampleProject } from "./sample-project";
import { sharedStoriesOf, storyImportPatch, storySize } from "./shared-stories";

const clone = (): Project => structuredClone(sampleProject);

function withStory(project: Project, story: Partial<StoryBible>): Project {
  return {
    ...project,
    story: { ...project.story, hooks: { ...project.story.hooks }, ...story },
  };
}

const arc = (characterId: string, want: string) => ({
  characterId,
  want,
  need: "",
  wound: "",
  flaw: "",
  secret: "",
  agency: "",
  arc: "",
});

describe("跨空间取一版故事（C1）", () => {
  it("文字整份取过来，同名同 id 的弧光与关系都带上", () => {
    const current = clone();
    const source = withStory(clone(), {
      logline: "外卖员撞见顶层的秘密",
      synopsis: "一夜之间，送餐变成逃亡。",
      genre: "悬疑",
      tone: "冷",
      hooks: { opening: "电梯门开，走廊尽头站着一个人", ending: "他按下了下行键" },
      arcs: [arc("c-lin", "拿到监控"), arc("c-zhou", "保住工作")],
      relationships: [{ fromCharacterId: "c-lin", toCharacterId: "c-zhou", tension: "都想先开口" }],
    });

    const imported = storyImportPatch(current, source);
    expect(imported).not.toBeNull();
    expect(imported!.patch.logline).toBe("外卖员撞见顶层的秘密");
    expect(imported!.patch.synopsis).toBe("一夜之间，送餐变成逃亡。");
    expect(imported!.patch.genre).toBe("悬疑");
    expect(imported!.patch.tone).toBe("冷");
    expect(imported!.patch.openingHook).toContain("走廊尽头");
    expect(imported!.patch.endingHook).toContain("下行键");
    expect(imported!.patch.arcs).toHaveLength(2);
    expect(imported!.patch.relationships).toHaveLength(1);
    expect(imported!.matchedCharacters.sort()).toEqual(["周", "林"]);
    expect(imported!.droppedArcs).toBe(0);
    expect(imported!.droppedRelationships).toBe(0);
  });

  it("同 id 但名字不同不算同一个人：弧光与关系跳过并计数", () => {
    const current = clone();
    // 本空间把 c-zhou 改了名：id 一样，人不是同一个
    current.characters = current.characters.map((character) =>
      character.id === "c-zhou" ? { ...character, name: "老周" } : character,
    );
    const source = withStory(clone(), {
      logline: "外卖员撞见顶层的秘密",
      arcs: [arc("c-lin", "拿到监控"), arc("c-zhou", "保住工作")],
      relationships: [{ fromCharacterId: "c-lin", toCharacterId: "c-zhou", tension: "都想先开口" }],
    });

    const imported = storyImportPatch(current, source)!;
    expect(imported.patch.arcs).toHaveLength(1);
    expect(imported.patch.arcs![0]!.characterId).toBe("c-lin");
    expect(imported.patch.relationships).toHaveLength(0);
    expect(imported.droppedArcs).toBe(1);
    expect(imported.droppedRelationships).toBe(1);
    expect(imported.matchedCharacters).toEqual(["林"]);
  });

  it("本空间没有这个角色：指向他的关系整条跳过", () => {
    const current = clone();
    current.characters = current.characters.filter((character) => character.id !== "c-zhou");
    const source = withStory(clone(), {
      logline: "外卖员撞见顶层的秘密",
      relationships: [{ fromCharacterId: "c-lin", toCharacterId: "c-zhou", tension: "都想先开口" }],
    });

    const imported = storyImportPatch(current, source)!;
    expect(imported.patch.relationships).toHaveLength(0);
    expect(imported.droppedRelationships).toBe(1);
  });

  it("与本空间完全一致时返回 null：不为一次空点击写事件", () => {
    const current = withStory(clone(), { logline: "一样的故事" });
    const source = withStory(clone(), { logline: "一样的故事" });
    expect(storyImportPatch(current, source)).toBeNull();
  });

  it("清单跳过空故事，能取的排前面", () => {
    const current = withStory(clone(), { logline: "本空间的故事" });
    const empty = { id: "w-empty", name: "空空间", project: clone() };
    const same = { id: "w-same", name: "同一版", project: withStory(clone(), { logline: "本空间的故事" }) };
    const fresh = {
      id: "w-fresh",
      name: "夜班",
      project: withStory(clone(), { logline: "夜班最后一小时" }),
    };

    const list = sharedStoriesOf([empty, same, fresh], current);
    expect(list.map((item) => item.workspaceName)).toEqual(["夜班", "同一版"]);
    expect(list[0]!.imported).not.toBeNull();
    expect(list[1]!.imported).toBeNull();
    expect(storySize(list[0]!.story)).toBe("");
  });
});
