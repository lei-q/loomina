"use client";

import { useEffect, useMemo } from "react";
import { TopBar } from "@/components/top-bar";
import { shotLabel, toScriptView } from "@/lib/read-model";
import { useWorkbench } from "@/lib/workbench-store";

export function ScriptScreen() {
  const project = useWorkbench((state) => state.project);
  const hydrate = useWorkbench((state) => state.hydrate);
  const readOnly = useWorkbench((state) => state.readOnly);
  const storageError = useWorkbench((state) => state.storageError);
  const setBudget = useWorkbench((state) => state.setBudget);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const view = useMemo(() => toScriptView(project), [project]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
      <TopBar
        title={view.title}
        version={view.version}
        stage="剧本"
        spentCny={view.spent}
        budgetCny={view.budget}
        unpriced={view.unpriced}
        spendBreakdown={view.spend}
        storageError={storageError}
        readOnly={readOnly}
        onBudgetChange={setBudget}
      />

      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
        <div className="mx-auto max-w-[720px]">
          <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
            <div>
              <h1 className="text-[13px] tracking-[.06em] text-text">剧本</h1>
              <p className="mt-1 text-[10.5px] leading-[1.6] text-muted-2">
                按场次和镜序摊平：动作在前，台词在后。这一页只读，改动去分镜页说。
              </p>
            </div>
            <dl className="tnum flex items-baseline gap-5 text-[10.5px]">
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-2">场</dt>
                <dd className="text-muted">{view.scenes.length}</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-2">镜</dt>
                <dd className="text-muted">{view.shotCount}</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-2">台词</dt>
                <dd className="text-muted">{view.dialogueCount}</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-2">时长</dt>
                <dd className="text-muted">{view.totalDur.toFixed(1)}s</dd>
              </div>
            </dl>
          </header>

          <div className="mt-8 space-y-10">
            {view.scenes.map((scene) => (
              <section key={scene.id}>
                <div className="flex items-baseline gap-3 border-b border-line pb-2">
                  <span className="tnum shrink-0 text-[9.5px] tracking-[.14em] text-muted-2">
                    第 {scene.no} 场
                  </span>
                  <h2 className="text-[13px] tracking-[.04em] text-text">{scene.place}</h2>
                  <span className="tnum ml-auto shrink-0 text-[9.5px] text-muted-2">
                    {scene.dur.toFixed(1)}s · {scene.shots.length} 镜
                  </span>
                </div>

                <ol className="mt-4 space-y-5">
                  {scene.shots.map((shot) => (
                    <li key={shot.id} className="grid grid-cols-[42px_1fr] gap-3">
                      <span className="tnum pt-[3px] text-[9px] text-muted-2">
                        {shotLabel(shot.no)}
                      </span>
                      <div className="min-w-0">
                        <p className="text-[13px] leading-[1.9] text-text">
                          {shot.action || (
                            <span className="text-muted-2">（这一镜还没有动作描述）</span>
                          )}
                        </p>

                        {shot.lines.length > 0 && (
                          <div className="mt-2 space-y-2">
                            {shot.lines.map((line) => (
                              <div key={line.id} className="border-l border-line-2 pl-3">
                                <p className="text-[9px] tracking-[.12em] text-muted-2">
                                  {line.character}
                                </p>
                                <p className="mt-0.5 text-[12.5px] leading-[1.8] text-text">
                                  {line.text}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}

                        <p className="tnum mt-2 text-[8.5px] text-muted-2">
                          {shot.size} · {shot.angle} · {shot.dur.toFixed(1)}s
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>

          {readOnly && (
            <p className="mt-8 text-[10px] text-muted-2">
              另一个标签页在编辑：这一页只读，刷新后才能接管。
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
