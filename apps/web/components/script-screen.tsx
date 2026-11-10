"use client";

import { useEffect, useMemo, useState } from "react";
import { TopBar } from "@/components/top-bar";
import {
  actionHistory,
  dialogueHistory,
  previousActionText,
  previousDialogueText,
  sceneHead,
  scriptToText,
  SPACE_LABEL,
  shotLabel,
  TIME_LABEL,
  toScriptView,
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
  const moveDialogue = useWorkbench((state) => state.moveDialogue);
  const editAction = useWorkbench((state) => state.editAction);
  const editScene = useWorkbench((state) => state.editScene);
  const events = useWorkbench((state) => state.events);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editingAction, setEditingAction] = useState<string | null>(null);
  const [actionDraft, setActionDraft] = useState("");
  const [editingScene, setEditingScene] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [swapping, setSwapping] = useState<string | null>(null);
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
    patch: { space?: "int" | "ext"; timeOfDay?: "day" | "night" | "dawn" | "dusk" },
  ) => {
    if (!editScene(sceneId, patch)) setNote(useWorkbench.getState().castError);
  };

  const saveAction = (shotId: string) => {
    if (editAction(shotId, actionDraft)) {
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

  const revertSpeaker = (lineId: string, characterId: string) => {
    if (changeSpeaker(lineId, characterId)) setNote(undefined);
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
            {view.scenes.map((scene) => (
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
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() => {
                        setEditingScene(scene.id);
                        setNote(undefined);
                      }}
                      title={readOnly ? "只读标签页不能改场头" : "改内 / 外景与日夜"}
                      className="tnum shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-default disabled:opacity-60"
                    >
                      {sceneHead(scene)}
                    </button>
                  )}
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
