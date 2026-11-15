import {
  assertValidProject,
  SHEET_LABELS,
  shotAnchors,
  type ActionBeat,
  type Character,
  type Composition,
  type GazeTarget,
  type Id,
  type Lighting,
  type Location,
  type Look,
  type Project,
  type ProjectSkill,
  type Prop,
  type SheetView,
  type Shot,
  type StagingMark,
  type Take,
} from "@loomina/ir";
import type { ImageAdapter, VideoAdapter, VideoJob } from "@loomina/gateway";
import { sceneTemplateById, sceneTemplatePrompt, type SceneTemplate } from "./scene-templates";
import { compileLook, compileStudioLook } from "./look";
import { compileSkills } from "./skills";
import { compileComposition, compileLighting } from "./language";

export * from "./dialogue";
export * from "./story";
export * from "./story-kit";
export * from "./scene-templates";
export * from "./blocking";
export * from "./elevation";
export * from "./structure";

export interface PriceTable {
  imageCny: number;
  videoPerSecondCny: number;
}

export const DEFAULT_PRICES: PriceTable = {
  imageCny: 0.3,
  videoPerSecondCny: 1.5,
};

export interface LedgerEntry {
  shotId: Id;
  modelId: string;
  cny: number;
}

export interface RunResult {
  project: Project;
  ledger: LedgerEntry[];
  totalCny: number;
}

export interface RunOptions {
  image: ImageAdapter;
  video: VideoAdapter;
  prices?: PriceTable;
  now?: () => string;
  imageSize?: string;
  videoResolution?: string;
  /**
   * 纯文生视频：跳过关键帧。
   * 只在关键帧接口不可用时用来单独验证视频通路，不是常规生产方式（P4 关键帧先行）。
   */
  textOnly?: boolean;
  /**
   * 视频任务等多久算超时（毫秒），默认 5 分钟。
   *
   * `poll` 只查一次、不等待（供应商侧是异步任务）；所以这里必须有循环，
   * 否则刚提交就拿到 `queued`，会被当成失败——那是工具的错，不是供应商的错。
   */
  videoTimeoutMs?: number;
  /** 两次轮询之间等多久（毫秒），默认 3 秒 */
  videoPollIntervalMs?: number;
  /**
   * 提交前压首帧（可选）。
   *
   * `POST /v1/videos` 的首帧走 `image_url` 的 data URI，代理按单个 part 限 1024 KB；
   * 一张 1024×1536 的 PNG 有 1.2 MB，base64 后约 1.6 MB，直接被 400 拒掉
   * （2026-11-15 实测：`Part exceeded maximum size of 1024KB.`）。
   *
   * pipeline 是纯函数包，不自己 spawn ffmpeg；由调用方注入压缩实现，
   * 压不动就原样返回，让供应商如实拒绝。
   */
  compressFrame?: (uri: string) => Promise<string>;
}

export interface ShotRunResult {
  shotId: Id;
  take: Take;
  ledger: LedgerEntry[];
  costCny: number;
  imageUri?: string;
  videoUri: string;
  /** 这一镜带进生成的参考图（ADR-0029） */
  anchorAssetIds: Id[];
}

/** 锚点不齐就不生成：宁可不拍，也不拍一张"另一个人"的图（ADR-0029）。 */
export class AnchorError extends Error {
  constructor(
    readonly shotId: Id,
    readonly missing: string[],
  ) {
    super(`镜头 ${shotId} 的资产锚点不齐：${missing.join("；")}`);
    this.name = "AnchorError";
  }
}

/**
 * S0 最小链路：校验 → 关键帧 → 视频 → 写回 Take + 记账。
 * 用来证明“契约能承载一条最小生产链路”，不追求质量。
 */
export async function runMinimalChain(
  project: Project,
  options: RunOptions,
): Promise<RunResult> {
  assertValidProject(project);

  const newTakes: Take[] = [];
  const ledger: LedgerEntry[] = [];

  for (const shot of project.shots) {
    const result = await runShot(project, shot, options);
    newTakes.push(result.take);
    ledger.push(...result.ledger);
  }

  const takeByShot = new Map(newTakes.map((take) => [take.shotId, take]));
  const shots = project.shots.map((shot) => {
    const take = takeByShot.get(shot.id);
    return take ? { ...shot, takeIds: [...shot.takeIds, take.id] } : shot;
  });

  const updated: Project = {
    ...project,
    // 这里是直接构造 Project（探针与测试用），不经过事件总线。
    // 接进工作流时，出片结果应以事件落进日志，由 applyEvent 统一按事件计版本，
    // 否则两次 +1 会让版本跳号（F1 / ADR-0113）。
    version: project.version + 1,
    shots,
    takes: [...project.takes, ...newTakes],
  };

  assertValidProject(updated);

  return {
    project: updated,
    ledger,
    totalCny: round2(ledger.reduce((sum, entry) => sum + entry.cny, 0)),
  };
}

/**
 * 单个镜头：关键帧 → 视频 → Take。
 *
 * 单独抽出来，是因为探针（S1 能力测绘）需要“一次失败不影响其他镜头”，
 * 而链路函数应该“一失败就停”。两种语义不该混在一个函数里。
 */
/**
 * 等到视频任务进入终态（succeeded / failed）。
 *
 * `poll` 只查一次；供应商侧的视频是异步任务，刚提交时状态是 `queued`。
 * 早先这里只 poll 一次就判失败，导致「接口 200、任务在排队」被误报成生成失败
 * （2026-11-15 实测发现）。现在按间隔重试到超时。
 */
async function waitForVideo(
  options: RunOptions,
  shotId: Id,
  jobId: string,
): Promise<VideoJob> {
  const timeoutMs = options.videoTimeoutMs ?? 5 * 60_000;
  const intervalMs = options.videoPollIntervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  let job = await options.video.poll(jobId);
  while (job.status === "queued" || job.status === "running") {
    if (Date.now() >= deadline) {
      return {
        ...job,
        status: "failed",
        error: `等了 ${Math.round(timeoutMs / 1000)} 秒还没出片（最后状态 ${job.status}）`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    job = await options.video.poll(jobId);
  }
  return job;
}

export async function runShot(
  project: Project,
  shot: Shot,
  options: RunOptions,
): Promise<ShotRunResult> {
  const prices = options.prices ?? DEFAULT_PRICES;
  const anchors = shotAnchors(project, shot);
  if (anchors.missing.length) throw new AnchorError(shot.id, anchors.missing);

  const prompt = buildShotPrompt(project, shot);

  const frame = options.textOnly
    ? undefined
    : await options.image.generate({
        shotId: shot.id,
        prompt,
        referenceAssetIds: anchors.assetIds,
        ...(options.imageSize ? { size: options.imageSize } : {}),
      });

  const imageUri = frame && options.compressFrame
    ? await options.compressFrame(frame.uri)
    : frame?.uri;

  const { jobId } = await options.video.submit({
    shotId: shot.id,
    ...(frame ? { imageAssetId: frame.assetId, imageUri } : {}),
    durationMs: shot.durationMs,
    prompt,
    ...(options.videoResolution ? { resolution: options.videoResolution } : {}),
  });

  const job = await waitForVideo(options, shot.id, jobId);
  if (job.status !== "succeeded") {
    throw new Error(`镜头 ${shot.id} 生成失败：${job.error ?? job.status}`);
  }
  const video = job.output ?? (await options.video.fetch(jobId));

  const imageCny = frame ? round2(frame.costCny ?? prices.imageCny) : 0;
  const videoCny = round2(
    video.costCny ?? (shot.durationMs / 1000) * prices.videoPerSecondCny,
  );

  const take: Take = {
    id: `take-${shot.id}-${video.assetId}`,
    shotId: shot.id,
    assetId: video.assetId,
    provenance: video.provenance,
    status: "draft",
    costCny: round2(imageCny + videoCny),
  };

  return {
    shotId: shot.id,
    take,
    ledger: [
      ...(frame
        ? [{ shotId: shot.id, modelId: frame.provenance.modelId, cny: imageCny }]
        : []),
      { shotId: shot.id, modelId: video.provenance.modelId, cny: videoCny },
    ],
    costCny: take.costCny ?? 0,
    ...(frame ? { imageUri: frame.uri } : {}),
    videoUri: video.uri,
    anchorAssetIds: anchors.assetIds,
  };
}

export const SHOT_SIZE_CN: Record<Shot["shotSize"], string> = {
  wide: "全景",
  medium: "中景",
  close: "特写",
  "extreme-close": "大特写",
};

export const SHOT_ANGLE_CN: Record<Shot["camera"]["angle"], string> = {
  eye: "平视",
  low: "仰拍",
  high: "俯拍",
  top: "顶拍",
  // 荷兰角：画面沿光轴滚转，人物与地平线一起歪
  dutch: "荷兰角",
};

/** 运镜的中文长说法（进提示词）；表格里的短词在 web 侧另有一份 */
export const MOVE_CN: Record<Shot["camera"]["movement"], string> = {
  static: "固定机位",
  push: "缓缓推近",
  pull: "缓缓拉远",
  pan: "横移",
  tilt: "升降",
  handheld: "手持轻微晃动",
};

/**
 * 镜头提示词：先写“看到什么”，再写人物锚点与技术参数。
 *
 * 人物的描述与 `mustNotChange` 用固定串原样带上——每次改写描述，
 * 模型就会把它当成另一个人（CONSISTENCY.md 第三层）。
 */
/** 镜头提示词的原料：只收业务字段，不收 id——服务端不接受资产 id（ADR-0032）。 */
export type ShotPromptMaterial = {
  description: string;
  shotSize: Shot["shotSize"];
  camera: Shot["camera"];
  /** 一句话指令落下的补充要求（ADR-0039）；没有就不带 */
  notes?: string[];
  characters: Pick<Character, "name" | "appearance" | "mustNotChange">[];
  location?: {
    name: string;
    /** 场景模板（B15 / ADR-0103）：给提示词补空间、主光与锚点 */
    template?: SceneTemplate;
  };
  props: Pick<Prop, "name" | "description">[];
  /** 这一镜的台词（A5 / ADR-0107）：只进视频提示词，不进首尾帧——静帧不烧字幕 */
  dialogue?: DialoguePrompt[];
  /** 表演设计（B16 / B17）：先翻成人话，再由 shotParts 拼进去 */
  performance?: PerformancePrompt;
  /** 镜头内调度（B17）：角色 / 道具在画面的左右与前后 */
  staging?: StagingPrompt[];
  /** 生成首帧 / 尾帧时要对上的那一拍（B16 不变量 24） */
  frameBeat?: ActionBeat;
  /**
   * 画面风格与摄影参数（B7 / I5，ADR-0165）：提示词最后一句由它编译。
   * 不传就是默认档，编译结果与以前逐字一致。
   */
  look?: Look;
  /** 光影模板（I2）：这一镜的光从哪来；不传就不带这一句 */
  lighting?: Lighting;
  /** 构图模板（I4）：主体放在哪；不传就不带这一句 */
  composition?: Composition;
  /**
   * 接上一段（C.6）：上一段的收尾描述与要回头的时长。
   * 由 `shotMaterial` 按时间线顺序补上，调用方不用自己找上一镜。
   */
  continuation?: { previous: string; tailMs: number };
};

export type PerformancePrompt = {
  objective: string;
  surface: string;
  subtext: string;
  intensity: number;
  gaze: GazeTarget;
  avoid: string[];
  /** 起 / 转 / 落；按时间排序 */
  beats: ActionBeat[];
  /** 视线对象与调度对象翻成名字：提示词里不能出现 id */
  gazeName?: string;
};

export type StagingPrompt = {
  name: string;
  side: StagingMark["side"];
  depth: StagingMark["depth"];
  note: string;
};

/** 送进视频提示词的一句台词：说话人用名字，不用 id。 */
export type DialoguePrompt = {
  speaker: string;
  text: string;
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

const GAZE_TARGET_CN: Record<GazeTarget["target"], string> = {
  character: "看人",
  prop: "看道具",
  camera: "看镜头",
  "off-screen": "看画外",
};

const GAZE_DIRECTION_CN: Record<GazeTarget["direction"], string> = {
  left: "向左",
  right: "向右",
  up: "向上",
  down: "向下",
  center: "向前",
};

const BEAT_PHASE_CN: Record<ActionBeat["phase"], string> = {
  before: "起",
  during: "转",
  after: "落",
};

/**
 * 时间线 / 分镜里排在 `shotId` 前一段的那一镜（C.6 / ADR-0192）。
 *
 * 以时间线为准（成片的先后才是观众看到的先后）；这一镜还没排进时间线时，
 * 退回分镜数组的先后。第一段没有上一段，返回 undefined。
 */
export function previousShotOf(project: Project, shotId: Id): Shot | undefined {
  const ordered = [...project.timeline.items]
    .sort((a, b) => a.startMs - b.startMs)
    .map((item) => item.shotId);
  const inTimeline = ordered.indexOf(shotId);
  // 排进时间线就按时间线算：第一条就是片头，没有上一段，
  // 不能退回分镜数组去找「排在它前面」的那一镜（成片里它并不在前面）。
  if (inTimeline === 0) return undefined;
  if (inTimeline > 0) {
    const id = ordered[inTimeline - 1]!;
    return project.shots.find((shot) => shot.id === id);
  }
  const inShots = project.shots.findIndex((shot) => shot.id === shotId);
  if (inShots > 0) return project.shots[inShots - 1];
  return undefined;
}

/** 把项目里的 id 解析成提示词原料。 */
export function shotMaterial(
  project: Project,
  shot: Shot,
  options: { frame?: "first" | "last" } = {},
): ShotPromptMaterial {
  const scene = project.scenes.find((item) => item.id === shot.sceneId);
  const location = scene
    ? project.locations.find((item) => item.id === scene.locationId)
    : undefined;
  const characterById = new Map(project.characters.map((character) => [character.id, character]));
  const propById = new Map(project.props.map((prop) => [prop.id, prop]));
  const dialogueById = new Map(project.dialogue.map((line) => [line.id, line]));

  const performance = shot.performance
    ? {
        objective: shot.performance.objective,
        surface: shot.performance.emotion.surface,
        subtext: shot.performance.emotion.subtext,
        intensity: shot.performance.intensity,
        gaze: shot.performance.gaze,
        avoid: shot.performance.avoid,
        beats: shot.performance.beats,
        ...(shot.performance.gaze.targetId
          ? {
              gazeName:
                shot.performance.gaze.target === "character"
                  ? characterById.get(shot.performance.gaze.targetId)?.name
                  : propById.get(shot.performance.gaze.targetId)?.name,
            }
          : {}),
      }
    : undefined;

  // 首帧对起、尾帧对落：首尾帧必须和表演设计的起止一致（不变量 24）
  const frameBeat =
    performance && options.frame
      ? options.frame === "first"
        ? (performance.beats.find((beat) => beat.phase === "before") ?? performance.beats[0])
        : (performance.beats.find((beat) => beat.phase === "after") ?? performance.beats.at(-1))
      : undefined;

  const previous = shot.continuation ? previousShotOf(project, shot.id) : undefined;
  const continuation =
    shot.continuation && previous
      ? { previous: previous.description, tailMs: shot.continuation.tailMs }
      : undefined;
  return {
    description: shot.description,
    shotSize: shot.shotSize,
    camera: shot.camera,
    notes: shot.promptNotes,
    characters: shot.characterIds
      .map((id) => characterById.get(id))
      .filter((character): character is Character => Boolean(character)),
    location: location
      ? {
          name: location.name,
          ...(sceneTemplateById(location.templateId)
            ? { template: sceneTemplateById(location.templateId) }
            : {}),
        }
      : undefined,
    props: shot.propIds.flatMap((id) => {
      const prop = propById.get(id);
      return prop ? [prop] : [];
    }),
    ...(shot.dialogueIds.length
      ? {
          dialogue: shot.dialogueIds.flatMap((id) => {
            const line = dialogueById.get(id);
            if (!line) return [];
            return [
              {
                speaker: characterById.get(line.characterId)?.name ?? "角色",
                text: line.text,
              },
            ];
          }),
        }
      : {}),
    ...(performance ? { performance } : {}),
    ...(shot.staging.length > 0
      ? {
          staging: shot.staging.flatMap((mark) => {
            const name = mark.characterId
              ? characterById.get(mark.characterId)?.name
              : propById.get(mark.propId ?? "")?.name;
            return name ? [{ name, side: mark.side, depth: mark.depth, note: mark.note }] : [];
          }),
        }
      : {}),
    ...(frameBeat ? { frameBeat } : {}),
    ...(project.look ? { look: project.look } : {}),
    ...(shot.lighting ? { lighting: shot.lighting } : {}),
    ...(shot.composition ? { composition: shot.composition } : {}),
    ...(continuation ? { continuation } : {}),
  };
}

function beatPrompt(beat: ActionBeat): string {
  const bits = [beat.micro, beat.body, beat.action].filter((bit): bit is string => Boolean(bit));
  return `${BEAT_PHASE_CN[beat.phase]}：${bits.join("，")}`;
}

/** "看到什么 → 人物锚点 → 表演与调度 → 场景与道具 → 机位"；不含画面质感那一句。 */
function shotParts(material: ShotPromptMaterial): string[] {
  const parts: string[] = [];
  if (material.description) parts.push(material.description);

  const people = material.characters.map((character) => {
    const look = character.appearance ? `，${character.appearance}` : "";
    const keep = character.mustNotChange.length
      ? `；不许变：${character.mustNotChange.join("、")}`
      : "";
    return `${character.name}${look}${keep}`;
  });
  if (people.length) parts.push(`人物：${people.join("；")}`);

  if (material.staging && material.staging.length) {
    const marks = material.staging.map((mark) => {
      const note = mark.note ? `，${mark.note}` : "";
      return `${mark.name}在${SIDE_CN[mark.side]}（${DEPTH_CN[mark.depth]}）${note}`;
    });
    parts.push(`调度：${marks.join("；")}`);
  }

  if (material.performance) {
    const performance = material.performance;
    const bits: string[] = [];
    if (performance.objective) bits.push(`目的：${performance.objective}`);
    if (performance.surface) bits.push(`表面情绪：${performance.surface}`);
    if (performance.subtext) bits.push(`潜台词：${performance.subtext}`);
    const gaze = performance.gazeName
      ? `${GAZE_TARGET_CN[performance.gaze.target]}${performance.gazeName}`
      : GAZE_TARGET_CN[performance.gaze.target];
    bits.push(`视线：${gaze}，${GAZE_DIRECTION_CN[performance.gaze.direction]}`);
    if (performance.intensity !== 3) bits.push(`表演强度 ${performance.intensity}/5`);
    if (performance.avoid.length) bits.push(`不要：${performance.avoid.join("、")}`);
    if (bits.length) parts.push(`表演：${bits.join("；")}`);
    if (material.frameBeat) {
      parts.push(`这一帧的表演：${beatPrompt(material.frameBeat)}`);
    } else if (performance.beats.length) {
      parts.push(`表演节拍：${performance.beats.map(beatPrompt).join("；")}`);
    }
  }

  if (material.location) {
    const template = material.location.template
      ? `（${sceneTemplatePrompt(material.location.template)}）`
      : "";
    parts.push(`场景：${material.location.name}${template}`);
  }

  if (material.notes && material.notes.length) {
    parts.push(`补充：${material.notes.join("；")}`);
  }

  const props = material.props.map((prop) =>
    prop.description ? `${prop.name}，${prop.description}` : prop.name,
  );
  if (props.length) parts.push(`道具：${props.join("；")}`);

  // 光影与构图（I2 / I4）：各一句，排在镜头参数前面——先说怎么打光、怎么摆，
  // 再说用多大的镜头；两者都没写时提示词与以前逐字一致。
  const lighting = compileLighting(material.lighting);
  if (lighting) parts.push(lighting);
  const composition = compileComposition(material.composition);
  if (composition) parts.push(composition);

  const { shotSize, camera } = material;
  parts.push(
    `${SHOT_SIZE_CN[shotSize]}，${SHOT_ANGLE_CN[camera.angle]}，${MOVE_CN[camera.movement]}，${camera.focalMm}mm`,
  );

  return parts;
}

/**
 * 镜头提示词：先写“看到什么”，再写人物锚点与技术参数。
 *
 * 人物的描述与 `mustNotChange` 用固定串原样带上——每次改写描述，
 * 模型就会把它当成另一个人（CONSISTENCY.md 第三层）。
 */
export function buildShotPrompt(project: Project, shot: Shot): string {
  const material = shotMaterial(project, shot);
  const parts = shotParts(material);
  parts.push(compileLook(material.look));
  return parts.join("。");
}

/**
 * 视频提示词（ADR-0083）：同一镜的提示词，加上"让它动起来"的一句。
 *
 * 首帧已经定住画面，这里只补运动与连贯，不重新描述人物——
 * 重复描述会被模型当成要重画一张，反而丢一致性。
 */
export function buildVideoPrompt(
  material: ShotPromptMaterial,
  skills?: ProjectSkill[],
): string {
  const parts = shotParts(material);
  // 接上一段（C.6）：先重复上一段结尾的动作，再进入本段，避免直接开新剧情
  if (material.continuation) {
    const seconds = Math.round(material.continuation.tailMs / 100) / 10;
    const previous = material.continuation.previous.trim() || "上一段结尾的动作";
    parts.push(
      `接上一段：本段开头先重复上一段最后 ${seconds} 秒的收势动作（上一段：${previous}），再进入本段动作，不要直接切到新剧情`,
    );
  }
  // 台词跟着视频走（A5 / ADR-0107）：改了台词，下一次出片的提示词就是新的。
  // 首帧 / 尾帧提示词不加这一句——静帧不烧字幕，也不要求口型。
  if (material.dialogue && material.dialogue.length) {
    const lines = material.dialogue
      .map((line) => `${line.speaker}「${line.text}」`)
      .join("；");
    parts.push(`台词（口型对齐）：${lines}`);
  }
  parts.push("从首帧起势，动作连贯，镜头平稳，保持人物一致");
  // 技能（C18）：视频阶段的要求排在风格那句之前，风格永远最后
  const guidance = compileSkills(skills, "video");
  if (guidance) parts.push(guidance);
  parts.push(compileLook(material.look));
  return parts.join("。");
}

/**
 * 关键帧是这一镜的起点还是落点（ADR-0037 / ADR-0038）。
 */
export type Frame = "first" | "last";

const FRAME_LINE: Record<Frame, string> = {
  first: "首帧画面，动作起势，无字幕，无文字，无水印",
  last: "尾帧画面，动作收势，无字幕，无文字，无水印",
};

/**
 * 关键帧提示词（ADR-0037 / ADR-0038）：同一镜的提示词，但明确"这是一张定住这一刻的静帧"。
 *
 * 首尾两帧只差收势那句：起势是视频的起点，收势是落点。不要字幕与水印——
 * 关键帧要能当封面看。
 */
export function buildKeyframePrompt(
  material: ShotPromptMaterial,
  frame: Frame = "first",
  skills?: ProjectSkill[],
): string {
  const parts = shotParts(material);
  parts.push(FRAME_LINE[frame]);
  // 技能排在风格之前：风格那句始终是提示词的最后一句（B7 / I5）
  const guidance = compileSkills(skills, "keyframe");
  // 作者常以句号结尾：去掉末尾句号，避免与 parts 的连接符叠成「。。」
  if (guidance) parts.push(guidance.replace(/[。.]+$/, ""));
  parts.push(compileLook(material.look));
  return parts.join("。");
}

/**
 * 一句话指令能改的字段（ADR-0039）。只放这次真的改了的：
 * 空对象表示没听懂，调用方据此不写事件。
 */
export type ShotPatch = {
  shotSize?: Shot["shotSize"];
  camera?: Shot["camera"];
  /** 快一点 / 慢一点：改镜头时长，重做报价跟着变 */
  durationMs?: number;
  /** 光影（I2 / F7）：压抑、柔和、神秘这类话落到结构字段，而不是只写进 promptNotes */
  lighting?: Shot["lighting"];
  /** 落不到结构字段的补充要求，追加进 `promptNotes` */
  note?: string;
};

const ANGLE_ORDER: Shot["camera"]["angle"][] = ["eye", "low", "high"];
const SIZE_ORDER: Shot["shotSize"][] = ["wide", "medium", "close", "extreme-close"];

/** 一句话改时长：一档 0.5 秒，最少 1 秒、最多 8 秒（短剧单镜的常见范围）。 */
const DURATION_STEP_MS = 500;
const DURATION_MIN_MS = 1000;
const DURATION_MAX_MS = 8000;

const NOTE_DARK = "整体提亮，补足曝光，阴影保留细节";
const NOTE_BRIGHT = "压暗一档，高光不过曝";

/**
 * 把一句人话翻成镜头补丁——**是查表，不是理解**（ADR-0039）。
 *
 * 认不出任何一条就返回 `null`：宁可说没听懂，也不把"她笑得太早了"
 * 编成一段假参数。同一个词只匹配一条规则，按下面的先后顺序取。
 */
export function parseInstruction(
  text: string,
  shot: Pick<Shot, "shotSize" | "camera" | "durationMs" | "lighting">,
): ShotPatch | null {
  const said = text.trim();
  if (!said) return null;

  const patch: ShotPatch = {};
  const { camera } = shot;

  // 时长：先说"太快 / 太慢"，否则"快一点"里的"快"会把方向说反
  if (/太快|慢一点|慢些|再慢|长一点|拉长|节奏慢/.test(said)) {
    const next = Math.min(shot.durationMs + DURATION_STEP_MS, DURATION_MAX_MS);
    if (next !== shot.durationMs) patch.durationMs = next;
  } else if (/太慢|快一点|快些|再快|短一点|压缩|节奏快/.test(said)) {
    const next = Math.max(shot.durationMs - DURATION_STEP_MS, DURATION_MIN_MS);
    if (next !== shot.durationMs) patch.durationMs = next;
  }

  // 亮度：先说"过曝"，否则"太亮"里的"亮"会被暗部规则吃掉
  if (/过曝|太亮|亮过头|刺眼|爆掉/.test(said)) {
    patch.note = NOTE_BRIGHT;
  } else if (/太暗|太黑|欠曝|曝光不足|提亮|亮一点|打光/.test(said)) {
    patch.note = NOTE_DARK;
  }

  if (/角度|机位|视角|换个拍法|换一个拍法/.test(said)) {
    const next = ANGLE_ORDER[(ANGLE_ORDER.indexOf(camera.angle) + 1) % ANGLE_ORDER.length]!;
    patch.camera = { ...camera, angle: next };
  }

  if (/靠近|推近|近一点|再近|特写/.test(said)) {
    const at = SIZE_ORDER.indexOf(shot.shotSize);
    const next = SIZE_ORDER[Math.min(at + 1, SIZE_ORDER.length - 1)]!;
    if (next !== shot.shotSize) patch.shotSize = next;
  } else if (/拉远|远一点|退后|全景|拉开/.test(said)) {
    const at = SIZE_ORDER.indexOf(shot.shotSize);
    const next = SIZE_ORDER[Math.max(at - 1, 0)]!;
    if (next !== shot.shotSize) patch.shotSize = next;
  }

  // 先说"稳住"：「有点晃，稳住」「别晃」里的"晃"不该被当成要手持
  if (/稳住|固定|别晃|三脚架/.test(said) && camera.movement !== "static") {
    patch.camera = { ...(patch.camera ?? camera), movement: "static" };
  } else if (/手持|晃/.test(said) && camera.movement !== "handheld") {
    patch.camera = { ...(patch.camera ?? camera), movement: "handheld" };
  }

  // 光影（I2 / F7）：「压抑一点」这类话落到结构字段，而不是只写进 promptNotes。
  // 情绪词与光影模板的对应来自 DIRECTOR-GRAMMAR.md 的 L 组（L5 主光方向决定情绪）。
  // 只改情绪的维度，不改光源：光源是"这个房间里有什么灯"，情绪词说不到那么具体。
  const mood = lightingOf(said, shot.lighting);
  if (mood) patch.lighting = mood;

  return Object.keys(patch).length ? patch : null;
}

/**
 * 一句话的作用域（E11 / 意图层语义编辑）。
 *
 * 同一句话可以落在三个层级上：这一镜 / 这一场 / 整片。
 * 只认**明确说了**的：说「都」「整片」才是整片，说「这一场」才是整场，
 * 没提就按当前这一镜——宁可少改，不可多改。
 *
 * 顺序有讲究：「整片」优先于「整场」，否则「整片每一场」会被判成整场。
 */
export type InstructionScope = "shot" | "scene" | "film";

export function parseInstructionScope(
  text: string,
  fallback: InstructionScope = "shot",
): InstructionScope {
  const said = text.trim();
  if (!said) return fallback;
  if (/整片|全片|整条片|整部|所有镜头|全部的镜|每一镜|每一场都|全都|都改/.test(said)) {
    return "film";
  }
  if (/这一场|整场|这场|当前的场/.test(said)) return "scene";
  if (/这一镜|这镜|当前镜|这一个镜头/.test(said)) return "shot";
  return fallback;
}

/**
 * 情绪词 → 光影模板（F7 / I2）。
 *
 * 只认能明确落到「主光方向 + 塑形」的说法：压抑 / 神秘 / 柔和 / 硬朗。
 * 「再压抑一点」是 F7 原文里的例子——以前它只能进 promptNotes，
 * 现在落成 `Shot.lighting`，走位台账与提示词编译都能读到。
 *
 * 没说光源就沿用原来那个；原来没写就留空，由 `LightingSchema` 的默认值补。
 */
function lightingOf(said: string, current?: Shot["lighting"]): Shot["lighting"] | undefined {
  const base = current ?? { source: "window" as const, position: "side" as const, mood: "modeled" as const, note: "" };
  // 压抑 / 悬疑：顶光压 + 剪影（L5「顶光压迫」）
  if (/压抑|沉重|压迫|悬疑|紧张/.test(said)) {
    return { ...base, position: "top", mood: "silhouette" };
  }
  // 神秘 / 暧昧：侧逆光（L5「侧逆光神秘」）
  if (/神秘|暧昧|看不透|阴森/.test(said)) {
    return { ...base, position: "back", mood: "modeled" };
  }
  // 柔和 / 温情：正面平光（L2 低光比）
  if (/柔和|温情|温柔|暖一点|软一点/.test(said)) {
    return { ...base, position: "front", mood: "flat" };
  }
  // 硬朗 / 冷峻：侧面强塑形（L1 高光比）
  if (/硬朗|冷峻|凌厉|锐利/.test(said)) {
    return { ...base, position: "side", mood: "modeled" };
  }
  return undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 三视图一格的提示词。人物固定串与镜头提示词同源，避免两处描述不一致。 */
export function buildSheetPrompt(
  character: Pick<Character, "name" | "appearance" | "mustNotChange">,
  angle: SheetView,
  look?: Look,
  skills?: ProjectSkill[],
): string {
  const parts = [`角色定妆照，${SHEET_LABELS[angle]}视角：${character.name}`];
  if (character.appearance) parts.push(character.appearance);
  if (character.mustNotChange.length) {
    parts.push(`不许变：${character.mustNotChange.join("、")}`);
  }
  parts.push("全身站姿，自然表情，纯浅灰背景，无文字，无水印");
  const guidance = compileSkills(skills, "sheet");
  if (guidance) parts.push(guidance.replace(/[。.]+$/, ""));
  // 定妆是棚拍：默认档保持原来的棚拍口径，作者改过风格才接上项目质感
  parts.push(compileStudioLook(look));
  return parts.join("。");
}

/** 场景主镜：空镜，只交代空间与光线。同一场所有镜头都引这一张。 */
export function buildMasterPrompt(
  location: Pick<Location, "name" | "description">,
  look?: Look,
  skills?: ProjectSkill[],
): string {
  const parts = [`场景主镜，空镜：${location.name}`];
  if (location.description) parts.push(location.description);
  parts.push("无人入画，广角，交代空间结构、陈设与光源方向");
  const guidance = compileSkills(skills, "master");
  if (guidance) parts.push(guidance.replace(/[。.]+$/, ""));
  parts.push(compileLook(look));
  return parts.join("。");
}

/** 道具参考图：一张能认出这件东西的静物。 */
export function buildPropPrompt(
  prop: Pick<Prop, "name" | "description">,
  look?: Look,
  skills?: ProjectSkill[],
): string {
  const parts = [`道具参考图：${prop.name}`];
  if (prop.description) parts.push(prop.description);
  parts.push("单件静物，正面，纯浅灰背景，无人物，无文字，无水印");
  const guidance = compileSkills(skills, "prop");
  if (guidance) parts.push(guidance.replace(/[。.]+$/, ""));
  parts.push(compileStudioLook(look));
  return parts.join("。");
}
export * from "./skills";
export * from "./look";
export * from "./language";
export * from "./import-verbatim";
