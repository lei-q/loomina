import type { Project, ProjectEvent, Take, VoiceTake } from "@loomina/ir";
import type { Frame } from "@loomina/pipeline";

/**
 * 废片库（C14 / ADR-0193）。
 *
 * 生成过的东西是花过钱的资产。淘汰的 take、删掉的 take、被重生成换下来的
 * 关键帧都不该在界面上消失——它们是「之后可取回或作参考」的那一堆。
 *
 * 这里只做**只读汇总**：从哪里来、哪一镜、什么时候、花了多少。
 * 取回动作在 store 里（`restoreTake` / `useKeyframeVersion`），不在这里改项目。
 */

export type TrashState = "rejected" | "removed" | "old";

export type TrashItem = {
  /** 稳定 key：`take:t-03` / `keyframe:s-03:first:a-...` */
  key: string;
  kind: "take" | "keyframe" | "voice";
  state: TrashState;
  shotId: string;
  /** 「第 2 场 · 第 3 镜」；分镜被删了就写 id */
  shotLabel: string;
  shotDescription: string;
  /** 淘汰 / 删除 / 归档的时间；不知道就空串 */
  at: string;
  assetId: string;
  uri?: string;
  /** take 上的钱；关键帧历史复制件不带钱（钱记在当前资产位） */
  costCny?: number;
  modelId?: string;
  /** 关键帧才有：它原来是首帧还是尾帧 */
  frame?: Frame;
  /** 配音才有：哪句台词 */
  lineId?: string;
  lineText?: string;
};

const STATE_CN: Record<TrashState, string> = {
  rejected: "淘汰",
  removed: "已删",
  old: "旧版",
};

export function trashStateLabel(state: TrashState): string {
  return STATE_CN[state];
}

function shotLabelsOf(project: Project): Map<string, { label: string; description: string }> {
  const labels = new Map<string, { label: string; description: string }>();
  for (const scene of project.scenes) {
    const sceneName = scene.code || `第 ${scene.index + 1} 场`;
    const shots = project.shots.filter((shot) => shot.sceneId === scene.id);
    shots.forEach((shot, index) => {
      labels.set(shot.id, {
        label: `${sceneName} · 第 ${index + 1} 镜`,
        description: shot.description,
      });
    });
  }
  // 场景缺失的镜头也列出来，别让废片凭空消失
  for (const shot of project.shots) {
    if (!labels.has(shot.id)) {
      labels.set(shot.id, { label: "未知场 · 一镜", description: shot.description });
    }
  }
  return labels;
}

/**
 * 从日志里找回一条已经被 `take.removed` 摘掉的 take。
 * 用在「取回」：记录不在项目里了，但 `take.added` 还在日志里。
 */
export function takeFromLog(events: ProjectEvent[], takeId: string): Take | undefined {
  let found: Take | undefined;
  for (const event of events) {
    if (event.type === "project.created") {
      // 示例项目 / 导入项目里的拍随项目一起出生，没有单独的 take.added
      found = event.project.takes.find((take) => take.id === takeId) ?? found;
    } else if (event.type === "take.added" && event.take.id === takeId) {
      found = event.take;
    }
  }
  return found;
}

/** 从日志里找回一版已经被 `voice.take.removed` 摘掉的配音。 */
export function voiceTakeFromLog(events: ProjectEvent[], takeId: string): VoiceTake | undefined {
  let found: VoiceTake | undefined;
  for (const event of events) {
    if (event.type === "project.created") {
      found = event.project.voiceTakes.find((take) => take.id === takeId) ?? found;
    } else if (event.type === "voice.take.added" && event.take.id === takeId) {
      found = event.take;
    }
  }
  return found;
}

/**
 * 汇总废片：淘汰的 take、日志里删掉的 take、日志里删掉的配音、
 * 关键帧历史里不是当前的那几版。
 * 新的排前面；同一张图在同一镜的同一帧只列一次。
 */
export function trashOf(project: Project, events: ProjectEvent[]): TrashItem[] {
  const labels = shotLabelsOf(project);
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const items: TrashItem[] = [];

  // 1) 还在项目里的淘汰拍
  for (const take of project.takes) {
    if (take.status !== "rejected") continue;
    const asset = assetById.get(take.assetId);
    const shot = labels.get(take.shotId);
    items.push({
      key: `take:${take.id}`,
      kind: "take",
      state: "rejected",
      shotId: take.shotId,
      shotLabel: shot?.label ?? take.shotId,
      shotDescription: shot?.description ?? "",
      at: take.provenance?.createdAt ?? asset?.createdAt ?? "",
      assetId: take.assetId,
      ...(asset?.uri ? { uri: asset.uri } : {}),
      ...(take.costCny > 0 ? { costCny: take.costCny } : {}),
      modelId: take.provenance?.modelId,
    });
  }

  // 2) 日志里已经删掉的拍：take.added 有原始记录，take.removed 之后就不在项目里了
  const added = new Map<string, Take>();
  const removedAt = new Map<string, string>();
  for (const event of events) {
    if (event.type === "take.added") {
      added.set(event.take.id, event.take);
      removedAt.delete(event.take.id);
    } else if (event.type === "take.removed") {
      removedAt.set(event.takeId, event.at);
    }
  }
  for (const [takeId, at] of removedAt) {
    // 后来又被取回过：项目里已经有了，算「淘汰 / 在册」，不重复列
    if (project.takes.some((take) => take.id === takeId)) continue;
    const take = added.get(takeId);
    if (!take) continue;
    const asset = assetById.get(take.assetId);
    // 资产记录也删了就找不回来了，不列一条点不动的空卡片
    if (!asset) continue;
    const shot = labels.get(take.shotId);
    items.push({
      key: `take:${takeId}`,
      kind: "take",
      state: "removed",
      shotId: take.shotId,
      shotLabel: shot?.label ?? take.shotId,
      shotDescription: shot?.description ?? "",
      at,
      assetId: take.assetId,
      ...(asset.uri ? { uri: asset.uri } : {}),
      ...(take.costCny > 0 ? { costCny: take.costCny } : {}),
      modelId: take.provenance?.modelId,
    });
  }

  // 3) 日志里已经删掉的配音：voice.take.added 有原始记录
  const voiceAdded = new Map<string, VoiceTake>();
  const voiceRemovedAt = new Map<string, string>();
  for (const event of events) {
    if (event.type === "project.created") {
      for (const take of event.project.voiceTakes) voiceAdded.set(take.id, take);
    } else if (event.type === "voice.take.added") {
      voiceAdded.set(event.take.id, event.take);
      voiceRemovedAt.delete(event.take.id);
    } else if (event.type === "voice.take.removed") {
      voiceRemovedAt.set(event.takeId, event.at);
    }
  }
  for (const [takeId, at] of voiceRemovedAt) {
    if (project.voiceTakes.some((take) => take.id === takeId)) continue;
    const take = voiceAdded.get(takeId);
    if (!take) continue;
    const asset = assetById.get(take.assetId);
    const line = project.dialogue.find((item) => item.id === take.lineId);
    // 资产或台词都没了就恢复不回来，不列点不动的空卡片
    if (!asset?.uri || !line) continue;
    const shot = project.shots.find((item) => item.dialogueIds.includes(line.id));
    items.push({
      key: `voice:${takeId}`,
      kind: "voice",
      state: "removed",
      shotId: shot?.id ?? "",
      shotLabel: shot ? (labels.get(shot.id)?.label ?? shot.id) : "配音",
      shotDescription: line.text,
      at,
      assetId: take.assetId,
      uri: asset.uri,
      modelId: take.provenance?.modelId,
      lineId: line.id,
      lineText: line.text,
    });
  }

  // 4) 关键帧旧版：每镜每帧最多 20 版，只列不是当前这一张的
  for (const shot of project.shots) {
    const shotLabel = labels.get(shot.id);
    for (const frame of ["first", "last"] as const) {
      const currentId = frame === "last" ? shot.keyframes.lastAssetId : shot.keyframes.firstAssetId;
      const currentUri = currentId ? assetById.get(currentId)?.uri : undefined;
      const seen = new Set<string>();
      for (const assetId of shot.keyframes.history?.[frame] ?? []) {
        const asset = assetById.get(assetId);
        if (!asset?.uri) continue;
        if (asset.uri === currentUri) continue;
        if (seen.has(asset.uri)) continue;
        seen.add(asset.uri);
        items.push({
          key: `keyframe:${shot.id}:${frame}:${asset.id}`,
          kind: "keyframe",
          state: "old",
          shotId: shot.id,
          shotLabel: shotLabel?.label ?? shot.id,
          shotDescription: shotLabel?.description ?? shot.description,
          at: asset.createdAt,
          assetId: asset.id,
          uri: asset.uri,
          modelId: asset.provenance?.modelId,
          frame,
        });
      }
    }
  }

  return items.sort((a, b) => {
    if (a.at === b.at) return a.key.localeCompare(b.key);
    return b.at.localeCompare(a.at);
  });
}
