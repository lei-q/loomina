import { NextResponse } from "next/server";
import { recordHealthEvent } from "@/lib/health-events";
import { INSTRUCTION_AI_MAX_CHARS, ShotSnapshotSchema } from "@/lib/instruction-ai";
import { instructionErrorOf, interpretInstruction } from "@/lib/instruction-run";
import { ProjectSkillSchema, type ProjectSkill } from "@loomina/ir";
import { z } from "zod";

/**
 * 一句话指令的模型兜底（H19）。
 *
 * 规则表在前端先跑；只有作者点了「让模型读一遍」才会走到这里。
 * 一次请求只回一个补丁（或一句「没读懂」），不写 IR，也不替作者按下去。
 *
 * 不记提示词：模型看到的是作者的一句话与镜头的公开字段，没有素材与密钥。
 */
export const runtime = "nodejs";
export const maxDuration = 60;

function skillsOf(value: unknown): ProjectSkill[] | string {
  if (value === undefined) return [];
  const parsed = z.array(ProjectSkillSchema).max(20).safeParse(value);
  if (!parsed.success) return "技能的格式不对";
  return parsed.data;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    text?: unknown;
    snapshot?: unknown;
    skills?: unknown;
  } | null;
  if (!body) {
    return NextResponse.json({ error: "请求体不是 JSON" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "先说一句要改什么" }, { status: 400 });
  }
  if (text.length > INSTRUCTION_AI_MAX_CHARS) {
    return NextResponse.json(
      { error: `一句话最多 ${INSTRUCTION_AI_MAX_CHARS} 个字` },
      { status: 400 },
    );
  }

  const snapshot = ShotSnapshotSchema.safeParse(body.snapshot);
  if (!snapshot.success) {
    return NextResponse.json({ error: "当前镜头的状态不完整" }, { status: 400 });
  }

  const skills = skillsOf(body.skills);
  if (typeof skills === "string") {
    return NextResponse.json({ error: skills }, { status: 400 });
  }

  try {
    const result = await interpretInstruction(text, snapshot.data, skills);
    void recordHealthEvent({
      at: new Date().toISOString(),
      modality: "text",
      ok: true,
    });
    return NextResponse.json(result);
  } catch (error) {
    const { message, status } = instructionErrorOf(error);
    void recordHealthEvent({
      at: new Date().toISOString(),
      modality: "text",
      ok: false,
      code: status === 422 ? "instruction_noop" : status === 502 ? "provider_error" : "unknown",
    });
    return NextResponse.json({ error: message }, { status });
  }
}
