import {
  assertValidProject,
  DEFAULT_BRAND,
  DEFAULT_FRAME,
  DEFAULT_GRADE,
  DEFAULT_LOOK,
  type Project,
} from "@loomina/ir";

/**
 * 逐字导入与章节拆分（F6 / ADR-0154）。
 *
 * 现有的「导入剧本 txt」是让模型把原文改编成 60–90 秒短剧；这里不调模型、
 * 不改一个字：按章节切成候选片段，把选中的一段原样摆出来，并给出可核对的
 * 保真报告（字符数 / 行数 / 与原文逐字相等）。
 *
 * 纯函数：章节、对照、指纹与项目最小骨架都在本机算，原文不需要经过服务端。
 */

/** 章节标题：第 N 章 / 第 N 集 / 数字 + 分隔符，也认「第一章」这类中文数字 */
const CHAPTER =
  /^\s*(?:第\s*[0-9一二三四五六七八九十百零〇两]+\s*[章节回集幕卷部篇]|(?:[0-9]{1,3}|[一二三四五六七八九十百零〇两]{1,6})\s*[、.．:：]\s*\S)(?:[^\n]{0,80})$/u;

export type ImportChapter = {
  /** 0 起：第几段 */
  index: number;
  title: string;
  /** 原文里的起止字符（左闭右开），用于保真对照 */
  start: number;
  end: number;
  body: string;
  chars: number;
  lines: number;
};

export type FidelityReport = {
  /** 选中的片段与原文对应区间逐字相等 */
  exact: boolean;
  sourceChars: number;
  excerptChars: number;
  lines: number;
  /** 被改动的行号（1 起）；逐字导入时应为空 */
  changedLines: number[];
};

/** 一行对照：界面按它画「原文 / 对照稿」，短的那边补空行 */
export type VerbatimLine = {
  /** 1 起 */
  line: number;
  original: string;
  draft: string;
  changed: boolean;
};

/** 逐行并排，不 diff 字符：作者要的是「哪一行不一样」，不是字符级高亮 */
export function compareLines(original: string, draft: string): VerbatimLine[] {
  const a = original.split("\n");
  const b = draft.split("\n");
  const count = Math.max(a.length, b.length);
  return Array.from({ length: count }, (_, index) => {
    const left = a[index] ?? "";
    const right = b[index] ?? "";
    return {
      line: index + 1,
      original: left,
      draft: right,
      changed: left !== right,
    };
  });
}

/**
 * 内容指纹：只用来复核「这份原文和导入时还是不是同一份」。
 * FNV-1a 32 位，与阶段闸门同口径；不是安全哈希，也不防有人故意改。
 */
export function documentFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 一份可以写进项目的逐字原文；纯数据，浏览器算好后交给 store 落事件 */
export type VerbatimDocument = {
  title: string;
  chapterIndex: number;
  chapterCount: number;
  text: string;
  fileName?: string;
  sourceChars: number;
  importedAt: string;
  fingerprint: string;
};

/**
 * 只按当前这一章构造原文槽位：章节位置、文件名与时间都来自界面，
 * 这里不碰 `Date.now()` / `crypto`，方便单测和跨端复用。
 */
export function verbatimDocument(input: {
  source: string;
  chapter: ImportChapter;
  chapterCount: number;
  text: string;
  fileName?: string;
  importedAt: string;
}): VerbatimDocument {
  const normalized = input.source.replace(/\r\n?/g, "\n");
  return {
    title: input.chapter.title,
    chapterIndex: input.chapter.index,
    chapterCount: input.chapterCount,
    text: input.text,
    ...(input.fileName ? { fileName: input.fileName } : {}),
    sourceChars: normalized.length,
    importedAt: input.importedAt,
    fingerprint: documentFingerprint(input.text),
  };
}

/** 认得出来就按章节切；认不出来整篇就是一段，不强行猜 */
export function splitChapters(source: string): ImportChapter[] {
  const text = source.replace(/\r\n?/g, "\n");
  const markers: { start: number; title: string }[] = [];
  const lines = text.split("\n");
  let offset = 0;
  for (const line of lines) {
    if (line.trim() && CHAPTER.test(line)) {
      markers.push({ start: offset, title: line.trim() });
    }
    offset += line.length + 1; // +1 是被 split 吃掉的换行
  }
  if (markers.length === 0) {
    return [
      {
        index: 0,
        title: "全文",
        start: 0,
        end: text.length,
        body: text,
        chars: text.length,
        lines: lines.length,
      },
    ];
  }
  return markers.map((marker, index) => {
    const end = markers[index + 1]?.start ?? text.length;
    const body = text.slice(marker.start, end);
    return {
      index,
      title: marker.title,
      start: marker.start,
      end,
      body,
      chars: body.length,
      lines: body.split("\n").length,
    };
  });
}

/** 取一段原文；按 [start,end) 精确切，不 trim 掉作者写的空格与换行 */
export function excerptOf(source: string, chapter: ImportChapter): string {
  return source.replace(/\r\n?/g, "\n").slice(chapter.start, chapter.end);
}

/**
 * 保真报告：逐字相等才叫「逐字导入」。
 *
 * 只比较选中的区间，而不是整篇：作者选了第二章，不该因为第一章不在稿里报警。
 */
export function fidelityOf(source: string, chapter: ImportChapter, excerpt: string): FidelityReport {
  const normalized = source.replace(/\r\n?/g, "\n");
  const original = normalized.slice(chapter.start, chapter.end);
  const a = original.split("\n");
  const b = excerpt.split("\n");
  const changedLines: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? "") !== (b[i] ?? "")) changedLines.push(i + 1);
  }
  return {
    exact: original === excerpt,
    sourceChars: normalized.length,
    excerptChars: excerpt.length,
    lines: b.length,
    changedLines,
  };
}

/**
 * 把选中的原文摆成一份**只读**草稿：不改一个字，只是给作者一个可核对的形状。
 *
 * 它不产出 `StoryDraft`——逐字导入不是分镜稿，硬塞进那个 schema 会把
 * 原文拆成「场景 / 镜头 / 台词」，那已经是改编了。`verbatimDocument`
 * 负责把这一段变成可进 IR 的只读参考槽位。
 */
export function verbatimExcerpt(source: string, chapter: ImportChapter) {
  const excerpt = excerptOf(source, chapter);
  return {
    title: chapter.title,
    excerpt,
    report: fidelityOf(source, chapter, excerpt),
  };
}

/**
 * 逐字项目的最小骨架（ADR-0154）：一个待定地点、一场、一空镜、零台词。
 *
 * 不把小说切成「人物 / 场次 / 台词」——那一步是改编，不是逐字导入。
 * 作者带着全章原文进剧本页，从这一个空镜开始自己写。
 */
export function projectFromVerbatimDocument(
  document: VerbatimDocument,
  options: { id: string; at: string; budgetCny: number },
): Project {
  const locationId = "loc-verbatim";
  const sceneId = "scene-verbatim";
  const shotId = "shot-verbatim-1";
  const title = document.title.slice(0, 30) || "逐字原文";
  const firstLine = document.text.split("\n").find((line) => line.trim())?.slice(0, 120) ?? "";
  const project: Project = {
    id: options.id,
    title,
    version: 1,
    models: {},
    look: DEFAULT_LOOK,
    grade: DEFAULT_GRADE,
    frame: DEFAULT_FRAME,
    brand: DEFAULT_BRAND,
    budgetCny: options.budgetCny,
    maxAttemptsPerShot: 3,
    onBudgetExceed: "block",
    story: {
      logline: firstLine,
      synopsis: `逐字导入「${document.title}」：原文挂在故事圣经里，还没有改编成分镜。`,
      genre: "",
      audience: "",
      tone: "",
      hooks: { opening: "", ending: "" },
      arcs: [],
      relationships: [],
      provenance: {
        modelId: "local:verbatim",
        prompt: `逐字导入（未调用模型）：${document.title} · ${document.text.length} 字 · 指纹 ${document.fingerprint}`,
        referenceAssetIds: [],
        createdAt: options.at,
      },
      sourceDocument: document,
    },
    motifs: [],
    locations: [
      {
        id: locationId,
        name: "待定地点",
        description: "逐字导入还没写场次地点，先留一个占位。",
        referenceImages: [],
      },
    ],
    characters: [],
    props: [],
    scenes: [
      {
        id: sceneId,
        index: 0,
        code: "",
        locationId,
        space: "int",
        timeOfDay: "day",
        shotIds: [shotId],
      },
    ],
    shots: [
      {
        id: shotId,
        sceneId,
        index: 0,
        durationMs: 5000,
        description: "逐字稿已挂在项目里：先在右侧原文面板看这一章，再写这一镜的动作与台词。",
        promptNotes: [],
        shotSize: "medium",
        camera: { angle: "eye", movement: "static", focalMm: 35 },
        characterIds: [],
        propIds: [],
        dialogueIds: [],
        takeIds: [],
        staging: [],
        keyframes: {},
        locked: false,
      },
    ],
    dialogue: [],
    voiceTakes: [],
    takes: [],
    assets: [],
    approvals: [],
    gates: [],
    timeline: { items: [], music: [], sfx: [], mix: { dialogueDb: 0, musicDb: 0, sfxDb: 0 } },
    subtitleOverrides: [],
    subtitleLayout: { preset: "default" },
    subtitleTranslation: { enabled: false, lang: "en", position: "below" },
    publishPackages: [],
    authorizations: [],
  };
  assertValidProject(project);
  return project;
}
