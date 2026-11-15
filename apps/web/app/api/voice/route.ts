import { NextResponse } from "next/server";
import { ConfigError, TreecloudError } from "@loomina/gateway";
import { speakLine, voiceInfo } from "@/lib/generate-voice";
import { recordHealthEvent } from "@/lib/health-events";
import { ProjectSkillSchema, type ProjectSkill } from "@loomina/ir";
import { compileSkills } from "@loomina/pipeline";
import { z } from "zod";

/**
 * 出声（ADR-0085）。
 *
 * GET  看看有没有配配音模型——不触发生成、不花钱
 * POST 把一句台词念成一条音轨，回 data URI
 *
 * 供应商配额不通时界面还有「贴一条音轨」兜底，所以失败只要如实说话。
 */
export const runtime = "nodejs";
export const maxDuration = 60;

/** 一句台词的文字上限：超过这个数多半是整段稿子贴进来了 */
const TEXT_MAX = 300;

/** 音色标识上限，和 IR 里 `VOICE_PROFILE_MAX` 对齐 */
const VOICE_MAX = 40;

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function skillsOf(value: unknown): ProjectSkill[] | string {
  if (value === undefined) return [];
  const parsed = z.array(ProjectSkillSchema).max(20).safeParse(value);
  if (!parsed.success) return "技能的格式不对";
  return parsed.data;
}

export async function GET() {
  try {
    return NextResponse.json(await voiceInfo());
  } catch (error) {
    const message =
      error instanceof ConfigError ? error.message : "读不到配音配置";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    text?: unknown;
    voice?: unknown;
    modelId?: unknown;
    speed?: unknown;
    instructions?: unknown;
    skills?: unknown;
  } | null;
  if (!body) return bad("请求体不是 JSON");

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return bad("这一句是空的，没有可念的内容");
  if (text.length > TEXT_MAX) return bad(`一次只念一句：${TEXT_MAX} 字以内`);

  const voice = typeof body.voice === "string" ? body.voice.trim() : "";
  if (voice.length > VOICE_MAX) return bad(`音色名太长了：${VOICE_MAX} 字以内`);
  const modelId = typeof body.modelId === "string" ? body.modelId : undefined;
  // 表演参数（C2 / ADR-0124）：越界的值直接钳到合法区间，不因为一个滑块没拦住就整句不念
  const speed =
    typeof body.speed === "number" && Number.isFinite(body.speed)
      ? Math.min(2, Math.max(0.5, body.speed))
      : undefined;
  const skills = skillsOf(body.skills);
  if (typeof skills === "string") return bad(skills);
  // 技能（C18）：配音阶段的要求拼在表演说明后面
  const guidance = compileSkills(skills, "voice");
  const rawInstructions = [
    typeof body.instructions === "string" ? body.instructions.trim() : "",
    guidance,
  ]
    .filter(Boolean)
    .join("；");
  const instructions = rawInstructions ? rawInstructions.slice(0, 300) : undefined;

  try {
    const result = await speakLine({
      text,
      ...(voice ? { voice } : {}),
      modelId,
      ...(speed !== undefined ? { speed } : {}),
      ...(instructions ? { instructions } : {}),
    });
    void recordHealthEvent({
      at: new Date().toISOString(),
      modality: "tts",
      ...(modelId ? { modelId } : {}),
      ok: true,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof TreecloudError || error instanceof ConfigError
        ? error.message
        : error instanceof Error
          ? error.message.slice(0, 300)
          : "出声失败";
    // 没配模型是配置问题，不是供应商挂了：回 500，界面才能分开说
    const status =
      error instanceof ConfigError ||
      (error instanceof TreecloudError && error.code === "tts_not_configured")
        ? 500
        : 502;
    void recordHealthEvent({
      at: new Date().toISOString(),
      modality: "tts",
      ...(modelId ? { modelId } : {}),
      ok: false,
      code:
        error instanceof TreecloudError
          ? error.code
          : error instanceof ConfigError
            ? "config"
            : "unknown",
    });
    return NextResponse.json({ error: message }, { status });
  }
}
