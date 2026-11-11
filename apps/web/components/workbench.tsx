"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimaticOverlay } from "@/components/animatic";
import { ConsistencyPanel } from "@/components/consistency-panel";
import { ReelBar } from "@/components/reel-bar";
import { Stage } from "@/components/stage";
import { StoryboardPanel } from "@/components/storyboard-panel";
import { TopBar } from "@/components/top-bar";
import { toAnimaticView, toStageView } from "@/lib/read-model";
import { fetchPrice } from "@/lib/image-price";
import { analyzeConsistency } from "@/lib/consistency";
import { analyzeStoryboard } from "@/lib/storyboard";
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
  const setShotPlan = useWorkbench((state) => state.setShotPlan);
  const toggleShotCharacter = useWorkbench((state) => state.toggleShotCharacter);
  const toggleShotProp = useWorkbench((state) => state.toggleShotProp);
  const moveShotCharacter = useWorkbench((state) => state.moveShotCharacter);
  const moveShotProp = useWorkbench((state) => state.moveShotProp);
  const approveAndLock = useWorkbench((state) => state.approveAndLock);
  const jobs = useWorkbench((state) => state.jobs);
  const castError = useWorkbench((state) => state.castError);
  const imageCny = useWorkbench((state) => state.imageCny);
  const setImagePrice = useWorkbench((state) => state.setImagePrice);
  const videoCnyPerSecond = useWorkbench((state) => state.videoCnyPerSecond);
  const setVideoPrice = useWorkbench((state) => state.setVideoPrice);
  const generateVideo = useWorkbench((state) => state.generateVideo);
  const attachVideo = useWorkbench((state) => state.attachVideo);

  useEffect(() => {
    void hydrate();
    // 首帧与视频的价目同样来自服务端：进页面问一次，用来标价并在提交前拦超预算
    void fetchPrice().then((price) => {
      if (!price) return;
      setImagePrice(price);
      if (price.video) setVideoPrice(price.video);
    });
  }, [hydrate, setImagePrice, setVideoPrice]);

  const events = useWorkbench((state) => state.events);
  const view = useMemo(
    () => toStageView(project, { currentShotId, events }),
    [project, currentShotId, events],
  );
  // 预演（ADR-0084）：把整条片子按镜头时长放一遍
  const [previewOpen, setPreviewOpen] = useState(false);
  const animatic = useMemo(() => toAnimaticView(project), [project]);
  // 分镜检查（ADR-0096）：覆盖率和校验都从同一份读模型来
  const [checkOpen, setCheckOpen] = useState(false);
  const storyboard = useMemo(
    () =>
      analyzeStoryboard(project, {
        requoteCny: view.requoteAll.totalCny,
        budgetCny: project.budgetCny,
      }),
    [project, view.requoteAll.totalCny],
  );
  // 一致性体检（ADR-0097）：只看结构化锚点与溯源
  const [consistencyOpen, setConsistencyOpen] = useState(false);
  const consistency = useMemo(() => analyzeConsistency(project), [project]);
  const currentShot = view.shots[view.current];
  const videoJob = currentShot ? jobs[`${currentShot.id}:video`] : undefined;

  // 键盘：← → 换格，⌘⏎ 留用；输入框里只让 ⌘⏎ 生效；预演 / 检查打开时让给它们
  useEffect(() => {
    if (previewOpen || checkOpen || consistencyOpen) return;
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
  }, [view, select, decide, previewOpen, checkOpen, consistencyOpen]);

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
        onCheck={
          view.shots.length > 0
            ? () => {
                setConsistencyOpen(false);
                setCheckOpen(true);
              }
            : undefined
        }
        checkCount={storyboard.summary.errors + storyboard.summary.warnings}
        onConsistency={
          view.shots.length > 0
            ? () => {
                setCheckOpen(false);
                setConsistencyOpen(true);
              }
            : undefined
        }
        consistencyCount={consistency.summary.review + consistency.summary.fail}
        onPreview={view.shots.length > 0 ? () => setPreviewOpen(true) : undefined}
      />
      {castError && (
        <p className="shrink-0 px-6 pb-1 text-[10.5px] leading-[1.6] text-pick">{castError}</p>
      )}
      {view.shots.length === 0 ? (
        // 删光了也不崩：留一句去哪继续（ADR-0067）
        <main className="flex min-h-0 flex-1 items-center justify-center px-6 text-[11px] leading-[1.8] text-muted-2">
          还没有镜头。去「剧本」页加一场，再回来点名出场、生成关键帧。
        </main>
      ) : (
        <>
          <Stage
            view={view}
            generating={
              jobs[`${view.shots[view.current]!.id}:last`]?.kind === "keyframe"
                ? "last"
                : jobs[`${view.shots[view.current]!.id}:first`]?.kind === "keyframe"
                  ? "first"
                  : null
            }
            generatingVideo={jobs[`${view.shots[view.current]!.id}:video`]?.kind === "video"}
            videoAttempt={videoJob?.kind === "video" ? videoJob.attempt : undefined}
            quoteCny={imageCny}
            videoCnyPerSecond={videoCnyPerSecond}
            readOnly={readOnly ?? false}
            onGenerateKeyframe={(frame) => void generateKeyframe(view.shots[view.current]!.id, frame)}
            onGenerateVideo={() => void generateVideo(view.shots[view.current]!.id)}
            onAttachVideo={(uri) => attachVideo(view.shots[view.current]!.id, uri)}
            onRemoveNote={(note) => removeNote(view.shots[view.current]!.id, note)}
            onToggleCharacter={(characterId) =>
              toggleShotCharacter(view.shots[view.current]!.id, characterId)
            }
            onToggleProp={(propId) => toggleShotProp(view.shots[view.current]!.id, propId)}
            onMoveCharacter={(characterId, delta) =>
              moveShotCharacter(view.shots[view.current]!.id, characterId, delta)
            }
            onMoveProp={(propId, delta) => moveShotProp(view.shots[view.current]!.id, propId, delta)}
          />
          <ReelBar
            view={view}
            onSelect={select}
            onDecide={decide}
            onInstruct={instruct}
            onSetLock={(locked) => setShotLock(view.shots[view.current]!.id, locked)}
            onApproveAndLock={() => approveAndLock(view.shots[view.current]!.id)}
            onRedo={() => void generateVideo(view.shots[view.current]!.id)}
            videoCnyPerSecond={videoCnyPerSecond}
          />
        </>
      )}
      {previewOpen && view.shots.length > 0 && (
        <AnimaticOverlay view={animatic} onClose={() => setPreviewOpen(false)} />
      )}
      {checkOpen && view.shots.length > 0 && (
        <StoryboardPanel
          project={project}
          currentShotId={view.shots[view.current]!.id}
          quoteAllCny={view.requoteAll.totalCny}
          readOnly={readOnly ?? false}
          onSelect={select}
          onPlanChange={(patch) => setShotPlan(view.shots[view.current]!.id, patch)}
          onClose={() => setCheckOpen(false)}
        />
      )}
      {consistencyOpen && view.shots.length > 0 && (
        <ConsistencyPanel
          project={project}
          currentShotId={view.shots[view.current]!.id}
          onSelect={select}
          onClose={() => setConsistencyOpen(false)}
        />
      )}
    </div>
  );
}
