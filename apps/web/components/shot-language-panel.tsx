"use client";

import { useEffect, useMemo, useState } from "react";
import type { Composition, Lighting, Project } from "@loomina/ir";
import {
  COMPOSITION_TEMPLATES,
  LIGHTING_TEMPLATES,
  SHOT_LANGUAGES,
  SHOT_LANGUAGE_GROUPS,
  MOVE_CN,
  SHOT_ANGLE_CN,
  SHOT_SIZE_CN,
  compileComposition,
  compileLighting,
  matchShotLanguage,
  previousShotOf,
  type CompositionTemplate,
  type LightingTemplate,
  type ShotLanguage,
} from "@loomina/pipeline";
import { shotSheetOf, shotSheetText, shotSheetTsv } from "@/lib/shot-sheet";
import { batchPlanOf, batchText, type BatchPatch } from "@/lib/shot-batch";
import { cn } from "@/lib/utils";

const MOVE_LABEL: Record<ShotLanguage["movement"], string> = {
  static: "固定",
  push: "推近",
  pull: "拉远",
  pan: "横移",
  tilt: "升降",
  handheld: "手持",
};

/** 手调参数用的取值表（I7）：与 IR 枚举一一对应，不另造词 */
const SHOT_SIZES = ["wide", "medium", "close", "extreme-close"] as const;
const ANGLES = ["eye", "low", "high", "top"] as const;
const MOVEMENTS = ["static", "push", "pull", "pan", "tilt", "handheld"] as const;
const FOCAL_STEPS = [14, 24, 35, 50, 85, 135] as const;

export type CameraPatch = {
  shotSize?: Project["shots"][number]["shotSize"];
  angle?: Project["shots"][number]["camera"]["angle"];
  movement?: Project["shots"][number]["camera"]["movement"];
  focalMm?: number;
};

export type ShotLanguagePanelProps = {
  project: Project;
  currentShotId: string;
  readOnly?: boolean;
  onSelectShot: (shotId: string) => void;
  /** 套一套说法：写一条 `shot.updated`；返回是否真的写了 */
  onApply: (shotId: string, languageId: string) => boolean;
  /** 手调一项摄影参数（I7）：同样一条 `shot.updated` */
  onCamera: (shotId: string, patch: CameraPatch) => boolean;
  /** 写这一镜的光影模板（I2）；`undefined` 清空 */
  onLighting: (shotId: string, lighting: Lighting | undefined) => boolean;
  /** 写这一镜的构图模板（I4）；`undefined` 清空 */
  onComposition: (shotId: string, composition: Composition | undefined) => boolean;
  /** 接上一段（C.6）：`tailMs` 毫秒；`null` 表示硬接 */
  onContinuation: (shotId: string, tailMs: number | null) => boolean;
  /** 按场批量套用（I7 第三档）：返回写了几条事件 */
  onBatch?: (sceneId: string, patch: BatchPatch) => number;
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
  onCamera,
  onLighting,
  onComposition,
  onContinuation,
  onBatch,
  onClose,
}: ShotLanguagePanelProps) {
  const [flash, setFlash] = useState("");
  /** 摄影单（I7 第二档）：全片逐镜参数总表，默认收起 */
  const [sheetOpen, setSheetOpen] = useState(false);
  /** 批量套用（I7 第三档）：正在改哪一场、选了哪项、草稿值 */
  const [batchScene, setBatchScene] = useState<string>();
  const [batchField, setBatchField] = useState<"shotSize" | "angle" | "movement" | "focalMm">("shotSize");
  const [batchValue, setBatchValue] = useState("");
  /** 自定义焦段的输入草稿：回车 / 失焦才写，边打字边写会把 1 写成 1mm */
  const [focalDraft, setFocalDraft] = useState("");
  const shot = project.shots.find((item) => item.id === currentShotId);
  const matched = useMemo(() => (shot ? matchShotLanguage(shot) : undefined), [shot]);
  const shotNo = shot
    ? project.shots.filter((item) => item.sceneId === shot.sceneId).findIndex((item) => item.id === shot.id) +
      1
    : 0;
  const locked = readOnly || shot?.locked === true;
  const lightingLine = compileLighting(shot?.lighting);
  const compositionLine = compileComposition(shot?.composition);
  const previous = shot ? previousShotOf(project, shot.id) : undefined;
  const previousNo = previous
    ? project.shots.filter((item) => item.sceneId === previous.sceneId).findIndex((item) => item.id === previous.id) + 1
    : 0;
  const tailMs = shot?.continuation?.tailMs ?? null;
  const sheet = useMemo(() => shotSheetOf(project), [project]);

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

  /** 手调一项：写一条 `shot.updated`，并把「改了什么」写在一处 */
  const applyCamera = (patch: CameraPatch, label: string) => {
    if (!shot) return;
    const ok = onCamera(shot.id, patch);
    setFlash(
      ok ? `改好了：${label}。` : locked ? "这一镜已锁定或页面只读，先解锁再改。" : "没有变化。",
    );
  };

  const commitFocal = () => {
    const value = Number(focalDraft.trim());
    if (!Number.isFinite(value) || focalDraft.trim() === "") return;
    applyCamera({ focalMm: value }, `焦段 ${Math.round(value)}mm`);
    setFocalDraft("");
  };

  const applyContinuation = (seconds: number) => {
    if (!shot) return;
    const ok = onContinuation(shot.id, seconds * 1000);
    setFlash(
      ok
        ? `接上一段：开头先重复上一段最后 ${seconds} 秒。`
        : locked
          ? "这一镜已锁定或页面只读，先解锁再改。"
          : "没有变化。",
    );
  };

  const clearContinuation = () => {
    if (!shot) return;
    const ok = onContinuation(shot.id, null);
    setFlash(ok ? "改成硬接：下一段直接从新动作开始。" : locked ? "这一镜已锁定或页面只读。" : "本来就是硬接。");
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

          {/* 摄影单（I7 第二档）：全片逐镜参数总表 */}
          <section className="mt-3 border border-line px-3 py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <button
                type="button"
                onClick={() => setSheetOpen((open) => !open)}
                className="text-[10px] tracking-[.06em] text-text underline decoration-line-2 underline-offset-2"
              >
                摄影单 {sheetOpen ? "收起" : "展开"}
              </button>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(shotSheetTsv(sheet));
                  setFlash("摄影单已复制（TSV）。");
                }}
                className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
              >
                复制表格
              </button>
            </div>
            <p className="tnum mt-1 text-[9px] leading-[1.65] text-muted-2">
              {shotSheetText(sheet)}
            </p>
            {sheetOpen && (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full border-collapse text-[9px]">
                  <thead>
                    <tr className="border-b border-line text-muted-2">
                      <th className="py-1 pr-2 text-left font-normal">镜</th>
                      <th className="py-1 pr-2 text-left font-normal">景别</th>
                      <th className="py-1 pr-2 text-left font-normal">机位</th>
                      <th className="py-1 pr-2 text-left font-normal">运镜</th>
                      <th className="py-1 pr-2 text-right font-normal">焦段</th>
                      <th className="py-1 pr-2 text-left font-normal">光影</th>
                      <th className="py-1 text-left font-normal">构图</th>
                    </tr>
                  </thead>
                  {sheet.groups.map((group) => (
                    <tbody key={group.sceneId}>
                      <tr>
                        <td colSpan={7} className="pt-2 text-[8.5px] text-muted-2">
                          <span className="flex flex-wrap items-baseline justify-between gap-2">
                            <span>
                              {group.label} · {group.locationName}
                            </span>
                            {onBatch && group.sceneId !== "orphan" && (
                              <button
                                type="button"
                                onClick={() => {
                                  setBatchScene(batchScene === group.sceneId ? undefined : group.sceneId);
                                  setBatchValue("");
                                }}
                                className="text-[8.5px] text-muted-2 underline decoration-line-2 underline-offset-2 hover:text-text"
                              >
                                {batchScene === group.sceneId ? "收起" : "整场改"}
                              </button>
                            )}
                          </span>
                        </td>
                      </tr>
                      {batchScene === group.sceneId && onBatch && (
                        <tr>
                          <td colSpan={7} className="pb-1.5">
                            <BatchRow
                              project={project}
                              sceneId={group.sceneId}
                              field={batchField}
                              value={batchValue}
                              readOnly={readOnly}
                              onField={setBatchField}
                              onValue={setBatchValue}
                              onApply={(patch) => {
                                const written = onBatch(group.sceneId, patch);
                                setFlash(
                                  written > 0 ? `整场改好了：写了 ${written} 条。` : "没有改动。",
                                );
                                setBatchScene(undefined);
                              }}
                            />
                          </td>
                        </tr>
                      )}
                      {group.rows.map((row) => (
                        <tr
                          key={row.shotId}
                          className={cn(
                            "border-b border-line/60",
                            row.shotId === currentShotId && "text-text",
                          )}
                        >
                          <td className="py-1 pr-2">
                            <button
                              type="button"
                              onClick={() => onSelectShot(row.shotId)}
                              className="tnum text-muted-2 underline decoration-line-2 underline-offset-2 hover:text-text"
                            >
                              {String(row.no).padStart(2, "0")}
                            </button>
                          </td>
                          <td className="py-1 pr-2 text-muted">{row.shotSize}</td>
                          <td className="py-1 pr-2 text-muted">{row.angle}</td>
                          <td className="py-1 pr-2 text-muted">{row.movement}</td>
                          <td className="tnum py-1 pr-2 text-right text-muted">{row.focalMm}</td>
                          <td className="py-1 pr-2 text-muted-2">{row.lighting ?? "—"}</td>
                          <td className="py-1 text-muted-2">{row.composition ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
                </table>
                <p className="mt-1.5 text-[8.5px] leading-[1.6] text-muted-2">
                  「—」= 这一镜没写。「复制表格」粘进 Excel / 飞书都是分好的列。
                </p>
              </div>
            )}
          </section>

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

          <section className="mt-3 border border-line px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">手调参数</h3>
              <span className="text-[8.5px] text-muted-2">改一项就写一条镜头改动</span>
            </div>

            <div className="mt-2 flex flex-col gap-2">
              <div>
                <p className="text-[8.5px] tracking-[.06em] text-muted-2">景别</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {SHOT_SIZES.map((size) => {
                    const active = shot?.shotSize === size;
                    return (
                      <button
                        key={size}
                        type="button"
                        disabled={locked || !shot}
                        aria-pressed={active}
                        onClick={() => applyCamera({ shotSize: size }, `景别改成「${SHOT_SIZE_CN[size]}」`)}
                        className={cn(
                          "rounded-token border px-1.5 py-0.5 text-[9.5px] transition-colors duration-[var(--dur)] disabled:opacity-40",
                          active ? "border-pick text-text" : "border-line text-muted-2 hover:border-line-2 hover:text-text",
                        )}
                      >
                        {SHOT_SIZE_CN[size]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="text-[8.5px] tracking-[.06em] text-muted-2">机位</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {ANGLES.map((angle) => {
                    const active = shot?.camera.angle === angle;
                    return (
                      <button
                        key={angle}
                        type="button"
                        disabled={locked || !shot}
                        aria-pressed={active}
                        onClick={() => applyCamera({ angle }, `机位改成「${SHOT_ANGLE_CN[angle]}」`)}
                        className={cn(
                          "rounded-token border px-1.5 py-0.5 text-[9.5px] transition-colors duration-[var(--dur)] disabled:opacity-40",
                          active ? "border-pick text-text" : "border-line text-muted-2 hover:border-line-2 hover:text-text",
                        )}
                      >
                        {SHOT_ANGLE_CN[angle]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="text-[8.5px] tracking-[.06em] text-muted-2">运镜</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {MOVEMENTS.map((movement) => {
                    const active = shot?.camera.movement === movement;
                    return (
                      <button
                        key={movement}
                        type="button"
                        disabled={locked || !shot}
                        aria-pressed={active}
                        onClick={() => applyCamera({ movement }, `运镜改成「${MOVE_LABEL[movement]}」`)}
                        className={cn(
                          "rounded-token border px-1.5 py-0.5 text-[9.5px] transition-colors duration-[var(--dur)] disabled:opacity-40",
                          active ? "border-pick text-text" : "border-line text-muted-2 hover:border-line-2 hover:text-text",
                        )}
                      >
                        {MOVE_LABEL[movement]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="text-[8.5px] tracking-[.06em] text-muted-2">焦段</p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {FOCAL_STEPS.map((mm) => {
                    const active = shot?.camera.focalMm === mm;
                    return (
                      <button
                        key={mm}
                        type="button"
                        disabled={locked || !shot}
                        aria-pressed={active}
                        onClick={() => applyCamera({ focalMm: mm }, `焦段改成 ${mm}mm`)}
                        className={cn(
                          "tnum rounded-token border px-1.5 py-0.5 text-[9.5px] transition-colors duration-[var(--dur)] disabled:opacity-40",
                          active ? "border-pick text-text" : "border-line text-muted-2 hover:border-line-2 hover:text-text",
                        )}
                      >
                        {mm}
                      </button>
                    );
                  })}
                  <input
                    type="number"
                    value={focalDraft}
                    min={8}
                    max={300}
                    step={1}
                    disabled={locked || !shot}
                    aria-label="自定义焦段（毫米）"
                    placeholder="自定义"
                    onChange={(event) => setFocalDraft(event.target.value)}
                    onBlur={commitFocal}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitFocal();
                      }
                    }}
                    className="tnum w-[64px] rounded-token border border-line-2 bg-surface px-1.5 py-0.5 text-[9.5px] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none disabled:opacity-40"
                  />
                  <span className="text-[8.5px] text-muted-2">mm（8–300）</span>
                </div>
              </div>
            </div>
            <p className="mt-2 text-[9px] leading-[1.6] text-muted-2">
              说法是整组换，这里是一项一项改：想保留「夜景街头」的机位，只把焦段拉长，用这一块。
            </p>
          </section>

                    <section className="mt-3 border border-line px-3 py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">接上一段</h3>
              <span className="tnum text-[8.5px] text-muted-2">
                {previous ? `上一段：第 ${previousNo} 镜` : "开头那一镜"}
              </span>
            </div>
            <p className="mt-1 text-[9px] leading-[1.7] text-muted-2">
              分镜切段出片时，本段开头先重复上一段最后几秒的动作，再进入本段剧情。
              比用收尾帧硬接更容易接上声音与动作。
            </p>
            {previous ? (
              <>
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {[1, 2, 3, 4, 5].map((seconds) => (
                    <button
                      key={seconds}
                      type="button"
                      disabled={locked}
                      onClick={() => applyContinuation(seconds)}
                      aria-pressed={tailMs === seconds * 1000}
                      className={cn(
                        "rounded-token border px-1.5 py-px text-[9px] transition-colors duration-[var(--dur)] disabled:opacity-40",
                        tailMs === seconds * 1000
                          ? "border-pick/60 text-pick"
                          : "border-line text-muted-2 enabled:hover:border-line-2 enabled:hover:text-text",
                      )}
                    >
                      {seconds} 秒
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={locked || tailMs === null}
                    onClick={clearContinuation}
                    className="rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
                  >
                    改成硬接
                  </button>
                </div>
                <p className="mt-1.5 text-[9px] leading-[1.6] text-muted-2">
                  {tailMs !== null
                    ? `开头先重复上一段最后 ${Math.round(tailMs / 100) / 10} 秒（视频提示词会写上这一句）。`
                    : "现在是硬切：本段直接从新动作开始。"}
                  {previous.description
                    ? ` 上一段：${previous.description.slice(0, 60)}`
                    : ""}
                </p>
              </>
            ) : (
              <p className="mt-1.5 text-[9px] leading-[1.6] text-muted-2">
                这一镜排在开头，没有上一段可接；先把后面几镜排进时间线，再回到这里。
              </p>
            )}
          </section>

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

/**
 * 按场批量套用的一行（I7 第三档）。
 *
 * 只给一项参数：批量改多项等于「整场重设」，那不是这个入口想干的事。
 * 选完先算计划、把「会改几镜、跳过几镜」摊给作者看，再点确认。
 */
function BatchRow({
  project,
  sceneId,
  field,
  value,
  readOnly,
  onField,
  onValue,
  onApply,
}: {
  project: Project;
  sceneId: string;
  field: "shotSize" | "angle" | "movement" | "focalMm";
  value: string;
  readOnly: boolean;
  onField: (field: "shotSize" | "angle" | "movement" | "focalMm") => void;
  onValue: (value: string) => void;
  onApply: (patch: BatchPatch) => void;
}) {
  const patch: BatchPatch =
    field === "focalMm"
      ? Number.isFinite(Number(value)) && value !== ""
        ? { focalMm: Number(value) }
        : {}
      : value !== ""
        ? ({ [field]: value } as BatchPatch)
        : {};
  const plan = Object.keys(patch).length > 0 ? batchPlanOf(project, sceneId, patch) : undefined;
  const error = plan && "error" in plan ? plan.error : undefined;
  const ready = plan && "changes" in plan ? plan : undefined;
  const canApply = !readOnly && ready !== undefined && ready.changes.length > 0;

  return (
    <div className="rounded-token border border-line px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[9px]">
        <select
          value={field}
          onChange={(event) => {
            onField(event.target.value as typeof field);
            onValue("");
          }}
          className="rounded-token border border-line bg-transparent px-1 py-0.5 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
        >
          <option value="shotSize" className="bg-surface">景别</option>
          <option value="angle" className="bg-surface">机位</option>
          <option value="movement" className="bg-surface">运镜</option>
          <option value="focalMm" className="bg-surface">焦段</option>
        </select>
        {field === "shotSize" && (
          <select
            value={value}
            onChange={(event) => onValue(event.target.value)}
            className="rounded-token border border-line bg-transparent px-1 py-0.5 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
          >
            <option value="" className="bg-surface">选一项</option>
            {(["wide", "medium", "close", "extreme-close"] as const).map((size) => (
              <option key={size} value={size} className="bg-surface">
                {SHOT_SIZE_CN[size]}
              </option>
            ))}
          </select>
        )}
        {field === "angle" && (
          <select
            value={value}
            onChange={(event) => onValue(event.target.value)}
            className="rounded-token border border-line bg-transparent px-1 py-0.5 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
          >
            <option value="" className="bg-surface">选一项</option>
            {(["eye", "low", "high", "top"] as const).map((angle) => (
              <option key={angle} value={angle} className="bg-surface">
                {SHOT_ANGLE_CN[angle]}
              </option>
            ))}
          </select>
        )}
        {field === "movement" && (
          <select
            value={value}
            onChange={(event) => onValue(event.target.value)}
            className="rounded-token border border-line bg-transparent px-1 py-0.5 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
          >
            <option value="" className="bg-surface">选一项</option>
            {(["static", "push", "pull", "pan", "tilt", "handheld"] as const).map((move) => (
              <option key={move} value={move} className="bg-surface">
                {MOVE_CN[move]}
              </option>
            ))}
          </select>
        )}
        {field === "focalMm" && (
          <input
            type="number"
            min={8}
            max={300}
            value={value}
            placeholder="8–300"
            onChange={(event) => onValue(event.target.value)}
            className="tnum w-[64px] rounded-token border border-line bg-transparent px-1 py-0.5 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
          />
        )}
        <button
          type="button"
          disabled={!canApply}
          onClick={() => onApply(patch)}
          className="rounded-token border border-line-2 px-1.5 py-0.5 text-[9px] text-text transition-colors duration-[var(--dur)] hover:bg-text/10 disabled:opacity-40"
        >
          确认整场改
        </button>
      </div>
      <p className="mt-1 text-[8.5px] leading-[1.6] text-muted-2">
        {error ?? (ready ? batchText(ready) : "选一项参数，这里会说清会改几镜。")}
      </p>
    </div>
  );
}
