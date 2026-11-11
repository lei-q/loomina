import { ConfigError, TreecloudChatAdapter, TreecloudClient } from "@loomina/gateway";
import {
  SOURCE_MAX_CHARS,
  beatSheetById,
  importStoryMessages,
  parseStoryDraft,
  storyMessages,
  type StoryDraft,
} from "@loomina/pipeline";
import { gatewayConfigOf, resolveModel } from "@/lib/app-config";

/**
 * 服务端故事生成（ADR-0088）。
 *
 * 一次调用产出 A1 / A3 / A4 的共用草稿；结果不写 IR，
 * 只有用户在 `/story` 点「用它开工」才构造新项目。
 */

export type StoryInfo = {
  /** 配了文本模型才给；没配就是空，界面据此说「还没配文本模型」 */
  model?: string;
  /** 配置页里的模型 id；页面切换时用它 */
  modelId?: string;
  provider?: string;
};

export async function storyInfo(): Promise<StoryInfo> {
  try {
    const resolved = await resolveModel("text");
    return {
      model: resolved.model.model,
      modelId: resolved.model.id,
      provider: resolved.provider.name,
    };
  } catch (error) {
    if (error instanceof ConfigError) return {};
    throw error;
  }
}

export type StoryResult = {
  draft: StoryDraft;
  model: string;
};

const IDEA_MAX = 2000;
const GENRE_MAX = 20;

export type StoryRequest = {
  idea?: string;
  source?: string;
  genre?: string;
  /** 节拍表 id：60s / 3min / series（A17） */
  beatSheet?: string;
};

export async function generateStory(
  request: StoryRequest,
  modelId?: string,
): Promise<StoryResult> {
  const idea = request.idea?.trim() ?? "";
  const source = request.source?.trim() ?? "";
  if (idea && source) {
    throw new Error("想法和剧本文本只能给一个：从想法开始，或导入 txt。");
  }
  if (!idea && !source) {
    throw new Error(
      source === "" && request.source !== undefined
        ? "导入的剧本是空的，先选一个 txt 或粘贴文字。"
        : "先写一句想法或一段大纲。",
    );
  }
  if (idea.length > IDEA_MAX) {
    throw new Error(`想法太长了（超过 ${IDEA_MAX} 字），先压缩成一段大纲。`);
  }
  if (source.length > SOURCE_MAX_CHARS) {
    throw new Error(
      `剧本太长了（超过 ${SOURCE_MAX_CHARS} 字），先截取一段，或拆成几集分别导入。`,
    );
  }
  const genre = request.genre?.trim().slice(0, GENRE_MAX) || undefined;
  const beatSheetId = request.beatSheet?.trim() || undefined;
  const beatSheet = beatSheetId ? beatSheetById(beatSheetId) : undefined;
  if (beatSheetId && !beatSheet) {
    throw new Error(`不认识的节拍表：${beatSheetId}。可选 60s / 3min / series。`);
  }

  const config = gatewayConfigOf(await resolveModel("text", modelId));
  const client = new TreecloudClient({ ...config, timeoutMs: 150_000 });
  const adapter = new TreecloudChatAdapter(client);
  const output = await adapter.complete({
    messages: source
      ? importStoryMessages(source, genre, beatSheet)
      : storyMessages(idea, genre, beatSheet),
    // 实测 claude-sonnet-5-5 生成一份完整草稿约 1 万 completion tokens，
    // 其中一半是推理；8000 会在 JSON 中途截断（ADR-0088）。
    maxTokens: 16_000,
  });

  return {
    draft: parseStoryDraft(output.text),
    model: output.provenance.modelId,
  };
}
