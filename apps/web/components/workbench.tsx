"use client";

import { useEffect, useMemo } from "react";
import { ReelBar } from "@/components/reel-bar";
import { Stage } from "@/components/stage";
import { TopBar } from "@/components/top-bar";
import { toStageView } from "@/lib/read-model";
import { useWorkbench } from "@/lib/workbench-store";

export function Workbench() {
  const project = useWorkbench((state) => state.project);
  const currentShotId = useWorkbench((state) => state.currentShotId);
  const select = useWorkbench((state) => state.select);
  const decide = useWorkbench((state) => state.decide);
  const hydrate = useWorkbench((state) => state.hydrate);
  const storageError = useWorkbench((state) => state.storageError);
  const readOnly = useWorkbench((state) => state.readOnly);
  const setBudget = useWorkbench((state) => state.setBudget);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const view = useMemo(
    () => toStageView(project, { currentShotId }),
    [project, currentShotId],
  );

  // 键盘：← → 换格，⌘⏎ 留用；输入框里只让 ⌘⏎ 生效
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        decide("approved");
        return;
      }
      if (typing) return;

      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (step === 0) return;

      event.preventDefault();
      const at = view.shots.findIndex((shot) => shot.id === view.shots[view.current]?.id);
      const next = view.shots[at + step];
      if (next) select(next.id);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view, select, decide]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
      <TopBar
        title={view.title}
        version={view.version}
        stage="分镜"
        spentCny={view.spent}
        budgetCny={view.budget}
        unpriced={view.unpriced}
        storageError={storageError}
        readOnly={readOnly}
        onBudgetChange={setBudget}
        allRequote={view.requoteAll}
      />
      <Stage view={view} />
      <ReelBar view={view} onSelect={select} onDecide={decide} />
    </div>
  );
}
