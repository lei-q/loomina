/**
 * 场景空间板 / 走位台账（B11 / ARCHITECTURE.md §八.3）。
 *
 * 一场戏里「谁在哪、朝哪、拿什么」要跨镜一致：上一镜林晚在窗边，下一镜
 * 突然站到门口，观众立刻出戏。台账把这个对比做成一张表——每一镜一列，
 * 每个出场人物一行，左右 / 前后 / 朝向 / 道具逐镜看下来。
 *
 * **不新增 IR 实体**：位置与朝向本来就在 `Shot.blocking`（米制坐标）与
 * `Shot.staging`（画面左中右 × 前中后景），道具在 `Shot.propIds`。
 * 再存一份 `SceneState` 就是同一件事写两处，迟早对不上——台账是这些字段的
 * **投影**，随改随新，不需要迁移、不需要同步、也不会出现「台账说的和分镜说的不一样」。
 *
 * 三件能判的事：
 * 1. 左右翻面（画面里换边）——跨镜连续性最常见的错；
 * 2. 朝向翻转（坐标版：面向角差超过 120°）；
 * 3. 前后景跳变（前景 → 后景）；
 * 4. 道具在这一镜里出现、下一镜没带。
 *
 * 判不了的（人物在屋里走位但没写坐标、镜头内位置变化）如实写在报告里。
 */

import type { Project, Shot, StagingMark } from "@loomina/ir";

export type SceneStateEntry = {
  shotId: string;
  no: number;
  label: string;
  /** 这一镜有没有走位坐标 */
  hasGeometry: boolean;
  characters: {
    characterId: string;
    name: string;
    /** 画面左中右；没标时为 null */
    side: StagingMark["side"] | null;
    depth: StagingMark["depth"] | null;
    /** 面向角（弧度）；没有坐标时为 null */
    facingRad: number | null;
    note: string;
  }[];
  props: { propId: string; name: string }[];
};

export type SceneSpaceIssue = {
  kind: "side" | "facing" | "depth" | "prop";
  severity: "review" | "fail";
  message: string;
  fix: string;
  /** 相邻两镜 */
  shotIds: [string, string];
  characterId?: string;
};

export type SceneSpaceRow = {
  sceneId: string;
  label: string;
  locationName: string;
  hasSpace: boolean;
  entries: SceneStateEntry[];
  issues: SceneSpaceIssue[];
  /** 这一场判不了什么、为什么 */
  notes: string[];
};

export type SceneSpaceReport = {
  scenes: SceneSpaceRow[];
  summary: {
    scenes: number;
    withGeometry: number;
    /** 相邻镜对里判过左右 / 朝向的 */
    checkedPairs: number;
    issues: number;
  };
};

const SIDE_CN: Record<StagingMark["side"], string> = {
  left: "画面左",
  center: "画面中",
  right: "画面右",
};

const DEPTH_CN: Record<StagingMark["depth"], string> = {
  foreground: "前景",
  midground: "中景",
  background: "后景",
};

const DEPTH_ORDER: Record<StagingMark["depth"], number> = {
  foreground: 0,
  midground: 1,
  background: 2,
};

/** 面向角差超过这个角度就算「转身了」（120°：斜过 45° 的抖动不算） */
const FACING_FLIP_RAD = (120 * Math.PI) / 180;

function shotLabel(no: number): string {
  return `SH-${String(no).padStart(2, "0")}`;
}

/** 面向角之差，折到 0–π */
function facingDelta(a: number, b: number): number {
  const raw = Math.abs(a - b) % (Math.PI * 2);
  return raw > Math.PI ? Math.PI * 2 - raw : raw;
}

function entryOf(
  project: Project,
  shot: Shot,
  no: number,
  markOf: (shot: Shot, characterId: string) => StagingMark | undefined,
): SceneStateEntry {
  return {
    shotId: shot.id,
    no,
    label: shotLabel(no),
    hasGeometry: Boolean(shot.blocking?.actors.length),
    characters: shot.characterIds.flatMap((characterId) => {
      const character = project.characters.find((item) => item.id === characterId);
      if (!character) return [];
      const mark = markOf(shot, characterId);
      const actor = shot.blocking?.actors.find((item) => item.characterId === characterId);
      return [
        {
          characterId,
          name: character.name,
          side: mark?.side ?? null,
          depth: mark?.depth ?? null,
          facingRad: actor?.facingRad ?? null,
          note: mark?.note ?? "",
        },
      ];
    }),
    props: shot.propIds.flatMap((propId) => {
      const prop = project.props.find((item) => item.id === propId);
      return prop ? [{ propId, name: prop.name }] : [];
    }),
  };
}

/**
 * 相邻两镜的连续性。
 *
 * 只判**同一场**里的相邻镜：跨场换位置是正常的。只判两边都写了的东西：
 * 一边没写左中右，就不知道是「没写」还是「换了」。
 */
function issuesBetween(previous: SceneStateEntry, current: SceneStateEntry): SceneSpaceIssue[] {
  const issues: SceneSpaceIssue[] = [];
  const pair: [string, string] = [previous.shotId, current.shotId];

  for (const before of previous.characters) {
    const after = current.characters.find((item) => item.characterId === before.characterId);
    if (!after) continue;

    // 左右翻面：两个人都写在画面里，但换了边
    if (before.side && after.side && before.side !== "center" && after.side !== "center") {
      if (before.side !== after.side) {
        issues.push({
          kind: "side",
          severity: "review",
          message: `${before.name}从${SIDE_CN[before.side]}换到了${SIDE_CN[after.side]}（${previous.label} → ${current.label}）。`,
          fix: "如果是同一条轴线，把其中一镜的调度改回来；真要换边，中间插一个中性镜。",
          shotIds: pair,
          characterId: before.characterId,
        });
      }
    }

    // 前后景跳变：前景直接跳到后景，或者反过来
    if (before.depth && after.depth) {
      const jump = Math.abs(DEPTH_ORDER[before.depth] - DEPTH_ORDER[after.depth]);
      if (jump >= 2) {
        issues.push({
          kind: "depth",
          severity: "review",
          message: `${before.name}从${DEPTH_CN[before.depth]}跳到了${DEPTH_CN[after.depth]}（${previous.label} → ${current.label}）：中间没有过渡。`,
          fix: "补一个中景，或把这一镜的前后关系改回来。",
          shotIds: pair,
          characterId: before.characterId,
        });
      }
    }

    // 朝向翻转：只在两边都有坐标时判
    if (before.facingRad !== null && after.facingRad !== null) {
      const delta = facingDelta(before.facingRad, after.facingRad);
      if (delta > FACING_FLIP_RAD) {
        issues.push({
          kind: "facing",
          severity: "review",
          message: `${before.name}的朝向翻了 ${Math.round((delta * 180) / Math.PI)}°（${previous.label} → ${current.label}）：看起来像转身，但没写转身。`,
          fix: "要么把朝向改回来，要么在走位里补一个中间镜交代转身。",
          shotIds: pair,
          characterId: before.characterId,
        });
      }
    }
  }

  // 道具：上一镜带着、下一镜没带（只提示；道具收起来是常有的事）
  for (const before of previous.props) {
    if (!current.props.some((item) => item.propId === before.propId)) {
      issues.push({
        kind: "prop",
        severity: "review",
        message: `「${before.name}」在 ${previous.label} 出现，${current.label} 里没了。`,
        fix: "如果这一镜还拿着，把道具加进这一镜；确实收起来了就不用管。",
        shotIds: pair,
      });
    }
  }

  return issues;
}

/**
 * 全片走位台账，按场给出。
 *
 * 只读、不写事件：发现的问题靠作者回「走位」或「表演与调度」里改。
 */
export function analyzeSceneSpace(project: Project): SceneSpaceReport {
  const byId = new Map(project.shots.map((shot) => [shot.id, shot]));
  let counter = 0;
  const rows: SceneSpaceRow[] = [];
  const seen = new Set<string>();

  const markOf = (shot: Shot, characterId: string) =>
    shot.staging.find((item) => item.characterId === characterId);

  const sceneRows = [...project.scenes]
    .sort((a, b) => a.index - b.index)
    .map((scene) => {
      const shots = scene.shotIds
        .map((id) => byId.get(id))
        .filter((shot): shot is Shot => Boolean(shot));
      for (const shot of shots) seen.add(shot.id);
      return { scene, shots };
    });
  // 没挂进场次的镜头也要进台账：它们是这一场之外的孤儿
  const orphans = project.shots.filter((shot) => !seen.has(shot.id));
  if (orphans.length > 0) {
    sceneRows.push({
      scene: {
        id: "orphan",
        index: 9999,
        code: "",
        locationId: "",
        space: "int",
        timeOfDay: "day",
        shotIds: [],
      },
      shots: orphans,
    });
  }

  for (const { scene, shots } of sceneRows) {
    const entries = shots.map((shot) => entryOf(project, shot, ++counter, markOf));
    const issues: SceneSpaceIssue[] = [];
    for (let index = 1; index < entries.length; index += 1) {
      issues.push(...issuesBetween(entries[index - 1]!, entries[index]!));
    }
    const location = project.locations.find((item) => item.id === scene.locationId);
    const hasSpace = Boolean(location?.space);
    const notes: string[] = [];
    if (!hasSpace) {
      notes.push("这个地点没有几何坐标：只按「画面左中右」判，朝向与真实距离判不了。");
    }
    if (entries.every((entry) => entry.characters.length === 0)) {
      notes.push("这一场没有出场人物：没有可比的走位。");
    }
    rows.push({
      sceneId: scene.id,
      label: scene.id === "orphan" ? "未进场次" : `第 ${scene.code || scene.index + 1} 场`,
      locationName: location?.name ?? "未挂地点",
      hasSpace,
      entries,
      issues,
      notes,
    });
  }

  let checkedPairs = 0;
  for (const row of rows) {
    for (let index = 1; index < row.entries.length; index += 1) {
      const before = row.entries[index - 1]!;
      const after = row.entries[index]!;
      const shared = before.characters.filter((item) =>
        after.characters.some((other) => other.characterId === item.characterId),
      );
      // 「判过」= 至少一个人两边都写了左中右或朝向
      if (
        shared.some(
          (item) =>
            (item.side && item.side !== "center") ||
            (item.facingRad !== null &&
              after.characters.find((other) => other.characterId === item.characterId)
                ?.facingRad !== null),
        )
      ) {
        checkedPairs += 1;
      }
    }
  }

  return {
    scenes: rows,
    summary: {
      scenes: rows.length,
      withGeometry: rows.filter((row) => row.hasSpace).length,
      checkedPairs,
      issues: rows.reduce((sum, row) => sum + row.issues.length, 0),
    },
  };
}
