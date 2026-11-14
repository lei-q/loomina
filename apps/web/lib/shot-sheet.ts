/**
 * 摄影单（I7 第二档）：全片逐镜的摄影参数总表。
 *
 * 分镜页一次只看一镜；作者想知道「整条片子的景别是不是太单一」
 * 「哪几镜忘了写光影」「焦段有没有跳」，得从头翻一遍。摄影单把
 * 景别 / 机位 / 运镜 / 焦段 / 光影 / 构图摊成一张表，按场分组。
 *
 * 纯派生：读 `Project`，不写 IR、不改事件。表里每一行都能点回那一镜，
 * 但点只是选中，改参数仍然走镜头语言抽屉里那套一次一项的入口。
 */

import type { Project, Shot } from "@loomina/ir";
import { SHOT_ANGLE_CN, SHOT_SIZE_CN, MOVE_CN } from "@loomina/pipeline";

export type ShotSheetRow = {
  shotId: string;
  sceneId: string;
  sceneLabel: string;
  /** 场内镜号，从 1 开始 */
  no: number;
  /** 全片镜号，从 1 开始 */
  overall: number;
  durationMs: number;
  shotSize: string;
  angle: string;
  movement: string;
  focalMm: number;
  /** 光影：没写就是 null */
  lighting: string | null;
  /** 构图：没写就是 null */
  composition: string | null;
  locked: boolean;
};

export type ShotSheetGroup = {
  sceneId: string;
  label: string;
  locationName: string;
  rows: ShotSheetRow[];
};

export type ShotSheetSummary = {
  shots: number;
  /** 各景别的镜数，按 SHOT_SIZE 顺序 */
  bySize: { key: string; label: string; count: number }[];
  /** 各机位档位的镜数 */
  byAngle: { key: string; label: string; count: number }[];
  /** 用到的焦段（去重、升序） */
  focals: number[];
  /** 没写光影 / 构图的镜数 */
  withoutLighting: number;
  withoutComposition: number;
  /** 整片平均镜长（秒） */
  averageSeconds: number;
};

export type ShotSheet = {
  groups: ShotSheetGroup[];
  summary: ShotSheetSummary;
};

const SIZE_ORDER: Shot["shotSize"][] = ["wide", "medium", "close", "extreme-close"];
const ANGLE_ORDER: Shot["camera"]["angle"][] = ["eye", "low", "high"];

const LIGHTING_POSITION_CN: Record<NonNullable<Shot["lighting"]>["position"], string> = {
  front: "正面",
  side: "侧面",
  back: "逆光",
  top: "顶光",
  under: "底光",
};

const COMPOSITION_CN: Record<NonNullable<Shot["composition"]>["rule"], string> = {
  thirds: "三分",
  centered: "居中",
  leading: "引导线",
  frame: "框式",
  diagonal: "对角",
  negative: "留白",
};

/** 一张摄影单：按场分组，场内按镜序 */
export function shotSheetOf(project: Project): ShotSheet {
  const byId = new Map(project.shots.map((shot) => [shot.id, shot]));
  const groups: ShotSheetGroup[] = [];
  const seen = new Set<string>();
  let overall = 0;

  for (const scene of [...project.scenes].sort((a, b) => a.index - b.index)) {
    const rows: ShotSheetRow[] = [];
    scene.shotIds.forEach((shotId, index) => {
      const shot = byId.get(shotId);
      if (!shot) return;
      seen.add(shot.id);
      overall += 1;
      rows.push({
        shotId: shot.id,
        sceneId: scene.id,
        sceneLabel: scene.code ? `第 ${scene.code} 场` : `第 ${scene.index + 1} 场`,
        no: index + 1,
        overall,
        durationMs: shot.durationMs,
        shotSize: SHOT_SIZE_CN[shot.shotSize],
        angle: SHOT_ANGLE_CN[shot.camera.angle],
        movement: MOVE_CN[shot.camera.movement],
        focalMm: shot.camera.focalMm,
        lighting: shot.lighting ? LIGHTING_POSITION_CN[shot.lighting.position] : null,
        composition: shot.composition ? COMPOSITION_CN[shot.composition.rule] : null,
        locked: shot.locked === true,
      });
    });
    if (rows.length === 0) continue;
    const location = project.locations.find((item) => item.id === scene.locationId);
    groups.push({
      sceneId: scene.id,
      label: scene.code ? `第 ${scene.code} 场` : `第 ${scene.index + 1} 场`,
      locationName: location?.name ?? "未挂地点",
      rows,
    });
  }

  // 没挂进场次的镜头也要进表：它们是这一场之外的孤儿
  const orphans = project.shots.filter((shot) => !seen.has(shot.id));
  if (orphans.length > 0) {
    groups.push({
      sceneId: "orphan",
      label: "未进场次",
      locationName: "—",
      rows: orphans.map((shot, index) => {
        overall += 1;
        return {
          shotId: shot.id,
          sceneId: "orphan",
          sceneLabel: "未进场次",
          no: index + 1,
          overall,
          durationMs: shot.durationMs,
          shotSize: SHOT_SIZE_CN[shot.shotSize],
          angle: SHOT_ANGLE_CN[shot.camera.angle],
          movement: MOVE_CN[shot.camera.movement],
          focalMm: shot.camera.focalMm,
          lighting: shot.lighting ? LIGHTING_POSITION_CN[shot.lighting.position] : null,
          composition: shot.composition ? COMPOSITION_CN[shot.composition.rule] : null,
          locked: shot.locked === true,
        };
      }),
    });
  }

  const rows = groups.flatMap((group) => group.rows);
  const totalMs = rows.reduce((sum, row) => sum + row.durationMs, 0);
  const countOf = <K extends "shotSize" | "angle">(key: K, value: string) =>
    rows.filter((row) => row[key] === value).length;

  return {
    groups,
    summary: {
      shots: rows.length,
      bySize: SIZE_ORDER.map((size) => ({
        key: size,
        label: SHOT_SIZE_CN[size],
        count: countOf("shotSize", SHOT_SIZE_CN[size]),
      })),
      byAngle: ANGLE_ORDER.map((angle) => ({
        key: angle,
        label: SHOT_ANGLE_CN[angle],
        count: countOf("angle", SHOT_ANGLE_CN[angle]),
      })),
      focals: [...new Set(rows.map((row) => row.focalMm))].sort((a, b) => a - b),
      withoutLighting: rows.filter((row) => !row.lighting).length,
      withoutComposition: rows.filter((row) => !row.composition).length,
      averageSeconds: rows.length === 0 ? 0 : Math.round(totalMs / rows.length / 100) / 10,
    },
  };
}

/**
 * 摄影单的一句话摘要，给面板标题旁边用。
 *
 * 只陈述事实，不评判：说「全景 2 / 中景 6」而不是「景别太单一」——
 * 是不是单一要看片子，工具不该替作者判。
 */
export function shotSheetText(sheet: ShotSheet): string {
  const { summary } = sheet;
  if (summary.shots === 0) return "还没有镜头。";
  const sizes = summary.bySize
    .filter((item) => item.count > 0)
    .map((item) => `${item.label} ${item.count}`)
    .join(" / ");
  const gaps: string[] = [];
  if (summary.withoutLighting > 0) gaps.push(`${summary.withoutLighting} 镜没写光影`);
  if (summary.withoutComposition > 0) gaps.push(`${summary.withoutComposition} 镜没写构图`);
  return `${summary.shots} 镜 · ${sizes} · 平均 ${summary.averageSeconds} 秒${gaps.length > 0 ? ` · ${gaps.join("、")}` : ""}`;
}

/** 把摄影单导成 TSV：给作者粘进表格或留档用 */
export function shotSheetTsv(sheet: ShotSheet): string {
  const header = [
    "场",
    "镜",
    "全片镜号",
    "景别",
    "机位",
    "运镜",
    "焦段(mm)",
    "光影",
    "构图",
    "时长(秒)",
    "锁定",
  ].join("\t");
  const lines = sheet.groups.flatMap((group) =>
    group.rows.map((row) =>
      [
        group.label,
        `SH-${String(row.no).padStart(2, "0")}`,
        row.overall,
        row.shotSize,
        row.angle,
        row.movement,
        row.focalMm,
        row.lighting ?? "—",
        row.composition ?? "—",
        (row.durationMs / 1000).toFixed(1),
        row.locked ? "是" : "",
      ].join("\t"),
    ),
  );
  return [header, ...lines].join("\n");
}
