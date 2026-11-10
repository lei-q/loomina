"use client";

import { useEffect, useMemo, useState } from "react";
import { TopBar } from "@/components/top-bar";
import {
  actionHistory,
  dialogueHistory,
  dialogueOrderHistory,
  previousActionText,
  previousDialogueText,
  previousSceneHead,
  removedLines,
  sceneHead,
  sceneHeadHistory,
  scriptToText,
  SPACE_LABEL,
  shotLabel,
  TIME_LABEL,
  toScriptView,
  type SceneHead,
} from "@/lib/read-model";
import { useWorkbench } from "@/lib/workbench-store";

/** 事件时间只到分钟：版本列表看的是先后，不是秒。 */
function clock(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function ScriptScreen() {
  const project = useWorkbench((state) => state.project);
  const hydrate = useWorkbench((state) => state.hydrate);
  const readOnly = useWorkbench((state) => state.readOnly);
  const storageError = useWorkbench((state) => state.storageError);
  const setBudget = useWorkbench((state) => state.setBudget);
  const editDialogue = useWorkbench((state) => state.editDialogue);
  const restoreDialogue = useWorkbench((state) => state.restoreDialogue);
  const addDialogue = useWorkbench((state) => state.addDialogue);
  const removeDialogue = useWorkbench((state) => state.removeDialogue);
  const changeSpeaker = useWorkbench((state) => state.changeSpeaker);
  const swapShotCharacter = useWorkbench((state) => state.swapShotCharacter);
  const moveDialogue = useWorkbench((state) => state.moveDialogue);
  const editAction = useWorkbench((state) => state.editAction);
  const editScene = useWorkbench((state) => state.editScene);
  const moveScene = useWorkbench((state) => state.moveScene);
  const moveSceneTo = useWorkbench((state) => state.moveSceneTo);
  const addScene = useWorkbench((state) => state.addScene);
  const addShot = useWorkbench((state) => state.addShot);
  const removeShot = useWorkbench((state) => state.removeShot);
  const removeScene = useWorkbench((state) => state.removeScene);
  const setDialogueOrder = useWorkbench((state) => state.setDialogueOrder);
  const moveDialogueTo = useWorkbench((state) => state.moveDialogueTo);
  const restoreLine = useWorkbench((state) => state.restoreLine);
  const events = useWorkbench((state) => state.events);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editingAction, setEditingAction] = useState<string | null>(null);
  const [actionDraft, setActionDraft] = useState("");
  const [editingScene, setEditingScene] = useState<string | null>(null);
  const [movingScene, setMovingScene] = useState<string | null>(null);
  const [deletingScene, setDeletingScene] = useState<string | null>(null);
  const [deletingShot, setDeletingShot] = useState<string | null>(null);
  /** 删除被拒的原因：贴在被删的那一场 / 那一镜下面，不塞进别的编辑器（ADR-0067） */
  const [deleteNote, setDeleteNote] = useState<{ id: string; text: string } | null>(null);
  /** 这一镜里换人：正在换哪一位（镜头 + 被换的人，ADR-0070） */
  const [swappingCast, setSwappingCast] = useState<{ shotId: string; characterId: string } | null>(null);
  /** 换人被拒的原因，贴在那一镜的出场行下面 */
  const [castNote, setCastNote] = useState<{ id: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [swapping, setSwapping] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [addSpeaker, setAddSpeaker] = useState("");
  const [addText, setAddText] = useState("");
  const [note, setNote] = useState<string | undefined>();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);
  // 场头的小编辑器：点外面就收起。只看 blur 不够——
  // 下拉没拿过焦点时，外面点击不会触发 blur，面板会一直挂着。
  useEffect(() => {
    if (!editingScene) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(`[data-scene-editor="${editingScene}"]`)) return;
      setEditingScene(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [editingScene]);

  const view = useMemo(() => toScriptView(project), [project]);

  const nameOf = (characterId: string) =>
    view.characters.find((item) => item.id === characterId)?.name ?? characterId;

  const shotChoices = view.scenes.flatMap((scene) =>
    scene.shots.map((shot) => ({ id: shot.id, label: `${shotLabel(shot.no)} · 第 ${scene.no} 场` })),
  );

  const startEdit = (lineId: string, text: string) => {
    setEditing(lineId);
    setDraft(text);
    setNote(undefined);
  };

  const startAction = (shotId: string, text: string) => {
    setEditingAction(shotId);
    setActionDraft(text);
    setEditing(null);
    setNote(undefined);
  };

  const commitScene = (
    sceneId: string,
    patch: {
      space?: "int" | "ext";
      timeOfDay?: "day" | "night" | "dawn" | "dusk";
      locationId?: string;
    },
  ) => {
    if (!editScene(sceneId, patch)) setNote(useWorkbench.getState().castError);
  };

  const saveAction = (shotId: string) => {    if (editAction(shotId, actionDraft)) {
      setEditingAction(null);
      setNote(undefined);
    } else {
      setNote(useWorkbench.getState().castError);
    }
  };

  const restoreAction = (shotId: string, text: string) => {
    if (editAction(shotId, text)) setNote(undefined);
    else setNote(useWorkbench.getState().castError);
  };

  const restoreScene = (sceneId: string, head: SceneHead) => {
    const ok = editScene(sceneId, {
      space: head.space,
      timeOfDay: head.timeOfDay,
      locationId: head.locationId,
    });
    if (ok) setNote(undefined);
    else setNote(useWorkbench.getState().castError);
  };

  /** 一版场头怎么写：`内 · 夜 · 走廊`。地点已不在库里也不装看不见。 */
  const headText = (head: SceneHead) => {
    const place =
      project.locations.find((item) => item.id === head.locationId)?.name ?? "（地点已不在库里）";
    return `${SPACE_LABEL[head.space]} · ${TIME_LABEL[head.timeOfDay]} · ${place}`;
  };

  const revertSpeaker = (lineId: string, characterId: string) => {
    if (changeSpeaker(lineId, characterId)) setNote(undefined);
    else setNote(useWorkbench.getState().castError);
  };

  const moveLine = (lineId: string, targetShotId: string) => {
    if (moveDialogueTo(lineId, targetShotId)) {
      setMoving(null);
      setNote(undefined);
    } else {
      setNote(useWorkbench.getState().castError);
    }
  };

  const restoreOrder = (shotId: string, lineIds: string[]) => {
    if (setDialogueOrder(shotId, lineIds)) setNote(undefined);
    else setNote(useWorkbench.getState().castError);
  };

  const restoreRemoved = (lineId: string) => {
    if (restoreLine(lineId)) setNote(undefined);
    else setNote(useWorkbench.getState().castError);
  };

  const save = (lineId: string) => {
    if (editDialogue(lineId, draft)) {
      setEditing(null);
      setNote(undefined);
    } else {
      setNote(useWorkbench.getState().castError);
    }
  };

  const startAdd = (shotId: string, characterIds: string[]) => {
    setAdding(shotId);
    setAddSpeaker(characterIds[0] ?? view.characters[0]?.id ?? "");
    setAddText("");
    setDeleting(null);
    setNote(undefined);
  };

  const saveAdd = (shotId: string) => {
    if (addDialogue(shotId, addSpeaker, addText)) {
      setAdding(null);
      setAddText("");
      setNote(undefined);
    } else {
      setNote(useWorkbench.getState().castError);
    }
  };

  const exportScript = () => {
    const blob = new Blob([scriptToText(view)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${view.title}-v${view.version}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const move = (lineId: string, direction: "up" | "down") => {
    if (!moveDialogue(lineId, direction)) setNote(useWorkbench.getState().castError);
  };

  const remove = (lineId: string) => {
    if (removeDialogue(lineId)) {
      setDeleting(null);
      setNote(undefined);
    } else {
      setNote(useWorkbench.getState().castError);
    }
  };

  const restore = (lineId: string, text: string, durMs: number) => {
    if (restoreDialogue(lineId, text, durMs)) {
      setEditing(null);
      setNote(undefined);
    } else {
      setNote(useWorkbench.getState().castError);
    }
  };

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
        onExport={exportScript}
        exportLabel="把剧本导出成纯文本（.txt）"
      />

      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
        <div className="mx-auto max-w-[720px]">
          <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
            <div>
              <h1 className="text-[13px] tracking-[.06em] text-text">剧本</h1>
              <p className="mt-1 text-[10.5px] leading-[1.6] text-muted-2">
                按场次和镜序摊平：动作在前，台词在后。动作点一下就能改；
                台词点「改」可以重写，时长按 0.3 秒 / 字重估，所属镜头跟着挪。
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
            {view.scenes.map((scene, at) => (
              <section key={scene.id}>
                <div className="flex items-baseline gap-3 border-b border-line pb-2">
                  <span className="tnum shrink-0 text-[9.5px] tracking-[.14em] text-muted-2">
                    第 {scene.no} 场
                  </span>
                  {editingScene === scene.id ? (
                    <span
                      data-scene-editor={scene.id}
                      className="flex shrink-0 items-baseline gap-1"
                    >
                      <select
                        autoFocus
                        value={scene.space}
                        onChange={(event) =>
                          commitScene(scene.id, { space: event.target.value as "int" | "ext" })
                        }
                        aria-label="内外景"
                        className="rounded-token border border-pick/70 bg-surface px-1 py-0 text-[9px] text-text focus:outline-none"
                      >
                        {Object.entries(SPACE_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <span className="text-muted-2">·</span>
                      <select
                        value={scene.timeOfDay}
                        onChange={(event) =>
                          commitScene(scene.id, {
                            timeOfDay: event.target.value as
                              | "day"
                              | "night"
                              | "dawn"
                              | "dusk",
                          })
                        }
                        aria-label="日夜"
                        className="rounded-token border border-pick/70 bg-surface px-1 py-0 text-[9px] text-text focus:outline-none"
                      >
                        {Object.entries(TIME_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <span className="text-muted-2">·</span>
                      <select
                        value={scene.locationId}
                        onChange={(event) =>
                          commitScene(scene.id, { locationId: event.target.value })
                        }
                        aria-label="地点"
                        className="rounded-token border border-pick/70 bg-surface px-1 py-0 text-[9px] text-text focus:outline-none"
                      >
                        {project.locations.map((location) => (
                          <option key={location.id} value={location.id}>
                            {location.name}
                          </option>
                        ))}
                        {!project.locations.some((item) => item.id === scene.locationId) && (
                          <option value={scene.locationId}>{scene.place}</option>
                        )}
                      </select>
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() => {
                        setEditingScene(scene.id);
                        setNote(undefined);
                      }}
                      title={readOnly ? "只读标签页不能改场头" : "改内 / 外景、日夜与地点"}
                      className="tnum shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-default disabled:opacity-60"
                    >
                      {sceneHead(scene)}
                    </button>
                  )}
                  <h2 className="text-[13px] tracking-[.04em] text-text">{scene.place}</h2>
                  <span className="tnum ml-auto shrink-0 text-[9.5px] text-muted-2">
                    {scene.dur.toFixed(1)}s · {scene.shots.length} 镜
                  </span>
                  {/* 调整场序（ADR-0060）：上移 / 下移一位，镜号跟着重排 */}
                  {!readOnly && (
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => moveScene(scene.id, "up")}
                        disabled={at === 0}
                        title="上移一场：场号与镜号跟着重排"
                        className="tnum rounded-token border border-line px-1 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-default disabled:opacity-40"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveScene(scene.id, "down")}
                        disabled={at === view.scenes.length - 1}
                        title="下移一场：场号与镜号跟着重排"
                        className="tnum rounded-token border border-line px-1 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-default disabled:opacity-40"
                      >
                        ↓
                      </button>
                      {/* 长距离换位：直接挑一个位置（ADR-0060 附记） */}
                      {movingScene === scene.id ? (
                        <select
                          autoFocus
                          value=""
                          onChange={(event) => {
                            moveSceneTo(scene.id, Number(event.target.value));
                            setMovingScene(null);
                          }}
                          onBlur={() => setMovingScene(null)}
                          aria-label="挪到第几场"
                          className="tnum rounded-token border border-pick/70 bg-surface px-1 py-px text-[9px] text-text focus:outline-none"
                        >
                          <option value="" disabled>
                            挪到…
                          </option>
                          {view.scenes.map((item, i) =>
                            i === at ? null : (
                              <option key={item.id} value={i}>
                                第 {i + 1} 场
                              </option>
                            ),
                          )}
                        </select>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setMovingScene(scene.id)}
                          title="长距离换位：直接挪到第 N 场"
                          className="tnum rounded-token border border-line px-1 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text"
                        >
                          挪
                        </button>
                      )}
                      {/* 删一场（ADR-0067）：先删它的镜头，再删场；两步确认 */}
                      {deletingScene === scene.id ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              const ok = removeScene(scene.id);
                              setDeleteNote(
                                ok ? null : { id: scene.id, text: useWorkbench.getState().castError ?? "删不掉这一场。" },
                              );
                              if (ok) setDeletingScene(null);
                            }}
                            title="删掉这一场：这一场的镜头会一起删，台词与 take 也跟着走"
                            className="tnum rounded-token border border-pick/70 px-1 py-px text-[9px] text-pick transition-colors duration-[var(--dur)] hover:bg-pick hover:text-bg"
                          >
                            {scene.shots.length > 0 ? `确认删 ${scene.shots.length} 镜` : "确认删"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeletingScene(null)}
                            className="tnum rounded-token border border-line px-1 py-px text-[9px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                          >
                            取消
                          </button>                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setDeletingScene(scene.id);
                            setDeleteNote(null);
                          }}
                          title={
                            scene.shots.length > 0
                              ? `删掉这一场：连这一场的 ${scene.shots.length} 镜一起删`
                              : "删掉这个空场"
                          }
                          className="tnum rounded-token border border-line px-1 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-pick enabled:hover:text-pick"
                        >
                          删
                        </button>
                      )}
                    </span>
                  )}
                </div>

                {deleteNote?.id === scene.id && (
                  <p className="mt-1.5 text-[9.5px] leading-[1.7] text-pick">{deleteNote.text}</p>
                )}

                {/* 场头改过几次（ADR-0058）：一场一件事，折叠在标题下面，不占正文 */}
                {(() => {
                  const history = sceneHeadHistory(events, scene.id);
                  if (history.edits.length === 0) return null;
                  const prev = previousSceneHead(history);
                  const current = {
                    space: scene.space,
                    timeOfDay: scene.timeOfDay,
                    locationId: scene.locationId,
                  };
                  const same = (head: SceneHead) =>
                    head.space === current.space &&
                    head.timeOfDay === current.timeOfDay &&
                    head.locationId === current.locationId;
                  return (
                    <details className="mt-1.5">
                      <summary className="tnum cursor-pointer list-none text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-muted [&::-webkit-details-marker]:hidden">
                        改过 {history.edits.length} 次
                        {prev ? ` · 上一版 ${headText(prev)}` : ""}
                      </summary>
                      <ul className="mt-1 space-y-0.5 text-[9.5px] leading-[1.7]">
                        {[...history.edits].reverse().map((edit, i) => (
                          <li key={`${edit.at}-${i}`} className="flex items-baseline gap-2">
                            <span className="tnum shrink-0 text-muted-2">{clock(edit.at)}</span>
                            <span className="text-muted">{headText(edit.head)}</span>
                            {!readOnly && (
                              <button
                                type="button"
                                disabled={same(edit.head)}
                                onClick={() => restoreScene(scene.id, edit.head)}
                                title={same(edit.head) ? "场头已经是这一版" : "用回这一版"}
                                className="shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                用这版
                              </button>
                            )}
                          </li>
                        ))}
                        {history.original && (
                          <li className="flex items-baseline gap-2">
                            <span className="shrink-0 text-muted-2">最初</span>
                            <span className="text-muted-2">{headText(history.original)}</span>
                            {!readOnly && (
                              <button
                                type="button"
                                disabled={same(history.original)}
                                onClick={() => restoreScene(scene.id, history.original!)}
                                title={
                                  same(history.original) ? "场头已经是这一版" : "用回最初这一版"
                                }
                                className="shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                用这版
                              </button>
                            )}
                          </li>
                        )}
                      </ul>
                    </details>
                  );
                })()}

                <ol className="mt-4 space-y-5">
                  {scene.shots.map((shot) => (
                    <li key={shot.id} className="grid grid-cols-[42px_1fr] gap-3">
                      <span className="tnum pt-[3px] text-[9px] text-muted-2">
                        {shotLabel(shot.no)}
                      </span>
                      <div className="min-w-0">
                        {editingAction === shot.id ? (
                          <div>
                            <textarea
                              autoFocus
                              value={actionDraft}
                              rows={2}
                              onChange={(event) => setActionDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                  saveAction(shot.id);
                                }
                                if (event.key === "Escape") setEditingAction(null);
                              }}
                              className="w-full resize-none rounded-token border border-line-2 bg-surface px-2 py-1.5 text-[13px] leading-[1.8] text-text focus:border-pick focus:outline-none"
                            />
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[9.5px]">
                              <button
                                type="button"
                                onClick={() => saveAction(shot.id)}
                                className="rounded-token border border-line-2 px-2 py-0.5 text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                              >
                                保存
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingAction(null)}
                                className="rounded-token border border-line px-2 py-0.5 text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                              >
                                取消
                              </button>
                              <span className="text-muted-2">⌘↩ 保存 · Esc 取消</span>
                              {note && <span className="text-pick">{note}</span>}
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={readOnly || shot.locked}
                            onClick={() => startAction(shot.id, shot.action)}
                            title={
                              shot.locked
                                ? "这一镜已锁定，先解锁才能改动作"
                                : "改这一镜的动作"
                            }
                            className="-mx-1 block w-full rounded-token px-1 text-left text-[13px] leading-[1.9] text-text transition-colors duration-[var(--dur)] enabled:hover:bg-surface disabled:cursor-default"
                          >
                            {shot.action || (
                              <span className="text-muted-2">（这一镜还没有动作描述）</span>
                            )}
                          </button>
                        )}

                        {editingAction !== shot.id &&
                          (() => {
                            const history = actionHistory(events, shot.id);
                            if (history.edits.length === 0) return null;
                            const prev = previousActionText(history);
                            return (
                              <details className="mt-1">
                                <summary className="tnum cursor-pointer list-none text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-muted [&::-webkit-details-marker]:hidden">
                                  改过 {history.edits.length} 次
                                  {prev ? ` · 上一版「${prev}」` : ""}
                                </summary>
                                <ul className="mt-1 space-y-0.5 text-[9.5px] leading-[1.7]">
                                  {[...history.edits].reverse().map((edit, i) => (
                                    <li
                                      key={`${edit.at}-${i}`}
                                      className="flex items-baseline gap-2"
                                    >
                                      <span className="tnum shrink-0 text-muted-2">
                                        {clock(edit.at)}
                                      </span>
                                      <span className="text-muted">{edit.text}</span>
                                      {!readOnly && (
                                        <button
                                          type="button"
                                          disabled={shot.locked || edit.text === shot.action}
                                          onClick={() => restoreAction(shot.id, edit.text)}
                                          title={
                                            shot.locked
                                              ? "这一镜已锁定，先解锁才能改动作"
                                              : "用回这一版"
                                          }
                                          className="shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                          用这版
                                        </button>
                                      )}
                                    </li>
                                  ))}
                                  {history.original !== undefined && (
                                    <li className="flex items-baseline gap-2">
                                      <span className="shrink-0 text-muted-2">最初</span>
                                      <span className="text-muted-2">{history.original}</span>
                                      {!readOnly && (
                                        <button
                                          type="button"
                                          disabled={
                                            shot.locked || history.original === shot.action
                                          }
                                          onClick={() =>
                                            restoreAction(shot.id, history.original!)
                                          }
                                          title={
                                            shot.locked
                                              ? "这一镜已锁定，先解锁才能改动作"
                                              : "用回最初这一版"
                                          }
                                          className="shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                          用这版
                                        </button>
                                      )}
                                    </li>
                                  )}
                                </ul>
                                {note && <p className="mt-1 text-[9.5px] text-pick">{note}</p>}
                              </details>
                            );
                          })()}

                        {shot.lines.length > 0 && (
                          <div className="mt-2 space-y-2">
                            {shot.lines.map((line, lineIndex) =>
                              editing === line.id ? (
                                <div key={line.id} className="border-l border-pick/70 pl-3">
                                  <p className="text-[9px] tracking-[.12em] text-muted-2">
                                    {line.character}
                                  </p>
                                  <textarea
                                    autoFocus
                                    value={draft}
                                    rows={2}
                                    onChange={(event) => setDraft(event.target.value)}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                        save(line.id);
                                      }
                                      if (event.key === "Escape") setEditing(null);
                                    }}
                                    className="mt-1 w-full resize-none rounded-token border border-line-2 bg-surface px-2 py-1.5 text-[12.5px] leading-[1.8] text-text focus:border-pick focus:outline-none"
                                  />
                                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[9.5px]">
                                    <button
                                      type="button"
                                      onClick={() => save(line.id)}
                                      className="rounded-token border border-line-2 px-2 py-0.5 text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                                    >
                                      保存
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setEditing(null)}
                                      className="rounded-token border border-line px-2 py-0.5 text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                                    >
                                      取消
                                    </button>
                                    <span className="text-muted-2">⌘↩ 保存 · Esc 取消</span>
                                    {note && <span className="text-pick">{note}</span>}
                                  </div>
                                </div>
                              ) : (
                                <div key={line.id} className="border-l border-line-2 pl-3">
                                  <div className="flex items-baseline gap-2">
                                    {swapping === line.id ? (
                                      <select
                                        autoFocus
                                        value={line.characterId}
                                        onChange={(event) => {
                                          if (changeSpeaker(line.id, event.target.value)) {
                                            setSwapping(null);
                                          } else {
                                            setNote(useWorkbench.getState().castError);
                                          }
                                        }}
                                        onBlur={() => setSwapping(null)}
                                        aria-label="说话人"
                                        className="rounded-token border border-pick/70 bg-surface px-1 py-0 text-[9.5px] text-text focus:outline-none"
                                      >
                                        {view.characters.map((character) => (
                                          <option key={character.id} value={character.id}>
                                            {character.name}
                                          </option>
                                        ))}
                                      </select>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={readOnly || shot.locked}
                                        onClick={() => {
                                          setSwapping(line.id);
                                          setNote(undefined);
                                        }}
                                        title={
                                          shot.locked
                                            ? "这一镜已锁定，先解锁才能换人"
                                            : "换个说话人"
                                        }
                                        className="tnum shrink-0 text-[9px] tracking-[.12em] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-text disabled:cursor-default"
                                      >
                                        {line.character}
                                      </button>
                                    )}
                                    <span className="tnum text-[9px] tracking-[.12em] text-muted-2">
                                      · {line.dur.toFixed(1)}s
                                    </span>
                                    {!readOnly &&
                                      (deleting === line.id ? (
                                        <span className="flex items-baseline gap-1">
                                          <button
                                            type="button"
                                            onClick={() => remove(line.id)}
                                            className="shrink-0 rounded-token border border-pick/70 px-1.5 py-px text-[9px] text-pick transition-colors duration-[var(--dur)] hover:border-pick"
                                          >
                                            确认删
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => setDeleting(null)}
                                            className="shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                                          >
                                            取消
                                          </button>
                                        </span>
                                      ) : (
                                        <span className="flex items-baseline gap-1">
                                          <button
                                            type="button"
                                            disabled={shot.locked}
                                            onClick={() => startEdit(line.id, line.text)}
                                            title={shot.locked ? "这一镜已锁定，先解锁才能改台词" : "改写这句台词"}
                                            className="shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
                                          >
                                            改
                                          </button>
                                          <button
                                            type="button"
                                            disabled={shot.locked}
                                            onClick={() => {
                                              setDeleting(line.id);
                                              setNote(undefined);
                                            }}
                                            title={shot.locked ? "这一镜已锁定，先解锁才能删台词" : "删掉这句台词"}
                                            className="shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
                                          >
                                            删
                                          </button>
                                          {moving === line.id ? (
                                            <select
                                              autoFocus
                                              value=""
                                              onChange={(event) => {
                                                if (event.target.value) {
                                                  moveLine(line.id, event.target.value);
                                                }
                                              }}
                                              onBlur={() => setMoving(null)}
                                              aria-label="移到哪一镜"
                                              className="rounded-token border border-pick/70 bg-surface px-1 py-0 text-[9px] text-text focus:outline-none"
                                            >
                                              <option value="" disabled>
                                                移到…
                                              </option>
                                              {shotChoices
                                                .filter((choice) => choice.id !== shot.id)
                                                .map((choice) => (
                                                  <option key={choice.id} value={choice.id}>
                                                    {choice.label}
                                                  </option>
                                                ))}
                                            </select>
                                          ) : (
                                            <button
                                              type="button"
                                              disabled={shot.locked}
                                              onClick={() => {
                                                setMoving(line.id);
                                                setNote(undefined);
                                              }}
                                              title={
                                                shot.locked
                                                  ? "这一镜已锁定，先解锁才能挪台词"
                                                  : "把这一句挪到别的镜头"
                                              }
                                              className="shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                              移
                                            </button>
                                          )}
                                          {shot.lines.length > 1 && (
                                            <>
                                              <button
                                                type="button"
                                                disabled={shot.locked || lineIndex === 0}
                                                onClick={() => move(line.id, "up")}
                                                title="往前挪一句"
                                                aria-label="上移台词"
                                                className="shrink-0 rounded-token border border-line px-1 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                                              >
                                                ↑
                                              </button>
                                              <button
                                                type="button"
                                                disabled={shot.locked || lineIndex === shot.lines.length - 1}
                                                onClick={() => move(line.id, "down")}
                                                title="往后挪一句"
                                                aria-label="下移台词"
                                                className="shrink-0 rounded-token border border-line px-1 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                                              >
                                                ↓
                                              </button>
                                            </>
                                          )}
                                        </span>
                                      ))}
                                  </div>
                                  <p className="mt-0.5 text-[12.5px] leading-[1.8] text-text">
                                    {line.text}
                                  </p>
                                  {(() => {
                                    const history = dialogueHistory(events, line.id);
                                    if (history.edits.length === 0 && history.speakers.length === 0) {
                                      return null;
                                    }
                                    const prev = previousDialogueText(history);
                                    return (
                                      <details className="mt-1">
                                        <summary className="tnum cursor-pointer list-none text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-muted [&::-webkit-details-marker]:hidden">
                                          {history.edits.length > 0
                                            ? `改过 ${history.edits.length} 次`
                                            : ""}
                                          {history.speakers.length > 0
                                            ? `${history.edits.length > 0 ? " · " : ""}换过 ${history.speakers.length} 次人`
                                            : ""}
                                          {prev ? ` · 上一版「${prev}」` : ""}
                                        </summary>
                                        <ul className="mt-1 space-y-0.5 text-[9.5px] leading-[1.7]">
                                          {[...history.edits].reverse().map((edit, i) => (
                                            <li key={`${edit.at}-${i}`} className="flex items-baseline gap-2">
                                              <span className="tnum shrink-0 text-muted-2">
                                                {clock(edit.at)}
                                              </span>
                                              <span className="text-muted">{edit.text}</span>
                                              <span className="tnum shrink-0 text-muted-2">
                                                {edit.dur.toFixed(1)}s
                                              </span>
                                              {!readOnly && (
                                                <button
                                                  type="button"
                                                  disabled={shot.locked || edit.text === line.text}
                                                  onClick={() =>
                                                    restore(line.id, edit.text, Math.round(edit.dur * 1000))
                                                  }
                                                  title={shot.locked ? "这一镜已锁定，先解锁才能改台词" : "用回这一版"}
                                                  className="shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                                                >
                                                  用这版
                                                </button>
                                              )}
                                            </li>
                                          ))}
                                          {history.speakers.length > 0 && (
                                            <>
                                              <li className="pt-1 text-[9px] text-muted-2">
                                                换人
                                              </li>
                                              {[...history.speakers].reverse().map((rev, i) => (
                                                <li
                                                  key={`sp-${rev.at}-${i}`}
                                                  className="flex items-baseline gap-2"
                                                >
                                                  <span className="tnum shrink-0 text-muted-2">
                                                    {clock(rev.at)}
                                                  </span>
                                                  <span className="text-muted">
                                                    {nameOf(rev.from)} → {nameOf(rev.to)}
                                                  </span>
                                                  {!readOnly && (
                                                    <button
                                                      type="button"
                                                      disabled={
                                                        shot.locked ||
                                                        rev.from === line.characterId
                                                      }
                                                      onClick={() => revertSpeaker(line.id, rev.from)}
                                                      title={
                                                        shot.locked
                                                          ? "这一镜已锁定，先解锁才能换人"
                                                          : `换回${nameOf(rev.from)}`
                                                      }
                                                      className="shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                                                    >
                                                      换回
                                                    </button>
                                                  )}
                                                </li>
                                              ))}
                                            </>
                                          )}
                                          {history.original && (
                                            <li className="flex items-baseline gap-2">
                                              <span className="shrink-0 text-muted-2">最初</span>
                                              <span className="text-muted-2">{history.original.text}</span>
                                              <span className="tnum shrink-0 text-muted-2">
                                                {history.original.dur.toFixed(1)}s
                                              </span>
                                              {!readOnly && (
                                                <button
                                                  type="button"
                                                  disabled={shot.locked || history.original.text === line.text}
                                                  onClick={() =>
                                                    restore(
                                                      line.id,
                                                      history.original!.text,
                                                      Math.round(history.original!.dur * 1000),
                                                    )
                                                  }
                                                  title={shot.locked ? "这一镜已锁定，先解锁才能改台词" : "用回最初这一版"}
                                                  className="shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                                                >
                                                  用这版
                                                </button>
                                              )}
                                            </li>
                                          )}
                                        </ul>
                                        {note && !editing && (
                                          <p className="mt-1 text-[9.5px] text-pick">{note}</p>
                                        )}
                                      </details>
                                    );
                                  })()}
                                </div>
                              ),
                            )}
                          </div>
                        )}

                        {(() => {
                          const revisions = dialogueOrderHistory(events, shot.id);
                          if (revisions.length === 0) return null;
                          const textOf = (id: string) => {
                            const line = shot.lines.find((item) => item.id === id);
                            if (!line) return "（已删）";
                            return line.text.length > 12 ? `${line.text.slice(0, 12)}…` : line.text;
                          };
                          const sameAsNow = (ids: string[]) =>
                            ids.length === shot.lines.length &&
                            ids.every((id, i) => id === shot.lines[i]?.id);
                          return (
                            <details className="mt-1">
                              <summary className="tnum cursor-pointer list-none text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-muted [&::-webkit-details-marker]:hidden">
                                这一镜的顺序改过 {revisions.length} 次
                              </summary>
                              <ul className="mt-1 space-y-0.5 text-[9.5px] leading-[1.7]">
                                {[...revisions].reverse().map((rev, i) => (
                                  <li
                                    key={`ord-${rev.at}-${i}`}
                                    className="flex items-baseline gap-2"
                                  >
                                    <span className="tnum shrink-0 text-muted-2">
                                      {clock(rev.at)}
                                    </span>
                                    <span className="text-muted">
                                      {rev.lineIds.map(textOf).join(" / ")}
                                    </span>
                                    {!readOnly && (
                                      <button
                                        type="button"
                                        disabled={shot.locked || sameAsNow(rev.lineIds)}
                                        onClick={() => restoreOrder(shot.id, rev.lineIds)}
                                        title={
                                          shot.locked
                                            ? "这一镜已锁定，先解锁才能调顺序"
                                            : "用回这一版的顺序"
                                        }
                                        className="shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                                      >
                                        用这版
                                      </button>
                                    )}
                                  </li>
                                ))}
                              </ul>
                              {note && <p className="mt-1 text-[9.5px] text-pick">{note}</p>}
                            </details>
                          );
                        })()}

                        {(() => {
                          const gone = removedLines(events, shot.id);
                          if (gone.length === 0) return null;
                          const live = new Set(project.dialogue.map((line) => line.id));
                          return (
                            <details className="mt-1">
                              <summary className="tnum cursor-pointer list-none text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-muted [&::-webkit-details-marker]:hidden">
                                删过 {gone.length} 句
                              </summary>
                              <ul className="mt-1 space-y-0.5 text-[9.5px] leading-[1.7]">
                                {[...gone].reverse().map((rec, i) => (
                                  <li
                                    key={`gone-${rec.lineId}-${rec.at}-${i}`}
                                    className="flex items-baseline gap-2"
                                  >
                                    <span className="tnum shrink-0 text-muted-2">
                                      {clock(rec.at)}
                                    </span>
                                    <span className="text-muted line-through decoration-muted-2/60">
                                      {rec.text.length > 18 ? `${rec.text.slice(0, 18)}…` : rec.text}
                                    </span>
                                    {!readOnly && (
                                      <button
                                        type="button"
                                        disabled={shot.locked || live.has(rec.lineId)}
                                        onClick={() => restoreRemoved(rec.lineId)}
                                        title={
                                          live.has(rec.lineId)
                                            ? "这一句已经恢复了"
                                            : shot.locked
                                              ? "这一镜已锁定，先解锁才能恢复"
                                              : "把这一句放回这一镜的队尾"
                                        }
                                        className="shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                                      >
                                        恢复
                                      </button>
                                    )}
                                  </li>
                                ))}
                              </ul>
                              {note && <p className="mt-1 text-[9.5px] text-pick">{note}</p>}
                            </details>
                          );
                        })()}

                        {!readOnly &&
                          (adding === shot.id ? (
                            <div className="mt-2 border-l border-pick/70 pl-3">
                              <div className="flex items-center gap-2">
                                <select
                                  value={addSpeaker}
                                  onChange={(event) => setAddSpeaker(event.target.value)}
                                  aria-label="说话人"
                                  className="rounded-token border border-line-2 bg-surface px-1.5 py-0.5 text-[10px] text-text focus:border-pick focus:outline-none"
                                >
                                  {view.characters.map((character) => (
                                    <option key={character.id} value={character.id}>
                                      {character.name}
                                    </option>
                                  ))}
                                </select>
                                <span className="text-[9px] tracking-[.12em] text-muted-2">
                                  加一句台词
                                </span>
                              </div>
                              <textarea
                                autoFocus
                                value={addText}
                                rows={2}
                                onChange={(event) => setAddText(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                    saveAdd(shot.id);
                                  }
                                  if (event.key === "Escape") setAdding(null);
                                }}
                                placeholder="写一句台词"
                                className="mt-1 w-full resize-none rounded-token border border-line-2 bg-surface px-2 py-1.5 text-[12.5px] leading-[1.8] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
                              />
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-[9.5px]">
                                <button
                                  type="button"
                                  onClick={() => saveAdd(shot.id)}
                                  className="rounded-token border border-line-2 px-2 py-0.5 text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                                >
                                  保存
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setAdding(null)}
                                  className="rounded-token border border-line px-2 py-0.5 text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                                >
                                  取消
                                </button>
                                <span className="text-muted-2">时长按 0.3 秒 / 字估，镜头跟着加</span>
                                {note && <span className="text-pick">{note}</span>}
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => startAdd(shot.id, shot.characterIds)}
                              disabled={shot.locked}
                              title={shot.locked ? "这一镜已锁定，先解锁才能加台词" : "给这一镜加一句台词"}
                              className="mt-2 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              + 加一句
                            </button>
                          ))}

                        <p className="tnum mt-2 text-[8.5px] text-muted-2">
                          {shot.size} · {shot.angle} · {shot.dur.toFixed(1)}s
                          {shot.locked && <span className="ml-2 text-muted-2">· 已锁定</span>}
                        </p>

                        {/* 这一镜里换人（ADR-0070）：点名字选换上的人，他这一镜的台词一起换 */}
                        {shot.characterIds.length > 0 && (
                          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                            <span className="tnum shrink-0 text-[9px] tracking-[.14em] text-muted-2">
                              出场
                            </span>
                            {shot.characterIds.map((id) => {
                              const name = nameOf(id);
                              const replacing =
                                swappingCast?.shotId === shot.id && swappingCast.characterId === id;
                              return replacing ? (
                                <select
                                  key={id}
                                  autoFocus
                                  value=""
                                  aria-label={`把${name}换成`}
                                  onChange={(event) => {
                                    const toId = event.target.value;
                                    if (!toId) return;
                                    if (swapShotCharacter(shot.id, id, toId)) {
                                      setSwappingCast(null);
                                      setCastNote(null);
                                    } else {
                                      setCastNote({
                                        id: shot.id,
                                        text: useWorkbench.getState().castError ?? "换不了这一镜的人。",
                                      });
                                    }
                                  }}
                                  onBlur={() => setSwappingCast(null)}
                                  className="rounded-token border border-pick/70 bg-surface px-1 py-0 text-[9px] text-text focus:outline-none"
                                >
                                  <option value="">换下 {name} →</option>
                                  {view.characters
                                    .filter((character) => character.id !== id)
                                    .map((character) => (
                                      <option key={character.id} value={character.id}>
                                        {character.name}
                                        {shot.characterIds.includes(character.id)
                                          ? "（已在这一镜）"
                                          : ""}
                                      </option>
                                    ))}
                                </select>
                              ) : (
                                <button
                                  key={id}
                                  type="button"
                                  disabled={readOnly || shot.locked}
                                  onClick={() => {
                                    setSwappingCast({ shotId: shot.id, characterId: id });
                                    setCastNote(null);
                                  }}
                                  title={
                                    shot.locked
                                      ? "这一镜已锁定，先解锁才能换人"
                                      : `把${name}换成别人：这一镜里他说的台词一起换`
                                  }
                                  className="rounded-token border border-line px-1.5 py-px text-[9px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-default disabled:opacity-50"
                                >
                                  {name}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {castNote?.id === shot.id && (
                          <p className="mt-1 text-[9.5px] leading-[1.7] text-pick">{castNote.text}</p>
                        )}

                        {/* 删一镜（ADR-0067）：台词、take、时间线项一起走；两步确认 */}
                        {!readOnly &&
                          (deletingShot === shot.id ? (
                            <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[9px]">
                              <span className="text-muted-2">删这一镜，台词与 take 一起删</span>
                              <button
                                type="button"
                                onClick={() => {
                                  const ok = removeShot(shot.id);
                                  setDeleteNote(
                                    ok ? null : { id: shot.id, text: useWorkbench.getState().castError ?? "删不掉这一镜。" },
                                  );
                                  if (ok) setDeletingShot(null);
                                }}
                                className="rounded-token border border-pick/70 px-1.5 py-px text-pick transition-colors duration-[var(--dur)] hover:bg-pick hover:text-bg"
                              >
                                确认删
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeletingShot(null)}
                                className="rounded-token border border-line px-1.5 py-px text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                              >
                                取消
                              </button>
                            </span>
                          ) : (
                            <span className="mt-1.5 flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={shot.locked}
                                onClick={() => {
                                  setDeletingShot(shot.id);
                                  setDeleteNote(null);
                                }}
                                title={
                                  shot.locked ? "这一镜已锁定，先解锁才能删" : "删掉这一镜"
                                }
                                className="tnum rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-pick enabled:hover:text-pick disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                删这一镜
                              </button>
                              {/* 在这一镜后面插一镜（ADR-0068） */}
                              <button
                                type="button"
                                onClick={() => {
                                  const id = addShot(scene.id, shot.id);
                                  setNote(!id ? useWorkbench.getState().castError : undefined);
                                }}
                                title="在这一镜后面插一镜：动作留空，景别中景、平视、3 秒"
                                className="tnum rounded-token border border-dashed border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                              >
                                ＋ 插一镜
                              </button>
                            </span>
                          ))}
                        {deleteNote?.id === shot.id && (
                          <p className="mt-1 text-[9.5px] leading-[1.7] text-pick">{deleteNote.text}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>

                {!readOnly && (
                  <span className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const id = addShot(scene.id);
                        setNote(!id ? useWorkbench.getState().castError : undefined);
                      }}
                      title="给这一场加一镜：动作留空，景别中景、平视、3 秒，随后都能改"
                      className="rounded-token border border-dashed border-line px-2 py-1 text-[9.5px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                    >
                      ＋ 加一镜
                    </button>
                    {/* 在这一场后面插一场（ADR-0068） */}
                    <button
                      type="button"
                      onClick={() => {
                        const id = addScene(undefined, scene.id);
                        setNote(!id ? useWorkbench.getState().castError : undefined);
                      }}
                      title="在这一场后面插一场空场：地点、内外景与日夜沿用这一场，场头随时能改"
                      className="rounded-token border border-dashed border-line px-2 py-1 text-[9.5px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                    >
                      ＋ 插一场
                    </button>
                  </span>
                )}
              </section>
            ))}

            {view.scenes.length === 0 && (
              <p className="rounded-token border border-dashed border-line px-3 py-6 text-center text-[10.5px] leading-[1.8] text-muted-2">
                还没有场次。下面加一场，从场头与第一镜开始写。
              </p>
            )}

            {!readOnly && (
              <button
                type="button"
                onClick={() => {
                  const id = addScene();
                  setNote(!id ? useWorkbench.getState().castError : undefined);
                }}
                title="在最后新加一场：地点、内外景与日夜沿用最后一场，场头随时能改"
                className="block w-full rounded-token border border-dashed border-line px-3 py-3 text-[10.5px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
              >
                ＋ 加一场
              </button>
            )}
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
