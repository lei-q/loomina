import { NextResponse } from "next/server";
import { ConfigError, TreecloudError } from "@loomina/gateway";
import { StoryDraftError } from "@loomina/pipeline";
import { recordHealthEvent } from "@/lib/health-events";
import { generateStory, storyInfo } from "@/lib/story";

/**
 * 故事入口（ADR-0088）。
 *
 * GET  看看有没有配文本模型——不触发生成、不花钱
 * POST 把一句话 / 大纲变成故事草稿（logline、人物弧光、场次、镜头、初稿台词）
 *
 * 返回的是草稿：这一层不写 IR，也不替用户换项目。
 */
export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET() {
  try {
    return NextResponse.json(await storyInfo());
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : "读不到文本模型配置";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    idea?: unknown;
    source?: unknown;
    genre?: unknown;
    beatSheet?: unknown;
    modelId?: unknown;
  } | null;
  if (!body) {
    return NextResponse.json({ error: "请求体不是 JSON" }, { status: 400 });
  }

  const idea = typeof body.idea === "string" ? body.idea : undefined;
  const source = typeof body.source === "string" ? body.source : undefined;
  const genre = typeof body.genre === "string" ? body.genre : undefined;
  const beatSheet = typeof body.beatSheet === "string" ? body.beatSheet : undefined;
  const modelId = typeof body.modelId === "string" ? body.modelId : undefined;

  try {
    const result = await generateStory({ idea, source, genre, beatSheet }, modelId);
    void recordHealthEvent({
      at: new Date().toISOString(),
      modality: "text",
      ...(modelId ? { modelId } : {}),
      ok: true,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof TreecloudError ||
      error instanceof ConfigError ||
      error instanceof StoryDraftError
        ? error.message
        : error instanceof Error
          ? error.message.slice(0, 300)
          : "生成失败";
    // 没配模型是配置问题，不是供应商挂了：回 500，界面才能分开说；
    // 模型给了不合规的结构是上游问题，回 502；空输入这类参数问题回 400。
    const status =
      error instanceof ConfigError ||
      (error instanceof TreecloudError && error.code === "text_not_configured")
        ? 500
        : error instanceof StoryDraftError
          ? 502
          : error instanceof TreecloudError
            ? error.status === 400
              ? 400
              : 502
            : 400;
    // 400 是这次请求本身的参数问题（空输入），不算供应商的账
    if (status !== 400) {
      void recordHealthEvent({
        at: new Date().toISOString(),
        modality: "text",
        ...(modelId ? { modelId } : {}),
        ok: false,
        code:
          error instanceof TreecloudError
            ? error.code
            : error instanceof StoryDraftError
              ? "story_draft"
              : error instanceof ConfigError
                ? "config"
                : "unknown",
      });
    }
    return NextResponse.json({ error: message }, { status });
  }
}
