import { NextResponse } from "next/server";
import { DoctorSnapshotSchema } from "@/lib/doctor-ai";
import { ProjectSkillSchema, type ProjectSkill } from "@loomina/ir";
import { z } from "zod";
import { doctorErrorOf, rewriteWithDoctor } from "@/lib/doctor-run";
import { recordHealthEvent } from "@/lib/health-events";

/**
 * 剧本医生的模型改写（A18 / ADR-0123）。
 *
 * 一次一个模式；只回建议，不写 IR，也不替作者按「采用」。
 * 快照里有标题、故事层文字与剧本本身，没有素材地址与密钥。
 */
export const runtime = "nodejs";
export const maxDuration = 90;

function skillsOf(value: unknown): ProjectSkill[] | string {
  if (value === undefined) return [];
  const parsed = z.array(ProjectSkillSchema).max(20).safeParse(value);
  if (!parsed.success) return "技能的格式不对";
  return parsed.data;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    snapshot?: unknown;
    skills?: unknown;
  } | null;
  if (!body) {
    return NextResponse.json({ error: "请求体不是 JSON" }, { status: 400 });
  }
  const snapshot = DoctorSnapshotSchema.safeParse(body.snapshot);
  if (!snapshot.success) {
    return NextResponse.json({ error: "剧本快照不完整" }, { status: 400 });
  }

  const skills = skillsOf(body.skills);
  if (typeof skills === "string") {
    return NextResponse.json({ error: skills }, { status: 400 });
  }

  try {
    const result = await rewriteWithDoctor(snapshot.data, skills);
    void recordHealthEvent({
      at: new Date().toISOString(),
      modality: "text",
      ok: true,
    });
    return NextResponse.json(result);
  } catch (error) {
    const { message, status } = doctorErrorOf(error);
    void recordHealthEvent({
      at: new Date().toISOString(),
      modality: "text",
      ok: false,
      code: status === 422 ? "doctor_noop" : status === 502 ? "provider_error" : "unknown",
    });
    return NextResponse.json({ error: message }, { status });
  }
}
