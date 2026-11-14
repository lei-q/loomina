import type { DialogueLine, Project, ProjectEvent, Scene, Shot } from "@loomina/ir";
import type { WorkspaceProject } from "@/lib/workspace-assets";

/**
 * 跨空间取一场剧本（C1 / ADR-0199）。
 *
 * 剧本 = 场 + 镜 + 台词。跨集复用一场时，结构可以直接搬，但**引用的
 * 地点与演员必须在本空间对得上**（同 id 同名）：指向别人的场次没法拍。
 * 对不上就整场不能取，而不是取半场回来慢慢修。
 *
 * 只取剧本结构：关键帧、take、配音、时间线都不跟——那些是另一个空间的花费与成片。
 */

export type SceneReadiness = {
  /** 地点与出场演员都对得上，才能整场取 */
  ready: boolean;
  /** 对不上的东西（人话）：地点 / 演员 */
  missing: string[];
  /** 道具对不上不拦，只摘掉引用并计数 */
  missingProps: string[];
  shots: number;
  lines: number;
};

export type SharedScene = {
  workspaceId: string;
  workspaceName: string;
  scene: Scene;
  /** 这一场的地点名（来自来源空间） */
  locationName: string;
  /** 摘要：第一镜的动作或第一句台词 */
  brief: string;
  readiness: SceneReadiness;
};

export type SceneImport = {
  events: ProjectEvent[];
  shots: number;
  lines: number;
  missingProps: string[];
  /** 新场的 id */
  sceneId: string;
};

const sameName = (left: { id: string; name: string }, right: { id: string; name: string }) =>
  left.id === right.id && left.name.trim() === right.name.trim();

function shotsOf(source: Project, scene: Scene): Shot[] {
  return scene.shotIds
    .map((id) => source.shots.find((shot) => shot.id === id))
    .filter((shot): shot is Shot => Boolean(shot));
}

function linesOf(source: Project, shot: Shot): DialogueLine[] {
  return shot.dialogueIds
    .map((id) => source.dialogue.find((line) => line.id === id))
    .filter((line): line is DialogueLine => Boolean(line));
}

/** 这一场能不能整场取过来：地点与所有出场演员都要在本空间同名同 id */
export function sceneReadiness(source: Project, current: Project, scene: Scene): SceneReadiness {
  const missing: string[] = [];
  const location = source.locations.find((item) => item.id === scene.locationId);
  const currentLocation = location
    ? current.locations.find((item) => sameName(item, location))
    : undefined;
  if (!currentLocation) missing.push(`地点「${location?.name ?? scene.locationId}」`);

  const shots = shotsOf(source, scene);
  const characterIds = new Set<string>();
  for (const shot of shots) {
    for (const id of shot.characterIds) characterIds.add(id);
    for (const line of linesOf(source, shot)) characterIds.add(line.characterId);
  }
  for (const id of characterIds) {
    const character = source.characters.find((item) => item.id === id);
    const present = character
      ? current.characters.some((item) => sameName(item, character))
      : false;
    if (!present) missing.push(`演员「${character?.name ?? id}」`);
  }

  const missingProps: string[] = [];
  const propIds = new Set(shots.flatMap((shot) => shot.propIds));
  for (const id of propIds) {
    const prop = source.props.find((item) => item.id === id);
    const present = prop ? current.props.some((item) => sameName(item, prop)) : false;
    if (!present) missingProps.push(prop?.name ?? id);
  }

  const lines = shots.reduce((sum, shot) => sum + linesOf(source, shot).length, 0);
  return { ready: missing.length === 0, missing, missingProps, shots: shots.length, lines };
}

/** 本机别的空间里能取的场次（纯函数）；能整场取的排前面 */
export function sharedScenesOf(spaces: WorkspaceProject[], current: Project): SharedScene[] {
  const list: SharedScene[] = [];
  for (const space of spaces) {
    for (const scene of space.project.scenes) {
      const readiness = sceneReadiness(space.project, current, scene);
      const shots = shotsOf(space.project, scene);
      const first = shots[0];
      const brief =
        first?.description.trim() ||
        (first ? linesOf(space.project, first)[0]?.text.trim() : undefined) ||
        "（这一场还没有字）";
      list.push({
        workspaceId: space.id,
        workspaceName: space.name,
        scene,
        locationName:
          space.project.locations.find((item) => item.id === scene.locationId)?.name ??
          scene.locationId,
        brief,
        readiness,
      });
    }
  }
  return list.sort((a, b) => Number(b.readiness.ready) - Number(a.readiness.ready));
}

/**
 * 把一场变成事件序列：`scene.added` → 逐镜 `shot.added` → 逐句 `dialogue.added`。
 *
 * id 一律重编（`tag` 是同一批事件的短标记）：跨空间保留原 id 会与本空间撞车，
 * 撞了就分不清「同一个人」还是「两个恰好同名的人」。同一批事件的 `at` 相同，
 * 正好落进 F2 的「同毫秒一组」，一次撤销就能整场退回去。
 */
export function sceneImportEvents(
  source: Project,
  current: Project,
  sceneId: string,
  tag: string,
  at: string,
): SceneImport | null {
  const scene = source.scenes.find((item) => item.id === sceneId);
  if (!scene) return null;
  const readiness = sceneReadiness(source, current, scene);
  if (!readiness.ready) return null;

  const used = new Set<string>([
    ...current.scenes.map((item) => item.id),
    ...current.shots.map((item) => item.id),
    ...current.dialogue.map((item) => item.id),
  ]);
  const takeId = (seed: string) => {
    let id = seed;
    while (used.has(id)) id += "x";
    used.add(id);
    return id;
  };

  const nextSceneId = takeId(`sc-${tag}`);
  const events: ProjectEvent[] = [
    {
      type: "scene.added",
      at,
      scene: {
        id: nextSceneId,
        index: current.scenes.length,
        code: scene.code,
        locationId: scene.locationId,
        space: scene.space,
        timeOfDay: scene.timeOfDay,
        shotIds: [],
      },
    },
  ];

  const missingPropIds = new Set(
    source.props
      .filter((prop) => !current.props.some((item) => sameName(item, prop)))
      .map((prop) => prop.id),
  );

  let lines = 0;
  shotsOf(source, scene).forEach((shot, shotIndex) => {
    const nextShotId = takeId(`s-${tag}-${shotIndex}`);
    const lineEvents: ProjectEvent[] = [];
    linesOf(source, shot).forEach((line, lineIndex) => {
      const { audioAssetId: _audio, ...rest } = line;
      const nextLineId = takeId(`d-${tag}-${shotIndex}-${lineIndex}`);
      lineEvents.push({
        type: "dialogue.added",
        at,
        shotId: nextShotId,
        line: { ...rest, id: nextLineId },
      });
      lines += 1;
    });

    events.push({
      type: "shot.added",
      at,
      shot: {
        ...shot,
        id: nextShotId,
        sceneId: nextSceneId,
        index: shotIndex,
        characterIds: [...shot.characterIds],
        propIds: shot.propIds.filter((id) => !missingPropIds.has(id)),
        dialogueIds: [],
        takeIds: [],
        keyframes: {},
        locked: false,
      },
    });
    events.push(...lineEvents);
  });

  // 台词事件要等镜头事件落地后再应用：顺序保持在 shot.added 之后、下一镜之前
  return {
    events,
    shots: shotsOf(source, scene).length,
    lines,
    missingProps: readiness.missingProps,
    sceneId: nextSceneId,
  };
}

export type SceneBatch = {
  events: ProjectEvent[];
  /** 取过来的场数 / 镜数 / 句数 */
  scenes: number;
  shots: number;
  lines: number;
  /** 取不过来被跳过的场（缺人 / 缺地点），带原因 */
  skipped: { sceneId: string; label: string; missing: string[] }[];
  /** 道具对不上、只摘了引用的名字（去重） */
  missingProps: string[];
};

/**
 * 整本剧本一起取（C24 第二档 / ADR-0212）。
 *
 * 按来源场序**串行**推进：第 2 场是在「第 1 场已经取过来」的项目上算 id 与就绪度，
 * 同一批里不会撞 id。取不过来的场跳过并记原因，其余照取——
 * 缺一个配角就整本拿不到，比「拿到 7 场、明确说第 8 场缺谁」更糟。
 *
 * 所有事件共用同一个 `at`：整本取用是一次操作，撤销一步整本退回。
 */
export function sceneBatchOf(
  source: Project,
  current: Project,
  tag: string,
  at: string,
  sceneIds?: string[],
): SceneBatch {
  const batch: SceneBatch = { events: [], scenes: 0, shots: 0, lines: 0, skipped: [], missingProps: [] };
  const wanted = new Set(sceneIds ?? source.scenes.map((scene) => scene.id));
  const props = new Set(batch.missingProps);
  let working = current;

  const ordered = [...source.scenes].sort((a, b) => a.index - b.index);
  for (const scene of ordered) {
    if (!wanted.has(scene.id)) continue;
    const imported = sceneImportEvents(source, working, scene.id, tag, at);
    if (!imported) {
      const readiness = sceneReadiness(source, working, scene);
      batch.skipped.push({
        sceneId: scene.id,
        label: `第 ${scene.index + 1} 场`,
        missing: readiness.missing,
      });
      continue;
    }
    // 串行推进：后面的场要看见前面取过来的结构
    for (const event of imported.events) working = applySceneEvent(working, event);
    batch.events.push(...imported.events);
    batch.scenes += 1;
    batch.shots += imported.shots;
    batch.lines += imported.lines;
    for (const name of imported.missingProps) props.add(name);
  }
  batch.missingProps = [...props];
  return batch;
}

/**
 * 只用来推进「工作副本」的最小回放：整批写进日志前还要过一次 `applyEvent`，
 * 这里只需要把新加的结构记进去，好让下一场算 id 与就绪度。
 */
function applySceneEvent(project: Project, event: ProjectEvent): Project {
  if (event.type === "scene.added") {
    return {
      ...project,
      scenes: [...project.scenes, { ...event.scene, index: project.scenes.length }],
    };
  }
  if (event.type === "shot.added") {
    return {
      ...project,
      shots: [...project.shots, event.shot],
      scenes: project.scenes.map((scene) =>
        scene.id === event.shot.sceneId
          ? { ...scene, shotIds: [...scene.shotIds, event.shot.id] }
          : scene,
      ),
    };
  }
  if (event.type === "dialogue.added") {
    return {
      ...project,
      dialogue: [...project.dialogue, event.line],
      shots: project.shots.map((shot) =>
        shot.id === event.shotId
          ? { ...shot, dialogueIds: [...shot.dialogueIds, event.line.id] }
          : shot,
      ),
    };
  }
  return project;
}
