"use client";

import { useMemo, useState } from "react";
import { useWorkbench } from "@/lib/workbench-store";
import { loadWorkspaceProjects, type WorkspaceProject } from "@/lib/workspace-assets";
import { sharedStoriesOf, storyCompareOf, storyImportPatch, storySize } from "@/lib/shared-stories";

/**
 * 从别的空间取一版故事（C1 / ADR-0198）。
 *
 * 故事是花过钱生成的东西；下一集沿用同一套世界观时，重新生成一遍就是再花一次钱。
 * 取用只写一条 `story.updated`：文字整份替换，弧光 / 关系只带同名同 id 的角色。
 */
export function SharedStoryPicker() {
  const workspaceId = useWorkbench((state) => state.workspaceId);
  const project = useWorkbench((state) => state.project);
  const adoptSharedStory = useWorkbench((state) => state.adoptSharedStory);
  const [open, setOpen] = useState(false);
  const [spaces, setSpaces] = useState<WorkspaceProject[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** 正在看哪一版的对比（C23 第二档 / ADR-0211） */
  const [comparing, setComparing] = useState<string>();

  const others = useMemo(
    () => (spaces ?? []).filter((space) => space.id !== workspaceId),
    [spaces, workspaceId],
  );
  const list = useMemo(() => (spaces ? sharedStoriesOf(others, project) : undefined), [spaces, others, project]);

  const openPicker = async () => {
    setOpen(true);
    if (spaces) return;
    setBusy(true);
    setError(undefined);
    try {
      setSpaces(await loadWorkspaceProjects());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读不到别的空间。");
    } finally {
      setBusy(false);
    }
  };

  const take = (space: WorkspaceProject) => {
    if (adoptSharedStory(space.project, space.name)) setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void openPicker()}
        title="从本机其它工作空间取一版故事：不重新生成、不花钱；弧光 / 关系只带同名同 id 的角色"
        className="rounded-token border border-line px-2 py-0.5 text-[9px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
      >
        从别的空间取一版故事
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-bg/80 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-label="从别的空间取一版故事"
            className="max-h-[82vh] w-[680px] max-w-[94vw] overflow-y-auto border border-line bg-bg px-4 py-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[11px] tracking-[.06em] text-text">从别的空间取一版故事</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
              >
                关闭
              </button>
            </div>
            <p className="mt-1 text-[9px] leading-[1.7] text-muted-2">
              只列本机其它工作空间里有字的故事。取用写一条
              <code> story.updated</code>：Logline / 梗概 / 类型 / 受众 / 调性 / 钩子整份替换，
              弧光与关系只带本空间同名同 id 的角色；不重新生成、不花钱。
              故事的来源记录与逐字原文不带过来。
            </p>

            {busy && <p className="mt-3 text-[10px] text-muted-2">正在读别的空间…</p>}
            {error && <p className="mt-2 text-[9.5px] text-pick">{error}</p>}

            {!busy && list && (
              <div className="mt-3 space-y-1.5">
                {list.map((item) => {
                  const space = others.find((entry) => entry.id === item.workspaceId);
                  const fresh = space ? storyImportPatch(project, space.project) : item.imported;
                  const size = storySize(item.story);
                  const dropped = fresh ? fresh.droppedArcs + fresh.droppedRelationships : 0;
                  return (
                    <div
                      key={item.workspaceId}
                      className="flex flex-wrap items-start gap-x-2 gap-y-1 border border-line px-2 py-1.5"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[9.5px] text-muted">
                          {item.story.logline.trim() || item.story.synopsis.trim() || "（没有一句话）"}
                        </span>
                        <span className="mt-0.5 block text-[8.5px] text-muted-2">
                          {item.workspaceName}
                          {size ? ` · ${size}` : ""}
                          {fresh ? ` · 对得上 ${fresh.matchedCharacters.length} 个角色` : ""}
                          {dropped > 0 ? ` · 会跳过 ${dropped} 条` : ""}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          disabled={!space}
                          onClick={() =>
                            setComparing(comparing === item.workspaceId ? undefined : item.workspaceId)
                          }
                          title="逐项看取用之后会变成什么；只看不改"
                          className="rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
                        >
                          {comparing === item.workspaceId ? "收起对比" : "对比"}
                        </button>
                        <button
                          type="button"
                          disabled={!fresh || !space}
                          onClick={() => space && take(space)}
                          className="rounded-token border border-line px-2 py-px text-[9px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-pick enabled:hover:text-pick disabled:opacity-40"
                        >
                          {fresh ? "取这版" : "就是现在这版"}
                        </button>
                      </span>
                      {comparing === item.workspaceId && space && (
                        <div className="w-full border-t border-line pt-1.5">
                          <table className="w-full text-left">
                            <thead>
                              <tr className="text-[8.5px] text-muted-2">
                                <th className="w-[76px] font-normal">字段</th>
                                <th className="font-normal">现在</th>
                                <th className="font-normal">取来之后</th>
                              </tr>
                            </thead>
                            <tbody>
                              {storyCompareOf(project, space.project).map((row) => (
                                <tr
                                  key={row.key}
                                  className={row.changed ? "text-text" : "text-muted-2"}
                                >
                                  <td className="py-0.5 align-top text-[8.5px]">{row.label}</td>
                                  <td className="max-w-[220px] py-0.5 align-top text-[9px] leading-[1.5]">
                                    {row.now}
                                  </td>
                                  <td className="max-w-[220px] py-0.5 align-top text-[9px] leading-[1.5]">
                                    {row.next}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <p className="mt-1 text-[8.5px] leading-[1.6] text-muted-2">
                            深色行会被改；灰色行不会变。弧光 / 关系只带本空间同名同 id 的角色，
                            对不上的会被跳过。
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
                {list.length === 0 && (
                  <p className="text-[10px] text-muted-2">
                    别的空间里还没有故事：先在另一个工作空间生成或写一版，再过来取。
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
