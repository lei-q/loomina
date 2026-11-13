"use client";

import { useEffect, useMemo, useState } from "react";
import type { Composition, Lighting, Project } from "@loomina/ir";
import {
  COMPOSITION_TEMPLATES,
  LIGHTING_TEMPLATES,
  SHOT_LANGUAGES,
  SHOT_LANGUAGE_GROUPS,
  SHOT_ANGLE_CN,
  SHOT_SIZE_CN,
  compileComposition,
  compileLighting,
  matchShotLanguage,
  type CompositionTemplate,
  type LightingTemplate,
  type ShotLanguage,
} from "@loomina/pipeline";
import { cn } from "@/lib/utils";

const MOVE_LABEL: Record<ShotLanguage["movement"], string> = {
  static: "固定",
  push: "推近",
  pull: "拉远",
  pan: "横移",
  tilt: "升降",
  handheld: "手持",
};

export type ShotLanguagePanelProps = {
  project: Project;
  currentShotId: string;
  readOnly?: boolean;
  onSelectShot: (shotId: string) => void;
  /** 套一套说法：写一条 `shot.updated`；返回是否真的写了 */
  onApply: (shotId: string, languageId: string) => boolean;
  /** 写这一镜的光影模板（I2）；`undefined` 清空 */
  onLighting: (shotId: string, lighting: Lighting | undefined) => boolean;
  /** 写这一镜的构图模板（I4）；`undefined` 清空 */
  onComposition: (shotId: string, composition: Composition | undefined) => boolean;
  onClose: () => void;
};

/**
 * 镜头语言库（I1）。
 *
 * 一镜的摄影意图由景别 / 机位 / 运镜 / 焦段四项组成。分开选要自己在心里拼，
 * 这里收成十四套「说法」——建立、对话、反应、细节、氛围五组。
 * 套一套就是一条 `shot.updated`，写的仍是那四个已有字段；库本身不进 IR。
 */
export function ShotLanguagePanel({
  project,
  currentShotId,
  readOnly = false,
  onSelectShot,
  onApply,
  onLighting,
  onComposition,
  onClose,
}: ShotLanguagePanelProps) {
  const [flash, setFlash] = useState("");
  const shot = project.shots.find((item) => item.id === currentShotId);
  const matched = useMemo(() => (shot ? matchShotLanguage(shot) : undefined), [shot]);
  const shotNo = shot
    ? project.shots.filter((item) => item.sceneId === shot.sceneId).findIndex((item) => item.id === shot.id) +
      1
    : 0;
  const locked = readOnly || shot?.locked === true;
  const lightingLine = compileLighting(shot?.lighting);
  const compositionLine = compileComposition(shot?.composition);

  const applyLighting = (template: LightingTemplate) => {
    if (!shot) return;
    const ok = onLighting(shot.id, template.value);
    setFlash(ok ? `光改成「${template.name}」。` : locked ? "这一镜已锁定或页面只读。" : "没有变化。");
  };

  const clearLighting = () => {
    if (!shot) return;
    const ok = onLighting(shot.id, undefined);
    setFlash(ok ? "光影已清空：回到场景与风格给的光。" : locked ? "这一镜已锁定或页面只读。" : "本来就没写。");
  };

  const applyComposition = (template: CompositionTemplate) => {
    if (!shot) return;
    const ok = onComposition(shot.id, template.value);
    setFlash(
      ok ? `构图改成「${template.name}」。` : locked ? "这一镜已锁定或页面只读。" : "没有变化。",
    );
  };

  const clearComposition = () => {
    if (!shot) return;
    const ok = onComposition(shot.id, undefined);
    setFlash(ok ? "构图已清空：让模型自己摆。" : locked ? "这一镜已锁定或页面只读。" : "本来就没写。");
  };

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const apply = (language: ShotLanguage) => {
    if (!shot) return;
    const ok = onApply(shot.id, language.id);
    setFlash(
      ok
        ? `这一镜换成「${language.name}」。`
        : locked
          ? "这一镜已锁定或页面只读，先解锁再换。"
          : "没有变化。",
    );
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="镜头语言"
        className="flex h-full w-[440px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">镜头语言</h2>
            <span className="tnum text-[9px] text-muted-2">
              {shot ? `SH-${String(shotNo).padStart(2, "0")}` : "没有选中镜头"}
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
          <p className="text-[9.5px] leading-[1.7] text-muted-2">
            一套说法 = 景别 + 机位 + 运镜 + 焦段。套用会写一条镜头改动，提示词里那行技术参数当场跟着变；
            机位坐标（走位里摆好的位置）保留不动。
          </p>

          {shot && (
            <section className="mt-3 border border-line px-3 py-2.5">
              <p className="text-[8.5px] tracking-[.06em] text-muted-2">现在这一镜</p>
              <p className="tnum mt-1 text-[10.5px] text-text">
                {SHOT_SIZE_CN[shot.shotSize]} · {SHOT_ANGLE_CN[shot.camera.angle]} ·{" "}
                {MOVE_LABEL[shot.camera.movement]} · {shot.camera.focalMm}mm
              </p>
              <p className="mt-1 text-[9.5px] leading-[1.65] text-muted-2">
                {matched ? `正好是「${matched.name}」。` : "不在库里：这是作者自己拼的一组。"}
              </p>
              {lightingLine && (
                <p className="mt-1 break-words text-[9px] leading-[1.6] text-muted-2">
                  提示词：{lightingLine}
                </p>
              )}
              {compositionLine && (
                <p className="mt-0.5 break-words text-[9px] leading-[1.6] text-muted-2">
                  提示词：{compositionLine}
                </p>
              )}
              {flash && <p className="mt-1 text-[9.5px] text-muted">{flash}</p>}
            </section>
          )}

          {SHOT_LANGUAGE_GROUPS.map((group) => (
            <section key={group} className="mt-4">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">{group}</h3>
              <div className="mt-1.5 flex flex-col gap-1.5">
                {SHOT_LANGUAGES.filter((item) => item.group === group).map((item) => {
                  const active = matched?.id === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={locked || !shot}
                      onClick={() => apply(item)}
                      aria-pressed={active}
                      className={cn(
                        "border px-2.5 py-1.5 text-left transition-colors duration-[var(--dur)] disabled:opacity-40",
                        active ? "border-pick bg-pick/10" : "border-line hover:border-line-2",
                      )}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="text-[10.5px] text-text">{item.name}</span>
                        <span className="tnum shrink-0 text-[8.5px] text-muted-2">
                          {SHOT_SIZE_CN[item.shotSize]} · {SHOT_ANGLE_CN[item.angle]} ·{" "}
                          {MOVE_LABEL[item.movement]} · {item.focalMm}mm
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[9px] leading-[1.6] text-muted-2">
                        {item.blurb}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}

          <section className="mt-5 border-t border-line pt-3">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">光从哪来（I2）</h3>
            <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">
              风格管整条片子的光比与色温，这里管这一镜的光源是谁。不选就沿用场景与风格给的光。
            </p>
            <div className="mt-1.5 flex flex-col gap-1">
              {LIGHTING_TEMPLATES.map((item) => {
                const active =
                  shot?.lighting !== undefined &&
                  JSON.stringify(shot.lighting) === JSON.stringify(item.value);
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={locked || !shot}
                    onClick={() => applyLighting(item)}
                    aria-pressed={active}
                    className={cn(
                      "border px-2.5 py-1 text-left transition-colors duration-[var(--dur)] disabled:opacity-40",
                      active ? "border-pick bg-pick/10" : "border-line hover:border-line-2",
                    )}
                  >
                    <span className="text-[10px] text-text">{item.name}</span>
                    <span className="ml-1.5 text-[9px] leading-[1.6] text-muted-2">
                      {item.blurb}
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                disabled={locked || !shot || !shot.lighting}
                onClick={clearLighting}
                className="mt-0.5 self-start text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-text disabled:opacity-40"
              >
                不指定光影
              </button>
            </div>
          </section>

          <section className="mt-4">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">怎么摆（I4）</h3>
            <p className="mt-1 text-[9px] leading-[1.65] text-muted-2">
              主体放在画面的哪里。不选就让模型自己构图。
            </p>
            <div className="mt-1.5 flex flex-col gap-1">
              {COMPOSITION_TEMPLATES.map((item) => {
                const active =
                  shot?.composition !== undefined &&
                  JSON.stringify(shot.composition) === JSON.stringify(item.value);
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={locked || !shot}
                    onClick={() => applyComposition(item)}
                    aria-pressed={active}
                    className={cn(
                      "border px-2.5 py-1 text-left transition-colors duration-[var(--dur)] disabled:opacity-40",
                      active ? "border-pick bg-pick/10" : "border-line hover:border-line-2",
                    )}
                  >
                    <span className="text-[10px] text-text">{item.name}</span>
                    <span className="ml-1.5 text-[9px] leading-[1.6] text-muted-2">
                      {item.blurb}
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                disabled={locked || !shot || !shot.composition}
                onClick={clearComposition}
                className="mt-0.5 self-start text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-text disabled:opacity-40"
              >
                不指定构图
              </button>
            </div>
          </section>

          <section className="mt-5 border-t border-line pt-3">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">其他镜头</h3>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {project.shots.map((item, index) => {
                const current = item.id === currentShotId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setFlash("");
                      onSelectShot(item.id);
                    }}
                    aria-current={current ? "true" : undefined}
                    title={item.description || "（没写动作）"}
                    className={cn(
                      "tnum rounded-token border px-1.5 py-0.5 text-[9px] transition-colors duration-[var(--dur)]",
                      current
                        ? "border-pick text-text"
                        : "border-line text-muted-2 hover:border-line-2 hover:text-text",
                    )}
                  >
                    {String(index + 1).padStart(2, "0")}
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
