import type { Project } from "./schema";

/**
 * 不变量：产品规则的可执行形式。
 * 每条都必须有正向（通过）与反向（篡改必失败）测试。
 */
export type InvariantCode =
  | "REF_DIALOGUE_CHARACTER"
  | "REF_SHOT_CHARACTER"
  | "REF_SCENE"
  | "REF_LOCATION"
  | "SCENE_SHOT_BIDIRECTIONAL"
  | "SHOT_INDEX_CONTIGUOUS"
  | "SHOT_DURATION_VS_DIALOGUE"
  | "TIMELINE_TAKE_OWNERSHIP"
  | "TIMELINE_OVERLAP"
  | "PUBLISH_AI_LABEL";

export interface Violation {
  code: InvariantCode;
  path: string;
  message: string;
}

export interface ValidateOptions {
  /** 每句台词前后的表演余量（毫秒）。默认 500。 */
  dialoguePaddingMs?: number;
  /** 镜头时长与“对白总时长 + 余量”的允许偏差比例。默认 0.25。 */
  dialogueToleranceRatio?: number;
}

const DEFAULT_PADDING_MS = 500;
const DEFAULT_TOLERANCE_RATIO = 0.25;

export function validateProject(
  project: Project,
  options: ValidateOptions = {},
): Violation[] {
  const violations: Violation[] = [];
  const padding = options.dialoguePaddingMs ?? DEFAULT_PADDING_MS;
  const tolerance =
    options.dialogueToleranceRatio ?? DEFAULT_TOLERANCE_RATIO;

  const characterIds = new Set(project.characters.map((c) => c.id));
  const locationIds = new Set(project.locations.map((l) => l.id));
  const sceneById = new Map(project.scenes.map((s) => [s.id, s]));
  const shotById = new Map(project.shots.map((s) => [s.id, s]));
  const dialogueById = new Map(project.dialogue.map((d) => [d.id, d]));
  const takeById = new Map(project.takes.map((t) => [t.id, t]));

  // 1. 台词角色必须存在
  for (const line of project.dialogue) {
    if (!characterIds.has(line.characterId)) {
      violations.push({
        code: "REF_DIALOGUE_CHARACTER",
        path: `dialogue.${line.id}.characterId`,
        message: `台词 ${line.id} 引用了不存在的角色 ${line.characterId}`,
      });
    }
  }

  // 2. 镜头角色必须存在
  for (const shot of project.shots) {
    for (const characterId of shot.characterIds) {
      if (!characterIds.has(characterId)) {
        violations.push({
          code: "REF_SHOT_CHARACTER",
          path: `shots.${shot.id}.characterIds`,
          message: `镜头 ${shot.id} 引用了不存在的角色 ${characterId}`,
        });
      }
    }
  }

  // 3. 镜头所属场景必须存在
  for (const shot of project.shots) {
    if (!sceneById.has(shot.sceneId)) {
      violations.push({
        code: "REF_SCENE",
        path: `shots.${shot.id}.sceneId`,
        message: `镜头 ${shot.id} 引用了不存在的场景 ${shot.sceneId}`,
      });
    }
  }

  // 4. 场景地点必须存在
  for (const scene of project.scenes) {
    if (!locationIds.has(scene.locationId)) {
      violations.push({
        code: "REF_LOCATION",
        path: `scenes.${scene.id}.locationId`,
        message: `场景 ${scene.id} 引用了不存在的地点 ${scene.locationId}`,
      });
    }
  }

  // 5. 场景与镜头的归属必须双向一致
  for (const scene of project.scenes) {
    for (const shotId of scene.shotIds) {
      const shot = shotById.get(shotId);
      if (!shot || shot.sceneId !== scene.id) {
        violations.push({
          code: "SCENE_SHOT_BIDIRECTIONAL",
          path: `scenes.${scene.id}.shotIds`,
          message: `场景 ${scene.id} 的 shotIds 包含 ${shotId}，但其 sceneId 不一致`,
        });
      }
    }
  }
  for (const shot of project.shots) {
    const scene = sceneById.get(shot.sceneId);
    if (scene && !scene.shotIds.includes(shot.id)) {
      violations.push({
        code: "SCENE_SHOT_BIDIRECTIONAL",
        path: `shots.${shot.id}.sceneId`,
        message: `镜头 ${shot.id} 属于场景 ${scene.id}，但该场景的 shotIds 未包含它`,
      });
    }
  }

  // 6. 同场景内镜头 index 唯一且从 0 连续
  for (const scene of project.scenes) {
    const indices = project.shots
      .filter((s) => s.sceneId === scene.id)
      .map((s) => s.index)
      .sort((a, b) => a - b);
    indices.forEach((value, position) => {
      if (value !== position) {
        violations.push({
          code: "SHOT_INDEX_CONTIGUOUS",
          path: `scenes.${scene.id}`,
          message: `场景 ${scene.id} 的镜头序号应为 0..${indices.length - 1}，实际为 ${indices.join(",")}`,
        });
      }
    });
  }

  // 7. 镜头时长必须与对白音频时长一致（含表演余量）
  for (const shot of project.shots) {
    if (shot.dialogueIds.length === 0) continue;
    let dialogueMs = 0;
    let missing = false;
    for (const dialogueId of shot.dialogueIds) {
      const line = dialogueById.get(dialogueId);
      if (!line) {
        missing = true;
        violations.push({
          code: "SHOT_DURATION_VS_DIALOGUE",
          path: `shots.${shot.id}.dialogueIds`,
          message: `镜头 ${shot.id} 引用了不存在的台词 ${dialogueId}`,
        });
        continue;
      }
      dialogueMs += line.durationMs;
    }
    if (missing) continue;
    const expected = dialogueMs + padding;
    const allowed = Math.max(padding, expected * tolerance);
    if (Math.abs(shot.durationMs - expected) > allowed) {
      violations.push({
        code: "SHOT_DURATION_VS_DIALOGUE",
        path: `shots.${shot.id}.durationMs`,
        message: `镜头 ${shot.id} 时长 ${shot.durationMs}ms 与对白 ${dialogueMs}ms + 余量 ${padding}ms 不一致`,
      });
    }
  }

  // 8. 时间线引用的 take 必须存在且属于该镜头
  for (const item of project.timeline.items) {
    const take = takeById.get(item.takeId);
    if (!take || take.shotId !== item.shotId) {
      violations.push({
        code: "TIMELINE_TAKE_OWNERSHIP",
        path: `timeline.${item.id}.takeId`,
        message: `时间线项 ${item.id} 的 take ${item.takeId} 不存在或不属于镜头 ${item.shotId}`,
      });
    }
  }

  // 9. 时间线片段不得重叠
  const ordered = [...project.timeline.items].sort(
    (a, b) => a.startMs - b.startMs,
  );
  let previousEnd = -1;
  let previousId = "";
  for (const item of ordered) {
    if (item.startMs < previousEnd) {
      violations.push({
        code: "TIMELINE_OVERLAP",
        path: `timeline.${item.id}`,
        message: `时间线项 ${item.id} 与 ${previousId} 重叠`,
      });
    }
    const end = item.startMs + item.durationMs;
    if (end > previousEnd) {
      previousEnd = end;
      previousId = item.id;
    }
  }

  // 10. 发布包必须携带完整 AI 标识
  for (const pack of project.publishPackages) {
    if (!pack.aiLabel || !pack.aiLabel.explicit || !pack.aiLabel.implicit) {
      violations.push({
        code: "PUBLISH_AI_LABEL",
        path: `publishPackages.${pack.id}.aiLabel`,
        message: `发布包 ${pack.id} 缺少显式/隐式 AI 标识`,
      });
    }
  }

  return violations;
}

export function assertValidProject(
  project: Project,
  options: ValidateOptions = {},
): void {
  const violations = validateProject(project, options);
  if (violations.length > 0) {
    const detail = violations
      .map((v) => `- [${v.code}] ${v.path}: ${v.message}`)
      .join("\n");
    throw new Error(`Project 违反 ${violations.length} 条不变量：\n${detail}`);
  }
}
