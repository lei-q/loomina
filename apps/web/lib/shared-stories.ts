import type { Project, StoryBible } from "@loomina/ir";
import { storyRestorePatch, type StoryRestore } from "@/lib/story-versions";
import type { WorkspaceProject } from "@/lib/workspace-assets";

/**
 * 跨空间取一版故事（C1 / ADR-0198）。
 *
 * 故事是花过钱生成的东西：下一集要沿用上一集的世界观与人物弧光时，
 * 不该重新生成一遍。这里只读回放别的空间，把「能取什么」摆出来；
 * 取用写一条 `story.updated`，不调模型、不花钱。
 *
 * 弧光与关系按**角色**走：不同空间各自用 `c-01` 指不同人是可能的，
 * 所以同一个 id 还要同名才算同一个人；对不上的条数如实计数，不硬塞。
 */

export type SharedStory = {
  workspaceId: string;
  workspaceName: string;
  story: StoryBible;
  /** 取这版会写成什么；null = 与本空间现在一致（或没有可取的文字与弧光） */
  imported: StoryImport | null;
};

export type StoryImport = StoryRestore & {
  /** 这一版里点过名、本空间能接住（同名同 id）的角色 */
  matchedCharacters: string[];
};

/** 有东西可取才算一版：空故事不该出现在清单里 */
function hasStory(story: StoryBible): boolean {
  const text = [
    story.logline,
    story.synopsis,
    story.genre,
    story.audience,
    story.tone,
    story.hooks.opening,
    story.hooks.ending,
  ];
  return text.some((value) => value.trim().length > 0) || story.arcs.length > 0 || story.relationships.length > 0;
}

/**
 * 把别的空间的故事接到本空间要用的 patch。
 *
 * 复用 `storyRestorePatch` 的整份写回语义：文字整组替换、`provenance` 不动、
 * 指向不存在角色的弧光 / 关系先过滤再计数。差别只在「哪些角色算存在」——
 * 这里要求**同名同 id**，避免把弧光安到本空间的另一个人身上。
 */
export function storyImportPatch(current: Project, source: Project): StoryImport | null {
  const sourceNames = new Map(source.characters.map((character) => [character.id, character.name.trim()]));
  const allowed = current.characters.filter(
    (character) => sourceNames.get(character.id) === character.name.trim(),
  );

  const restore = storyRestorePatch(current.story, source.story, allowed);
  if (!restore) return null;

  const allowedIds = new Set(allowed.map((character) => character.id));
  const referenced = new Set<string>();
  for (const arc of source.story.arcs) referenced.add(arc.characterId);
  for (const relation of source.story.relationships) {
    referenced.add(relation.fromCharacterId);
    referenced.add(relation.toCharacterId);
  }

  return {
    ...restore,
    matchedCharacters: allowed
      .filter((character) => referenced.has(character.id))
      .map((character) => character.name),
  };
}

/**
 * 本机别的空间里能取的故事（纯函数）。
 *
 * 一份日志读不出来的空间由 `loadWorkspaceProjects` 跳过；空故事不列。
 * 能取的排前面，其次按传入顺序（工作空间列表本来就是最近用过的在前）。
 */
export function sharedStoriesOf(spaces: WorkspaceProject[], current: Project): SharedStory[] {
  return spaces
    .filter((space) => hasStory(space.project.story))
    .map((space) => ({
      workspaceId: space.id,
      workspaceName: space.name,
      story: space.project.story,
      imported: storyImportPatch(current, space.project),
    }))
    .sort((a, b) => Number(Boolean(b.imported)) - Number(Boolean(a.imported)));
}

/** 弧光 / 关系条数，给挑之前一句话说清楚 */
export function storySize(story: StoryBible): string {
  const parts: string[] = [];
  if (story.arcs.length > 0) parts.push(`弧光 ${story.arcs.length}`);
  if (story.relationships.length > 0) parts.push(`关系 ${story.relationships.length}`);
  return parts.join(" · ");
}

/**
 * 取用前的逐字段对比（C23 第二档 / ADR-0211）。
 *
 * 行与 `storyRestorePatch` 的可写字段一一对应：作者看到的「会被改成什么」
 * 就是取用后真正写回去的东西。弧光 / 关系按条数比，不逐条摊开。
 */
export type StoryCompareRow = {
  key: string;
  label: string;
  /** 现在这一项的值（人话） */
  now: string;
  /** 取用之后会变成什么 */
  next: string;
  changed: boolean;
};

const emptyAs = (value: string, fallback: string) => (value.trim() ? value.trim() : fallback);

export function storyCompareOf(current: Project, source: Project): StoryCompareRow[] {
  const rows: StoryCompareRow[] = [];
  const text = (key: string, label: string, before: string, after: string) => {
    rows.push({
      key,
      label,
      now: emptyAs(before, "（空）"),
      next: emptyAs(after, "（空）"),
      changed: before.trim() !== after.trim(),
    });
  };

  text("logline", "Logline", current.story.logline, source.story.logline);
  text("synopsis", "梗概", current.story.synopsis, source.story.synopsis);
  text("genre", "类型", current.story.genre, source.story.genre);
  text("audience", "受众", current.story.audience, source.story.audience);
  text("tone", "调性", current.story.tone, source.story.tone);
  text("opening", "开场钩子", current.story.hooks.opening, source.story.hooks.opening);
  text("ending", "结尾钩子", current.story.hooks.ending, source.story.hooks.ending);

  rows.push({
    key: "arcs",
    label: "人物弧光",
    now: `${current.story.arcs.length} 条`,
    next: `${source.story.arcs.length} 条（只带同名同 id 的角色）`,
    changed: current.story.arcs.length !== source.story.arcs.length,
  });
  rows.push({
    key: "relationships",
    label: "关系张力",
    now: `${current.story.relationships.length} 对`,
    next: `${source.story.relationships.length} 对（两端都要对得上）`,
    changed: current.story.relationships.length !== source.story.relationships.length,
  });
  return rows;
}
