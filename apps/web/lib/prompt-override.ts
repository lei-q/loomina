/**
 * 手改提示词（ADR-0148）。
 *
 * 每个会调模型的阶段都把「这次真正送出去的那一段」摆在生成按钮旁边；
 * 作者改过就带上改后的版本，没改就用代码拼出来的默认提示词。
 *
 * 这一层只做形状与长度校验：提示词是作者自己的文本，
 * 能不能送出去由 H6 的 `assertPromptAllowed` 在调用前判定。
 */

/** 一段提示词的上限：默认提示词最长约两千字，四千字留出改写空间，也防手滑贴整篇稿子 */
export const PROMPT_OVERRIDE_MAX = 4000;

/** 故事阶段是系统 + 用户两条消息，单条可以更长 */
export const STORY_PROMPT_OVERRIDE_MAX = 8000;

export type PromptOverrideRead = { prompt?: string; error?: string };

/**
 * 从请求体里读一段可选的提示词。
 *
 * 缺省 / 空串 / 纯空白都按「没改」处理：走默认提示词，
 * 不因为界面上留了一个空的输入框就把生成拦下来。
 */
export function readPromptOverride(
  value: unknown,
  max = PROMPT_OVERRIDE_MAX,
): PromptOverrideRead {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string") return { error: "提示词只能是文本" };
  const prompt = value.trim();
  if (!prompt) return {};
  if (prompt.length > max) {
    return { error: `提示词太长了：${max} 字以内` };
  }
  return { prompt };
}
