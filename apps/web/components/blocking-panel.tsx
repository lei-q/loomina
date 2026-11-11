"use client";

import { useEffect, useMemo, useState } from "react";
import type { Blocking, CameraPlacement, Project, Shot, Vec3 } from "@loomina/ir";
import { blockingOf, checkAxis, hasGeometry, suggestBlocking } from "@loomina/pipeline";
import { BlockingBoard, type BoardActor, type BoardCamera } from "@/components/blocking-board";
import { cn } from "@/lib/utils";

function shotLabel(no: number): string {
  return `SH-${String(no).padStart(2, "0")}`;
}

export type BlockingPanelProps = {
  project: Project;
  currentShotId: string;
  readOnly?: boolean;
  onSelect: (shotId: string) => void;
  /** 写一条 `shot.updated { blocking, camera.placement }` */
  onApply: (shotId: string, blocking: Blocking, placement?: CameraPlacement) => boolean;
  onClose: () => void;
};

type SceneRow = {
  id: string;
  label: string;
  locationName: string;
  shots: Shot[];
  hasSpace: boolean;
};

/**
 * 走位抽屉（B13.1 / ADR-0126 §5）。
 *
 * 按场列出俯视走位图：房间外框、锚点、人物与朝向、轴线、机位视锥。
 * 自动摆位**只建议**，点「用这个摆位」才写事件；越轴用真实坐标判，
 * 没有坐标的场次明确说「退回调度近似」。
 */
export function BlockingPanel({
  project,
  currentShotId,
  readOnly = false,
  onSelect,
  onApply,
  onClose,
}: BlockingPanelProps) {
  const scenes = useMemo<SceneRow[]>(() => {
    const byId = new Map(project.shots.map((shot) => [shot.id, shot]));
    return [...project.scenes]
      .sort((a, b) => a.index - b.index)
      .map((scene) => ({
        id: scene.id,
        label: `第 ${scene.code || scene.index + 1} 场`,
        locationName:
          project.locations.find((item) => item.id === scene.locationId)?.name ?? "未挂地点",
        shots: scene.shotIds
          .map((id) => byId.get(id))
          .filter((shot): shot is Shot => Boolean(shot)),
        hasSpace: hasGeometry(project, scene.id),
      }));
  }, [project]);

  const currentShot = project.shots.find((shot) => shot.id === currentShotId);
  const [sceneId, setSceneId] = useState(
    currentShot?.sceneId ?? scenes[0]?.id ?? "",
  );
  const [notice, setNotice] = useState("");
  const [showSuggestion, setShowSuggestion] = useState(true);

  useEffect(() => {
    setNotice("");
    setShowSuggestion(true);
    if (currentShot?.sceneId) setSceneId(currentShot.sceneId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentShotId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const scene = scenes.find((item) => item.id === sceneId) ?? scenes[0];
  const location = project.locations.find(
    (item) => item.id === project.scenes.find((item) => item.id === scene?.id)?.locationId,
  );
  const space = location?.space;
  const suggestion = scene && space ? suggestBlocking(project, scene.id) : undefined;
  const refused = suggestion && "reason" in suggestion ? suggestion : undefined;
  const suggested = suggestion && !("reason" in suggestion) ? suggestion : undefined;
  const axis = scene ? checkAxis(project, scene.id) : { violations: [], checked: 0, axis: null };

  const activeShot = scene?.shots.find((shot) => shot.id === currentShotId) ?? scene?.shots[0];

  // 图上画什么：有当前走位就画当前走位，否则画建议
  const currentActors: BoardActor[] = [];
  const actorSource = activeShot?.blocking?.actors;
  if (actorSource) {
    for (const actor of actorSource) {
      const character = project.characters.find((item) => item.id === actor.characterId);
      if (!character) continue;
      currentActors.push({
        characterId: actor.characterId,
        name: character.name,
        position: actor.position,
        facingRad: actor.facingRad,
      });
    }
  }
  const suggestedActors: BoardActor[] = (suggested?.actors ?? []).map((actor) => ({
    characterId: actor.characterId,
    name: project.characters.find((item) => item.id === actor.characterId)?.name ?? "角色",
    position: actor.position,
    facingRad: actor.facingRad,
  }));
  const actors = currentActors.length > 0 ? currentActors : showSuggestion ? suggestedActors : [];

  const cameras: BoardCamera[] = (scene?.shots ?? []).flatMap((shot) =>
    shot.camera.placement
      ? [
          {
            shotId: shot.id,
            label: shotLabel(scene!.shots.indexOf(shot) + 1),
            placement: shot.camera.placement,
            focalMm: shot.camera.focalMm,
          },
        ]
      : [],
  );
  const placements = cameras.length;
  const suggestedCameras: BoardCamera[] =
    showSuggestion && currentActors.length === 0
      ? (suggested?.cameras ?? []).map((camera) => ({
          shotId: camera.shotId,
          label: camera.label,
          placement: camera.placement,
          focalMm: camera.focalMm,
        }))
      : [];

  const apply = () => {
    if (!suggested || readOnly) return;
    let written = 0;
    let failed = 0;
    for (const camera of suggested.cameras) {
      const shot = scene?.shots.find((item) => item.id === camera.shotId);
      if (!shot) continue;
      const blocking = blockingOf(
        suggested.actors.filter((actor) => shot.characterIds.includes(actor.characterId)),
      );
      if (onApply(shot.id, blocking, camera.placement)) written += 1;
      else failed += 1;
    }
    setNotice(
      failed === 0
        ? `已把这一场的摆位与机位写进 ${written} 镜。`
        : `写进 ${written} 镜，${failed} 镜没写成：可能是已锁定或坐标不合法。`,
    );
    setShowSuggestion(false);
  };

  const moveCamera = (shotId: string, position: Vec3) => {
    if (readOnly) return;
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot?.camera.placement) return;
    // 拖机位只改位置：目标点保持原样，视线方向跟着走
    onApply(
      shotId,
      shot.blocking ?? { actors: [], props: [] },
      { position, target: shot.camera.placement.target },
    );
  };

  const moveActor = (characterId: string, position: Vec3) => {
    if (!activeShot || readOnly) return;
    const existing = activeShot.blocking;
    const actorsNext = existing?.actors.some((actor) => actor.characterId === characterId)
      ? existing.actors.map((actor) =>
          actor.characterId === characterId ? { ...actor, position } : actor,
        )
      : [
          ...(existing?.actors ?? []),
          {
            characterId,
            position,
            facingRad: suggestedActors.find((actor) => actor.characterId === characterId)?.facingRad ?? 0,
          },
        ];
    onApply(activeShot.id, { actors: actorsNext, props: existing?.props ?? [] });
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="走位"
        className="flex h-full w-[460px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">走位</h2>
            <span className="tnum text-[9px] text-muted-2">俯视平面 · 不是最终画面</span>
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
              value={scene?.id ?? ""}
              onChange={(event) => setSceneId(event.target.value)}
              className="rounded-token border border-line bg-bg px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
            >
              {scenes.map((row) => (
                <option key={row.id} value={row.id} className="bg-surface">
                  {row.label} · {row.locationName} · {row.shots.length} 镜
                  {row.hasSpace ? "" : "（无几何）"}
                </option>
              ))}
            </select>
          </label>

          {!space ? (
            <p className="mt-3 rounded-token border border-line px-2 py-2 text-[9.5px] leading-[1.7] text-muted-2">
              这个地点还没有几何：先在定妆页给地点选一个场景模板（公寓客厅、卧室、办公室…），
              走位图与越轴检查才有坐标可用。没有坐标时，分镜检查退回「像越轴」的调度近似。
            </p>
          ) : (
            <>
              <div className="mt-3">
                <BlockingBoard
                  space={space}
                  actors={actors}
                  cameras={[...cameras, ...suggestedCameras]}
                  axis={
                    suggested?.axis ??
                    (axis.axis ? { aId: axis.axis.aId, bId: axis.axis.bId } : null)
                  }
                  activeShotId={activeShot?.id}
                  onMoveActor={readOnly || !activeShot ? undefined : moveActor}
                  onMoveCamera={readOnly ? undefined : moveCamera}
                  caption={
                    currentActors.length > 0
                      ? `当前走位 · ${activeShot ? shotLabel(scene!.shots.indexOf(activeShot) + 1) : ""}`
                      : suggestedActors.length > 0
                        ? "自动摆位建议（还没写进项目）"
                        : "俯视走位图"
                  }
                />
              </div>

              <section className="mt-4">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-[10.5px] tracking-[.06em] text-text">自动摆位</h3>
                  <span className="text-[9px] text-muted-2">
                    {suggested ? "只建议，不自动写" : "不可用"}
                  </span>
                </div>
                {refused ? (
                  <p className="mt-1 text-[9.5px] leading-[1.7] text-muted-2">{refused.reason}</p>
                ) : suggested ? (
                  <>
                    <p className="mt-1 text-[9.5px] leading-[1.7] text-muted">
                      {suggested.note}。三个机位默认都在轴线同一侧。
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={apply}
                        disabled={readOnly}
                        className="rounded-token border border-line-2 px-2.5 py-1 text-[10.5px] text-text transition-colors duration-[var(--dur)] enabled:hover:border-pick enabled:hover:text-pick disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        用这个摆位
                      </button>
                      <span className="text-[9px] text-muted-2">
                        {suggested.actors
                          .map(
                            (actor) =>
                              project.characters.find((item) => item.id === actor.characterId)?.name ??
                              actor.characterId,
                          )
                          .join(" · ")}
                      </span>
                    </div>
                    {readOnly && (
                      <p className="mt-1.5 text-[9px] leading-[1.6] text-muted-2">
                        另一个标签页在编辑：这里只读。
                      </p>
                    )}
                  </>
                ) : null}
                {notice && (
                  <p role="status" className="mt-2 text-[9.5px] leading-[1.6] text-pick">
                    {notice}
                  </p>
                )}
              </section>

              <section className="mt-4">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-[10.5px] tracking-[.06em] text-text">轴线</h3>
                  <span className="tnum text-[9px] text-muted-2">
                    {axis.checked > 0 ? `查了 ${axis.checked} 对相邻镜` : "这一场还判不了"}
                  </span>
                </div>
                {axis.violations.length === 0 ? (
                  <p className="mt-1 text-[9.5px] leading-[1.7] text-muted-2">
                    {axis.checked > 0
                      ? "相邻两镜的机位都在轴线同一侧。"
                      : !axis.axis
                        ? "这一场只有一个人（或没人）：轴线要两个人连线，越轴判不了。"
                        : placements === 0
                          ? "机位还没有坐标：用自动摆位写一次，或手动拖机位之后才判得准。"
                          : "相邻两镜里至少一镜还没有机位坐标：补齐之后才判得准。"}
                  </p>
                ) : (
                  <ul className="mt-1 border-t border-line">
                    {axis.violations.map((violation) => {
                      const [first, second] = violation.shotIds as [string, string];
                      const firstNo = scene?.shots.findIndex((shot) => shot.id === first) ?? 0;
                      const secondNo = scene?.shots.findIndex((shot) => shot.id === second) ?? 0;
                      return (
                        <li key={`${first}-${second}`} className="border-b border-line py-2">
                          <p className="text-[9.5px] leading-[1.65] text-muted">
                            {shotLabel(firstNo + 1)} → {shotLabel(secondNo + 1)}：机位跨到了 180°
                            轴线另一侧。
                          </p>
                          <p className="mt-1 flex items-baseline gap-2 text-[9px]">
                            <button
                              type="button"
                              onClick={() => onSelect(first)}
                              className="text-muted-2 underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
                            >
                              去 {shotLabel(firstNo + 1)}
                            </button>
                            <button
                              type="button"
                              onClick={() => onSelect(second)}
                              className="text-muted-2 underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-text"
                            >
                              去 {shotLabel(secondNo + 1)}
                            </button>
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section className="mt-4">
                <h3 className="text-[10.5px] tracking-[.06em] text-text">这一场的机位</h3>
                <ul className="mt-1 border-t border-line">
                  {scene?.shots.map((shot, index) => {
                    const placement = shot.camera.placement;
                    return (
                      <li key={shot.id} className="flex items-baseline justify-between gap-2 border-b border-line py-1.5">
                        <button
                          type="button"
                          onClick={() => onSelect(shot.id)}
                          className={cn(
                            "text-[10px] transition-colors duration-[var(--dur)] hover:text-text",
                            shot.id === activeShot?.id ? "text-text" : "text-muted",
                          )}
                        >
                          {shotLabel(index + 1)}
                          <span className="ml-2 text-[9px] text-muted-2">
                            {shot.shotSize} · {shot.camera.focalMm}mm
                          </span>
                        </button>
                        <span className="tnum text-[9px] text-muted-2">
                          {placement
                            ? `${placement.position.map((value) => value.toFixed(1)).join(" / ")}`
                            : "无坐标"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </>
          )}

          <p className="mt-4 border-t border-line pt-3 text-[9px] leading-[1.7] text-muted-2">
            这是俯视走位图，不是最终画面：它只有房间平面、人物位置与机位方向，没有相机高度、遮挡与光线。
            坐标单位米，原点在房间中心地面；拖动人物只改位置，不改镜头角度。
          </p>
        </div>
      </aside>
    </div>
  );
}
