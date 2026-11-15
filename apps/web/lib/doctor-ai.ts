import { z } from "zod";
import type { ProjectSkill } from "@loomina/ir";
import { compileSkills } from "@loomina/pipeline";
import type { Project } from "@loomina/ir";
/**
 * 剧本快照只需要「每场每镜的动作与台词」这一层形状。
 *
 * 不直接引用 `@/lib/read-model` 的 `ScriptView`：那是 state 子模块的读模型，
 * 只为取一个字段就反向依赖，会让 models ⇄ state 绕成环（M4）。
 */
export type DoctorScriptView = {
  scenes: {
    label: string;
    place: string;
    shots: {
      id: string;
      no: number;
      size: string;
      action: string;
      lines: { id: string; character: string; text: string }[];
    }[];
  }[];
};
import {
  DOCTOR_MODE_LABEL,
  type DoctorMode,
  type ScriptDoctorReport,
} from "@/lib/script-doctor";
import { extractJson } from "@/lib/instruction-ai";

/**
 * 剧本医生的第二档（A18 / ADR-0123）：模型按指定模式给一版改写建议。
 *
 * 与第一档相同的规矩：报告与建议都不进 IR；模型只**建议**，作者点「采用」
 * 才落 `dialogue.updated` / `shot.updated` / `story.updated`。减人物 / 减场景
 * 只允许改字，不允许删实体——结构是作者的决定。
 *
 * 发给模型的是一份精简剧本快照（场、镜、动作、台词与故事层几个字段），
 * 不含素材地址、密钥与资产。
 */

export const DOCTOR_MODES = [
  "strengthenHook",
  "addReversal",
  "trimExposition",
  "sharpenConflict",
  "reduceCast",
  "rewriteEnding",
] as const satisfies readonly DoctorMode[];

export const DOCTOR_ITEM_MAX = 3;
export const DOCTOR_DIALOGUE_MAX_CHARS = 120;
export const DOCTOR_SHOT_DESC_MAX_CHARS = 160;
export const DOCTOR_STORY_TEXT_MAX_CHARS = 400;
export const DOCTOR_REASON_MAX_CHARS = 200;

/** 故事层允许模型改的字段：与 `story.updated` 的文本字段同一份 */
export const DOCTOR_STORY_FIELDS = ["logline", "synopsis", "genre", "audience", "tone"] as const;
export type DoctorStoryField = (typeof DOCTOR_STORY_FIELDS)[number];

const DOCTOR_STORY_FIELD_LABEL: Record<DoctorStoryField, string> = {
  logline: "一句话梗概",
  synopsis: "故事梗概",
  genre: "类型",
  audience: "受众",
  tone: "调性",
};

const SNAPSHOT_DESC_MAX = 400;
const SNAPSHOT_LINE_MAX = 160;
const SNAPSHOT_NOTE_MAX = 200;

export const DoctorSnapshotSchema = z.object({
  mode: z.enum(DOCTOR_MODES),
  title: z.string().max(120).default(""),
  story: z
    .object({
      logline: z.string().max(400).default(""),
      synopsis: z.string().max(1200).default(""),
      genre: z.string().max(80).default(""),
      audience: z.string().max(80).default(""),
      tone: z.string().max(80).default(""),
    })
    .default({}),
  scenes: z
    .array(
      z.object({
        label: z.string().max(40),
        place: z.string().max(60).default(""),
        shots: z
          .array(
            z.object({
              id: z.string().min(1).max(80),
              no: z.number().int().positive(),
              shotSize: z.string().max(24).default(""),
              description: z.string().max(SNAPSHOT_DESC_MAX).default(""),
              dialogue: z
                .array(
                  z.object({
                    id: z.string().min(1).max(80),
                    speaker: z.string().max(40).default(""),
                    text: z.string().max(SNAPSHOT_LINE_MAX),
                  }),
                )
                .max(6)
                .default([]),
            }),
          )
          .max(30),
      }),
    )
    .max(10)
    .default([]),
  /** 本地报告里这一模式相关的发现与方向：给模型一个起点，不当作结论 */
  notes: z.array(z.string().max(SNAPSHOT_NOTE_MAX)).max(8).default([]),
});

export type DoctorSnapshot = z.infer<typeof DoctorSnapshotSchema>;

export type DoctorRewriteItem =
  | {
      kind: "dialogue";
      lineId: string;
      text: string;
      why?: string;
      /** 界面上写「SH-03 · 周」 */
      target: string;
    }
  | {
      kind: "shot";
      shotId: string;
      text: string;
      why?: string;
      target: string;
    }
  | {
      kind: "story";
      field: DoctorStoryField;
      text: string;
      why?: string;
      target: string;
    };

export type DoctorRewrite = {
  mode: DoctorMode;
  reason?: string;
  model: string;
  items: DoctorRewriteItem[];
};

export type ChatMessage = { role: "system" | "user"; content: string };

const clamp = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** 把当前剧本压成发给模型的快照；台词与动作过长时截断并留省略号 */
export function doctorSnapshotOf(
  project: Project,
  view: DoctorScriptView,
  report: ScriptDoctorReport,
  mode: DoctorMode,
): DoctorSnapshot {
  const notes = [
    ...report.findings.map((finding) => finding.message),
    ...report.suggestions
      .filter((suggestion) => suggestion.mode === mode)
      .map((suggestion) => `${suggestion.target}：${suggestion.direction}`),
  ]
    .map((note) => clamp(note, SNAPSHOT_NOTE_MAX))
    .slice(0, 8);

  return {
    mode,
    title: project.title,
    story: {
      logline: project.story.logline,
      synopsis: project.story.synopsis,
      genre: project.story.genre,
      audience: project.story.audience,
      tone: project.story.tone,
    },
    scenes: view.scenes.map((scene) => ({
      label: scene.label,
      place: scene.place,
      shots: scene.shots.map((shot) => ({
        id: shot.id,
        no: shot.no,
        shotSize: shot.size,
        description: clamp(shot.action, SNAPSHOT_DESC_MAX),
        dialogue: shot.lines.map((line) => ({
          id: line.id,
          speaker: line.character,
          text: clamp(line.text, SNAPSHOT_LINE_MAX),
        })),
      })),
    })),
    notes,
  };
}

export function doctorMessages(
  snapshot: DoctorSnapshot,
  skills?: ProjectSkill[],
): ChatMessage[] {
  const guidance = compileSkills(skills, "script");
  const mode = snapshot.mode;
  return [
    {
      role: "system",
      content: [
        "你是短剧剧本医生。作者选中了一个改写模式，你要给出**可以直接替换原文**的改写建议。",
        "只输出 JSON，不要解释、不要代码块。",
        "",
        '输出形状：{"reason":"一句话说明这版改了什么","items":[...]}，items 最多 3 条。',
        "每条只能是下面三种之一：",
        '- {"kind":"dialogue","lineId":"原台词 id","text":"改写后的台词","why":"为什么"}',
        '- {"kind":"shot","shotId":"原镜头 id","text":"改写后的动作描述","why":"为什么"}',
        '- {"kind":"story","field":"logline|synopsis|genre|audience|tone","text":"改写后的文字","why":"为什么"}',
        "",
        "规则：",
        "1. 只能引用快照里出现的 lineId / shotId；只能改 story 的五个字段之一。",
        "2. 台词保持说话人不变、不新增人物、不新增镜头；一句改一句，长度与原句相当。",
        `3. 单句台词不超过 ${DOCTOR_DIALOGUE_MAX_CHARS} 字，动作描述不超过 ${DOCTOR_SHOT_DESC_MAX_CHARS} 字，故事字段不超过 ${DOCTOR_STORY_TEXT_MAX_CHARS} 字。`,
        "4. 减人物 / 减场景只建议怎么合并与改写，不要假装删掉角色或场次。",
        "5. 不要复述原文，不要给多套方案；拿不准就少改，reason 说清放弃的原因。",
        "6. 这是 60–180 秒的竖屏短剧：前三秒要抓人，对话要短，结尾留钩子。",
        "",
        `本次模式：${DOCTOR_MODE_LABEL[mode]}（${mode}）`,
        ...(guidance ? ["", `作者技能（必须遵守）：${guidance}`] : []),
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `标题：${snapshot.title || "（未命名）"}`,
        `一句话梗概：${snapshot.story.logline || "（没写）"}`,
        `梗概：${snapshot.story.synopsis || "（没写）"}`,
        `类型 / 受众 / 调性：${[
          snapshot.story.genre || "未写",
          snapshot.story.audience || "未写",
          snapshot.story.tone || "未写",
        ].join(" / ")}`,
        "",
        ...snapshot.scenes.map((scene) =>
          [
            `第 ${scene.label} 场（${scene.place || "地点未写"}）`,
            ...scene.shots.map((shot) => {
              const lines = shot.dialogue
                .map((line) => `  ${line.speaker}（${line.id}）：「${line.text}」`)
                .join("\n");
              return [
                `SH-${String(shot.no).padStart(2, "0")}（${shot.id}）${shot.shotSize}：${shot.description || "（动作没写）"}`,
                lines,
              ]
                .filter(Boolean)
                .join("\n");
            }),
          ].join("\n"),
        ),
        "",
        `本地报告的相关提示：${snapshot.notes.length > 0 ? snapshot.notes.join("；") : "（无）"}`,
      ].join("\n"),
    },
  ];
}

const AiItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("dialogue"),
      lineId: z.string().min(1),
      text: z.string().trim().min(1).max(DOCTOR_DIALOGUE_MAX_CHARS),
      why: z.string().trim().max(120).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("shot"),
      shotId: z.string().min(1),
      text: z.string().trim().min(1).max(DOCTOR_SHOT_DESC_MAX_CHARS),
      why: z.string().trim().max(120).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("story"),
      field: z.enum(DOCTOR_STORY_FIELDS),
      text: z.string().trim().min(1).max(DOCTOR_STORY_TEXT_MAX_CHARS),
      why: z.string().trim().max(120).optional(),
    })
    .strict(),
]);

const AiReplySchema = z
  .object({
    reason: z.string().trim().max(DOCTOR_REASON_MAX_CHARS).optional(),
    items: z.array(AiItemSchema).max(DOCTOR_ITEM_MAX),
  })
  .strict();

/**
 * 校验模型输出，并把引用不到的角色 / 台词 / 镜头丢掉。
 *
 * 丢掉未知 id 是安全的：采用仍然要作者点；整条拒绝则会让一次调用白花。
 * 丢完一条不剩就按「没读出能用的改写」处理。
 */
export function parseDoctorReply(
  raw: string,
  snapshot: DoctorSnapshot,
): { reason?: string; items: DoctorRewriteItem[] } | null {
  const json = extractJson(raw);
  if (json === undefined) return null;
  const parsed = AiReplySchema.safeParse(json);
  if (!parsed.success) return null;

  const shotNoById = new Map<string, number>();
  const lineTargetById = new Map<string, string>();
  for (const scene of snapshot.scenes) {
    for (const shot of scene.shots) {
      shotNoById.set(shot.id, shot.no);
      for (const line of shot.dialogue) {
        lineTargetById.set(
          line.id,
          `SH-${String(shot.no).padStart(2, "0")} · ${line.speaker}`,
        );
      }
    }
  }

  const items: DoctorRewriteItem[] = [];
  for (const item of parsed.data.items) {
    if (item.kind === "dialogue") {
      const target = lineTargetById.get(item.lineId);
      if (!target) continue;
      items.push({
        kind: "dialogue",
        lineId: item.lineId,
        text: item.text,
        target,
        ...(item.why ? { why: item.why } : {}),
      });
    } else if (item.kind === "shot") {
      const no = shotNoById.get(item.shotId);
      if (no === undefined) continue;
      items.push({
        kind: "shot",
        shotId: item.shotId,
        text: item.text,
        target: `SH-${String(no).padStart(2, "0")} · 动作`,
        ...(item.why ? { why: item.why } : {}),
      });
    } else {
      items.push({
        kind: "story",
        field: item.field,
        text: item.text,
        target: DOCTOR_STORY_FIELD_LABEL[item.field],
        ...(item.why ? { why: item.why } : {}),
      });
    }
  }
  if (items.length === 0) return null;
  return {
    ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    items,
  };
}
