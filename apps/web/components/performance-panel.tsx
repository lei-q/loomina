"use client";

import { useEffect, useState } from "react";
import type {
  ActionBeat,
  GazeTarget,
  PerformanceSpec,
  Project,
  Shot,
  StagingMark,
} from "@loomina/ir";
import { describeSceneTemplate, sceneTemplateById } from "@loomina/pipeline";
import { cn } from "@/lib/utils";

const GAZE_TARGET_LABEL: Record<GazeTarget["target"], string> = {
  character: "看一个人",
  prop: "看一件道具",
  camera: "看镜头",
  "off-screen": "看画外",
};

const GAZE_DIRECTION_LABEL: Record<GazeTarget["direction"], string> = {
  left: "向左",
  right: "向右",
  up: "向上",
  down: "向下",
  center: "向前",
};

const SIDE_LABEL: Record<StagingMark["side"], string> = {
  left: "左",
  center: "中",
  right: "右",
};

const DEPTH_LABEL: Record<StagingMark["depth"], string> = {
  foreground: "前景",
  midground: "中景",
  background: "后景",
};

const PHASES: { phase: ActionBeat["phase"]; label: string; task: string }[] = [
  { phase: "before", label: "起", task: "首帧定住的表情与姿态" },
  { phase: "during", label: "转", task: "镜头中段发生的微动作" },
  { phase: "after", label: "落", task: "尾帧落到的表情与姿态" },
];

type BeatDraft = { micro: string; body: string; action: string };
type MarkDraft = { side: StagingMark["side"]; depth: StagingMark["depth"]; note: string };

type Draft = {
  objective: string;
  surface: string;
  subtext: string;
  intensity: number;
  gazeTarget: GazeTarget["target"];
  gazeTargetId: string;
  gazeDirection: GazeTarget["direction"];
  beats: Record<ActionBeat["phase"], BeatDraft>;
  avoid: string;
};

const EMPTY_BEAT: BeatDraft = { micro: "", body: "", action: "" };

function draftOf(performance: PerformanceSpec | undefined): Draft {
  const beats: Draft["beats"] = {
    before: { ...EMPTY_BEAT },
    during: { ...EMPTY_BEAT },
    after: { ...EMPTY_BEAT },
  };
  for (const beat of performance?.beats ?? []) {
    beats[beat.phase] = {
      micro: beat.micro,
      body: beat.body,
      action: beat.action ?? "",
    };
  }
  return {
    objective: performance?.objective ?? "",
    surface: performance?.emotion.surface ?? "",
    subtext: performance?.emotion.subtext ?? "",
    intensity: performance?.intensity ?? 3,
    gazeTarget: performance?.gaze.target ?? "camera",
    gazeTargetId: performance?.gaze.targetId ?? "",
    gazeDirection: performance?.gaze.direction ?? "center",
    beats,
    avoid: performance?.avoid.join("、") ?? "",
  };
}

function marksOf(shot: Shot): Record<string, MarkDraft> {
  const out: Record<string, MarkDraft> = {};
  for (const mark of shot.staging) {
    const key = mark.characterId ? `c:${mark.characterId}` : `p:${mark.propId}`;
    out[key] = { side: mark.side, depth: mark.depth, note: mark.note };
  }
  return out;
}

function splitList(value: string): string[] {
  return value
    .split(/[、,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function fieldClass(disabled: boolean): string {
  return cn(
    "rounded-token border border-line bg-bg px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none",
    disabled && "cursor-not-allowed opacity-45",
  );
}

export type PerformancePanelProps = {
  project: Project;
  shotId: string;
  /** 这一镜的视频提示词：保存后立刻能看到表演与调度写进去了 */
  prompt?: string;
  readOnly?: boolean;
  onSavePerformance: (performance: PerformanceSpec | undefined) => boolean;
  onSaveStaging: (staging: StagingMark[]) => boolean;
  onClose: () => void;
};

/**
 * 表演与调度面板（B16 / B17，ADR-0103）。
 *
 * 左边是表演设计（objective / 情绪 / 起转落 / 视线 / 不要做什么），
 * 右边是这一镜的站位。保存时写 `shot.updated`，底下的视频提示词当场刷新。
 */
export function PerformancePanel({
  project,
  shotId,
  prompt,
  readOnly = false,
  onSavePerformance,
  onSaveStaging,
  onClose,
}: PerformancePanelProps) {
  const shot = project.shots.find((item) => item.id === shotId);
  const [draft, setDraft] = useState<Draft>(() => draftOf(shot?.performance));
  const [marks, setMarks] = useState<Record<string, MarkDraft>>(() => (shot ? marksOf(shot) : {}));
  const [notice, setNotice] = useState("");

  // 换镜时跟上；同一镜保存后保留本地草稿与提示，不清空
  useEffect(() => {
    const current = project.shots.find((item) => item.id === shotId);
    setDraft(draftOf(current?.performance));
    setMarks(current ? marksOf(current) : {});
    setNotice("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!shot) return null;

  const locked = readOnly || shot.locked;
  const scene = project.scenes.find((item) => item.id === shot.sceneId);
  const location = scene
    ? project.locations.find((item) => item.id === scene.locationId)
    : undefined;
  const template = sceneTemplateById(location?.templateId);
  const characters = shot.characterIds.flatMap((id) => {
    const character = project.characters.find((item) => item.id === id);
    return character ? [{ id, name: character.name }] : [];
  });
  const props = shot.propIds.flatMap((id) => {
    const prop = project.props.find((item) => item.id === id);
    return prop ? [{ id, name: prop.name }] : [];
  });
  const gazeOptions =
    draft.gazeTarget === "character"
      ? characters
      : draft.gazeTarget === "prop"
        ? props
        : [];

  const setBeat = (phase: ActionBeat["phase"], patch: Partial<BeatDraft>) =>
    setDraft((current) => ({
      ...current,
      beats: { ...current.beats, [phase]: { ...current.beats[phase], ...patch } },
    }));

  const setMark = (key: string, patch: Partial<MarkDraft>) =>
    setMarks((current) => ({
      ...current,
      [key]: { side: "center", depth: "midground", note: "", ...current[key], ...patch },
    }));

  const save = () => {
    if (locked) return;
    if (!draft.objective.trim()) {
      setNotice("先写一句 objective：这一镜他要什么。");
      return;
    }
    if (
      (draft.gazeTarget === "character" || draft.gazeTarget === "prop") &&
      !draft.gazeTargetId
    ) {
      setNotice(draft.gazeTarget === "character" ? "视线要先选一个人。" : "视线要先选一件道具。");
      return;
    }

    const beats: ActionBeat[] = PHASES.flatMap(({ phase }, index) => {
      const beat = draft.beats[phase];
      if (!beat.micro.trim() && !beat.body.trim() && !beat.action.trim()) return [];
      const span = Math.floor(shot.durationMs / 3);
      return [
        {
          phase,
          micro: beat.micro.trim(),
          body: beat.body.trim(),
          ...(beat.action.trim() ? { action: beat.action.trim() } : {}),
          startMs: span * index,
          endMs: index === 2 ? shot.durationMs : span * (index + 1),
        },
      ];
    });

    const gaze: GazeTarget = {
      target: draft.gazeTarget,
      ...(draft.gazeTarget === "character" || draft.gazeTarget === "prop"
        ? { targetId: draft.gazeTargetId }
        : {}),
      direction: draft.gazeDirection,
    };

    const performance: PerformanceSpec = {
      objective: draft.objective.trim(),
      emotion: { surface: draft.surface.trim(), subtext: draft.subtext.trim() },
      beats,
      gaze,
      intensity: draft.intensity,
      avoid: splitList(draft.avoid),
    };

    const staging: StagingMark[] = [
      ...characters.map((character) => {
        const mark = marks[`c:${character.id}`];
        return {
          characterId: character.id,
          side: mark?.side ?? "center",
          depth: mark?.depth ?? "midground",
          note: mark?.note.trim() ?? "",
        };
      }),
      ...props.map((prop) => {
        const mark = marks[`p:${prop.id}`];
        return {
          propId: prop.id,
          side: mark?.side ?? "center",
          depth: mark?.depth ?? "midground",
          note: mark?.note.trim() ?? "",
        };
      }),
    ];

    const performanceSaved = onSavePerformance(performance);
    const stagingSaved =
      characters.length + props.length > 0 ? onSaveStaging(staging) : false;
    if (performanceSaved || stagingSaved) {
      setNotice(
        performanceSaved && stagingSaved
          ? "已写进项目：表演与调度都更新了，提示词已跟着变。"
          : performanceSaved
            ? "已写进项目：表演更新了；调度没有变，不重复写。"
            : "已写进项目：调度更新了；表演没有变。",
      );
    } else {
      setNotice("和项目里的一样，没有要写的。");
    }
  };

  const clear = () => {
    if (locked) return;
    if (onSavePerformance(undefined)) {
      setDraft(draftOf(undefined));
      setNotice("已清空这一镜的表演设计：提示词回到只写画面与人物。");
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="表演与调度"
        className="flex h-full w-[440px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">表演与调度</h2>
            <span className="tnum text-[9px] text-muted-2">
              {shot.id} · {(shot.durationMs / 1000).toFixed(1)}s
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-token border border-line px-2 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            关闭
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <section>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">这一镜的场景</h3>
              <span className="text-[9px] text-muted-2">{location?.name ?? "未挂地点"}</span>
            </div>
            {template ? (
              <p className="mt-1 rounded-token border border-line px-2 py-1.5 text-[9px] leading-[1.6] text-muted-2">
                {describeSceneTemplate(template)}
              </p>
            ) : (
              <p className="mt-1 text-[9px] leading-[1.6] text-muted-2">
                这个地点还没有场景模板：去定妆台给它选一个，提示词才会带上空间、主光与锚点。
              </p>
            )}
          </section>

          <section className="mt-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">表演设计</h3>
              <span className="text-[9px] text-muted-2">
                {shot.performance ? "已写在项目里" : "还没写"}
              </span>
            </div>

            <div className="mt-2 grid grid-cols-1 gap-2">
              <label className="flex flex-col gap-1 text-[9px] text-muted-2">
                objective（只能一个）
                <input
                  type="text"
                  value={draft.objective}
                  disabled={locked}
                  onChange={(event) => setDraft({ ...draft, objective: event.target.value })}
                  placeholder="这一镜他要什么：让她相信自己"
                  aria-label="表演目的"
                  className={fieldClass(locked)}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[9px] text-muted-2">
                  表面情绪
                  <input
                    type="text"
                    value={draft.surface}
                    disabled={locked}
                    onChange={(event) => setDraft({ ...draft, surface: event.target.value })}
                    placeholder="克制、微笑"
                    aria-label="表面情绪"
                    className={fieldClass(locked)}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[9px] text-muted-2">
                  潜台词
                  <input
                    type="text"
                    value={draft.subtext}
                    disabled={locked}
                    onChange={(event) => setDraft({ ...draft, subtext: event.target.value })}
                    placeholder="其实在试探"
                    aria-label="潜台词"
                    className={fieldClass(locked)}
                  />
                </label>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <label className="flex flex-col gap-1 text-[9px] text-muted-2">
                  视线
                  <select
                    value={draft.gazeTarget}
                    disabled={locked}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        gazeTarget: event.target.value as GazeTarget["target"],
                        gazeTargetId: "",
                      })
                    }
                    aria-label="视线对象"
                    className={fieldClass(locked)}
                  >
                    {Object.entries(GAZE_TARGET_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[9px] text-muted-2">
                  {draft.gazeTarget === "character"
                    ? "看谁"
                    : draft.gazeTarget === "prop"
                      ? "看哪件"
                      : "对象"}
                  <select
                    value={draft.gazeTargetId}
                    disabled={locked || gazeOptions.length === 0}
                    onChange={(event) => setDraft({ ...draft, gazeTargetId: event.target.value })}
                    aria-label="视线目标"
                    className={fieldClass(locked || gazeOptions.length === 0)}
                  >
                    {gazeOptions.length === 0 ? (
                      <option value="">—</option>
                    ) : (
                      gazeOptions.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[9px] text-muted-2">
                  方向
                  <select
                    value={draft.gazeDirection}
                    disabled={locked}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        gazeDirection: event.target.value as GazeTarget["direction"],
                      })
                    }
                    aria-label="视线方向"
                    className={fieldClass(locked)}
                  >
                    {Object.entries(GAZE_DIRECTION_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="flex flex-col gap-1 text-[9px] text-muted-2">
                表演强度（3 是默认，提示词里不写）
                <select
                  value={draft.intensity}
                  disabled={locked}
                  onChange={(event) =>
                    setDraft({ ...draft, intensity: Number.parseInt(event.target.value, 10) })
                  }
                  aria-label="表演强度"
                  className={fieldClass(locked)}
                >
                  {[1, 2, 3, 4, 5].map((value) => (
                    <option key={value} value={value}>
                      {value} / 5
                    </option>
                  ))}
                </select>
              </label>

              <div className="mt-1 border-t border-line pt-2">
                <p className="text-[9px] text-muted-2">
                  起转落：起对首帧、落对尾帧；三行都空就不进提示词。
                </p>
                {PHASES.map(({ phase, label, task }) => (
                  <div key={phase} className="mt-1.5 grid grid-cols-[18px_1fr] gap-1.5">
                    <span className="pt-1 text-[10px] text-text">{label}</span>
                    <div className="grid grid-cols-1 gap-1">
                      <input
                        type="text"
                        value={draft.beats[phase].micro}
                        disabled={locked}
                        onChange={(event) => setBeat(phase, { micro: event.target.value })}
                        placeholder={`微表情：${task}`}
                        aria-label={`${label} · 微表情`}
                        className={fieldClass(locked)}
                      />
                      <input
                        type="text"
                        value={draft.beats[phase].body}
                        disabled={locked}
                        onChange={(event) => setBeat(phase, { body: event.target.value })}
                        placeholder="姿态 / 手：手指收紧、身体前倾"
                        aria-label={`${label} · 姿态`}
                        className={fieldClass(locked)}
                      />
                    </div>
                  </div>
                ))}
              </div>

              <label className="flex flex-col gap-1 text-[9px] text-muted-2">
                不要做什么（顿号分隔）
                <input
                  type="text"
                  value={draft.avoid}
                  disabled={locked}
                  onChange={(event) => setDraft({ ...draft, avoid: event.target.value })}
                  placeholder="不要笑得太开、不要抬手"
                  aria-label="表演避讳"
                  className={fieldClass(locked)}
                />
              </label>
            </div>
          </section>

          <section className="mt-5 border-t border-line pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">镜头内调度</h3>
              <span className="text-[9px] text-muted-2">左右 × 前后就是关系</span>
            </div>
            {characters.length + props.length === 0 ? (
              <p className="mt-1.5 text-[9px] leading-[1.6] text-muted-2">
                这一镜还没有点名出场的人或道具：先回分镜页把人和道具点出来，再来排站位。
              </p>
            ) : (
              <ul className="mt-2 grid grid-cols-1 gap-2">
                {[
                  ...characters.map((item) => ({ key: `c:${item.id}`, name: item.name })),
                  ...props.map((item) => ({ key: `p:${item.id}`, name: `${item.name}（道具）` })),
                ].map((item) => {
                  const mark = marks[item.key];
                  return (
                    <li key={item.key} className="grid grid-cols-[1fr_auto_auto] items-center gap-1.5">
                      <span className="truncate text-[10px] text-text">{item.name}</span>
                      <select
                        value={mark?.side ?? "center"}
                        disabled={locked}
                        onChange={(event) =>
                          setMark(item.key, { side: event.target.value as StagingMark["side"] })
                        }
                        aria-label={`${item.name} 的左右位置`}
                        className={fieldClass(locked)}
                      >
                        {Object.entries(SIDE_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <select
                        value={mark?.depth ?? "midground"}
                        disabled={locked}
                        onChange={(event) =>
                          setMark(item.key, {
                            depth: event.target.value as StagingMark["depth"],
                          })
                        }
                        aria-label={`${item.name} 的前后纵深`}
                        className={fieldClass(locked)}
                      >
                        {Object.entries(DEPTH_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={mark?.note ?? ""}
                        disabled={locked}
                        onChange={(event) => setMark(item.key, { note: event.target.value })}
                        placeholder="补一句：背对门、手里攥着杯子（选填）"
                        aria-label={`${item.name} 的调度说明`}
                        className={cn(fieldClass(locked), "col-span-3")}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="mt-5 border-t border-line pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={save}
                disabled={locked}
                className="rounded-token border border-line-2 px-2.5 py-1 text-[10.5px] text-text transition-colors duration-[var(--dur)] enabled:hover:border-pick enabled:hover:text-pick disabled:cursor-not-allowed disabled:opacity-45"
              >
                保存到这一镜
              </button>
              {shot.performance && (
                <button
                  type="button"
                  onClick={clear}
                  disabled={locked}
                  className="rounded-token border border-line px-2 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-pick enabled:hover:text-pick disabled:cursor-not-allowed disabled:opacity-45"
                >
                  清空表演设计
                </button>
              )}
              {locked && (
                <span className="text-[9px] text-muted-2">
                  {readOnly ? "另一个标签页在编辑：这一页只读。" : "这一镜已锁定：先解锁再改。"}
                </span>
              )}
            </div>
            {notice && <p className="mt-1.5 text-[9px] leading-[1.6] text-pick">{notice}</p>}
          </section>

          <section className="mt-4">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">保存后的视频提示词</h3>
            <p className="mt-1 whitespace-pre-wrap rounded-token border border-line px-2 py-1.5 text-[9px] leading-[1.7] text-muted-2">
              {prompt ?? "这一镜还没有提示词。"}
            </p>
          </section>
        </div>
      </aside>
    </div>
  );
}
