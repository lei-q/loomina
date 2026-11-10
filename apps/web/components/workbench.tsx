"use client";

import { useEffect, useMemo } from "react";
import { ReelBar } from "@/components/reel-bar";
import { Stage } from "@/components/stage";
import { TopBar } from "@/components/top-bar";
import { toStageView } from "@/lib/read-model";
import { fetchImagePrice } from "@/lib/image-price";
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
  const generateKeyframe = useWorkbench((state) => state.generateKeyframe);
  const instruct = useWorkbench((state) => state.instruct);
  const removeNote = useWorkbench((state) => state.removeNote);
  const setShotLock = useWorkbench((state) => state.setShotLock);
  const jobs = useWorkbench((state) => state.jobs);
  const castError = useWorkbench((state) => state.castError);
  const imageCny = useWorkbench((state) => state.imageCny);
  const setImagePrice = useWorkbench((state) => state.setImagePrice);

  useEffect(() => {
    void hydrate();
    // 首帧的价目同样来自服务端：进页面问一次，用来标价并在提交前拦超预算
    void fetchImagePrice().then((price) => {
      if (price) setImagePrice(price);
    });
  }, [hydrate, setImagePrice]);

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
        spendBreakdown={view.spend}
        storageError={storageError}
        readOnly={readOnly}
        onBudgetChange={setBudget}
        allRequote={view.requoteAll}
      />
      {castError && (
        <p className="shrink-0 px-6 pb-1 text-[10.5px] leading-[1.6] text-pick">{castError}</p>
      )}
      <Stage
        view={view}
        generating={
          jobs[`${view.shots[view.current]!.id}:last`]?.kind === "keyframe"
            ? "last"
            : jobs[`${view.shots[view.current]!.id}:first`]?.kind === "keyframe"
              ? "first"
              : null
        }
        quoteCny={imageCny}
        onGenerateKeyframe={(frame) => void generateKeyframe(view.shots[view.current]!.id, frame)}
        onRemoveNote={(note) => removeNote(view.shots[view.current]!.id, note)}
      />
      <ReelBar
        view={view}
        onSelect={select}
        onDecide={decide}
        onInstruct={instruct}
        onSetLock={(locked) => setShotLock(view.shots[view.current]!.id, locked)}
      />
    </div>
  );
}
