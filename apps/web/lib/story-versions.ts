import type { ProjectEvent, StoryBible } from "@loomina/ir";

/**
 * 故事版本库（C2 第二档）。
 *
 * 故事是花过钱生成的东西：一次 `story.updated` 就是一次改字，旧字不该只剩在
 * 历史抽屉里翻。这里从事件日志把每一版故事**重建**出来——不新存快照、不新增字段，
 * 日志就是版本库本身。
 *
 * 纯函数：不读盘、不发请求，测试可以直接拿几条事件跑。
 */

export type StoryVersion = {
  /** 这一版落在日志的第几条：`project.created` 也算一版 */
  eventIndex: number;
  at: string;
  /** 这一版之后的故事全貌 */
  story: StoryBible;
  /** 这一版改了什么（人话，按固定顺序）；初版写「初版」 */
  changed: string[];
};

const TEXT_FIELDS = [
  ["logline", "Logline"],
  ["synopsis", "梗概"],
  ["genre", "类型"],
  ["audience", "受众"],
  ["tone", "调性"],
] as const;

function cloneStory(story: StoryBible): StoryBible {
  return {
    ...story,
    hooks: { ...story.hooks },
    arcs: story.arcs.map((arc) => ({ ...arc })),
    relationships: story.relationships.map((relation) => ({ ...relation })),
  };
}

/** 按 `applyEvent` 的同一套语义把一条 patch 落到故事上（只用于重建，不校验角色） */
function applyPatch(story: StoryBible, patch: Extract<ProjectEvent, { type: "story.updated" }>["patch"]): StoryBible {
  const next: StoryBible = { ...story, hooks: { ...story.hooks } };
  for (const [key] of TEXT_FIELDS) {
    const value = patch[key];
    if (value !== undefined) next[key] = value.trim();
  }
  if (patch.openingHook !== undefined) next.hooks.opening = patch.openingHook.trim();
  if (patch.endingHook !== undefined) next.hooks.ending = patch.endingHook.trim();
  if (patch.arcs !== undefined) next.arcs = patch.arcs.map((arc) => ({ ...arc }));
  if (patch.relationships !== undefined) {
    next.relationships = patch.relationships.map((relation) => ({ ...relation }));
  }
  return next;
}

/** 这一版改了什么：只报真的变了的字段，空 patch（写回同样的字）不算一版 */
function changedFields(before: StoryBible, after: StoryBible): string[] {
  const changed: string[] = [];
  for (const [key, label] of TEXT_FIELDS) {
    if (before[key] !== after[key]) changed.push(label);
  }
  if (before.hooks.opening !== after.hooks.opening) changed.push("开场钩子");
  if (before.hooks.ending !== after.hooks.ending) changed.push("结尾钩子");
  if (JSON.stringify(before.arcs) !== JSON.stringify(after.arcs)) {
    changed.push(`人物弧光（${after.arcs.length} 人）`);
  }
  if (JSON.stringify(before.relationships) !== JSON.stringify(after.relationships)) {
    changed.push(`关系张力（${after.relationships.length} 对）`);
  }
  return changed;
}

/**
 * 每一版故事：初版在最前，之后按日志顺序。
 *
 * 没有任何文字的初版也算一版——「从这里开工」本身就是一种版本，
 * 否则第一条真实改动会被误当成起点。
 */
export function storyVersionsOf(events: ProjectEvent[]): StoryVersion[] {
  const createdIndex = events.findIndex((event) => event.type === "project.created");
  if (createdIndex < 0) return [];
  const created = events[createdIndex];
  if (created?.type !== "project.created") return [];

  let story = cloneStory(created.project.story);
  const versions: StoryVersion[] = [
    { eventIndex: createdIndex, at: created.at, story: cloneStory(story), changed: ["初版"] },
  ];

  events.forEach((event, index) => {
    if (event.type !== "story.updated") return;
    const next = applyPatch(story, event.patch);
    const changed = changedFields(story, next);
    if (changed.length === 0) return;
    story = next;
    versions.push({ eventIndex: index, at: event.at, story: cloneStory(next), changed });
  });

  return versions;
}

/** 故事层可恢复部分的指纹：只比这些字段，`provenance` 与来源不参与 */
function fingerprint(story: StoryBible): string {
  return JSON.stringify({
    logline: story.logline,
    synopsis: story.synopsis,
    genre: story.genre,
    audience: story.audience,
    tone: story.tone,
    opening: story.hooks.opening,
    ending: story.hooks.ending,
    arcs: story.arcs,
    relationships: story.relationships,
  });
}

export type StoryRestore = {
  patch: Extract<ProjectEvent, { type: "story.updated" }>["patch"];
  /** 这一版里有、但角色已经删掉，带不回来的条数 */
  droppedArcs: number;
  droppedRelationships: number;
};

/**
 * 把「这一版」整份写回要用的 patch（C2）。
 *
 * 故事层的字段全是文字，恢复就是一次整份替换；`provenance` 不动。
 * 这一版里指向**已删角色**的弧光与关系带不回来——硬写会让 `story.updated`
 * 校验失败，整个恢复作废；所以在这里就过滤掉并如实计数。
 * 内容与现在完全一样时返回 null：不为一次没变化的点击写事件。
 */
export function storyRestorePatch(
  current: StoryBible,
  target: StoryBible,
  characters: { id: string }[],
): StoryRestore | null {
  const known = new Set(characters.map((character) => character.id));

  const seenArcs = new Set<string>();
  const arcs = target.arcs.filter((arc) => {
    if (!known.has(arc.characterId) || seenArcs.has(arc.characterId)) return false;
    seenArcs.add(arc.characterId);
    return true;
  });

  const seenRelations = new Set<string>();
  const relationships = target.relationships.filter((relation) => {
    const key = `${relation.fromCharacterId}->${relation.toCharacterId}`;
    if (
      relation.fromCharacterId === relation.toCharacterId ||
      !known.has(relation.fromCharacterId) ||
      !known.has(relation.toCharacterId) ||
      seenRelations.has(key)
    ) {
      return false;
    }
    seenRelations.add(key);
    return true;
  });

  const patch: StoryRestore["patch"] = {
    logline: target.logline.trim(),
    synopsis: target.synopsis.trim(),
    genre: target.genre.trim(),
    audience: target.audience.trim(),
    tone: target.tone.trim(),
    openingHook: target.hooks.opening.trim(),
    endingHook: target.hooks.ending.trim(),
    arcs: arcs.map((arc) => ({ ...arc })),
    relationships: relationships.map((relation) => ({ ...relation })),
  };

  // 与现在完全一样就不写事件：点一下「现在」不该多一条空改动
  if (fingerprint(current) === fingerprint(applyPatch(current, patch))) return null;

  return {
    patch,
    droppedArcs: target.arcs.length - arcs.length,
    droppedRelationships: target.relationships.length - relationships.length,
  };
}
