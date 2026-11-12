/**
 * 一句话指令的模型兜底（H19 / ADR-0039 跟进）。
 *
 * 规则表（`parseInstruction`）认七类说法，认不出就直说「没听懂」。
 * 这一层是作者**显式点一下**才会走的第二条路：把同一句话和当前镜头交给
 * 文本模型，让它吐出一个**受同一套 schema 约束**的补丁。
 *
 * 三条底线：
 * 1. 规则表永远先跑；这里只在规则表没听懂时用；
 * 2. 模型只能填允许的字段与枚举，越界 / 多出来的键一律丢弃；
 * 3. 模型给不出具体改动就当没听懂，不写事件、不花钱第二次。
 */

import { z } from "zod";
import { CameraSchema, type Shot } from "@loomina/ir";
import type { ShotPatch } from "@loomina/pipeline";

export const INSTRUCTION_AI_MAX_CHARS = 200;
export const INSTRUCTION_NOTE_MAX_CHARS = 60;
export const INSTRUCTION_REASON_MAX_CHARS = 120;

const SHOT_SIZES = ["wide", "medium", "close", "extreme-close"] as const;
const CAMERA_ANGLES = ["eye", "low", "high", "top"] as const;
const CAMERA_MOVEMENTS = ["static", "push", "pull", "pan", "tilt", "handheld"] as const;

const SHOT_SIZE_CN: Record<(typeof SHOT_SIZES)[number], string> = {
  wide: "全景",
  medium: "中景",
  close: "特写",
  "extreme-close": "大特写",
};
const ANGLE_CN: Record<(typeof CAMERA_ANGLES)[number], string> = {
  eye: "平视",
  low: "仰拍",
  high: "俯拍",
  top: "顶拍",
};
const MOVEMENT_CN: Record<(typeof CAMERA_MOVEMENTS)[number], string> = {
  static: "固定机位",
  push: "推镜",
  pull: "拉镜",
  pan: "横摇",
  tilt: "纵摇",
  handheld: "手持",
};

export type ShotSnapshot = {
  shotNo: number;
  shotSize: Shot["shotSize"];
  /** 整个机位带过来：模型只改角度 / 运镜，焦段与坐标原样保留 */
  camera: Shot["camera"];
  durationMs: number;
  notes: string[];
};

export function shotSnapshotOf(shot: Shot, shotNo: number): ShotSnapshot {
  return {
    shotNo,
    shotSize: shot.shotSize,
    camera: shot.camera,
    durationMs: shot.durationMs,
    notes: shot.promptNotes.slice(0, 8),
  };
}

export const ShotSnapshotSchema = z.object({
  shotNo: z.number().int().positive(),
  shotSize: z.enum(SHOT_SIZES),
  camera: CameraSchema,
  durationMs: z.number().int().min(1).max(60_000),
  notes: z.array(z.string().max(200)).max(12),
});

export type ChatMessage = { role: "system" | "user"; content: string };

export function instructionMessages(
  text: string,
  snapshot: ShotSnapshot,
): ChatMessage[] {
  const notes = snapshot.notes.length > 0 ? snapshot.notes.join("；") : "（没有）";
  return [
    {
      role: "system",
      content: [
        "你是短剧分镜的指令解析器。把作者的一句话翻成一个结构化补丁，不做文学创作。",
        '只输出 JSON，形如 {"patch":{...},"reason":"一句话说明改了什么"}，不要解释、不要代码块。',
        "",
        "允许的字段（全部可选，最多改两项）：",
        '- shotSize: "wide" | "medium" | "close" | "extreme-close"（只表示比现在更近或更远一档）',
        '- cameraAngle: "eye" | "low" | "high" | "top"',
        '- cameraMovement: "static" | "push" | "pull" | "pan" | "tilt" | "handheld"',
        "- durationMs: 1000–8000 的整数（只改镜头时长，一档 500ms）",
        `- note: 落不到上面字段的补充要求，不超过 ${INSTRUCTION_NOTE_MAX_CHARS} 个汉字，会追加进提示词`,
        "",
        "规则：",
        "1. 只改最明确的一个意图；拿不准就返回 \"patch\":{}。",
        "2. 不要改人物、台词、剧情、场景；不要编造不存在的字段。",
        "3. 已有补充里有的意思不要重复写进 note。",
        `4. reason 不超过 ${INSTRUCTION_REASON_MAX_CHARS} 个字，说人话，不要重复原句。`,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `当前镜头 SH-${String(snapshot.shotNo).padStart(2, "0")}：`,
        `景别 ${SHOT_SIZE_CN[snapshot.shotSize]}（${snapshot.shotSize}），`,
        `机位 ${ANGLE_CN[snapshot.camera.angle]}（${snapshot.camera.angle}），`,
        `运镜 ${MOVEMENT_CN[snapshot.camera.movement]}（${snapshot.camera.movement}），`,
        `时长 ${snapshot.durationMs}ms。`,
        `已有补充：${notes}`,
        "",
        `作者说：${text.trim()}`,
      ].join("\n"),
    },
  ];
}

const AiPatchSchema = z
  .object({
    shotSize: z.enum(SHOT_SIZES).optional(),
    cameraAngle: z.enum(CAMERA_ANGLES).optional(),
    cameraMovement: z.enum(CAMERA_MOVEMENTS).optional(),
    durationMs: z.number().int().min(1000).max(8000).optional(),
    note: z.string().trim().min(1).max(INSTRUCTION_NOTE_MAX_CHARS).optional(),
  })
  .strict();

const AiReplySchema = z.object({
  patch: AiPatchSchema.default({}),
  reason: z.string().trim().max(INSTRUCTION_REASON_MAX_CHARS).optional(),
});

export type AiReply = z.infer<typeof AiReplySchema>;

/** 从模型输出里取第一段 JSON：有的模型会包一层 ```json */
export function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** 校验模型输出；字段越界、多出来的键、空补丁都按「没听懂」处理 */
export function parseAiReply(raw: string): AiReply | null {
  const json = extractJson(raw);
  if (json === undefined) return null;
  const parsed = AiReplySchema.safeParse(json);
  if (!parsed.success) return null;
  if (Object.keys(parsed.data.patch).length === 0) return null;
  return parsed.data;
}

/**
 * 模型的补丁 → 能直接写进 `shot.updated` 的补丁。
 *
 * 只保留真的会改变镜头的字段：和现值一样的景别 / 机位 / 时长不写，
 * 已有补充里出现过的 note 不重复追加。
 */
export function aiReplyToShotPatch(
  reply: AiReply,
  snapshot: ShotSnapshot,
): ShotPatch | null {
  const patch: ShotPatch = {};
  const { patch: ai } = reply;

  if (ai.shotSize && ai.shotSize !== snapshot.shotSize) patch.shotSize = ai.shotSize;

  const angle =
    ai.cameraAngle && ai.cameraAngle !== snapshot.camera.angle
      ? ai.cameraAngle
      : snapshot.camera.angle;
  const movement =
    ai.cameraMovement && ai.cameraMovement !== snapshot.camera.movement
      ? ai.cameraMovement
      : snapshot.camera.movement;
  if (angle !== snapshot.camera.angle || movement !== snapshot.camera.movement) {
    patch.camera = { ...snapshot.camera, angle, movement };
  }

  if (ai.durationMs && ai.durationMs !== snapshot.durationMs) {
    patch.durationMs = ai.durationMs;
  }

  const note = ai.note?.trim();
  if (note && !snapshot.notes.includes(note)) patch.note = note;

  return Object.keys(patch).length > 0 ? patch : null;
}

/** 给界面看的成功说明：模型的理解 + 改了哪几处 */
export function describeAiPatch(patch: ShotPatch, reason?: string): string {
  const parts: string[] = [];
  if (patch.shotSize) parts.push(`景别改为${SHOT_SIZE_CN[patch.shotSize]}`);
  if (patch.camera) {
    parts.push(
      `机位改为${ANGLE_CN[patch.camera.angle]} / ${MOVEMENT_CN[patch.camera.movement]}`,
    );
  }
  if (patch.durationMs) parts.push(`时长改为 ${(patch.durationMs / 1000).toFixed(1)}s`);
  if (patch.note) parts.push(`补充「${patch.note}」`);
  const what = parts.length > 0 ? parts.join("，") : "没有具体改动";
  return reason ? `模型这样理解：${reason}（${what}）` : `模型这样理解：${what}`;
}

export type InstructionAiResult =
  | { ok: true; patch: ShotPatch; reason?: string; model: string }
  | { ok: false; error: string };

/** 客户端调用：只有作者点了「让模型读一遍」才会发这一条 */
export async function askInstructionAi(
  text: string,
  snapshot: ShotSnapshot,
): Promise<InstructionAiResult> {
  try {
    const response = await fetch("/api/instruction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, snapshot }),
    });
    const body = (await response.json().catch(() => null)) as
      | { patch?: unknown; reason?: string; model?: string; error?: string }
      | null;
    if (!response.ok || !body) {
      return { ok: false, error: body?.error ?? "模型没回话：稍后再试。" };
    }
    const parsed = AiPatchSchema.safeParse(body.patch);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      return { ok: false, error: "模型给的不是一个能用的补丁：这次没有改动。" };
    }
    const reason = typeof body.reason === "string" ? body.reason.slice(0, INSTRUCTION_REASON_MAX_CHARS) : undefined;
    const patch = aiReplyToShotPatch({ patch: parsed.data, ...(reason ? { reason } : {}) }, snapshot);
    if (!patch) {
      return { ok: false, error: "模型也没读出具体要改什么：换个说法，或点补充上的 × 手动删。" };
    }
    return {
      ok: true,
      patch,
      ...(reason ? { reason } : {}),
      model: body.model ?? "文本模型",
    };
  } catch {
    return { ok: false, error: "连不上服务器：这次没有改动，也不会计费。" };
  }
}
