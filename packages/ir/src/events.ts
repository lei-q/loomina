import { z } from "zod";
import { clone } from "./clone";
import {
  BlockingSchema,
  CameraSchema,
  LocationSpaceSchema,
  PerformanceSpecSchema,
  StagingMarkSchema,
} from "./schema";
import { blockingProblem, placementProblem, spaceProblem, spaceOfShot } from "./geometry";
import type {
  Approval,
  Asset,
  Character,
  DialogueLine,
  GateStage,
  Id,
  Location,
  LocationSpace,
  MusicCue,
  Project,
  Prop,
  PublishPackage,
  Scene,
  Shot,
  StoryArc,
  StoryBible,
  StoryRelationship,
  Take,
  TimelineItem,
} from "./schema";

/** "不许变"清单：单条上限（整句进提示词，ADR-0074） */
export const MUST_NOT_CHANGE_MAX = 60;

/** "不许变"清单：条数上限，防止把镜头指令挤掉（ADR-0074） */
export const MUST_NOT_CHANGE_COUNT_MAX = 20;
/** 参考图上限：人物 / 道具各 8 张，再多进提示词与锚点就没有意义了（ADR-0079） */
export const REFERENCE_IMAGES_MAX = 8;

/** 音色标识上限：供应商的音色名通常很短，留点余量（ADR-0085） */
export const VOICE_PROFILE_MAX = 40;

/** 阶段闸门备注上限（F9）：一句话说清「为什么这时候确认」，不是写检讨 */
export const GATE_NOTE_MAX = 240;

/**
 * 事件日志（ADR-0011）。
 *
 * 第一版只做“可回放”：
 * - `project.created` 是引导事件，携带初始快照；
 * - 其后的增量事件在快照上应用。
 *
 * 不做 CRDT、不做 OTIO、不做多人协作。
 */
export type ProjectEvent =
  | { type: "project.created"; at: string; project: Project }
  | {
      /**
       * 项目级设置（H10）：预算、单镜重试上限与超预算处置。
       * 改了都要留痕，否则"什么时候从 60 改成 19 的"说不清。
       */
      type: "project.updated";
      at: string;
      budgetCny?: number;
      maxAttemptsPerShot?: number;
      onBudgetExceed?: "block" | "keep";
    }
  | {
      /**
       * 故事层改写（A16）：只允许改这几样文字字段。
       *
       * 不整块替换 `story`：`provenance` 记的是这份故事从哪来，作者改字不该把它抹掉。
       * 传 undefined 的字段不动；传空串表示清空。
       */
      type: "story.updated";
      at: string;
      patch: Partial<
        Pick<
          StoryBible,
          "logline" | "synopsis" | "genre" | "audience" | "tone"
        >
      > & {
        openingHook?: string;
        endingHook?: string;
        /** 整组替换人物弧光；`characterId` 必须存在 */
        arcs?: StoryArc[];
        /** 整组替换关系张力；两端角色必须存在且不相同 */
        relationships?: StoryRelationship[];
      };
    }
  | { type: "shot.updated"; at: string; shotId: Id; patch: Partial<Shot> }
  | {
      /**
       * 场头改写（ADR-0050）：目前只允许内 / 外景与日夜。
       * 地点、场号属于结构，不在这里改。
       */
      type: "scene.updated";
      at: string;
      sceneId: Id;
      patch: Partial<Pick<Scene, "space" | "timeOfDay" | "locationId" | "code">>;
    }
  | {
      /**
       * 新建场次（ADR-0064 / ADR-0068）：插在第 `scene.index` 位，后面的场次顺次后移。
       * 新场还没有镜头，所以这里不带任何镜头引用。
       */
      type: "scene.added";
      at: string;
      scene: Scene;
    }
  | {
      /**
       * 新建镜头（ADR-0064 / ADR-0068）：插在所属场次的第 `shot.index` 位，
       * 后面的镜头顺次后移。动作描述留空，景别与机位给的是默认值，都可以随后改。
       */
      type: "shot.added";
      at: string;
      shot: Shot;
    }
  | {
      /**
       * 调整场序（ADR-0060）：一场一位。镜号跟着场序重排；
       * 台词、take、关键帧都按 id 引用，不跟着动。
       */
      type: "scene.moved";
      at: string;
      sceneId: Id;
      /** 挪到第几位（从 0 数），必须落在现有场次范围内 */
      toIndex: number;
    }
  | {
      /**
       * 删一场（ADR-0067）：只能删空场。
       * 还有镜头时先逐条写 `shot.removed`——回放到任一前缀都不会有悬挂引用，
       * 也让日志里"这一场原来有几镜"看得见。
       */
      type: "scene.removed";
      at: string;
      sceneId: Id;
    }
  | {
      /**
       * 删一镜（ADR-0067）：镜头自己的台词、take 与时间线项一并摘掉。
       * 这些都是镜头的从属物，没有各自独立的界面；资产留着不删（孤儿资产另行回收）。
       */
      type: "shot.removed";
      at: string;
      shotId: Id;
    }
  | {
      /** 加一个地点（ADR-0059）：先有地点，场次才挂得上去 */
      type: "location.added";
      at: string;
      location: Location;
    }
  | {
      /** 改地点（ADR-0059 / ADR-0063）：名字、模板与场景描述；主镜与参考图走资产那条路 */
      type: "location.updated";
      at: string;
      locationId: Id;
      /**
       * `space: null` 表示清掉几何（换成没有坐标的旧模板时用）。
       * 用 null 而不是 undefined：undefined 存进 JSON 就消失了，回放会留下旧几何。
       */
      patch: Partial<Pick<Location, "name" | "templateId" | "description">> & {
        space?: LocationSpace | null;
      };
    }
  | {
      /** 删地点（ADR-0061）：还有场次指向它时拒绝，不留悬挂引用 */
      type: "location.removed";
      at: string;
      locationId: Id;
    }
  | {
      /** 加一个人物（ADR-0071）：先有人物，分镜页与剧本页才点得出这个名字 */
      type: "character.added";
      at: string;
      character: Character;
    }
  | {
      /**
       * 改人物（ADR-0071 / ADR-0074）：名字、外形描述与"不许变"清单；
       * 三视图、参考图走资产那条路。`mustNotChange` 整份替换——清单短，
       * 一条一条增删反而让日志更长。
       */
      type: "character.updated";
      at: string;
      characterId: Id;
      patch: Partial<
        Pick<
          Character,
          | "name"
          | "appearance"
          | "mustNotChange"
          | "referenceImages"
          /** 音色（ADR-0085）：空串表示用回默认音色 */
          | "voiceProfileId"
        >
      >;
    }
  | {
      /** 加一件道具（ADR-0072）：先有道具，分镜页的道具签才点得出来 */
      type: "prop.added";
      at: string;
      prop: Prop;
    }
  | {
      /** 改道具（ADR-0072 / ADR-0079）：名字、描述与参考图（参考图先走 asset.updated） */
      type: "prop.updated";
      at: string;
      propId: Id;
      patch: Partial<Pick<Prop, "name" | "description" | "referenceImages">>;
    }
  | {
      /**
       * 删一个人物（ADR-0073）：还有镜头点着他、或还有台词属于他时拒绝，不留悬挂引用。
       * 三视图与参考图留着不删（孤儿资产另行回收）。
       */
      type: "character.removed";
      at: string;
      characterId: Id;
    }
  | {
      /** 删一件道具（ADR-0073）：还有镜头用着它时拒绝；参考图留着不删 */
      type: "prop.removed";
      at: string;
      propId: Id;
    }
  | {
      /**
       * 台词改写（ADR-0044）：只允许改文本与时长。
       * 说话人不在这里改——换人等于换一句台词，应该新增而不是覆盖。
       */
      type: "dialogue.updated";
      at: string;
      lineId: Id;
      patch: Partial<Omit<DialogueLine, "id" | "characterId">>;
    }
  | {
      /** 换说话人（ADR-0046）：同一句台词换个角色说，文本与时长不动 */
      type: "dialogue.speaker.updated";
      at: string;
      lineId: Id;
      characterId: Id;
    }
  | {
      /** 加一句台词（ADR-0045）：同时挂到镜头的 dialogueIds 上 */
      type: "dialogue.added";
      at: string;
      shotId: Id;
      line: DialogueLine;
    }
  | {
      /** 删一句台词（ADR-0045）：整句从项目与所属镜头上摘掉 */
      type: "dialogue.removed";
      at: string;
      lineId: Id;
    }
  | {
      /**
       * 手改一句的断句（D2）。
       *
       * `cues` 为 null 表示恢复自动断句。覆盖按整句存：自动断句是读模型派生的，
       * 只改其中一条字幕会让其余几条的边界跟着漂。
       */
      type: "subtitle.updated";
      at: string;
      lineId: Id;
      cues: { text: string; durationMs: number }[] | null;
    }
  | { type: "take.added"; at: string; take: Take }
  | {
      /**
       * 删一拍（B5）：这一版不要了。
       *
       * 只摘 take 与它在时间线上的片段，不删资产——资产可能还被别处引用，
       * 回收是另一件事（F4）。删掉的 take 仍留在日志里，历史回滚能找回来。
       */
      type: "take.removed";
      at: string;
      takeId: Id;
    }
  | {
      /** 闸门：定妆锁定 / 解锁。同一目标只保留一条，按 (targetType, targetId) 覆盖。 */
      type: "approval.updated";
      at: string;
      approval: Approval;
    }
  | {
      type: "take.updated";
      at: string;
      takeId: Id;
      /** 只允许改生成结果的状态与元数据，id 与 shotId 不可改 */
      patch: Partial<Omit<Take, "id" | "shotId">>;
    }
  | {
      /** 资产回写：生成结果落成一张图，按 id upsert。 */
      type: "asset.updated";
      at: string;
      asset: Asset;
    }
  | {
      /**
       * 整条时间线换掉（ADR-0086）。
       *
       * 初剪、换 take 都产出一条「整条替换」的事件，而不是逐项增删：
       * 时间线的价值在片段之间的关系（顺序、起点、不重叠），
       * 只记增量的话，回放时得靠一堆小事件拼出同一件事，反而更难核对。
       */
      type: "timeline.updated";
      at: string;
      items: TimelineItem[];
    }
  | {
      /**
       * 阶段确认（F8 / F9）：把「这一阶段的内容我认了」写进日志。
       * 同阶段只有一条，重复确认按阶段覆盖；签名对不上当前内容就算过期。
       */
      type: "gate.confirmed";
      at: string;
      stage: GateStage;
      /** 确认时的内容指纹，8 位十六进制 */
      signature: string;
      /** 作者备注，最多 240 字 */
      note?: string;
      /** 带条件确认（A12）：明知还有可豁免缺口仍然确认 */
      override?: boolean;
    }
  | {
      /**
       * 回退阶段闸门：删掉这一阶段的确认记录。
       * 不删下游的确认记录——它们各自会因为签名变化显示「内容改过」。
       */
      type: "gate.reopened";
      at: string;
      stage: GateStage;
    }
  | {
      /**
       * 配乐床整条替换（C4）。和 `timeline.updated` 分开：
       * 换 take 不该顺手重写音乐，音乐改了也不该假装画面动了。
       */
      type: "timeline.music.updated";
      at: string;
      music: MusicCue[];
    }
  | {
      /**
       * 记一条发布记录（G1）：把这一包对应的平台、档位与成片文件信息写进 IR。
       * 只追加，不覆盖——同一版改过标题再发一次，是两条发布历史（ADR-0102）。
       */
      type: "publish.recorded";
      at: string;
      package: PublishPackage;
    }
  | {
      /**
       * 全局回滚（F2 / ADR-0109）：把项目恢复到「前 `toEventCount` 条事件之后」的样子。
       *
       * 不携带快照：日志只追加、前缀的回放结果永远相同，存一个位置就够了。
       * 带快照的话，每撤销一次就会把整份项目（含图片 data URI）再抄一遍，
       * 一个正常项目几十兆，撤销几次就把本地库撑爆了。
       *
       * 因为它必须看得到前面的日志，`applyEvent` 单条应用不了——
       * 回放交给 `rebuild`，见那里的注释。
       */
      type: "project.restored";
      at: string;
      /** 前缀长度：1 表示只留下 `project.created`。必须 ≤ 本条事件之前的条数 */
      toEventCount: number;
      /** 给用户看的说明：回到了哪一步（历史抽屉里原样显示） */
      label?: string;
    };

/** 时间线项的公共校验：id 唯一、时长合法、take 属于该镜、片段不重叠 */
function checkTimeline(items: TimelineItem[], project: Project) {
  const ids = new Set<Id>();
  const takeById = new Map(project.takes.map((take) => [take.id, take]));
  const shotIds = new Set(project.shots.map((shot) => shot.id));
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`timeline.updated 有重复的时间线项: ${item.id}`);
    ids.add(item.id);
    if (!shotIds.has(item.shotId)) {
      throw new Error(`timeline.updated 指向不存在的镜头: ${item.shotId}`);
    }
    const take = takeById.get(item.takeId);
    if (!take || take.shotId !== item.shotId) {
      throw new Error(`timeline.updated 的 take ${item.takeId} 不存在或不属于镜头 ${item.shotId}`);
    }
    if (!Number.isInteger(item.startMs) || item.startMs < 0) {
      throw new Error(`timeline.updated 的起点不合法: ${item.startMs}`);
    }
    if (!Number.isInteger(item.durationMs) || item.durationMs <= 0) {
      throw new Error(`timeline.updated 的时长不合法: ${item.durationMs}`);
    }
  }
  const ordered = [...items].sort((a, b) => a.startMs - b.startMs);
  let previousEnd = -1;
  let previousId = "";
  for (const item of ordered) {
    if (item.startMs < previousEnd) {
      throw new Error(`timeline.updated 的 ${item.id} 与 ${previousId} 重叠`);
    }
    const end = item.startMs + item.durationMs;
    if (end > previousEnd) {
      previousEnd = end;
      previousId = item.id;
    }
  }
}

function checkMusic(cues: MusicCue[], project: Project) {
  const ids = new Set<Id>();
  const timelineEnd = project.timeline.items.reduce(
    (end, item) => Math.max(end, item.startMs + item.durationMs),
    0,
  );
  for (const cue of cues) {
    if (ids.has(cue.id)) throw new Error(`timeline.music.updated 有重复的配乐项: ${cue.id}`);
    ids.add(cue.id);
    const asset = project.assets.find((item) => item.id === cue.assetId);
    if (!asset || asset.kind !== "audio") {
      throw new Error(`timeline.music.updated 的 ${cue.id} 没有挂到音频资产 ${cue.assetId}`);
    }
    if (!cue.licenseRef.trim()) {
      throw new Error(`timeline.music.updated 的 ${cue.id} 缺少授权备注`);
    }
    if (!Number.isInteger(cue.startMs) || cue.startMs < 0) {
      throw new Error(`timeline.music.updated 的 ${cue.id} 起点不合法`);
    }
    if (!Number.isInteger(cue.durationMs) || cue.durationMs <= 0) {
      throw new Error(`timeline.music.updated 的 ${cue.id} 时长不合法`);
    }
    if (timelineEnd > 0 && cue.startMs >= timelineEnd) {
      throw new Error(`timeline.music.updated 的 ${cue.id} 起点在成片之外`);
    }
    if (cue.gainDb > 0 || cue.gainDb < -40) {
      throw new Error(`timeline.music.updated 的 ${cue.id} 增益超出 -40–0 dB`);
    }
    if (cue.duckDb < 12 || cue.duckDb > 18) {
      throw new Error(`timeline.music.updated 的 ${cue.id} ducking 深度超出 12–18 dB`);
    }
  }
}

function checkReferenceImages(ids: Id[], assets: Asset[], label: string) {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} 的 referenceImages 有重复`);
  }
  if (ids.length > REFERENCE_IMAGES_MAX) {
    throw new Error(`${label} 的 referenceImages 超过 ${REFERENCE_IMAGES_MAX} 张`);
  }
  for (const id of ids) {
    if (!assets.some((asset) => asset.id === id)) {
      throw new Error(`${label} 的 referenceImages 指向不存在的资产: ${id}`);
    }
  }
}

/**
 * 应用一条事件；`Project.version` 每应用一条就 +1（F1 状态校准）。
 *
 * 版本号要能回答「现在这份项目是第几版」，所以它跟着状态走，而不是跟着某一次
 * 批量生成走：改一句台词、确认一次闸门、回退一次，都是新的一版。
 * `project.created` 是例外——它带来自己的起始版本。
 */
export function applyEvent(
  current: Project | null,
  event: ProjectEvent,
): Project {
  const next = applyEventCore(current, event);
  if (event.type === "project.created") return next;
  return { ...next, version: next.version + 1 };
}

function applyEventCore(
  current: Project | null,
  event: ProjectEvent,
): Project {
  switch (event.type) {
    case "project.created":
      return clone(event.project);

    case "project.updated": {
      if (!current) throw new Error("project.updated 之前必须有 project.created");
      const next: Project = { ...current };
      let touched = 0;
      if (event.budgetCny !== undefined) {
        if (!(event.budgetCny > 0)) {
          throw new Error(`预算必须大于 0：${event.budgetCny}`);
        }
        next.budgetCny = event.budgetCny;
        touched += 1;
      }
      if (event.maxAttemptsPerShot !== undefined) {
        if (
          !Number.isInteger(event.maxAttemptsPerShot) ||
          event.maxAttemptsPerShot < 1 ||
          event.maxAttemptsPerShot > 5
        ) {
          throw new Error(`单镜重试上限必须是 1–5 的整数：${event.maxAttemptsPerShot}`);
        }
        next.maxAttemptsPerShot = event.maxAttemptsPerShot;
        touched += 1;
      }
      if (event.onBudgetExceed !== undefined) {
        if (event.onBudgetExceed !== "block" && event.onBudgetExceed !== "keep") {
          throw new Error(`超预算处置只能是 block 或 keep：${event.onBudgetExceed}`);
        }
        next.onBudgetExceed = event.onBudgetExceed;
        touched += 1;
      }
      if (touched === 0) throw new Error("project.updated 没有要改的字段");
      return next;
    }

    case "story.updated": {
      if (!current) throw new Error("story.updated 之前必须有 project.created");
      const { patch } = event;
      const story = current.story;
      const next = { ...story, hooks: { ...story.hooks } };
      let touched = 0;

      for (const key of ["logline", "synopsis", "genre", "audience", "tone"] as const) {
        const value = patch[key];
        if (value === undefined) continue;
        next[key] = value.trim();
        touched += 1;
      }
      if (patch.openingHook !== undefined) {
        next.hooks.opening = patch.openingHook.trim();
        touched += 1;
      }
      if (patch.endingHook !== undefined) {
        next.hooks.ending = patch.endingHook.trim();
        touched += 1;
      }
      if (patch.arcs !== undefined) {
        const ids = new Set<string>();
        for (const arc of patch.arcs) {
          if (ids.has(arc.characterId)) {
            throw new Error(`story.updated 里同一个角色有两份弧光: ${arc.characterId}`);
          }
          if (!current.characters.some((item) => item.id === arc.characterId)) {
            throw new Error(`story.updated 的弧光指向不存在的角色: ${arc.characterId}`);
          }
          ids.add(arc.characterId);
        }
        next.arcs = patch.arcs.map((arc) => ({ ...arc }));
        touched += 1;
      }
      if (patch.relationships !== undefined) {
        const seen = new Set<string>();
        for (const relation of patch.relationships) {
          if (relation.fromCharacterId === relation.toCharacterId) {
            throw new Error("story.updated 的关系两端不能是同一个人");
          }
          for (const id of [relation.fromCharacterId, relation.toCharacterId]) {
            if (!current.characters.some((item) => item.id === id)) {
              throw new Error(`story.updated 的关系指向不存在的角色: ${id}`);
            }
          }
          const key = `${relation.fromCharacterId}->${relation.toCharacterId}`;
          if (seen.has(key)) {
            throw new Error(`story.updated 里同一对关系写了两遍: ${key}`);
          }
          seen.add(key);
        }
        next.relationships = patch.relationships.map((relation) => ({ ...relation }));
        touched += 1;
      }
      if (touched === 0) throw new Error("story.updated 没有要改的字段");
      return { ...current, story: next };
    }

    case "shot.updated": {
      if (!current) throw new Error("shot.updated 之前必须有 project.created");
      if (!current.shots.some((shot) => shot.id === event.shotId)) {
        throw new Error(`shot.updated 指向不存在的镜头: ${event.shotId}`);
      }
      // 单镜预算（H10）：要么不设，要么是正的有限数；0 与负数都不代表「不设上限」
      if (
        event.patch.budgetCny !== undefined &&
        (!Number.isFinite(event.patch.budgetCny) || event.patch.budgetCny <= 0)
      ) {
        throw new Error(`单镜预算必须大于 0：${event.patch.budgetCny}`);
      }
      // 表演与调度（B16 / B17）：结构不合法就不该进日志，回放时才发现就晚了
      let patch = event.patch;
      if (event.patch.performance !== undefined) {
        const parsed = PerformanceSpecSchema.safeParse(event.patch.performance);
        if (!parsed.success) {
          throw new Error(
            `表演设计不合法：${parsed.error.issues[0]?.message ?? "未知原因"}`,
          );
        }
        // 补上默认值再落库：回放拿到的结构与新建时一致
        patch = { ...patch, performance: parsed.data };
      }
      if (event.patch.staging !== undefined) {
        const parsed = z.array(StagingMarkSchema).safeParse(event.patch.staging);
        if (!parsed.success) {
          throw new Error(
            `镜头调度不合法：${parsed.error.issues[0]?.message ?? "未知原因"}`,
          );
        }
        patch = { ...patch, staging: parsed.data };
      }
      // 走位与机位坐标（B13）：越界、不在场、两点重合都不进日志
      if (event.patch.blocking !== undefined) {
        const parsed = BlockingSchema.safeParse(event.patch.blocking);
        if (!parsed.success) {
          throw new Error(`走位不合法：${parsed.error.issues[0]?.message ?? "未知原因"}`);
        }
        const target = current.shots.find((shot) => shot.id === event.shotId)!;
        const problem = blockingProblem(spaceOfShot(current, target), target, parsed.data);
        if (problem) throw new Error(`走位不合法：${problem.message}`);
        patch = { ...patch, blocking: parsed.data };
      }
      if (event.patch.camera?.placement !== undefined) {
        const parsed = CameraSchema.safeParse(event.patch.camera);
        if (!parsed.success) {
          throw new Error(`机位不合法：${parsed.error.issues[0]?.message ?? "未知原因"}`);
        }
        const target = current.shots.find((shot) => shot.id === event.shotId)!;
        const problem = placementProblem(spaceOfShot(current, target), parsed.data.placement!);
        if (problem) throw new Error(`机位不合法：${problem.message}`);
        patch = { ...patch, camera: parsed.data };
      }
      const shots = current.shots.map((shot) =>
        shot.id === event.shotId ? { ...shot, ...patch } : shot,
      );
      return { ...current, shots };
    }

    case "scene.updated": {
      if (!current) throw new Error("scene.updated 之前必须有 project.created");
      if (!current.scenes.some((scene) => scene.id === event.sceneId)) {
        throw new Error(`scene.updated 指向不存在的场次: ${event.sceneId}`);
      }
      if (Object.keys(event.patch).length === 0) {
        throw new Error("scene.updated 的 patch 是空的");
      }
      if (
        event.patch.locationId !== undefined &&
        !current.locations.some((location) => location.id === event.patch.locationId)
      ) {
        throw new Error(`scene.updated 指向不存在的地点: ${event.patch.locationId}`);
      }
      if (event.patch.code !== undefined) {
        const code = event.patch.code;
        if (code !== "" && !/^[0-9A-Za-z]{1,4}$/.test(code)) {
          throw new Error(`scene.updated 的场号只能是 1–4 位字母数字: ${code}`);
        }
        if (
          code !== "" &&
          current.scenes.some((scene) => scene.id !== event.sceneId && scene.code === code)
        ) {
          throw new Error(`scene.updated 的场号重复: ${code}`);
        }
      }
      const scenes = current.scenes.map((scene) =>
        scene.id === event.sceneId ? { ...scene, ...event.patch } : scene,
      );
      return { ...current, scenes };
    }

    case "scene.added": {
      if (!current) throw new Error("scene.added 之前必须有 project.created");
      const scene = event.scene;
      if (current.scenes.some((item) => item.id === scene.id)) {
        throw new Error(`scene.added 重复的场次: ${scene.id}`);
      }
      if (!current.locations.some((location) => location.id === scene.locationId)) {
        throw new Error(`scene.added 指向不存在的地点: ${scene.locationId}`);
      }
      if (
        !Number.isInteger(scene.index) ||
        scene.index < 0 ||
        scene.index > current.scenes.length
      ) {
        throw new Error(`新建场次的位置越界: ${scene.index} / ${current.scenes.length}`);
      }
      if (scene.shotIds.length > 0) {
        throw new Error("新建场次不该带镜头：先用 shot.added 一镜一镜加");
      }
      // 插在指定位置，后面的场次顺次后移：场号始终连续
      const ordered = [...current.scenes].sort((a, b) => a.index - b.index);
      ordered.splice(scene.index, 0, scene);
      return { ...current, scenes: ordered.map((item, index) => ({ ...item, index })) };
    }

    case "shot.added": {
      if (!current) throw new Error("shot.added 之前必须有 project.created");
      const shot = event.shot;
      if (current.shots.some((item) => item.id === shot.id)) {
        throw new Error(`shot.added 重复的镜头: ${shot.id}`);
      }
      const scene = current.scenes.find((item) => item.id === shot.sceneId);
      if (!scene) throw new Error(`shot.added 指向不存在的场次: ${shot.sceneId}`);
      if (
        !Number.isInteger(shot.index) ||
        shot.index < 0 ||
        shot.index > scene.shotIds.length
      ) {
        throw new Error(
          `新建镜头的位置越界: ${shot.index} / ${scene.shotIds.length}`,
        );
      }
      if (shot.dialogueIds.length > 0 || shot.takeIds.length > 0) {
        throw new Error("新建镜头不该带台词或 take：那样就能绕过各自的添加事件");
      }
      // 插在指定位置，这一场后面的镜头顺次后移：镜号始终连续
      const shotIds = [...scene.shotIds];
      shotIds.splice(shot.index, 0, shot.id);
      const scenes = current.scenes.map((item) =>
        item.id === scene.id ? { ...item, shotIds } : item,
      );
      const shots = current.shots.map((item) =>
        item.sceneId === scene.id ? { ...item, index: shotIds.indexOf(item.id) } : item,
      );
      return { ...current, scenes, shots: [...shots, shot] };
    }

    case "scene.moved": {
      if (!current) throw new Error("scene.moved 之前必须有 project.created");
      const ordered = [...current.scenes].sort((a, b) => a.index - b.index);
      const from = ordered.findIndex((scene) => scene.id === event.sceneId);
      if (from < 0) {
        throw new Error(`scene.moved 指向不存在的场次: ${event.sceneId}`);
      }
      if (
        !Number.isInteger(event.toIndex) ||
        event.toIndex < 0 ||
        event.toIndex >= ordered.length
      ) {
        throw new Error(`scene.moved 的目标位置越界: ${event.toIndex}`);
      }
      if (event.toIndex === from) {
        throw new Error(`场次 ${event.sceneId} 已经在这个位置`);
      }
      const [moved] = ordered.splice(from, 1);
      ordered.splice(event.toIndex, 0, moved!);
      const scenes = ordered.map((scene, index) => ({ ...scene, index }));
      return { ...current, scenes };
    }

    case "scene.removed": {
      if (!current) throw new Error("scene.removed 之前必须有 project.created");
      const scene = current.scenes.find((item) => item.id === event.sceneId);
      if (!scene) {
        throw new Error(`scene.removed 指向不存在的场次: ${event.sceneId}`);
      }
      // 先删镜头、再删场：这样回放到任一前缀都不会有镜头挂在不存在的场次上
      if (scene.shotIds.length > 0) {
        throw new Error(
          `scene.removed 还有 ${scene.shotIds.length} 镜在这场: ${event.sceneId}`,
        );
      }
      const scenes = current.scenes
        .filter((item) => item.id !== event.sceneId)
        .sort((a, b) => a.index - b.index)
        .map((item, index) => ({ ...item, index }));
      return { ...current, scenes };
    }

    case "shot.removed": {
      if (!current) throw new Error("shot.removed 之前必须有 project.created");
      const shot = current.shots.find((item) => item.id === event.shotId);
      if (!shot) {
        throw new Error(`shot.removed 指向不存在的镜头: ${event.shotId}`);
      }
      const scene = current.scenes.find((item) => item.id === shot.sceneId);
      if (!scene) {
        throw new Error(`shot.removed 的镜头挂在不存在的场次: ${shot.sceneId}`);
      }
      const dialogueIds = new Set(shot.dialogueIds);
      const takeIds = new Set(shot.takeIds);
      return {
        ...current,
        // 台词、take、时间线项都是镜头的从属物：镜头没了，它们也没有地方挂
        dialogue: current.dialogue.filter((line) => !dialogueIds.has(line.id)),
        takes: current.takes.filter((take) => take.shotId !== event.shotId),
        timeline: {
          ...current.timeline,
          items: current.timeline.items.filter(
            (item) => item.shotId !== event.shotId && !takeIds.has(item.takeId),
          ),
        },
        shots: current.shots
          .filter((item) => item.id !== event.shotId)
          .map((item) =>
            item.sceneId !== shot.sceneId
              ? item
              : {
                  ...item,
                  // 这一场里后面的镜号往前补，保持连续
                  index: scene.shotIds
                    .filter((id) => id !== event.shotId)
                    .indexOf(item.id),
                },
          ),
        scenes: current.scenes.map((item) =>
          item.id === shot.sceneId
            ? { ...item, shotIds: item.shotIds.filter((id) => id !== event.shotId) }
            : item,
        ),
      };
    }

    case "location.added": {
      if (!current) throw new Error("location.added 之前必须有 project.created");
      if (event.location.name.trim().length === 0) throw new Error("地点总得有个名字");
      if (current.locations.some((location) => location.id === event.location.id)) {
        throw new Error(`location.added 重复的地点: ${event.location.id}`);
      }
      return { ...current, locations: [...current.locations, event.location] };
    }

    case "location.updated": {
      if (!current) throw new Error("location.updated 之前必须有 project.created");
      if (!current.locations.some((location) => location.id === event.locationId)) {
        throw new Error(`location.updated 指向不存在的地点: ${event.locationId}`);
      }
      if (Object.keys(event.patch).length === 0) {
        throw new Error("location.updated 的 patch 是空的");
      }
      if (event.patch.name !== undefined && event.patch.name.trim().length === 0) {
        throw new Error("地点总得有个名字");
      }
      // 场地几何（B13）：尺寸必须为正，锚点必须落在场地里；null 表示清掉
      let patch: Partial<Location> = {};
      if (event.patch.name !== undefined) patch.name = event.patch.name;
      if (event.patch.templateId !== undefined) patch.templateId = event.patch.templateId;
      if (event.patch.description !== undefined) patch.description = event.patch.description;
      if (event.patch.space !== undefined && event.patch.space !== null) {
        const parsed = LocationSpaceSchema.safeParse(event.patch.space);
        if (!parsed.success) {
          throw new Error(`场地几何不合法：${parsed.error.issues[0]?.message ?? "未知原因"}`);
        }
        const problem = spaceProblem(parsed.data);
        if (problem) throw new Error(`场地几何不合法：${problem.message}`);
        patch = { ...patch, space: parsed.data };
      }
      const clearSpace = event.patch.space === null;
      const locations = current.locations.map((location) => {
        if (location.id !== event.locationId) return location;
        const merged: Location = { ...location, ...patch };
        if (clearSpace) delete merged.space;
        return merged;
      });
      return { ...current, locations };
    }

    case "location.removed": {
      if (!current) throw new Error("location.removed 之前必须有 project.created");
      if (!current.locations.some((location) => location.id === event.locationId)) {
        throw new Error(`location.removed 指向不存在的地点: ${event.locationId}`);
      }
      const used = current.scenes.filter((scene) => scene.locationId === event.locationId);
      if (used.length > 0) {
        throw new Error(
          `location.removed 还有 ${used.length} 场在这个地点: ${event.locationId}`,
        );
      }
      return {
        ...current,
        locations: current.locations.filter((location) => location.id !== event.locationId),
      };
    }

    case "character.added": {
      if (!current) throw new Error("character.added 之前必须有 project.created");
      if (event.character.name.trim().length === 0) throw new Error("人物总得有个名字");
      if (current.characters.some((character) => character.id === event.character.id)) {
        throw new Error(`character.added 重复的人物: ${event.character.id}`);
      }
      return { ...current, characters: [...current.characters, event.character] };
    }

    case "character.updated": {
      if (!current) throw new Error("character.updated 之前必须有 project.created");
      if (!current.characters.some((character) => character.id === event.characterId)) {
        throw new Error(`character.updated 指向不存在的人物: ${event.characterId}`);
      }
      if (Object.keys(event.patch).length === 0) {
        throw new Error("character.updated 的 patch 是空的");
      }
      if (event.patch.name !== undefined && event.patch.name.trim().length === 0) {
        throw new Error("人物总得有个名字");
      }
      if (event.patch.mustNotChange !== undefined) {
        const items = event.patch.mustNotChange;
        if (items.some((item) => item.trim().length === 0)) {
          throw new Error("character.updated 的 mustNotChange 里有空条目");
        }
        if (new Set(items).size !== items.length) {
          throw new Error("character.updated 的 mustNotChange 有重复条目");
        }
        if (items.some((item) => item.length > MUST_NOT_CHANGE_MAX)) {
          throw new Error(`character.updated 的 mustNotChange 单条超过 ${MUST_NOT_CHANGE_MAX} 字`);
        }
        if (items.length > MUST_NOT_CHANGE_COUNT_MAX) {
          throw new Error(
            `character.updated 的 mustNotChange 超过 ${MUST_NOT_CHANGE_COUNT_MAX} 条`,
          );
        }
      }
      if (event.patch.referenceImages !== undefined) {
        checkReferenceImages(event.patch.referenceImages, current.assets, "character.updated");
      }
      if (
        event.patch.voiceProfileId !== undefined &&
        event.patch.voiceProfileId.trim().length > VOICE_PROFILE_MAX
      ) {
        throw new Error(
          `character.updated 的 voiceProfileId 超过 ${VOICE_PROFILE_MAX} 字`,
        );
      }
      const characters = current.characters.map((character) => {
        if (character.id !== event.characterId) return character;
        const merged = { ...character, ...event.patch };
        // 空串表示「用回默认音色」：删掉这个键，而不是留一个空音色
        if (event.patch.voiceProfileId === "") delete merged.voiceProfileId;
        return merged;
      });
      return { ...current, characters };
    }

    case "prop.added": {
      if (!current) throw new Error("prop.added 之前必须有 project.created");
      if (event.prop.name.trim().length === 0) throw new Error("道具总得有个名字");
      if (current.props.some((prop) => prop.id === event.prop.id)) {
        throw new Error(`prop.added 重复的道具: ${event.prop.id}`);
      }
      return { ...current, props: [...current.props, event.prop] };
    }

    case "prop.updated": {
      if (!current) throw new Error("prop.updated 之前必须有 project.created");
      if (!current.props.some((prop) => prop.id === event.propId)) {
        throw new Error(`prop.updated 指向不存在的道具: ${event.propId}`);
      }
      if (Object.keys(event.patch).length === 0) {
        throw new Error("prop.updated 的 patch 是空的");
      }
      if (event.patch.name !== undefined && event.patch.name.trim().length === 0) {
        throw new Error("道具总得有个名字");
      }
      if (event.patch.referenceImages !== undefined) {
        checkReferenceImages(event.patch.referenceImages, current.assets, "prop.updated");
      }
      const props = current.props.map((prop) =>
        prop.id === event.propId ? { ...prop, ...event.patch } : prop,
      );
      return { ...current, props };
    }

    case "character.removed": {
      if (!current) throw new Error("character.removed 之前必须有 project.created");
      if (!current.characters.some((character) => character.id === event.characterId)) {
        throw new Error(`character.removed 指向不存在的人物: ${event.characterId}`);
      }
      const inShots = current.shots.filter((shot) =>
        shot.characterIds.includes(event.characterId),
      );
      if (inShots.length > 0) {
        throw new Error(
          `character.removed 还有 ${inShots.length} 镜点着这个人: ${event.characterId}`,
        );
      }
      const speaking = current.dialogue.filter(
        (line) => line.characterId === event.characterId,
      );
      if (speaking.length > 0) {
        throw new Error(
          `character.removed 还有 ${speaking.length} 句台词属于这个人: ${event.characterId}`,
        );
      }
      return {
        ...current,
        characters: current.characters.filter((character) => character.id !== event.characterId),
      };
    }

    case "prop.removed": {
      if (!current) throw new Error("prop.removed 之前必须有 project.created");
      if (!current.props.some((prop) => prop.id === event.propId)) {
        throw new Error(`prop.removed 指向不存在的道具: ${event.propId}`);
      }
      const used = current.shots.filter((shot) => shot.propIds.includes(event.propId));
      if (used.length > 0) {
        throw new Error(`prop.removed 还有 ${used.length} 镜用着这件道具: ${event.propId}`);
      }
      return { ...current, props: current.props.filter((prop) => prop.id !== event.propId) };
    }

    case "dialogue.updated": {
      if (!current) throw new Error("dialogue.updated 之前必须有 project.created");
      const line = current.dialogue.find((item) => item.id === event.lineId);
      if (!line) {
        throw new Error(`dialogue.updated 指向不存在的台词: ${event.lineId}`);
      }
      if (event.patch.text !== undefined && event.patch.text.trim().length === 0) {
        throw new Error("台词不能改成空");
      }
      if (event.patch.durationMs !== undefined && !(event.patch.durationMs > 0)) {
        throw new Error(`台词时长必须大于 0：${event.patch.durationMs}`);
      }
      if (event.patch.audioAssetId !== undefined) {
        const asset = current.assets.find((item) => item.id === event.patch.audioAssetId);
        if (!asset) {
          throw new Error(`dialogue.updated 指向不存在的配音资产: ${event.patch.audioAssetId}`);
        }
        if (asset.kind !== "audio") {
          throw new Error(`dialogue.updated 的配音资产不是音频: ${asset.id}`);
        }
      }
      const dialogue = current.dialogue.map((item) =>
        item.id === event.lineId ? { ...item, ...event.patch } : item,
      );
      return { ...current, dialogue };
    }

    case "dialogue.speaker.updated": {
      if (!current) throw new Error("dialogue.speaker.updated 之前必须有 project.created");
      const line = current.dialogue.find((item) => item.id === event.lineId);
      if (!line) {
        throw new Error(`dialogue.speaker.updated 指向不存在的台词: ${event.lineId}`);
      }
      if (!current.characters.some((item) => item.id === event.characterId)) {
        throw new Error(`dialogue.speaker.updated 指向不存在的角色: ${event.characterId}`);
      }
      if (line.characterId === event.characterId) {
        throw new Error(`台词 ${event.lineId} 已经是 ${event.characterId} 说的`);
      }
      return {
        ...current,
        dialogue: current.dialogue.map((item) =>
          item.id === event.lineId ? { ...item, characterId: event.characterId } : item,
        ),
      };
    }

    case "dialogue.added": {
      if (!current) throw new Error("dialogue.added 之前必须有 project.created");
      if (current.dialogue.some((item) => item.id === event.line.id)) {
        throw new Error(`dialogue.added 的台词 id 已存在: ${event.line.id}`);
      }
      const shot = current.shots.find((item) => item.id === event.shotId);
      if (!shot) {
        throw new Error(`dialogue.added 指向不存在的镜头: ${event.shotId}`);
      }
      if (event.line.text.trim().length === 0 || !(event.line.durationMs > 0)) {
        throw new Error("dialogue.added 的台词必须是正时长且非空");
      }
      return {
        ...current,
        dialogue: [...current.dialogue, event.line],
        shots: current.shots.map((item) =>
          item.id === event.shotId
            ? { ...item, dialogueIds: [...item.dialogueIds, event.line.id] }
            : item,
        ),
      };
    }

    case "dialogue.removed": {
      if (!current) throw new Error("dialogue.removed 之前必须有 project.created");
      if (!current.dialogue.some((item) => item.id === event.lineId)) {
        throw new Error(`dialogue.removed 指向不存在的台词: ${event.lineId}`);
      }
      return {
        ...current,
        dialogue: current.dialogue.filter((item) => item.id !== event.lineId),
        // 台词没了，它的手动断句也没地方落，一起摘掉（D2）
        subtitleOverrides: current.subtitleOverrides.filter(
          (override) => override.lineId !== event.lineId,
        ),
        shots: current.shots.map((item) =>
          item.dialogueIds.includes(event.lineId)
            ? { ...item, dialogueIds: item.dialogueIds.filter((id) => id !== event.lineId) }
            : item,
        ),
      };
    }

    case "subtitle.updated": {
      if (!current) throw new Error("subtitle.updated 之前必须有 project.created");
      if (!current.dialogue.some((item) => item.id === event.lineId)) {
        throw new Error(`subtitle.updated 指向不存在的台词: ${event.lineId}`);
      }
      const rest = current.subtitleOverrides.filter(
        (override) => override.lineId !== event.lineId,
      );
      const next =
        event.cues === null
          ? rest
          : [...rest, { lineId: event.lineId, cues: event.cues }];
      if (event.cues !== null) {
        const empty = event.cues.some((cue) => cue.text.trim().length === 0);
        if (empty) throw new Error("subtitle.updated 的每条字幕都要有字");
        if (event.cues.some((cue) => cue.durationMs <= 0)) {
          throw new Error("subtitle.updated 的每条字幕都要有正时长");
        }
      }
      return { ...current, subtitleOverrides: next };
    }

    case "take.updated": {
      if (!current) throw new Error("take.updated 之前必须有 project.created");
      if (!current.takes.some((take) => take.id === event.takeId)) {
        throw new Error(`take.updated 指向不存在的 take: ${event.takeId}`);
      }
      const takes = current.takes.map((take) =>
        take.id === event.takeId ? { ...take, ...event.patch } : take,
      );
      return { ...current, takes };
    }

    case "approval.updated": {
      if (!current) throw new Error("approval.updated 之前必须有 project.created");
      const exists = current.approvals.some(
        (item) =>
          item.id === event.approval.id ||
          (item.targetType === event.approval.targetType &&
            item.targetId === event.approval.targetId),
      );
      const approvals = exists
        ? current.approvals.map((item) =>
            item.id === event.approval.id ||
            (item.targetType === event.approval.targetType &&
              item.targetId === event.approval.targetId)
              ? event.approval
              : item,
          )
        : [...current.approvals, event.approval];
      return { ...current, approvals };
    }

    case "asset.updated": {
      if (!current) throw new Error("asset.updated 之前必须有 project.created");
      const exists = current.assets.some((item) => item.id === event.asset.id);
      const assets = exists
        ? current.assets.map((item) =>
            item.id === event.asset.id ? { ...item, ...event.asset } : item,
          )
        : [...current.assets, event.asset];
      return { ...current, assets };
    }

    case "take.added": {
      if (!current) throw new Error("take.added 之前必须有 project.created");
      const shots = current.shots.map((shot) =>
        shot.id === event.take.shotId
          ? { ...shot, takeIds: [...shot.takeIds, event.take.id] }
          : shot,
      );
      return {
        ...current,
        shots,
        takes: [...current.takes, event.take],
      };
    }

    case "take.removed": {
      if (!current) throw new Error("take.removed 之前必须有 project.created");
      const take = current.takes.find((item) => item.id === event.takeId);
      if (!take) {
        throw new Error(`take.removed 指向不存在的 take: ${event.takeId}`);
      }
      return {
        ...current,
        // 镜头上的 takeIds 与时间线项都跟着摘掉，否则回放会出现悬空引用
        shots: current.shots.map((shot) =>
          shot.id === take.shotId
            ? { ...shot, takeIds: shot.takeIds.filter((id) => id !== event.takeId) }
            : shot,
        ),
        takes: current.takes.filter((item) => item.id !== event.takeId),
        timeline: {
          ...current.timeline,
          items: current.timeline.items.filter((item) => item.takeId !== event.takeId),
        },
      };
    }

    case "gate.confirmed": {
      if (!current) throw new Error("gate.confirmed 之前必须有 project.created");
      if (!/^[0-9a-f]{8}$/.test(event.signature)) {
        throw new Error(`gate.confirmed 的签名不是 8 位十六进制: ${event.signature}`);
      }
      const note = event.note?.trim() ?? "";
      if (note.length > GATE_NOTE_MAX) {
        throw new Error(`gate.confirmed 的备注超过 ${GATE_NOTE_MAX} 字`);
      }
      const record = {
        stage: event.stage,
        signature: event.signature,
        at: event.at,
        note,
        override: event.override === true,
      };
      const exists = current.gates.some((gate) => gate.stage === event.stage);
      const gates = exists
        ? current.gates.map((gate) => (gate.stage === event.stage ? record : gate))
        : [...current.gates, record];
      return { ...current, gates };
    }

    case "gate.reopened": {
      if (!current) throw new Error("gate.reopened 之前必须有 project.created");
      return {
        ...current,
        gates: current.gates.filter((gate) => gate.stage !== event.stage),
      };
    }

    case "timeline.updated": {
      if (!current) throw new Error("timeline.updated 之前必须有 project.created");
      checkTimeline(event.items, current);
      return {
        ...current,
        timeline: { ...current.timeline, items: event.items.map((item) => ({ ...item })) },
      };
    }

    case "timeline.music.updated": {
      if (!current) throw new Error("timeline.music.updated 之前必须有 project.created");
      checkMusic(event.music, current);
      return {
        ...current,
        timeline: {
          ...current.timeline,
          music: event.music.map((cue) => ({ ...cue })),
        },
      };
    }

    case "publish.recorded": {
      if (!current) throw new Error("publish.recorded 之前必须有 project.created");
      const pack = event.package;
      if (!pack?.id) throw new Error("publish.recorded 缺少发布包 id");
      if (current.publishPackages.some((item) => item.id === pack.id)) {
        throw new Error(`publish.recorded 有重复的发布包 id: ${pack.id}`);
      }
      if (!pack.platform?.trim()) throw new Error("publish.recorded 缺少平台");
      // AI 标识不能靠界面补：缺了就直接拒绝，别让 IR 处于无效状态（准则 P16）
      if (!pack.aiLabel?.explicit || !pack.aiLabel?.implicit) {
        throw new Error(`发布包 ${pack.id} 缺少显式 / 隐式 AI 标识`);
      }
      if (
        pack.bytes !== undefined &&
        (!Number.isInteger(pack.bytes) || pack.bytes < 0)
      ) {
        throw new Error(`发布包 ${pack.id} 的字节数不合法: ${pack.bytes}`);
      }
      return {
        ...current,
        publishPackages: [...current.publishPackages, clone(pack)],
      };
    }

    case "project.restored": {
      // 这一条的目标是「日志前缀」，单条 applyEvent 看不到前缀，猜不得：
      // 静默返回 current 会让增量应用悄悄跑偏，只能让调用方换成 rebuild。
      throw new Error(
        "project.restored 需要整条日志才能定位到前缀：请用 rebuild 回放，不要逐条 applyEvent",
      );
    }
  }
}

/**
 * 从头回放整条日志，返回「每一步之后」的项目。
 *
 * `project.restored` 是唯一不能靠 `applyEvent` 单条应用的事件：它指向日志前缀，
 * 所以这里逐条记下每个位置跑出来的项目（结构共享，数组本身占用很小），
 * 遇到回滚就直接取前缀那一步的结果。前缀永远回放得出同一个结果，
 * 因为日志只追加、从不删改（ADR-0011 / ADR-0109）。
 *
 * 历史抽屉与回收站要显示「当时它叫什么」，也靠这份数组。
 */
export function rebuildStates(events: ProjectEvent[]): Project[] {
  if (events.length === 0) throw new Error("事件日志为空");

  const states: Project[] = [];
  for (const [index, event] of events.entries()) {
    const previous = index > 0 ? states[index - 1]! : null;
    if (event.type === "project.restored") {
      const target = event.toEventCount;
      if (!Number.isInteger(target) || target < 1 || target > index) {
        throw new Error(
          `project.restored 的目标不合法：${target}（要落在 1–${index} 之间）`,
        );
      }
      // 回滚只指向前面的日志，所以这一步一定已经算过。
      // 版本号同样 +1：回到旧内容也是一次状态变更，否则「v 几」会往回跳。
      states.push({ ...states[target - 1]!, version: previous!.version + 1 });
      continue;
    }
    if (!previous && event.type !== "project.created") {
      throw new Error(`${event.type} 之前必须有 project.created`);
    }
    states.push(applyEvent(previous, event));
  }
  return states;
}

/** 当前项目：整条日志回放的最后一步。 */
export function rebuild(events: ProjectEvent[]): Project {
  return rebuildStates(events).at(-1)!;
}
