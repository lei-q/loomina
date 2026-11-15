import type { ProjectSkill } from "@loomina/ir";
import { ConfigError, TreecloudChatAdapter, TreecloudClient, TreecloudError } from "@loomina/gateway";
import type { ShotPatch } from "@loomina/pipeline";
import { gatewayConfigOf, resolveModel } from "@/lib/app-config";
import {
  aiReplyToShotPatch,
  instructionMessages,
  parseAiReply,
  type ShotSnapshot,
} from "@/lib/instruction-ai";

/**
 * 让文本模型把一句话翻成镜头补丁（H19 的模型兜底）。
 *
 * 只在作者点了「让模型读一遍」时调用；规则表先跑，这里不抢它的活。
 * 模型输出必须过 `parseAiReply` 的 schema，越界与空补丁都当没听懂。
 */

export class InstructionAiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InstructionAiError";
  }
}

export type InstructionRun = {
  patch: ShotPatch;
  reason?: string;
  model: string;
};

export async function interpretInstruction(
  text: string,
  snapshot: ShotSnapshot,
  skills?: ProjectSkill[],
): Promise<InstructionRun> {
  const resolved = await resolveModel("text");
  const client = new TreecloudClient({ ...gatewayConfigOf(resolved), timeoutMs: 45_000 });
  const adapter = new TreecloudChatAdapter(client);
  const output = await adapter.complete({
    messages: instructionMessages(text, snapshot, skills),
    // 一条补丁只有几个字段；给到 600 是留给「先想一想」的推理 token
    maxTokens: 600,
  });
  const reply = parseAiReply(output.text);
  if (!reply) {
    throw new InstructionAiError("模型给的不是一个能用的补丁：这次没有改动。", 502);
  }
  const patch = aiReplyToShotPatch(reply, snapshot);
  if (!patch) {
    throw new InstructionAiError(
      "模型也没读出具体要改什么：换个说法，或点补充上的 × 手动删。",
      422,
    );
  }
  return {
    patch,
    ...(reply.reason ? { reason: reply.reason } : {}),
    model: output.provenance.modelId,
  };
}

/** 错误 → 说人话的提示 + HTTP 状态；供应商的原始报错不直接怼给作者 */
export function instructionErrorOf(error: unknown): { message: string; status: number } {
  if (error instanceof InstructionAiError) {
    return { message: error.message, status: error.status };
  }
  if (error instanceof ConfigError) {
    return { message: "还没配文本模型：去设置页选一个，再让模型读。", status: 500 };
  }
  if (error instanceof TreecloudError) {
    return {
      message:
        error.status === 429
          ? "文本模型在限流：等一会儿再点。"
          : `文本模型没回话：${error.message.slice(0, 120)}`,
      status: 502,
    };
  }
  return {
    message: error instanceof Error ? error.message.slice(0, 160) : "模型没读出来",
    status: 500,
  };
}
