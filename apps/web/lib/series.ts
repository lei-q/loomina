import type { Project } from "@loomina/ir";
import type { WorkspaceMeta } from "@/lib/event-log";

/**
 * 多集连载（A6 / ADR-0209）。
 *
 * 一集 = 一个工作空间。集序与系列归属存在工作空间登记表（本机编排），
 * 不进事件日志；连载概览与钩子接力都是从各集项目**只读派生**出来的。
 *
 * 纯函数：不读盘、不发请求、不写 IR。
 */

export type SeriesEpisode = {
  workspaceId: string;
  name: string;
  episodeNo: number;
  project: Project;
  scenes: number;
  shots: number;
  /** 有几镜已经有能播的成片（take 有资产地址） */
  finished: number;
  /** 这一集的开场 / 结尾钩子原文 */
  opening: string;
  ending: string;
  /** 与上一集的接力状态；第一集恒为 `first` */
  link: "first" | "linked" | "weak" | "missing";
  /** 上一集结尾钩子（第一集为空串） */
  previousEnding: string;
};

export type Series = {
  seriesId: string;
  episodes: SeriesEpisode[];
};

/** 词面交集：中文按二元组切，英文按词切；至少一个共同片段才算接上 */
export function hooksOverlap(previousEnding: string, opening: string): boolean {
  const tokens = (text: string): string[] => {
    const clean = text.toLowerCase().replace(/[\s\p{P}]+/gu, "");
    if (clean.length === 0) return [];
    const grams: string[] = [];
    for (let index = 0; index + 2 <= clean.length; index += 1) {
      grams.push(clean.slice(index, index + 2));
    }
    return grams;
  };
  const before = new Set(tokens(previousEnding));
  if (before.size === 0) return false;
  return tokens(opening).some((gram) => before.has(gram));
}

function countsOf(project: Project): { finished: number } {
  const playable = new Set(
    project.assets.filter((asset) => asset.uri && asset.kind === "video").map((asset) => asset.id),
  );
  const finished = project.shots.filter((shot) =>
    shot.takeIds.some((takeId) => {
      const take = project.takes.find((item) => item.id === takeId);
      return take ? playable.has(take.assetId) : false;
    }),
  ).length;
  return { finished };
}

/** 登记表里的系列归属：旧数据没有这两个字段，按「自己是一集」处理 */
export function seriesOfSpace(meta: WorkspaceMeta): { seriesId: string; episodeNo: number } {
  return {
    seriesId: meta.seriesId ?? meta.id,
    episodeNo: meta.episodeNo ?? 1,
  };
}

/**
 * 把工作空间按系列分组。
 *
 * 只收能回放的集（`projects` 里有对应项目）；坏日志的空间由调用方先滤掉。
 * 组内按集序排；集序相同按名字排，保证顺序稳定。
 */
export function seriesOf(
  metas: WorkspaceMeta[],
  projects: Map<string, Project>,
): Series[] {
  const groups = new Map<string, SeriesEpisode[]>();
  for (const meta of metas) {
    const project = projects.get(meta.id);
    if (!project) continue;
    const { seriesId, episodeNo } = seriesOfSpace(meta);
    const list = groups.get(seriesId) ?? [];
    list.push({
      workspaceId: meta.id,
      name: meta.name,
      episodeNo,
      project,
      scenes: project.scenes.length,
      shots: project.shots.length,
      finished: countsOf(project).finished,
      opening: project.story.hooks.opening.trim(),
      ending: project.story.hooks.ending.trim(),
      link: "first",
      previousEnding: "",
    });
    groups.set(seriesId, list);
  }

  const series: Series[] = [];
  for (const [seriesId, episodes] of groups) {
    episodes.sort((a, b) => a.episodeNo - b.episodeNo || a.name.localeCompare(b.name));
    episodes.forEach((episode, index) => {
      if (index === 0) {
        episode.link = "first";
        episode.previousEnding = "";
        return;
      }
      const previous = episodes[index - 1]!;
      episode.previousEnding = previous.ending;
      if (!previous.ending || !episode.opening) {
        episode.link = "missing";
      } else {
        episode.link = hooksOverlap(previous.ending, episode.opening) ? "linked" : "weak";
      }
    });
    series.push({ seriesId, episodes });
  }
  // 集数多的系列排前面；同数量按第一集的集序
  return series.sort(
    (a, b) =>
      b.episodes.length - a.episodes.length ||
      (a.episodes[0]?.episodeNo ?? 0) - (b.episodes[0]?.episodeNo ?? 0),
  );
}

/** 接力状态的人话 */
export const LINK_LABEL: Record<SeriesEpisode["link"], string> = {
  first: "第一集",
  linked: "接上了",
  weak: "看不出接上",
  missing: "有一侧没写钩子",
};

/** 新一集的集序：同系列当前最大值 + 1 */
export function nextEpisodeNo(metas: WorkspaceMeta[], seriesId: string): number {
  const numbers = metas
    .filter((meta) => seriesOfSpace(meta).seriesId === seriesId)
    .map((meta) => seriesOfSpace(meta).episodeNo);
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}