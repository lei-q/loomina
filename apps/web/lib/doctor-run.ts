import { ConfigError, TreecloudChatAdapter, TreecloudClient, TreecloudError } from "@loomina/gateway";
import { gatewayConfigOf, resolveModel } from "@/lib/app-config";
import {
  DOCTOR_ITEM_MAX,
  doctorMessages,
  parseDoctorReply,
  type DoctorSnapshot,
  type DoctorRewrite,
} from "@/lib/doctor-ai";

/**
 * 剧本医生的模型改写（A18 第二档 / ADR-0123）。
 *
 * 只在作者点「让模型改一版」时调用；一次一个模式，最多回三条建议。
 * 建议不进 IR，采用是界面上的另一次点击。
 */

export class DoctorAiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DoctorAiError";
  }
}

export async function rewriteWithDoctor(snapshot: DoctorSnapshot): Promise<DoctorRewrite> {
  const resolved = await resolveModel("text");
  const client = new TreecloudClient({ ...gatewayConfigOf(resolved), timeoutMs: 60_000 });
  const adapter = new TreecloudChatAdapter(client);
  const output = await adapter.complete({
    messages: doctorMessages(snapshot),
    // 三条短改写；给到 1200 是留给模型先列问题再改
    maxTokens: 1200,
  });
  const reply = parseDoctorReply(output.text, snapshot);
  if (!reply) {
    throw new DoctorAiError(
      "模型没给出能替换原文的改写：换个模式，或先补全这一镜的动作与台词。",
      422,
    );
  }
  return {
    mode: snapshot.mode,
    ...(reply.reason ? { reason: reply.reason } : {}),
    model: output.provenance.modelId,
    items: reply.items.slice(0, DOCTOR_ITEM_MAX),
  };
}

/** 错误 → 说人话的提示 + HTTP 状态；供应商原始报错不直接怼给作者 */
export function doctorErrorOf(error: unknown): { message: string; status: number } {
  if (error instanceof DoctorAiError) {
    return { message: error.message, status: error.status };
  }
  if (error instanceof ConfigError) {
    return { message: "还没配文本模型：去设置页选一个，再让医生改。", status: 500 };
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
    message: error instanceof Error ? error.message : "剧本医生这次没跑成。",
    status: 500,
  };
}
