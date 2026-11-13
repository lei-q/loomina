"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimaticOverlay } from "@/components/animatic";
import { BlockingPanel } from "@/components/blocking-panel";
import { ConsistencyPanel } from "@/components/consistency-panel";
import { PerformancePanel } from "@/components/performance-panel";
import { PerformanceQaPanel } from "@/components/performance-qa-panel";
import { ReelBar } from "@/components/reel-bar";
import { SceneSpacePanel } from "@/components/scene-space-panel";
import { Stage } from "@/components/stage";
import { ShotLanguagePanel } from "@/components/shot-language-panel";
import { StoryboardPanel } from "@/components/storyboard-panel";
import { TimelineStrip } from "@/components/timeline-strip";
import { StageGate } from "@/components/stage-gate";
import { TopBar } from "@/components/top-bar";
import { toAnimaticView, toStageView } from "@/lib/read-model";
import { fetchPrice } from "@/lib/image-price";
import { analyzeConsistency } from "@/lib/consistency";
import { analyzePerformanceQa, performanceQaCount } from "@/lib/performance-qa";
import { analyzeSceneSpace } from "@/lib/scene-space";
import { analyzeStoryboard } from "@/lib/storyboard";
import { matchShotLanguage } from "@loomina/pipeline";
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
  const setShotBudget = useWorkbench((state) => state.setShotBudget);
  const setShotPlan = useWorkbench((state) => state.setShotPlan);
  const applyShotLanguage = useWorkbench((state) => state.applyShotLanguage);
  const setShotCamera = useWorkbench((state) => state.setShotCamera);
  const setShotLighting = useWorkbench((state) => state.setShotLighting);
  const setShotComposition = useWorkbench((state) => state.setShotComposition);
  const setShotContinuation = useWorkbench((state) => state.setShotContinuation);
  const setShotPerformance = useWorkbench((state) => state.setShotPerformance);
  const setShotStaging = useWorkbench((state) => state.setShotStaging);
  const setShotBlocking = useWorkbench((state) => state.setShotBlocking);
  const toggleShotCharacter = useWorkbench((state) => state.toggleShotCharacter);
  const toggleShotProp = useWorkbench((state) => state.toggleShotProp);
  const moveShotCharacter = useWorkbench((state) => state.moveShotCharacter);
  const moveShotProp = useWorkbench((state) => state.moveShotProp);
  const approveAndLock = useWorkbench((state) => state.approveAndLock);
  const jobs = useWorkbench((state) => state.jobs);
  const castError = useWorkbench((state) => state.castError);
  const instructionNotice = useWorkbench((state) => state.instructionNotice);
  const instructionBusy = useWorkbench((state) => state.instructionBusy);
  const instructWithModel = useWorkbench((state) => state.instructWithModel);
  const imageCny = useWorkbench((state) => state.imageCny);
  const setImagePrice = useWorkbench((state) => state.setImagePrice);
  const videoCnyPerSecond = useWorkbench((state) => state.videoCnyPerSecond);
  const setVideoPrice = useWorkbench((state) => state.setVideoPrice);
  const generateVideo = useWorkbench((state) => state.generateVideo);
  const mode = useWorkbench((state) => state.mode);
  const attachVideo = useWorkbench((state) => state.attachVideo);
  const removeTake = useWorkbench((state) => state.removeTake);

  useEffect(() => {
    void hydrate();
    // 首帧与视频的价目同样来自服务端：进页面问一次，用来标价并在提交前拦超预算
    void fetchPrice().then((price) => {
      if (!price) return;
      setImagePrice(price);
      if (price.video) setVideoPrice(price.video);
    });
  }, [hydrate, setImagePrice, setVideoPrice, project.models?.image, project.models?.video]);

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
  // 表演与调度（B16 / B17，ADR-0103）：一镜的表演设计、视线与站位
  const [performanceOpen, setPerformanceOpen] = useState(false);
  // 表演 QA（B18）：表演设计配不配景别、视线与节拍
  const [performanceQaOpen, setPerformanceQaOpen] = useState(false);
  // 一致性体检（ADR-0097）：只看结构化锚点与溯源
  const [consistencyOpen, setConsistencyOpen] = useState(false);
  // 走位（B13.1 / ADR-0126）：俯视平面图 + 自动摆位 + 精确越轴
  const [blockingOpen, setBlockingOpen] = useState(false);
  // 场景空间板 / 走位台账（B11）：跨镜对一遍谁在哪、朝哪、拿什么
  const [spaceOpen, setSpaceOpen] = useState(false);
  // 镜头语言库（I1）：景别 / 机位 / 运镜 / 焦段收成一套套说法
  const [languageOpen, setLanguageOpen] = useState(false);
  const consistency = useMemo(() => analyzeConsistency(project), [project]);
  const performanceQa = useMemo(() => analyzePerformanceQa(project), [project]);
  const sceneSpace = useMemo(() => analyzeSceneSpace(project), [project]);
  // 当前镜是不是正好对上了库里的一套说法（I1）：没对上就在按钮上标一点
  const currentShot = view.shots[view.current];
  const languageMatched = useMemo(() => {
    const shot = currentShot
      ? project.shots.find((item) => item.id === currentShot.id)
      : undefined;
    return shot
      ? Boolean(matchShotLanguage(shot)) && Boolean(shot.lighting) && Boolean(shot.composition)
      : false;
  }, [project.shots, currentShot]);
  const videoJob = currentShot ? jobs[`${currentShot.id}:video`] : undefined;

  // 键盘：← → 换格，⌘⏎ 留用；输入框里只让 ⌘⏎ 生效；预演 / 检查打开时让给它们
  useEffect(() => {
    if (previewOpen || checkOpen || consistencyOpen || performanceOpen || blockingOpen || languageOpen)
      return;
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
  }, [
    view,
    select,
    decide,
    previewOpen,
    checkOpen,
    consistencyOpen,
    performanceOpen,
    performanceQaOpen,
    blockingOpen,
    spaceOpen,
    languageOpen,
  ]);

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
                setPerformanceOpen(false);
                setPerformanceQaOpen(false);
                setSpaceOpen(false);
                setBlockingOpen(false);
                setCheckOpen(true);
              }
            : undefined
        }
        checkCount={storyboard.summary.errors + storyboard.summary.warnings}
        onPerformance={
          view.shots.length > 0
            ? () => {
                setCheckOpen(false);
                setConsistencyOpen(false);
                setPerformanceQaOpen(false);
                setSpaceOpen(false);
                setBlockingOpen(false);
                setPerformanceOpen(true);
              }
            : undefined
        }
        performanceCount={
          project.shots.filter((shot) => !shot.performance?.objective.trim()).length
        }
        onPerformanceQa={
          view.shots.length > 0
            ? () => {
                setCheckOpen(false);
                setPerformanceOpen(false);
                setConsistencyOpen(false);
                setBlockingOpen(false);
                setLanguageOpen(false);
                setPerformanceQaOpen(true);
              }
            : undefined
        }
        performanceQaCount={performanceQaCount(performanceQa)}
        onConsistency={
          view.shots.length > 0
            ? () => {
                setCheckOpen(false);
                setPerformanceOpen(false);
                setPerformanceQaOpen(false);
                setSpaceOpen(false);
                setBlockingOpen(false);
                setConsistencyOpen(true);
              }
            : undefined
        }
        onBlocking={
          view.shots.length > 0
            ? () => {
                setCheckOpen(false);
                setPerformanceOpen(false);
                setPerformanceQaOpen(false);
                setSpaceOpen(false);
                setConsistencyOpen(false);
                setBlockingOpen(true);
              }
            : undefined
        }
        blockingCount={storyboard.issues.filter((issue) => issue.rule === "V3").length}
        onSpace={
          view.shots.length > 0
            ? () => {
                setCheckOpen(false);
                setPerformanceOpen(false);
                setPerformanceQaOpen(false);
                setConsistencyOpen(false);
                setBlockingOpen(false);
                setLanguageOpen(false);
                setSpaceOpen(true);
              }
            : undefined
        }
        spaceCount={sceneSpace.summary.issues}
        consistencyCount={consistency.summary.review + consistency.summary.fail}
        onLanguage={
          view.shots.length > 0
            ? () => {
                setCheckOpen(false);
                setPerformanceOpen(false);
                setPerformanceQaOpen(false);
                setSpaceOpen(false);
                setConsistencyOpen(false);
                setBlockingOpen(false);
                setLanguageOpen(true);
              }
            : undefined
        }
        languageMatched={languageMatched}
        onPreview={view.shots.length > 0 ? () => setPreviewOpen(true) : undefined}
      />
      {castError && (
        <p className="shrink-0 px-6 pb-1 text-[10.5px] leading-[1.6] text-pick">{castError}</p>
      )}
      {!castError && instructionNotice && (
        <p className="shrink-0 px-6 pb-1 text-[10.5px] leading-[1.6] text-muted">
          {instructionNotice}
        </p>
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
            onTakeSharedVideo={(uri) =>
              attachVideo(view.shots[view.current]!.id, uri, "library")
            }
            onRemoveNote={(note) => removeNote(view.shots[view.current]!.id, note)}
            onToggleCharacter={(characterId) =>
              toggleShotCharacter(view.shots[view.current]!.id, characterId)
            }
            onToggleProp={(propId) => toggleShotProp(view.shots[view.current]!.id, propId)}
            onMoveCharacter={(characterId, delta) =>
              moveShotCharacter(view.shots[view.current]!.id, characterId, delta)
            }
            onMoveProp={(propId, delta) => moveShotProp(view.shots[view.current]!.id, propId, delta)}
            onSetBudget={(cny) => setShotBudget(view.shots[view.current]!.id, cny)}
            onRemoveTake={removeTake}
          />
          <ReelBar
            view={view}
            onSelect={select}
            onDecide={decide}
            onInstruct={instruct}
            onInstructWithModel={instructWithModel}
            instructBusy={instructionBusy}
            onSetLock={(locked) => setShotLock(view.shots[view.current]!.id, locked)}
            onApproveAndLock={() => approveAndLock(view.shots[view.current]!.id)}
            onRedo={() => void generateVideo(view.shots[view.current]!.id)}
            videoCnyPerSecond={videoCnyPerSecond}
          />
          {/* 自由工作台：分镜、预览、时间线同屏（F8） */}
          {mode === "free" && <TimelineStrip />}
        </>
      )}
      <StageGate stage="storyboard" />
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
      {performanceOpen && view.shots.length > 0 && (
        <PerformancePanel
          project={project}
          shotId={view.shots[view.current]!.id}
          prompt={view.shots[view.current]!.prompts.video}
          readOnly={readOnly ?? false}
          onSavePerformance={(performance) =>
            setShotPerformance(view.shots[view.current]!.id, performance)
          }
          onSaveStaging={(staging) => setShotStaging(view.shots[view.current]!.id, staging)}
          onClose={() => setPerformanceOpen(false)}
        />
      )}
      {performanceQaOpen && view.shots.length > 0 && (
        <PerformanceQaPanel
          project={project}
          currentShotId={view.shots[view.current]!.id}
          onSelect={select}
          onEdit={(shotId) => {
            select(shotId);
            setPerformanceQaOpen(false);
            setPerformanceOpen(true);
          }}
          onClose={() => setPerformanceQaOpen(false)}
        />
      )}
      {blockingOpen && view.shots.length > 0 && (
        <BlockingPanel
          project={project}
          currentShotId={view.shots[view.current]!.id}
          readOnly={readOnly ?? false}
          onSelect={select}
          onApply={(shotId, blocking, placement) => setShotBlocking(shotId, blocking, placement)}
          onClose={() => setBlockingOpen(false)}
        />
      )}
      {spaceOpen && view.shots.length > 0 && (
        <SceneSpacePanel
          project={project}
          currentShotId={view.shots[view.current]!.id}
          onSelect={select}
          onBlocking={(shotId) => {
            select(shotId);
            setSpaceOpen(false);
            setBlockingOpen(true);
          }}
          onClose={() => setSpaceOpen(false)}
        />
      )}
      {languageOpen && view.shots.length > 0 && (
        <ShotLanguagePanel
          project={project}
          currentShotId={view.shots[view.current]!.id}
          readOnly={readOnly ?? false}
          onSelectShot={select}
          onApply={(shotId, languageId) => applyShotLanguage(shotId, languageId)}
          onCamera={(shotId, patch) => setShotCamera(shotId, patch)}
          onLighting={(shotId, lighting) => setShotLighting(shotId, lighting)}
          onComposition={(shotId, composition) => setShotComposition(shotId, composition)}
          onContinuation={(shotId, tailMs) => setShotContinuation(shotId, tailMs)}
          onClose={() => setLanguageOpen(false)}
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
