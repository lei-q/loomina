import type { Project, Shot, Take } from "@loomina/ir";

export type SceneKind = "door" | "two" | "table" | "corridor";
export type ShotState = "open" | "pick" | "reject";

export type StageShot = {
  /** 镜号，从 1 开始；IR 里的 index 从 0 开始 */
  no: number;
  id: string;
  art: SceneKind;
  action: string;
  /** 秒 */
  dur: number;
  state: ShotState;
  /** 当前用的是第几版 take，没有 take 时为空 */
  take?: number;
};

export type StageView = {
  title: string;
  version: number;
  /** 已花 / 预算，元 */
  spent: number;
  budget: number;
  /** 当前镜在 shots 里的下标 */
  current: number;
  /** 重做一次要多少钱，元 */
  requote: number;
  /** 烧在画面里的字幕；当前镜没有台词时为空串 */
  subtitle: string;
  shots: StageShot[];
};

export type StageOptions = {
  budgetCny?: number;
  requoteCny?: number;
  /** 指定看哪一格；不传则挑第一个还没定的镜头 */
  currentShotId?: string;
};

const artByTemplate: Record<string, SceneKind> = {
  corridor: "corridor",
  doorway: "door",
  door: "door",
  table: "table",
};

function shotState(shot: Shot, take: Take | undefined): ShotState {
  if (take?.status === "approved") return "pick";
  if (take?.status === "rejected") return "reject";
  if (shot.locked) return "pick";
  return "open";
}

/** 同一个镜头有多条 take 时，按生成时间取最新的一条。 */
function latestTake(shot: Shot, takesById: Map<string, Take>): Take | undefined {
  let latest: Take | undefined;
  for (const id of shot.takeIds) {
    const take = takesById.get(id);
    if (!take) continue;
    if (!latest || take.provenance.createdAt > latest.provenance.createdAt) latest = take;
  }
  return latest;
}

/** 镜头挂的场景 → 场景所在地 → 场景模板 → 用哪张分镜剪影。 */
function artFor(
  shot: Shot,
  templateByLocation: Map<string, string | undefined>,
  locationByScene: Map<string, string>,
): SceneKind {
  if (shot.characterIds.length >= 2) return "two";
  const locationId = locationByScene.get(shot.sceneId);
  const template = locationId ? templateByLocation.get(locationId) : undefined;
  return (template && artByTemplate[template]) || "door";
}

/** 按场次顺序、场内镜序排一遍；没挂进 scene.shotIds 的镜头兜底接在后面。 */
function orderShots(project: Project): Shot[] {
  const shotsById = new Map(project.shots.map((shot) => [shot.id, shot]));
  const ordered: Shot[] = [];

  for (const scene of [...project.scenes].sort((a, b) => a.index - b.index)) {
    for (const shotId of scene.shotIds) {
      const shot = shotsById.get(shotId);
      if (shot) ordered.push(shot);
    }
  }

  const seen = new Set(ordered.map((shot) => shot.id));
  for (const shot of [...project.shots].sort((a, b) => a.index - b.index)) {
    if (!seen.has(shot.id)) ordered.push(shot);
  }

  return ordered;
}

/**
 * Project IR → 审片台读模型。
 * 组件只认 StageView，不认 IR；IR 的结构变化只改这一个文件。
 */
export function toStageView(project: Project, options: StageOptions = {}): StageView {
  const takesById = new Map(project.takes.map((take) => [take.id, take]));
  const dialogueById = new Map(project.dialogue.map((line) => [line.id, line]));
  const templateByLocation = new Map<string, string | undefined>(
    project.locations.map((location) => [location.id, location.templateId]),
  );
  const locationByScene = new Map<string, string>(
    project.scenes.map((scene) => [scene.id, scene.locationId]),
  );

  const ordered = orderShots(project);

  const shots: StageShot[] = ordered.map((shot, i) => {
    const take = latestTake(shot, takesById);
    return {
      no: i + 1,
      id: shot.id,
      art: artFor(shot, templateByLocation, locationByScene),
      action: shot.description,
      dur: shot.durationMs / 1000,
      state: shotState(shot, take),
      take: take ? shot.takeIds.indexOf(take.id) + 1 : undefined,
    };
  });

  const requested = options.currentShotId
    ? shots.findIndex((shot) => shot.id === options.currentShotId)
    : shots.findIndex((shot) => shot.state === "open");
  const current = requested >= 0 ? requested : 0;

  const currentShot = ordered[current];
  const subtitle = currentShot
    ? currentShot.dialogueIds
        .map((id) => dialogueById.get(id)?.text)
        .filter((text): text is string => Boolean(text))
        .join(" ")
    : "";

  const spent = project.takes.reduce((sum, take) => sum + take.costCny, 0);

  return {
    title: project.title,
    version: project.version,
    spent,
    budget: options.budgetCny ?? 60,
    current,
    requote: options.requoteCny ?? 2.12,
    subtitle,
    shots,
  };
}

export function shotLabel(no: number): string {
  return `SH-${String(no).padStart(2, "0")}`;
}
