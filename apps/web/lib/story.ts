import {
  TreecloudChatAdapter,
  TreecloudClient,
  loadEnvFile,
  treecloudEnvFrom,
} from "@loomina/gateway";
import {
  parseStoryDraft,
  storyMessages,
  type StoryDraft,
} from "@loomina/pipeline";
import { envPath } from "@/lib/server-env";

/**
 * 服务端故事生成（ADR-0088）。
 *
 * 一次调用产出 A1 / A3 / A4 的共用草稿；结果不写 IR，
 * 只有用户在 `/story` 点「用它开工」才构造新项目。
 */

export type StoryInfo = {
  /** 配了文本模型才给；没配就是空，界面据此说「还没配文本模型」 */
  model?: string;
};

export function storyInfo(): StoryInfo {
  const config = treecloudEnvFrom(loadEnvFile(envPath()));
  return config.textModel ? { model: config.textModel } : {};
}

export type StoryResult = {
  draft: StoryDraft;
  model: string;
};

const IDEA_MAX = 2000;
const GENRE_MAX = 20;

export async function generateStory(request: {
  idea: string;
  genre?: string;
}): Promise<StoryResult> {
  const idea = request.idea.trim();
  if (!idea) throw new Error("先写一句想法或一段大纲。");
  if (idea.length > IDEA_MAX) {
    throw new Error(`想法太长了（超过 ${IDEA_MAX} 字），先压缩成一段大纲。`);
  }
  const genre = request.genre?.trim().slice(0, GENRE_MAX) || undefined;

  const config = treecloudEnvFrom(loadEnvFile(envPath()));
  const client = new TreecloudClient({ ...config, timeoutMs: 150_000 });
  const adapter = new TreecloudChatAdapter(client);
  const output = await adapter.complete({
    messages: storyMessages(idea, genre),
    // 实测 claude-sonnet-5-5 生成一份完整草稿约 1 万 completion tokens，
    // 其中一半是推理；8000 会在 JSON 中途截断（ADR-0088）。
    maxTokens: 16_000,
  });

  return {
    draft: parseStoryDraft(output.text),
    model: output.provenance.modelId,
  };
}
