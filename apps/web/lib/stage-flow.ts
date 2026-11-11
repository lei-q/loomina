/**
 * 阶段式创作流（F8）与闸门确认（F9）。
 *
 * 七个阶段与顶栏、路由一一对应。这里的职责只有三件：
 * 1. 说清每个阶段现在「有什么、还差什么」；
 * 2. 给这一阶段的内容算一个稳定指纹，用来判断确认之后有没有改过；
 * 3. 给出确认时锁住什么、确认后再改要付什么代价——不替作者做决定。
 *
 * 闸门是提醒，不是硬墙：任何阶段都能直接点进去改，只是下游会显示「内容改过」。
 */

import { castReadiness, type GateStage, type Project } from "@loomina/ir";
import { fnv1a } from "./fnv";

export type StageKey = GateStage;

export type GateStatus = "none" | "confirmed" | "stale";
export type StageReadiness = "empty" | "partial" | "ready";

export type StageState = {
  key: StageKey;
  name: string;
  href: string;
  readiness: StageReadiness;
  gate: GateStatus;
  /** 当前内容的指纹；确认记录里的签名对不上它就是过期 */
  signature: string;
  /** 一眼能看懂的现状，例如「3 场 · 12 镜 · 18 句台词」 */
  summary: string;
  /** 还不能确认的原因；空数组表示可确认 */
  missing: string[];
  canConfirm: boolean;
  confirmedAt?: string;
  note?: string;
  /** 这次确认会锁住什么 */
  locks: string;
  /** 确认后再改的代价 */
  downstream: string;
  /** 确认按钮的文案 */
  confirmLabel: string;
  /** 下一阶段；末阶段没有 */
  next?: { key: StageKey; name: string; href: string };
};

type StageMeta = {
  key: StageKey;
  name: string;
  href: string;
  confirmLabel: string;
  locks: string;
  downstream: string;
};

export const STAGE_META: StageMeta[] = [
  {
    key: "story",
    name: "故事",
    href: "/story",
    confirmLabel: "确认故事，进入剧本",
    locks: "故事圣经：logline、梗概、类型、基调、人物弧光、关系张力与开头 / 结尾钩子",
    downstream: "确认后改故事，按旧故事写出来的场次与台词不会自动重写；剧本阶段会标「内容改过」。",
  },
  {
    key: "script",
    name: "剧本",
    href: "/script",
    confirmLabel: "确认剧本，进入定妆",
    locks: "场次、场序、镜序、动作描述与全部台词",
    downstream: "确认后删场、改台词或挪镜序，已出的关键帧与视频会对不上，相关阶段会标「内容改过」。",
  },
  {
    key: "cast",
    name: "定妆",
    href: "/cast",
    confirmLabel: "确认定妆，进入分镜",
    locks: "角色三视图、场景主镜、道具参考图，以及每一个必锁锚点的锁定状态",
    downstream: "确认后换脸、换装或换景，已经生成的镜头与关键帧会对不上，需要重做。",
  },
  {
    key: "storyboard",
    name: "分镜",
    href: "/",
    confirmLabel: "确认分镜，进入关键帧",
    locks: "场序、镜序、景别、机位、动作、出场人物与道具、镜头时长",
    downstream: "确认后改分镜，已出的关键帧与视频会标「过期」；成片时间线要重新初剪。",
  },
  {
    key: "keyframes",
    name: "关键帧",
    href: "/keyframes",
    confirmLabel: "确认画面，进入声音",
    locks: "每一镜的首帧、尾帧与已经生成的视频 take",
    downstream: "确认后重生成首帧或重拍视频，成片时间线里用到的 take 可能失效，需要重剪。",
  },
  {
    key: "voice",
    name: "声音",
    href: "/voice",
    confirmLabel: "确认声音，进入成片",
    locks: "每一句台词的音轨与每个角色的音色",
    downstream: "确认后改台词、换音色或重配，字幕、时间线与成片都要跟着重算。",
  },
  {
    key: "edit",
    name: "成片",
    href: "/edit",
    confirmLabel: "确认这一版成片",
    locks: "这一版的时间线、配乐、响度与导出参数",
    downstream: "确认后再改画面或声音，成片需要重渲；已经导出的文件不会自动更新。",
  },
];

export function stageMetaOf(key: StageKey): StageMeta {
  return STAGE_META.find((item) => item.key === key) ?? STAGE_META[0]!;
}

/** 用资产的内容摘出指纹，不把整串 data URI 拉进哈希 */
function assetStamp(project: Project, assetId: string | undefined): string {
  if (!assetId) return "";
  const asset = project.assets.find((item) => item.id === assetId);
  if (!asset) return `${assetId}:missing`;
  const uri = asset.uri ?? "";
  return [
    asset.id,
    asset.costCny ?? "",
    asset.provenance?.createdAt ?? "",
    asset.provenance?.modelId ?? "",
    uri.length,
    // 同一资产 id 覆盖写时，URI 尾部的 base64 也会变；取尾部足够区分
    uri.slice(-24),
  ].join(":");
}

function stampsOf(project: Project, ids: (string | undefined)[]): string[] {
  return ids.map((id) => assetStamp(project, id));
}

/** 这一阶段当前内容的指纹。只放这一阶段真正管的东西，别的阶段改了不影响它。 */
export function stageSignature(project: Project, key: StageKey): string {
  switch (key) {
    case "story":
      return fnv1a(JSON.stringify({ title: project.title, story: project.story }));

    case "script":
      return fnv1a(
        JSON.stringify({
          scenes: project.scenes.map((scene) => ({
            id: scene.id,
            index: scene.index,
            code: scene.code,
            locationId: scene.locationId,
            space: scene.space,
            timeOfDay: scene.timeOfDay,
            shotIds: scene.shotIds,
          })),
          shots: project.shots.map((shot) => ({
            id: shot.id,
            sceneId: shot.sceneId,
            index: shot.index,
            durationMs: shot.durationMs,
            description: shot.description,
            dialogueIds: shot.dialogueIds,
          })),
          dialogue: project.dialogue,
        }),
      );

    case "cast":
      return fnv1a(
        JSON.stringify({
          characters: project.characters.map((character) => ({
            id: character.id,
            name: character.name,
            appearance: character.appearance,
            mustNotChange: character.mustNotChange,
            referenceImages: character.referenceImages,
            sheet: character.sheet,
            sheetStamps: stampsOf(project, Object.values(character.sheet)),
          })),
          locations: project.locations.map((location) => ({
            id: location.id,
            name: location.name,
            templateId: location.templateId,
            description: location.description,
            master: assetStamp(project, location.masterShotId),
          })),
          props: project.props.map((prop) => ({
            id: prop.id,
            name: prop.name,
            description: prop.description,
            referenceImages: stampsOf(project, prop.referenceImages),
          })),
          // 解锁会让这个阶段的确认失效：确认的本来就是「都锁好了」
          approvals: project.approvals.map((approval) => ({
            targetType: approval.targetType,
            targetId: approval.targetId,
            status: approval.status,
            lockedAssetIds: approval.lockedAssetIds,
          })),
        }),
      );

    case "storyboard":
      return fnv1a(
        JSON.stringify({
          scenes: project.scenes.map((scene) => ({
            id: scene.id,
            index: scene.index,
            shotIds: scene.shotIds,
          })),
          shots: project.shots.map((shot) => ({
            id: shot.id,
            sceneId: shot.sceneId,
            index: shot.index,
            durationMs: shot.durationMs,
            description: shot.description,
            promptNotes: shot.promptNotes,
            shotSize: shot.shotSize,
            camera: shot.camera,
            beat: shot.beat,
            purpose: shot.purpose,
            characterIds: shot.characterIds,
            propIds: shot.propIds,
            dialogueIds: shot.dialogueIds,
          })),
        }),
      );

    case "keyframes":
      return fnv1a(
        JSON.stringify({
          frames: project.shots.map((shot) => ({
            id: shot.id,
            first: assetStamp(project, shot.keyframes.firstAssetId),
            last: assetStamp(project, shot.keyframes.lastAssetId),
          })),
          takes: project.takes.map((take) => ({
            id: take.id,
            shotId: take.shotId,
            status: take.status,
            asset: assetStamp(project, take.assetId),
          })),
        }),
      );

    case "voice":
      return fnv1a(
        JSON.stringify({
          voices: project.characters.map((character) => ({
            id: character.id,
            voiceProfileId: character.voiceProfileId ?? "",
          })),
          lines: project.dialogue.map((line) => ({
            id: line.id,
            characterId: line.characterId,
            text: line.text,
            durationMs: line.durationMs,
            audio: assetStamp(project, line.audioAssetId),
          })),
        }),
      );

    case "edit":
      return fnv1a(
        JSON.stringify({
          items: project.timeline.items,
          music: project.timeline.music,
          takes: project.takes.map((take) => ({
            id: take.id,
            asset: assetStamp(project, take.assetId),
          })),
        }),
      );
  }
}

function readinessOf(project: Project, key: StageKey): {
  readiness: StageReadiness;
  summary: string;
  missing: string[];
} {
  switch (key) {
    case "story": {
      const story = project.story;
      const missing: string[] = [];
      if (!story.logline.trim()) missing.push("还差一句 logline");
      if (!story.synopsis.trim()) missing.push("还差一段梗概");
      const filled = [
        story.logline,
        story.synopsis,
        story.genre,
        story.audience,
        story.tone,
        story.hooks.opening,
        story.hooks.ending,
      ].filter((item) => item.trim()).length;
      const readiness: StageReadiness =
        missing.length === 0 ? "ready" : filled > 0 ? "partial" : "empty";
      return {
        readiness,
        summary: `${filled} / 7 项填写 · ${story.arcs.length} 条人物弧光 · ${story.relationships.length} 对关系`,
        missing,
      };
    }

    case "script": {
      const missing: string[] = [];
      if (project.scenes.length === 0) missing.push("还没有场次");
      if (project.shots.length === 0) missing.push("场次里还没有镜头");
      const readiness: StageReadiness =
        missing.length === 0
          ? "ready"
          : project.scenes.length > 0 || project.dialogue.length > 0
            ? "partial"
            : "empty";
      return {
        readiness,
        summary: `${project.scenes.length} 场 · ${project.shots.length} 镜 · ${project.dialogue.length} 句台词`,
        missing,
      };
    }

    case "cast": {
      const cast = castReadiness(project);
      const missing: string[] = [];
      const open = cast.totalRequired - cast.lockedCount;
      if (cast.totalRequired === 0) {
        missing.push(
          project.characters.length === 0 ? "还没有角色" : "还没有必锁的锚点（有近景的角色、有镜头的场景、进镜的道具）",
        );
      } else if (open > 0) {
        missing.push(`${open} 个必锁锚点还没锁定`);
      }
      const readiness: StageReadiness =
        cast.complete ? "ready" : cast.totalRequired > 0 ? "partial" : "empty";
      return {
        readiness,
        summary: `${cast.lockedCount} / ${cast.totalRequired} 个必锁锚点已锁定 · ${project.characters.length} 个角色`,
        missing,
      };
    }

    case "storyboard": {
      const noDescription = project.shots.filter((shot) => !shot.description.trim()).length;
      const missing: string[] = [];
      if (project.shots.length === 0) missing.push("还没有镜头");
      else if (noDescription > 0) missing.push(`${noDescription} 镜还没有动作描述`);
      const seconds =
        project.timeline.items.length > 0
          ? project.timeline.items.reduce(
              (end, item) => Math.max(end, item.startMs + item.durationMs),
              0,
            ) / 1000
          : project.shots.reduce((sum, shot) => sum + shot.durationMs, 0) / 1000;
      return {
        readiness:
          project.shots.length === 0 ? "empty" : missing.length === 0 ? "ready" : "partial",
        summary: `${project.shots.length} 镜 · 约 ${seconds.toFixed(1)} 秒`,
        missing,
      };
    }

    case "keyframes": {
      const withFirst = project.shots.filter((shot) => shot.keyframes.firstAssetId).length;
      const withLast = project.shots.filter((shot) => shot.keyframes.lastAssetId).length;
      const missing: string[] = [];
      if (project.shots.length === 0) missing.push("还没有镜头");
      else if (withFirst < project.shots.length) {
        missing.push(`${project.shots.length - withFirst} 镜还没有首帧`);
      }
      return {
        readiness:
          project.shots.length === 0
            ? "empty"
            : withFirst === project.shots.length
              ? "ready"
              : "partial",
        summary: `${withFirst} / ${project.shots.length} 镜有首帧 · ${withLast} 有尾帧 · ${project.takes.length} 段视频`,
        missing,
      };
    }

    case "voice": {
      const audioIds = new Set(
        project.assets.filter((asset) => asset.kind === "audio").map((asset) => asset.id),
      );
      const voiced = project.dialogue.filter(
        (line) => line.audioAssetId !== undefined && audioIds.has(line.audioAssetId),
      ).length;
      const speakers = new Set(project.dialogue.map((line) => line.characterId));
      const missing: string[] = [];
      if (project.dialogue.length === 0) missing.push("还没有台词");
      else if (voiced < project.dialogue.length) {
        missing.push(`${project.dialogue.length - voiced} 句还没有配音`);
      }
      return {
        readiness:
          project.dialogue.length === 0
            ? "empty"
            : voiced === project.dialogue.length
              ? "ready"
              : "partial",
        summary: `${voiced} / ${project.dialogue.length} 句有声 · ${speakers.size} 个说话角色`,
        missing,
      };
    }

    case "edit": {
      const items = project.timeline.items;
      const seconds =
        items.reduce((end, item) => Math.max(end, item.startMs + item.durationMs), 0) / 1000;
      const missing: string[] = [];
      if (items.length === 0) missing.push("时间线还是空的：先去初剪");
      return {
        readiness: items.length === 0 ? "empty" : "ready",
        summary: `${items.length} 段 · ${seconds.toFixed(1)} 秒 · ${project.timeline.music.length} 条配乐`,
        missing,
      };
    }
  }
}

export function stageStateOf(project: Project, key: StageKey): StageState {
  const meta = stageMetaOf(key);
  const signature = stageSignature(project, key);
  const record = project.gates.find((gate) => gate.stage === key);
  const gate: GateStatus = !record
    ? "none"
    : record.signature === signature
      ? "confirmed"
      : "stale";
  const { readiness, summary, missing } = readinessOf(project, key);
  const nextMeta = STAGE_META[STAGE_META.findIndex((item) => item.key === key) + 1];
  return {
    ...meta,
    readiness,
    gate,
    signature,
    summary,
    missing,
    // 闸门是「这一段做完了」的标记：没达到可确认条件时按钮是灰的，
    // 但导航不受限——作者仍然可以直接点去下一阶段，只是那里会显示未确认。
    canConfirm: readiness === "ready",
    confirmedAt: record?.at,
    note: record?.note,
    next: nextMeta
      ? { key: nextMeta.key, name: nextMeta.name, href: nextMeta.href }
      : undefined,
  };
}

export function stageStates(project: Project): StageState[] {
  return STAGE_META.map((meta) => stageStateOf(project, meta.key));
}

/** 顶栏的「下一步」：第一个还没确认（或确认后改过）的阶段 */
export function nextOpenStage(states: StageState[]): StageState | undefined {
  return states.find((stage) => stage.gate !== "confirmed");
}

/** 还有哪些下游阶段会因为这一改显示「内容改过」 */
export function staleDownstream(project: Project, from: StageKey): StageState[] {
  const at = STAGE_META.findIndex((item) => item.key === from);
  if (at < 0) return [];
  return STAGE_META.slice(at + 1)
    .map((meta) => stageStateOf(project, meta.key))
    .filter((state) => state.gate !== "none");
}
