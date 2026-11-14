"use client";

import { useCallback, useEffect, useState } from "react";
import { useWorkbench } from "@/lib/workbench-store";
import { listWorkspaces, rememberWorkspace, type WorkspaceMeta } from "@/lib/event-log";
import { loadWorkspaceProjects } from "@/lib/workspace-assets";
import { LINK_LABEL, seriesOf, type SeriesEpisode } from "@/lib/series";
import { cn } from "@/lib/utils";

/**
 * 连载（A6 / ADR-0209）。
 *
 * 一部剧 = 同系列的一组工作空间。集序与系列归属在本机登记表里；
 * 钩子接力是从各集故事圣经只读派生出来的提示，不写 IR、不改内容。
 */
export function SeriesSection() {
  const workspaceId = useWorkbench((state) => state.workspaceId);
  const [metas, setMetas] = useState<WorkspaceMeta[]>();
  const [episodes, setEpisodes] = useState<Map<string, SeriesEpisode[]>>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      // 归档的集不进连载概览（C15 / ADR-0210）
      const list = (await listWorkspaces()).filter((meta) => !meta.archivedAt);
      setMetas(list);
      const spaces = await loadWorkspaceProjects();
      const projects = new Map(spaces.map((space) => [space.id, space.project]));
      const series = seriesOf(list, projects);
      const map = new Map<string, SeriesEpisode[]>();
      for (const group of series) map.set(group.seriesId, group.episodes);
      setEpisodes(map);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读不到连载信息。");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (id: string) => {
    if (id === workspaceId) return;
    rememberWorkspace(id);
    window.location.assign("/");
  };

  const groups = [...(episodes ?? new Map<string, SeriesEpisode[]>()).entries()];
  const total = groups.reduce((sum, [, list]) => sum + list.length, 0);

  return (
    <section className="mt-9 border-t border-line pt-5" aria-label="连载">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[12px] tracking-[.04em]">连载</h2>
          <span className="tnum text-[9px] text-muted-2">A6</span>
        </div>
        <span className="tnum text-[9.5px] text-muted-2">
          {metas ? `${groups.length} 部 · ${total} 集` : "读不到工作空间"}
        </span>
      </div>
      <p className="mt-1 max-w-[640px] text-[9.5px] leading-[1.7] text-muted-2">
        一集是一个工作空间。集序只记在这台浏览器的登记表里，不进项目日志；
        新建时「照某个空间的设定开工」会自动排到同系列的下一集。
        结尾钩子 → 下一集开场钩子是按词面比出来的提示，接不接得上由你判断。
      </p>

      {error && <p className="mt-2 text-[9.5px] leading-[1.7] text-pick">{error}</p>}

      {metas && groups.length === 0 && (
        <p className="mt-2 text-[9.5px] text-muted-2">还没有能回放的集：先建一个工作空间。</p>
      )}

      <div className="mt-3 space-y-3">
        {groups.map(([seriesId, list]) => (
          <div key={seriesId} className="rounded-token border border-line px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[10px] text-text">
                {list[0]?.project.title ?? "未命名"} · 共 {list.length} 集
              </h3>
              <span className="tnum text-[8.5px] text-muted-2">系列 {seriesId.slice(0, 12)}</span>
            </div>
            <ul className="mt-1.5 space-y-1">
              {list.map((episode) => (
                <li
                  key={episode.workspaceId}
                  className={cn(
                    "flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-line/60 pt-1.5 first:border-t-0 first:pt-0",
                    episode.workspaceId === workspaceId && "text-text",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="tnum mr-2 text-[9px] text-muted-2">第 {episode.episodeNo} 集</span>
                    <span className="text-[10px]">{episode.name}</span>
                    <span className="tnum ml-2 text-[8.5px] text-muted-2">
                      {episode.scenes} 场 / {episode.shots} 镜 / 成片 {episode.finished}
                    </span>
                    <span
                      className={cn(
                        "ml-2 rounded-token border px-1 py-px text-[8px]",
                        episode.link === "linked"
                          ? "border-pick/60 text-pick"
                          : episode.link === "weak"
                            ? "border-line-2 text-muted"
                            : "border-line text-muted-2",
                      )}
                    >
                      {LINK_LABEL[episode.link]}
                    </span>
                    {episode.link === "weak" && episode.previousEnding && (
                      <span className="mt-0.5 block truncate text-[8.5px] text-muted-2">
                        上一集结尾「{episode.previousEnding.slice(0, 28)}」，这一集开场「
                        {episode.opening.slice(0, 28)}」，看不出接上
                      </span>
                    )}
                    {episode.link === "missing" && (
                      <span className="mt-0.5 block text-[8.5px] text-muted-2">
                        上一集结尾或这一集开场有一侧没写钩子
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => open(episode.workspaceId)}
                    disabled={episode.workspaceId === workspaceId}
                    title={
                      episode.workspaceId === workspaceId
                        ? "正在这一集"
                        : "切到这一集（整页加载，与空间菜单同一条路）"
                    }
                    className="shrink-0 rounded-token border border-line px-2 py-0.5 text-[9px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
                  >
                    {episode.workspaceId === workspaceId ? "正在这一集" : "去这一集"}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}