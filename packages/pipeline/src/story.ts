import { z } from "zod";
import {
  assertValidProject,
  sheetSlotAssets,
  sheetSlotsOf,
  type BeatKind,
  type Character,
  type DialogueLine,
  type Location,
  type Project,
  type Prop,
  type Scene,
  type Shot,
  type ShotPurpose,
  type StoryArc,
  type StoryRelationship,
} from "@loomina/ir";
import { estimateDialogueMs } from "./dialogue";
import { beatSheetPrompt, type BeatSheet } from "./story-kit";

/**
 * 故事入口（ADR-0088）。
 *
 * 文本模型只负责「内容」：标题、logline、人物弧光、关系、地点、场次、镜头与台词。
 * id、时长、枚举与双向引用全部由代码定，模型输出再离谱也落不成一个坏项目。
 */

const SHOT_SIZES = ["wide", "medium", "close", "extreme-close"] as const;
const ANGLES = ["eye", "low", "high", "top"] as const;
const MOVEMENTS = ["static", "push", "pull", "pan", "tilt", "handheld"] as const;
const SPACES = ["int", "ext"] as const;
const TIMES = ["day", "night", "dawn", "dusk"] as const;

const BEAT_ALIASES: Record<string, BeatKind> = {
  hook: "hook", 钩子: "hook", 开场钩子: "hook",
  setup: "setup", 铺垫: "setup", 建置: "setup", 建立: "setup",
  escalation: "escalation", 升级: "escalation", 加压: "escalation", 冲突升级: "escalation",
  turn: "turn", 转折: "turn", 反转: "turn",
  climax: "climax", 高潮: "climax", 爽点: "climax",
  resolution: "resolution", 收束: "resolution", 结局: "resolution", 解决: "resolution",
  endhook: "endHook", 尾钩: "endHook", 结尾钩子: "endHook", 悬念: "endHook",
};

const PURPOSE_ALIASES: Record<string, ShotPurpose> = {
  establish: "establish", 建立: "establish", 定场: "establish", 环境: "establish",
  information: "information", 信息: "information", 交代: "information",
  emotion: "emotion", 情绪: "emotion",
  reaction: "reaction", 反应: "reaction",
  transition: "transition", 过渡: "transition", 空镜: "transition",
  hook: "hook", 钩子: "hook", 抓人: "hook",
};

const SHOT_SIZE_ALIASES: Record<string, (typeof SHOT_SIZES)[number]> = {
  wide: "wide", 远景: "wide", 全景: "wide", 大远景: "wide",
  medium: "medium", 中景: "medium", 中近景: "medium",
  close: "close", 近景: "close", 特写: "close",
  "extreme-close": "extreme-close", 大特写: "extreme-close", 极特写: "extreme-close",
};
const ANGLE_ALIASES: Record<string, (typeof ANGLES)[number]> = {
  eye: "eye", 平视: "eye", 平拍: "eye",
  low: "low", 仰拍: "low", 低机位: "low",
  high: "high", 俯拍: "high", 高机位: "high",
  top: "top", 顶拍: "top", 俯视: "top",
};
const MOVEMENT_ALIASES: Record<string, (typeof MOVEMENTS)[number]> = {
  static: "static", 固定: "static", 静止: "static",
  push: "push", 推: "push", 推近: "push", 推镜: "push",
  pull: "pull", 拉: "pull", 拉远: "pull", 拉镜: "pull",
  pan: "pan", 摇: "pan", 摇镜: "pan",
  tilt: "tilt", 俯仰: "tilt", 升降: "tilt",
  handheld: "handheld", 手持: "handheld", 晃动: "handheld",
};
const SPACE_ALIASES: Record<string, (typeof SPACES)[number]> = {
  int: "int", 内: "int", 内景: "int", 室内: "int",
  ext: "ext", 外: "ext", 外景: "ext", 室外: "ext",
};
const TIME_ALIASES: Record<string, (typeof TIMES)[number]> = {
  day: "day", 日: "day", 白天: "day", 日间: "day",
  night: "night", 夜: "night", 夜晚: "night", 夜间: "night",
  dawn: "dawn", 晨: "dawn", 清晨: "dawn", 黎明: "dawn",
  dusk: "dusk", 黄昏: "dusk", 傍晚: "dusk",
};

const RawStorySchema = z.object({
  title: z.string().min(1),
  logline: z.string().min(1),
  synopsis: z.string().min(1),
  genre: z.string().min(1),
  audience: z.string().min(1),
  tone: z.string().min(1),
  openingHook: z.string().optional().default(""),
  endingHook: z.string().optional().default(""),
  characters: z
    .array(
      z.object({
        name: z.string().min(1),
        role: z.string().optional().default(""),
        appearance: z.string().min(1),
        want: z.string().optional().default(""),
        need: z.string().optional().default(""),
        wound: z.string().optional().default(""),
        flaw: z.string().optional().default(""),
        secret: z.string().optional().default(""),
        agency: z.string().optional().default(""),
        arc: z.string().optional().default(""),
      }),
    )
    .min(1),
  relationships: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        tension: z.string().optional().default(""),
      }),
    )
    .optional()
    .default([]),
  locations: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional().default(""),
        space: z.string().optional().default("int"),
        timeOfDay: z.string().optional().default("day"),
      }),
    )
    .min(1),
  props: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional().default(""),
      }),
    )
    .optional()
    .default([]),
  scenes: z
    .array(
      z.object({
        locationName: z.string().min(1),
        space: z.string().optional().default("int"),
        timeOfDay: z.string().optional().default("day"),
        shots: z
          .array(
            z.object({
              description: z.string().min(1),
              shotSize: z.string().optional().default("medium"),
              angle: z.string().optional().default("eye"),
              movement: z.string().optional().default("static"),
              focalMm: z.union([z.number(), z.string()]).optional(),
              /** 故事节拍与镜头目的（A11 / A12）；模型没给就留空，由分镜检查推断 */
              beat: z.string().optional().default(""),
              purpose: z.string().optional().default(""),
              characterNames: z.array(z.string()).optional().default([]),
              propNames: z.array(z.string()).optional().default([]),
              dialogue: z
                .array(
                  z.object({
                    characterName: z.string().min(1),
                    text: z.string().min(1),
                  }),
                )
                .optional()
                .default([]),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

export type StoryDraft = {
  title: string;
  logline: string;
  synopsis: string;
  genre: string;
  audience: string;
  tone: string;
  openingHook: string;
  endingHook: string;
  characters: {
    name: string;
    role: string;
    appearance: string;
    want: string;
    need: string;
    wound: string;
    flaw: string;
    secret: string;
    agency: string;
    arc: string;
  }[];
  relationships: { from: string; to: string; tension: string }[];
  locations: {
    name: string;
    description: string;
    space: (typeof SPACES)[number];
    timeOfDay: (typeof TIMES)[number];
  }[];
  props: { name: string; description: string }[];
  scenes: {
    locationName: string;
    space: (typeof SPACES)[number];
    timeOfDay: (typeof TIMES)[number];
    shots: {
      description: string;
      shotSize: (typeof SHOT_SIZES)[number];
      angle: (typeof ANGLES)[number];
      movement: (typeof MOVEMENTS)[number];
      focalMm: number;
      beat?: BeatKind;
      purpose?: ShotPurpose;
      characterNames: string[];
      propNames: string[];
      dialogue: { characterName: string; text: string }[];
    }[];
  }[];
};

export class StoryDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryDraftError";
  }
}

/** 输出上限：单集短剧用不到这么多，但给复杂大纲留余量。 */
const MAX_CHARACTERS = 5;
const MAX_RELATIONSHIPS = 8;
const MAX_LOCATIONS = 3;
const MAX_PROPS = 6;
const MAX_SCENES = 3;
const MAX_SHOTS = 10;
const MAX_DIALOGUE_PER_SHOT = 2;

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function pick<T extends string>(aliases: Record<string, T>, value: string | undefined, fallback: T): T {
  const key = (value ?? "").trim();
  if (!key) return fallback;
  return aliases[key.toLowerCase()] ?? aliases[key] ?? fallback;
}

/** 认不出来就留空：由分镜检查按镜序推断，不猜一个看似合理的值写进 IR */
function pickOptional<T extends string>(
  aliases: Record<string, T>,
  value: string | undefined,
): T | undefined {
  const key = (value ?? "").trim();
  if (!key) return undefined;
  return aliases[key.toLowerCase()] ?? aliases[key];
}

function focalOf(value: number | string | undefined): number {
  const number = typeof value === "number" ? value : Number.parseFloat(value ?? "");
  if (!Number.isFinite(number)) return 35;
  return Math.min(85, Math.max(24, Math.round(number)));
}

/**
 * 从模型输出里取 JSON：允许 Markdown 围栏、前后有解释文字。
 * 取第一个 `{` 到最后一个 `}`，再交给 zod。
 */
export function parseStoryDraft(text: string): StoryDraft {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new StoryDraftError("模型没有给出 JSON：请重新生成一次");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new StoryDraftError("模型给的 JSON 不完整：请重新生成一次");
  }

  const parsed = RawStorySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "故事";
    throw new StoryDraftError(
      `模型给回来的故事结构不完整（${path}：${issue?.message ?? "字段不合法"}）`,
    );
  }

  return normalize(parsed.data);
}

function normalize(raw: z.infer<typeof RawStorySchema>): StoryDraft {
  const characters = raw.characters.slice(0, MAX_CHARACTERS).map((character) => ({
    name: clip(character.name, 12),
    role: clip(character.role, 40),
    appearance: clip(character.appearance, 200),
    want: clip(character.want, 80),
    need: clip(character.need, 80),
    wound: clip(character.wound, 80),
    flaw: clip(character.flaw, 80),
    secret: clip(character.secret, 80),
    agency: clip(character.agency, 80),
    arc: clip(character.arc, 120),
  }));
  const names = new Set(characters.map((character) => character.name));

  const locations = raw.locations.slice(0, MAX_LOCATIONS).map((location) => ({
    name: clip(location.name, 20),
    description: clip(location.description, 200),
    space: pick(SPACE_ALIASES, location.space, "int"),
    timeOfDay: pick(TIME_ALIASES, location.timeOfDay, "day"),
  }));
  const locationNames = new Set(locations.map((location) => location.name));

  const props = raw.props
    .slice(0, MAX_PROPS)
    .map((prop) => ({ name: clip(prop.name, 20), description: clip(prop.description, 200) }))
    .filter((prop) => prop.name);
  const propNames = new Set(props.map((prop) => prop.name));

  const scenes = raw.scenes.slice(0, MAX_SCENES).flatMap((scene) => {
    const locationName =
      (locationNames.has(scene.locationName.trim()) ? scene.locationName.trim() : undefined) ??
      locations[0]?.name;
    if (!locationName) return [];
    const shots = scene.shots.slice(0, MAX_SHOTS).map((shot) => ({
      description: clip(shot.description, 200),
      shotSize: pick(SHOT_SIZE_ALIASES, shot.shotSize, "medium"),
      angle: pick(ANGLE_ALIASES, shot.angle, "eye"),
      movement: pick(MOVEMENT_ALIASES, shot.movement, "static"),
      focalMm: focalOf(shot.focalMm),
      beat: pickOptional(BEAT_ALIASES, shot.beat),
      purpose: pickOptional(PURPOSE_ALIASES, shot.purpose),
      characterNames: shot.characterNames
        .map((name) => name.trim())
        .filter((name) => names.has(name))
        .slice(0, MAX_CHARACTERS),
      propNames: shot.propNames
        .map((name) => name.trim())
        .filter((name) => propNames.has(name))
        .slice(0, MAX_PROPS),
      dialogue: shot.dialogue
        .map((line) => ({ characterName: line.characterName.trim(), text: clip(line.text, 60) }))
        .filter((line) => names.has(line.characterName) && line.text)
        .slice(0, MAX_DIALOGUE_PER_SHOT),
    }));
    if (shots.length === 0) return [];
    return [
      {
        locationName,
        space: pick(SPACE_ALIASES, scene.space, locations.find((l) => l.name === locationName)!.space),
        timeOfDay: pick(
          TIME_ALIASES,
          scene.timeOfDay,
          locations.find((l) => l.name === locationName)!.timeOfDay,
        ),
        shots,
      },
    ];
  });
  if (scenes.length === 0) {
    throw new StoryDraftError("模型没有给出可用的场次：请重新生成一次");
  }

  return {
    title: clip(raw.title, 30),
    logline: clip(raw.logline, 120),
    synopsis: clip(raw.synopsis, 600),
    genre: clip(raw.genre, 20),
    audience: clip(raw.audience, 40),
    tone: clip(raw.tone, 40),
    openingHook: clip(raw.openingHook, 120),
    endingHook: clip(raw.endingHook, 120),
    characters,
    relationships: raw.relationships
      .map((relation) => ({
        from: relation.from.trim(),
        to: relation.to.trim(),
        tension: clip(relation.tension, 120),
      }))
      .filter((relation) => names.has(relation.from) && names.has(relation.to) && relation.from !== relation.to)
      .slice(0, MAX_RELATIONSHIPS),
    locations,
    props,
    scenes,
  };
}

export interface StoryToProjectOptions {
  id: string;
  at: string;
  /** 文本模型与原始输入，写进 Story Bible 的 provenance */
  modelId: string;
  idea: string;
  budgetCny?: number;
  /**
   * 这一次故事生成花了多少（H4）与用了多少 token。
   *
   * 草稿本身不写 IR，只有作者点「用它开工」才落成项目——所以这笔钱要从
   * 生成那一刻带过来，否则它就只存在于浏览器的内存里，一刷新就没了。
   */
  costCny?: number;
  usage?: { units: number; unit: "tokens" | "chars" };
}

/**
 * 生成草稿的默认时长口径。
 *
 * 台词按 0.3 秒 / 字估算，镜头再留 1 秒表演余量：竖屏短剧里一句台词前后
 * 需要反应与动作，500ms 常常不够，成片也会因此掉到 60 秒以下。
 * 1 秒仍是 `SHOT_DURATION_VS_DIALOGUE` 的允许范围（最短一句 800ms 时，
 * 偏差 500ms 正好等于容忍下限）。没有台词的镜头按 5 秒计，给空镜留呼吸。
 */
export const SHOT_PADDING_MS = 1000;
export const SHOT_MIN_MS = 5000;

/** 导入 txt 的一次上限（ADR-0089）：约 2 万字，超过先截一段 */
export const SOURCE_MAX_CHARS = 20_000;

/**
 * 草稿 → 新项目。确定性地生成 id、时长与双向引用，最后过 `assertValidProject`。
 *
 * 台词时长沿用 0.3 秒 / 字的估算；镜头时长 = 全部台词 + 500ms 表演余量，
 * 正好落在 `SHOT_DURATION_VS_DIALOGUE` 允许的范围内。
 */
export function projectFromStoryDraft(
  draft: StoryDraft,
  options: StoryToProjectOptions,
): Project {
  const characterByName = new Map<string, Character>();
  const characters: Character[] = draft.characters.map((item, index) => {
    const character: Character = {
      id: `char-${index + 1}`,
      name: item.name,
      appearance: item.appearance,
      // 新建人物先把四格占上（ADR-0144）：否则「生成三视图」没有资产位可写
      sheet: sheetSlotsOf(`char-${index + 1}`),
      referenceImages: [],
      mustNotChange: [],
    };
    characterByName.set(item.name, character);
    return character;
  });

  const locationByName = new Map<string, Location>();
  const locations: Location[] = draft.locations.map((item, index) => {
    const location: Location = {
      id: `loc-${index + 1}`,
      name: item.name,
      description: item.description,
      referenceImages: [],
    };
    locationByName.set(item.name, location);
    return location;
  });

  const propByName = new Map<string, Prop>();
  const props: Prop[] = draft.props.map((item, index) => {
    const prop: Prop = {
      id: `prop-${index + 1}`,
      name: item.name,
      description: item.description,
      referenceImages: [],
    };
    propByName.set(item.name, prop);
    return prop;
  });

  const scenes: Scene[] = [];
  const shots: Shot[] = [];
  const dialogue: DialogueLine[] = [];

  draft.scenes.forEach((sceneDraft, sceneIndex) => {
    const location = locationByName.get(sceneDraft.locationName) ?? locations[0]!;
    const scene: Scene = {
      id: `scene-${sceneIndex + 1}`,
      index: sceneIndex,
      code: "",
      locationId: location.id,
      space: sceneDraft.space,
      timeOfDay: sceneDraft.timeOfDay,
      shotIds: [],
    };

    sceneDraft.shots.forEach((shotDraft, shotIndex) => {
      const shotId = `shot-${sceneIndex + 1}-${shotIndex + 1}`;
      const lineIds: string[] = [];
      let dialogueMs = 0;
      shotDraft.dialogue.forEach((lineDraft, lineIndex) => {
        const character = characterByName.get(lineDraft.characterName);
        if (!character) return;
        const durationMs = estimateDialogueMs(lineDraft.text);
        const line: DialogueLine = {
          id: `line-${sceneIndex + 1}-${shotIndex + 1}-${lineIndex + 1}`,
          characterId: character.id,
          text: lineDraft.text,
          durationMs,
        };
        dialogue.push(line);
        lineIds.push(line.id);
        dialogueMs += durationMs;
      });

      const shot: Shot = {
        id: shotId,
        sceneId: scene.id,
        index: shotIndex,
        durationMs: lineIds.length > 0 ? dialogueMs + SHOT_PADDING_MS : SHOT_MIN_MS,
        description: shotDraft.description,
        promptNotes: [],
        shotSize: shotDraft.shotSize,
        camera: {
          angle: shotDraft.angle,
          movement: shotDraft.movement,
          focalMm: shotDraft.focalMm,
        },
        ...(shotDraft.beat ? { beat: shotDraft.beat } : {}),
        ...(shotDraft.purpose ? { purpose: shotDraft.purpose } : {}),
        characterIds: shotDraft.characterNames
          .map((name) => characterByName.get(name)?.id)
          .filter((id): id is string => Boolean(id)),
        propIds: shotDraft.propNames
          .map((name) => propByName.get(name)?.id)
          .filter((id): id is string => Boolean(id)),
        dialogueIds: lineIds,
        takeIds: [],
        staging: [],
        keyframes: {},
        locked: false,
      };
      scene.shotIds.push(shot.id);
      shots.push(shot);
    });

    scenes.push(scene);
  });

  const arcs: StoryArc[] = draft.characters.flatMap((item, index) => {
    const character = characters[index];
    if (!character) return [];
    return [
      {
        characterId: character.id,
        want: item.want,
        need: item.need,
        wound: item.wound,
        flaw: item.flaw,
        secret: item.secret,
        agency: item.agency,
        arc: item.arc,
      },
    ];
  });

  const relationships: StoryRelationship[] = draft.relationships.flatMap((relation) => {
    const from = characterByName.get(relation.from);
    const to = characterByName.get(relation.to);
    if (!from || !to) return [];
    return [{ fromCharacterId: from.id, toCharacterId: to.id, tension: relation.tension }];
  });

  const project: Project = {
    id: options.id,
    title: draft.title,
    version: 1,
    models: {},
    budgetCny: options.budgetCny ?? 60,
    maxAttemptsPerShot: 3,
    onBudgetExceed: "block",
    story: {
      logline: draft.logline,
      synopsis: draft.synopsis,
      genre: draft.genre,
      audience: draft.audience,
      tone: draft.tone,
      hooks: {
        opening: draft.openingHook || shots[0]?.description || "",
        ending: draft.endingHook,
      },
      arcs,
      relationships,
      provenance: {
        modelId: options.modelId,
        prompt: options.idea,
        referenceAssetIds: [],
        createdAt: options.at,
        ...(options.costCny !== undefined ? { costCny: options.costCny } : {}),
        ...(options.usage ? { usage: options.usage } : {}),
      },
    },
    motifs: [],
    locations,
    characters,
    props,
    scenes,
    shots,
    dialogue,
    voiceTakes: [],
    takes: [],
    // 四格资产位先占上（ADR-0144），故事人物进来就能直接出三视图
    assets: characters.flatMap((character) => sheetSlotAssets(character.id, options.at)),
    approvals: [],
    gates: [],
    timeline: { items: [], music: [] },
    subtitleOverrides: [],
    subtitleLayout: { preset: "default" },
    publishPackages: [],
  };

  assertValidProject(project);
  return project;
}

export function storyMessages(
  idea: string,
  genre?: string,
  beatSheet?: BeatSheet,
): { role: "system" | "user"; content: string }[] {
  const system = storySystem(
    "目标：把一句话或一段大纲变成一条 60–90 秒的竖屏短剧骨架，可直接进入分镜。",
    beatSheet ? [beatSheetPrompt(beatSheet)] : [],
  );
  const user = [
    genre?.trim() ? `题材偏好：${genre.trim()}` : "",
    "想法 / 大纲：",
    idea.trim(),
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * 导入 txt（F6，ADR-0089）。
 *
 * 与一句话生成共用同一份 `StoryDraft` 与落项目映射；区别只在提示词：
 * 原文必须保留人物关系、核心冲突与结局意思，但允许合并次要人物与场次，
 * 因为目标仍是一条 60–90 秒的单集。不是逐字导入，界面要说清楚。
 */
export function importStoryMessages(
  source: string,
  genre?: string,
  beatSheet?: BeatSheet,
): { role: "system" | "user"; content: string }[] {
  const system = storySystem(
    "目标：把用户给的小说 / 剧本文字改写成一条 60–90 秒的竖屏短剧骨架，可直接进入分镜。",
    [
      "改编约束：",
      "7. 忠实保留原文的人物关系、核心冲突与结局意思；可以合并次要人物与场次，不新增原文没有的主要人物。",
      "8. 删除旁白、说明性叙述与无法拍摄的内心描写，把信息改成动作、物件或台词。",
      "9. 不照抄大段原文；台词可以精简，但不能改变人物立场与结局。",
      ...(beatSheet ? [beatSheetPrompt(beatSheet)] : []),
    ],
  );
  const user = [
    genre?.trim() ? `题材偏好：${genre.trim()}` : "",
    "原文（小说 / 剧本）：",
    source.trim(),
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function storySystem(task: string, extraRules: string[]): string {
  return [
    "你是《织光机》的短剧策划与分镜师。你只输出 JSON，不输出 Markdown、解释或注释。",
    task,
    "硬约束：",
    "1. 1–2 场；主要人物 3–5 个；地点 1–2 个；总镜头 10–14 个（每场 4–8 镜）。",
    "2. 成片 60–90 秒；前 3 秒必须是钩子；结尾必须留钩。",
    "3. 每镜最多 2 句台词；单句不超过 15 个汉字；除最多 2 个空镜（只拍动作或道具），每镜都要有人说话；台词总量 20–24 句。",
    "4. 只写能拍出来的动作，不写内心独白与抽象情绪；用动作和物件透露信息。台词要短、狠、能截图。",
    "5. 人物要有一个当场做出的选择，不能只是被剧情推着走。",
    "6. 镜头之间要有景别变化，不要连续三个同景别。",
    "7. 每一镜标出所属节拍 beat 与镜头目的 purpose；节拍顺序沿 hook → setup → escalation → turn → climax → endHook（需要收束可用 resolution）。每个节拍至少有一个信息镜头（establish / information）与一个情绪或反应镜头（emotion / reaction）。",
    ...extraRules,
    "枚举值（必须原样使用）：",
    "shotSize: wide | medium | close | extreme-close",
    "angle: eye | low | high | top",
    "movement: static | push | pull | pan | tilt | handheld",
    "space: int | ext",
    "timeOfDay: day | night | dawn | dusk",
    "beat: hook | setup | escalation | turn | climax | resolution | endHook",
    "purpose: establish | information | emotion | reaction | transition | hook",
    "输出 JSON 的形状：",
    JSON.stringify(
      {
        title: "不超过 12 字",
        logline: "不超过 40 字，一句话说清欲望、障碍与代价",
        synopsis: "40–100 字，这一集发生什么",
        genre: "都市情感 / 逆袭打脸 / 甜宠 等",
        audience: "目标观众",
        tone: "基调",
        openingHook: "开场钩子，一句话",
        endingHook: "结尾钩子，一句话",
        characters: [
          {
            name: "名字",
            role: "身份 / 与主角的关系",
            appearance: "可拍的外形：年龄、服装、发型、辨识特征，不超过 80 字",
            want: "表层欲望",
            need: "深层需要",
            wound: "创伤",
            flaw: "缺陷",
            secret: "秘密",
            agency: "他主动做出的选择",
            arc: "这一集从哪走到哪",
          },
        ],
        relationships: [{ from: "人物名", to: "人物名", tension: "他们想要 / 害怕 / 隐瞒什么" }],
        locations: [{ name: "地点名", description: "空间、陈设、光线，可拍", space: "int", timeOfDay: "day" }],
        props: [{ name: "道具名", description: "外观与叙事作用" }],
        scenes: [
          {
            locationName: "必须与 locations 里的 name 一致",
            space: "int",
            timeOfDay: "day",
            shots: [
              {
                description: "这一镜观众看到什么",
                shotSize: "medium",
                angle: "eye",
                movement: "static",
                focalMm: 35,
                beat: "escalation",
                purpose: "information",
                characterNames: ["必须与 characters 里的 name 一致"],
                propNames: ["必须与 props 里的 name 一致"],
                dialogue: [{ characterName: "人物名", text: "不超过 15 字" }],
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
    "只输出这个 JSON 对象本身。",
  ].join("\n");
}
