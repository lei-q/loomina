import {
  TreecloudClient,
  TreecloudTranscriptionAdapter,
  loadEnvFile,
  treecloudEnvFrom,
} from "@loomina/gateway";
import { envPath } from "@/lib/server-env";

/**
 * 服务端识别（ADR-0087）。
 *
 * 只收内嵌音轨（data:audio/…;base64）：音轨本来就在浏览器本地日志里，
 * 服务端不替用户去抓外部地址，少一个 SSRF 口子。
 * 识别结果是「建议」——写回台词是界面上的一次确认，服务端不自动改 IR。
 */

export type TranscribeInfo = {
  /** 配了 ASR 模型才给；没配就是空，界面据此说「还没配识别模型」 */
  model?: string;
};

export function transcribeInfo(): TranscribeInfo {
  const config = treecloudEnvFrom(loadEnvFile(envPath()));
  return config.asrModel ? { model: config.asrModel } : {};
}

export type TranscribedLine = {
  text: string;
  model: string;
  /** 供应商给的逐段分时；没给就是空数组，不猜 */
  segments: { text: string; startMs: number; endMs: number }[];
};

/** 一句台词的音轨上限，和「贴音轨」的上限对齐（8 MB） */
const AUDIO_BYTES_MAX = 8_000_000;

export async function transcribeLine(request: {
  uri: string;
  mime?: string;
}): Promise<TranscribedLine> {
  const match = /^data:(audio\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(
    request.uri.trim(),
  );
  if (!match) {
    throw new Error(
      "识别只收内嵌音轨（data:audio/…;base64）：先给这一句配一条音轨，或贴上自己的录音。",
    );
  }
  const mime = request.mime?.trim() || match[1]!;
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length === 0) {
    throw new Error("这条音轨是空的，没有可识别的内容。");
  }
  if (bytes.length > AUDIO_BYTES_MAX) {
    throw new Error("这条音轨太大了（超过 8 MB），没有送去识别。");
  }

  const config = treecloudEnvFrom(loadEnvFile(envPath()));
  const client = new TreecloudClient({ ...config, timeoutMs: 60_000 });
  const adapter = new TreecloudTranscriptionAdapter(client);
  const extension =
    /^[a-z0-9]+$/i.exec(mime.split("/")[1] ?? "")?.[0] ?? "bin";
  const output = await adapter.transcribe({
    bytes,
    mime,
    filename: `line.${extension}`,
  });

  return {
    text: output.text,
    model: output.provenance.modelId,
    segments: output.segments,
  };
}
