import { ConfigError, TreecloudClient, TreecloudSpeechAdapter } from "@loomina/gateway";
import { gatewayConfigOf, resolveModel } from "@/lib/app-config";
import { meteredCostCny } from "@/lib/metered-price";

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
  /**
   * 这一句念了多少字（H4）：按去空白后的字数计，供应商按字收费。
   * 中文一个字算一个，英文按字符算——与「元 / 千字」的口径一致。
   */
  chars: number;
  /** 这一次出声花了多少（元）；作者没在设置页填配音单价时为 undefined */
  cny?: number;
};

export async function speakLine(request: {
  text: string;
  voice?: string;
  modelId?: string;
  /** 语速（C2 / ADR-0124）；供应商忽略时与不传一致 */
  speed?: number;
  /** 表演说明（C2 / ADR-0124）；供应商忽略时与不传一致 */
  instructions?: string;
}): Promise<SpokenLine> {
  const resolved = await resolveModel("tts", request.modelId);
  const client = new TreecloudClient({ ...gatewayConfigOf(resolved), timeoutMs: 60_000 });
  const adapter = new TreecloudSpeechAdapter(client);

  const output = await adapter.speak({
    text: request.text,
    ...(request.voice ? { voice: request.voice } : {}),
    ...(request.speed !== undefined ? { speed: request.speed } : {}),
    ...(request.instructions ? { instructions: request.instructions } : {}),
  });

  // 一句台词不该有几 MB；超了说明供应商回的不是这一句，宁可报错
  const base64 = Buffer.from(output.bytes).toString("base64");
  if (base64.length > 8_000_000) {
    throw new Error("这一句的音轨太大了（超过 8 MB），没有收下");
  }

  // 配音按字计价（H4）：字数就是发出去的这句，去空白后再数
  const chars = request.text.replace(/\s+/g, "").length;
  const cny = meteredCostCny("tts", chars, resolved.model.unitPriceCny);

  return {
    uri: `data:${output.mime};base64,${base64}`,
    mime: output.mime,
    model: output.provenance.modelId,
    ...(request.voice ? { voice: request.voice } : {}),
    chars,
    ...(cny !== undefined ? { cny } : {}),
  };
}
