import { spawn } from "node:child_process";
import {
  REFERENCE_SOFT_BYTES,
  fitArgsOf,
  fitsHardLimit,
  shouldFitReference,
} from "@/lib/reference-fit";

/**
 * 出图前把过大的参考图压小（B2 / ADR-0206）。
 *
 * 只在 Node 运行时里跑：ffmpeg 管道，stdin 进原字节、stdout 出 MJPEG。
 * **压不动就原样发**——没有 ffmpeg、ffmpeg 报错、输出空，都不是错误：
 * 生成不该因为「这台机器没装 ffmpeg」而失败（与 preview 路由同一条口径）。
 */

const TIMEOUT_MS = 15_000;

export type Compressed = {
  bytes: Uint8Array;
  mime: string;
  /** 是不是真的压过：false 表示原样返回（不需要压或压不动） */
  fitted: boolean;
};

function runFfmpeg(bytes: Uint8Array): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: Uint8Array | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let child;
    try {
      child = spawn("ffmpeg", fitArgsOf(), { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      done(null);
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, TIMEOUT_MS);

    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => done(null));
    child.on("close", (code) => {
      const out = Buffer.concat(chunks);
      done(code === 0 && out.byteLength > 0 ? new Uint8Array(out) : null);
    });
    // stdin 关得早会 EPIPE：监听一下，别让进程因为这个崩
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(Buffer.from(bytes));
  });
}

/**
 * 一张参考图要不要压、压完是什么。
 *
 * - 不超过软阈值：原样返回；
 * - 压完仍超过网关硬上限：**也原样返回**，由调用方按真实大小如实记 `missing`
 *   （压过了还是太大，这件事要说出来，而不是悄悄发一张会被过滤的图）。
 */
export async function fitReferenceBytes(
  bytes: Uint8Array,
  mime: string,
): Promise<Compressed> {
  if (!shouldFitReference({ bytes: bytes.byteLength, known: true })) {
    return { bytes, mime, fitted: false };
  }
  const out = await runFfmpeg(bytes);
  if (!out || out.byteLength === 0) return { bytes, mime, fitted: false };
  if (!fitsHardLimit(out.byteLength)) return { bytes, mime, fitted: false };
  return { bytes: out, mime: "image/jpeg", fitted: true };
}

export { REFERENCE_SOFT_BYTES };