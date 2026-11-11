import { ConfigError, TreecloudClient, TreecloudSpeechAdapter } from "@loomina/gateway";
import { gatewayConfigOf, resolveModel } from "@/lib/app-config";

/**
 * 服务端出声（ADR-0085）。
 *
 * 一句台词一次请求：供应商直接回音频字节，这里转成 data URI 交给浏览器存进本地日志。
 * 密钥仍然只在服务端；音频时长不由网关猜——浏览器读完 `loadedmetadata`
 * 再把真实时长写回 IR（准则 P5：镜头时长服从配音）。
 */

export type VoiceInfo = {
  /** 配了 TTS 模型才给；没配就是空，界面据此说「还没配配音模型」 */
  model?: string;
  /** 默认音色 */
  voice?: string;
  /** 配置页里的模型 id */
  modelId?: string;
};

export async function voiceInfo(): Promise<VoiceInfo> {
  try {
    const { model } = await resolveModel("tts");
    return {
      model: model.model,
      modelId: model.id,
      ...(model.voice ? { voice: model.voice } : {}),
    };
  } catch (error) {
    if (error instanceof ConfigError) return {};
    throw error;
  }
}

export type SpokenLine = {
  uri: string;
  mime: string;
  model: string;
  voice?: string;
};

export async function speakLine(request: {
  text: string;
  voice?: string;
  modelId?: string;
}): Promise<SpokenLine> {
  const config = gatewayConfigOf(await resolveModel("tts", request.modelId));
  const client = new TreecloudClient({ ...config, timeoutMs: 60_000 });
  const adapter = new TreecloudSpeechAdapter(client);

  const output = await adapter.speak({
    text: request.text,
    ...(request.voice ? { voice: request.voice } : {}),
  });

  // 一句台词不该有几 MB；超了说明供应商回的不是这一句，宁可报错
  const base64 = Buffer.from(output.bytes).toString("base64");
  if (base64.length > 8_000_000) {
    throw new Error("这一句的音轨太大了（超过 8 MB），没有收下");
  }

  return {
    uri: `data:${output.mime};base64,${base64}`,
    mime: output.mime,
    model: output.provenance.modelId,
    ...(request.voice ? { voice: request.voice } : {}),
  };
}
