"use client";

import { useEffect, useMemo, useState } from "react";
import type { Project, StagingMark } from "@loomina/ir";
import { analyzeSceneSpace, type SceneStateEntry } from "@/lib/scene-space";
import { cn } from "@/lib/utils";

const SIDE_CN: Record<StagingMark["side"], string> = {
  left: "左",
  center: "中",
  right: "右",
};

const DEPTH_CN: Record<StagingMark["depth"], string> = {
  foreground: "前",
  midground: "中",
  background: "后",
};

/** 朝向角 → 八方位；只在有坐标时显示 */
function facingText(rad: number | null): string {
  if (rad === null) return "—";
  const deg = ((rad * 180) / Math.PI + 360) % 360;
  const points = ["朝前", "朝右前", "朝右", "朝右后", "朝后", "朝左后", "朝左", "朝左前"];
  return points[Math.round(deg / 45) % 8]!;
}

export type SceneSpacePanelProps = {
  project: Project;
  currentShotId: string;
  onSelect: (shotId: string) => void;
  /** 去走位抽屉调坐标；不给就只列 */
  onBlocking?: (shotId: string) => void;
  onClose: () => void;
};

/**
 * 场景空间板 / 走位台账（B11）。
 *
 * 一张跨镜对照表：每一镜一列，每个出场人物一行——画面左中右、前后景、
 * 朝向、道具。旁边列出相邻镜之间翻面、跳景、转身与道具丢失。
 *
 * 台账是 `Shot.staging` / `Shot.blocking` / `Shot.propIds` 的投影，不另存一份：
 * 改完分镜这里立刻是新的，不会出现两份说法。
 */
export function SceneSpacePanel({
  project,
  currentShotId,
  onSelect,
  onBlocking,
  onClose,
}: SceneSpacePanelProps) {
  const report = useMemo(() => analyzeSceneSpace(project), [project]);
  const currentScene = project.shots.find((shot) => shot.id === currentShotId)?.sceneId;
  const [sceneId, setSceneId] = useState(
    report.scenes.find((row) => row.sceneId === currentScene)?.sceneId ??
      report.scenes[0]?.sceneId ??
      "",
  );
  const row = report.scenes.find((item) => item.sceneId === sceneId) ?? report.scenes[0];

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 表里的人物：这一场所有镜头出场过的人，按首次出场顺序
  const characters = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of row?.entries ?? []) {
      for (const item of entry.characters) {
        if (!seen.has(item.characterId)) seen.set(item.characterId, item.name);
      }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [row]);

  const props = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of row?.entries ?? []) {
      for (const item of entry.props) {
        if (!seen.has(item.propId)) seen.set(item.propId, item.name);
      }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [row]);

  const cellOf = (entry: SceneStateEntry, characterId: string) => {
    const item = entry.characters.find((person) => person.characterId === characterId);
    if (!item) return null;
    return item;
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="场景空间板"
        className="flex h-full w-[520px] max-w-[96vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">场景空间板</h2>
            <span className="tnum text-[9px] text-muted-2">
              {report.summary.scenes} 场 · {report.summary.checkedPairs} 对相邻镜判过
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
          <label className="flex flex-col gap-1 text-[9px] text-muted-2">
            场次
            <select
              value={row?.sceneId ?? ""}
              onChange={(event) => setSceneId(event.target.value)}
              className="rounded-token border border-line bg-bg px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
            >
              {report.scenes.map((item) => (
                <option key={item.sceneId} value={item.sceneId} className="bg-surface">
                  {item.label} · {item.locationName} · {item.entries.length} 镜
                  {item.hasSpace ? "" : "（无几何）"}
                </option>
              ))}
            </select>
          </label>

          {!row ? (
            <p className="mt-3 text-[10px] leading-[1.7] text-muted-2">还没有场次。</p>
          ) : (
            <>
              {/* 跨镜对照表：镜号横排，人物与道具竖排 */}
              <div className="mt-3 overflow-x-auto border border-line">
                <table className="w-full border-collapse text-[9px]">
                  <thead>
                    <tr>
                      <th className="sticky left-0 z-10 bg-bg px-1.5 py-1 text-left font-normal text-muted-2">
                        人物 / 道具
                      </th>
                      {row.entries.map((entry) => (
                        <th key={entry.shotId} className="px-1.5 py-1 font-normal">
                          <button
                            type="button"
                            onClick={() => onSelect(entry.shotId)}
                            className={cn(
                              "tnum transition-colors duration-[var(--dur)] hover:text-text",
                              entry.shotId === currentShotId ? "text-text" : "text-muted",
                            )}
                          >
                            {entry.label}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {characters.map((character) => (
                      <tr key={character.id} className="border-t border-line">
                        <th className="sticky left-0 z-10 bg-bg px-1.5 py-1 text-left font-normal text-muted">
                          {character.name}
                        </th>
                        {row.entries.map((entry) => {
                          const cell = cellOf(entry, character.id);
                          return (
                            <td key={entry.shotId} className="px-1.5 py-1 text-center">
                              {!cell ? (
                                <span className="text-muted-2/50">·</span>
                              ) : (
                                <span className="inline-flex flex-col items-center gap-0.5">
                                  <span
                                    className={cn(
                                      "tnum",
                                      cell.side || cell.depth ? "text-text" : "text-muted-2",
                                    )}
                                  >
                                    {cell.side ? SIDE_CN[cell.side] : "—"}
                                    {cell.depth ? DEPTH_CN[cell.depth] : ""}
                                  </span>
                                  <span className="text-[8px] text-muted-2">
                                    {facingText(cell.facingRad)}
                                  </span>
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {props.map((prop) => (
                      <tr key={prop.id} className="border-t border-line">
                        <th className="sticky left-0 z-10 bg-bg px-1.5 py-1 text-left font-normal text-muted">
                          {prop.name}
                        </th>
                        {row.entries.map((entry) => (
                          <td key={entry.shotId} className="px-1.5 py-1 text-center">
                            {entry.props.some((item) => item.propId === prop.id) ? (
                              <span className="text-text">有</span>
                            ) : (
                              <span className="text-muted-2/50">·</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {characters.length === 0 && props.length === 0 && (
                      <tr className="border-t border-line">
                        <td
                          colSpan={row.entries.length + 1}
                          className="px-1.5 py-2 text-[9.5px] leading-[1.7] text-muted-2"
                        >
                          这一场没有出场人物与道具：台账里没有可比的走位。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="mt-1.5 text-[8.5px] leading-[1.6] text-muted-2">
                格子里：<span className="text-muted">左 / 中 / 右</span> +
                <span className="text-muted">前 / 中 / 后</span>，下面一行是朝向（有坐标才有）。
                「·」= 这一镜没有这个人物 / 道具。
              </p>

              <section className="mt-4">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-[10.5px] tracking-[.06em] text-text">相邻镜的问题</h3>
                  <span className="tnum text-[9px] text-muted-2">{row.issues.length} 条</span>
                </div>
                {row.issues.length === 0 ? (
                  <p className="mt-1 text-[9.5px] leading-[1.7] text-muted-2">
                    相邻镜之间没有翻面、跳景、转身或道具丢失。
                  </p>
                ) : (
                  <ul className="mt-1 border-t border-line">
                    {row.issues.map((issue, index) => (
                      <li key={`${issue.kind}-${index}`} className="border-b border-line py-2">
                        <p className="text-[9.5px] leading-[1.65] text-muted">{issue.message}</p>
                        <p className="mt-0.5 text-[9px] leading-[1.6] text-muted-2">{issue.fix}</p>
                        <p className="mt-1 flex flex-wrap items-baseline gap-2 text-[9px]">
                          <button
                            type="button"
                            onClick={() => onSelect(issue.shotIds[0])}
                            className="text-muted-2 underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
                          >
                            去前一镜
                          </button>
                          <button
                            type="button"
                            onClick={() => onSelect(issue.shotIds[1])}
                            className="text-muted-2 underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
                          >
                            去后一镜
                          </button>
                          {onBlocking && issue.kind !== "prop" && (
                            <button
                              type="button"
                              onClick={() => onBlocking(issue.shotIds[1])}
                              className="text-muted-2 underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
                            >
                              调这一镜的走位
                            </button>
                          )}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {row.notes.length > 0 && (
                <section className="mt-4">
                  <h3 className="text-[10.5px] tracking-[.06em] text-text">判不了的</h3>
                  <ul className="mt-1 space-y-1 border-t border-line pt-2">
                    {row.notes.map((note) => (
                      <li key={note} className="text-[9px] leading-[1.65] text-muted-2">
                        {note}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}

          <p className="mt-4 border-t border-line pt-3 text-[9px] leading-[1.7] text-muted-2">
            台账是分镜里的站位、走位坐标与道具的投影，不另存一份：改完分镜，这里立刻是新的。
            只判同一场相邻两镜——跨场换位置是正常的。没写左中右或没有坐标的地方判不了，
            不猜。
          </p>
        </div>
      </aside>
    </div>
  );
}
