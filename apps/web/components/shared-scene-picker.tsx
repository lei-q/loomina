"use client";

import { useMemo, useState } from "react";
import { useWorkbench } from "@/lib/workbench-store";
import { loadWorkspaceProjects, type WorkspaceProject } from "@/lib/workspace-assets";
import { sharedScenesOf, type SharedScene } from "@/lib/shared-scenes";

/**
 * 从别的空间取一场剧本（C1 / ADR-0199）。
 *
 * 场 / 镜 / 台词整场搬过来；地点与出场演员必须在本空间同名同 id，
 * 否则整场不能取——取半场回来还得一条条修，不如说清楚缺谁。
 */
export function SharedScenePicker() {
  const workspaceId = useWorkbench((state) => state.workspaceId);
  const project = useWorkbench((state) => state.project);
  const adoptSharedScene = useWorkbench((state) => state.adoptSharedScene);
  const [open, setOpen] = useState(false);
  const [spaces, setSpaces] = useState<WorkspaceProject[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();

  const others = useMemo(
    () => (spaces ?? []).filter((space) => space.id !== workspaceId),
    [spaces, workspaceId],
  );
  const list = useMemo(() => (spaces ? sharedScenesOf(others, project) : undefined), [spaces, others, project]);

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

  const take = (space: WorkspaceProject, item: SharedScene) => {
    if (!adoptSharedScene(space.project, item.scene.id, space.name)) {
      setError(useWorkbench.getState().castError ?? "这一场没取成。");
      return;
    }
    setError(undefined);
    setNote(
      `已取用「${space.name}」的第 ${item.scene.index + 1} 场：${item.readiness.shots} 镜 · ${item.readiness.lines} 句${
        item.readiness.missingProps.length
          ? `；道具「${item.readiness.missingProps.join("、")}」只摘掉了引用`
          : ""
      }。关键帧、take 与配音没有跟过来。`,
    );
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void openPicker()}
        title="从本机其它工作空间取一场剧本：场 / 镜 / 台词整场取过来，不重新生成、不花钱"
        className="rounded-token border border-line px-2 py-0.5 text-[9px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
      >
        从别的空间取一场
      </button>

      {note && (
        <span className="w-full text-[9px] leading-[1.6] text-muted-2">{note}</span>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-bg/80 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-label="从别的空间取一场剧本"
            className="max-h-[82vh] w-[700px] max-w-[94vw] overflow-y-auto border border-line bg-bg px-4 py-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[11px] tracking-[.06em] text-text">从别的空间取一场剧本</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
              >
                关闭
              </button>
            </div>
            <p className="mt-1 text-[9px] leading-[1.7] text-muted-2">
              场 / 镜 / 台词整场追加到末尾，id 全部重编；地点与出场演员必须在本空间同名同 id，
              否则整场不能取。关键帧、take、配音与时间线不跟。不重新生成、不花钱。
            </p>

            {busy && <p className="mt-3 text-[10px] text-muted-2">正在读别的空间…</p>}
            {error && <p className="mt-2 text-[9.5px] text-pick">{error}</p>}

            {!busy && list && (
              <div className="mt-3 space-y-1.5">
                {list.slice(0, 80).map((item) => {
                  const space = others.find((entry) => entry.id === item.workspaceId);
                  const label = item.scene.code.trim() || `第 ${item.scene.index + 1} 场`;
                  return (
                    <div
                      key={`${item.workspaceId}:${item.scene.id}`}
                      className="flex flex-wrap items-start gap-x-2 gap-y-1 border border-line px-2 py-1.5"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[9.5px] text-muted">
                          {label} · {item.locationName} · {item.brief}
                        </span>
                        <span className="mt-0.5 block text-[8.5px] text-muted-2">
                          {item.workspaceName} · {item.readiness.shots} 镜 · {item.readiness.lines} 句
                          {item.readiness.missingProps.length
                            ? ` · 缺道具「${item.readiness.missingProps.join("、")}」只摘引用`
                            : ""}
                          {!item.readiness.ready ? ` · 缺 ${item.readiness.missing.join("、")}` : ""}
                        </span>
                      </span>
                      <button
                        type="button"
                        disabled={!item.readiness.ready || !space}
                        onClick={() => space && take(space, item)}
                        className="rounded-token border border-line px-2 py-px text-[9px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-pick enabled:hover:text-pick disabled:opacity-40"
                      >
                        {item.readiness.ready ? "取这一场" : "缺人 / 缺地点"}
                      </button>
                    </div>
                  );
                })}
                {list.length === 0 && (
                  <p className="text-[10px] text-muted-2">
                    别的空间里还没有场次：先在另一个工作空间写一场，再过来取。
                  </p>
                )}
              </div>
            )}
            {list && list.length > 80 && (
              <p className="mt-2 text-[9px] text-muted-2">只列了前 80 场：先在别的空间整理一下。</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
