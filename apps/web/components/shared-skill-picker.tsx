"use client";

import { useMemo, useState } from "react";
import { SKILL_STAGE_CN } from "@loomina/pipeline";
import { useWorkbench } from "@/lib/workbench-store";
import { loadWorkspaceProjects, type WorkspaceProject } from "@/lib/workspace-assets";
import { sharedSkillsOf, type SharedSkill } from "@/lib/shared-skills";

/**
 * 从别的空间取技能（C.5 / ADR-0202）。
 *
 * 固定要求写一次就够了：跨集取用只抄内容，id 重新编，
 * 之后两边各改各的，互不影响。
 */
export function SharedSkillPicker() {
  const workspaceId = useWorkbench((state) => state.workspaceId);
  const project = useWorkbench((state) => state.project);
  const adoptSharedSkill = useWorkbench((state) => state.adoptSharedSkill);
  const [open, setOpen] = useState(false);
  const [spaces, setSpaces] = useState<WorkspaceProject[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const others = useMemo(
    () => (spaces ?? []).filter((space) => space.id !== workspaceId),
    [spaces, workspaceId],
  );
  const list = useMemo(() => (spaces ? sharedSkillsOf(others, project) : undefined), [spaces, others, project]);

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

  const take = (item: SharedSkill) => {
    if (!adoptSharedSkill(item.skill)) {
      setError(useWorkbench.getState().castError ?? "这条技能取不过来。");
      return;
    }
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void openPicker()}
        title="从本机其它工作空间取一条技能：照抄内容，不调模型、不花钱"
        className="rounded-token border border-line px-2 py-0.5 text-[9px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
      >
        从别的空间取一条技能
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
            aria-label="从别的空间取一条技能"
            className="max-h-[82vh] w-[640px] max-w-[94vw] overflow-y-auto border border-line bg-bg px-4 py-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[11px] tracking-[.06em] text-text">从别的空间取一条技能</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
              >
                关闭
              </button>
            </div>
            <p className="mt-1 text-[9px] leading-[1.7] text-muted-2">
              取用时照抄名字、说明、阶段与内容，id 重新编、默认启用；之后两边各改各的。
              已经有一模一样的一条会标出来，不能重复取。不调模型、不花钱。
            </p>

            {busy && <p className="mt-3 text-[10px] text-muted-2">正在读别的空间…</p>}
            {error && <p className="mt-2 text-[9.5px] text-pick">{error}</p>}

            {!busy && list && (
              <div className="mt-3 space-y-1.5">
                {list.slice(0, 60).map((item) => (
                  <div
                    key={`${item.workspaceId}:${item.skill.id}`}
                    className="flex flex-wrap items-start gap-x-2 gap-y-1 border border-line px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[9.5px] text-text">{item.skill.name}</span>
                        <span className="text-[8.5px] text-muted-2">
                          {SKILL_STAGE_CN[item.skill.stage]}
                          {item.skill.enabled ? "" : " · 在来源空间里关着"}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[8.5px] leading-[1.6] text-muted-2">
                        {item.skill.body.slice(0, 90)}
                        {item.skill.body.length > 90 ? "…" : ""}
                      </span>
                      <span className="block text-[8px] text-muted-2">{item.workspaceName}</span>
                    </span>
                    <button
                      type="button"
                      disabled={item.duplicate}
                      onClick={() => take(item)}
                      className="rounded-token border border-line px-2 py-px text-[9px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-pick enabled:hover:text-pick disabled:opacity-40"
                    >
                      {item.duplicate ? "已在用" : "取这条"}
                    </button>
                  </div>
                ))}
                {list.length === 0 && (
                  <p className="text-[10px] text-muted-2">
                    别的空间里还没有技能：先在另一个工作空间的设置页写一条，再过来取。
                  </p>
                )}
              </div>
            )}
            {list && list.length > 60 && (
              <p className="mt-2 text-[9px] text-muted-2">只列了前 60 条：先在别的空间整理一下。</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}