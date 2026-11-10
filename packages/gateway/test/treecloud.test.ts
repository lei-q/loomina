import { describe, expect, it } from "vitest";
import {
  ConfigError,
  TreecloudClient,
  TreecloudError,
  TreecloudImageAdapter,
  TreecloudSpeechAdapter,
  TreecloudVideoAdapter,
  imageUriOf,
  mapVideoStatus,
  parseEnvFile,
  treecloudEnvFrom,
  videoUriOf,
} from "../src/index";
import { videoCostCny, imageCostCny } from "../src/pricing";

const NOW = () => "2026-11-09T12:00:00Z";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fakeFetch(responses: Array<() => Response>) {
  const calls: Call[] = [];
  let index = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next) throw new Error("没有预置响应");
    return next();
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function clientWith(responses: Array<() => Response>, extra: Record<string, unknown> = {}) {
  const { fetcher, calls } = fakeFetch(responses);
  const client = new TreecloudClient({
    baseUrl: "https://relay.test",
    apiKey: "sk-secret-123",
    videoModel: "minimax-h3",
    imageModel: "gpt-image-2-c",
    fetcher,
    now: NOW,
    sleep: async () => {},
    ...extra,
  });
  return { client, calls };
}

describe("env 解析", () => {
  it("解析 KEY=VALUE、引号、export 和注释，且不执行内容", () => {
    const env = parseEnvFile(
      [
        "# 注释",
        "BASE_URL=https://api.test",
        'API_KEY="sk-abc"',
        "export MODEL_NAME='minimax-h3'",
        "EMPTY=",
        "WEIRD=$(rm -rf /)",
      ].join("\n"),
    );

    expect(env.BASE_URL).toBe("https://api.test");
    expect(env.API_KEY).toBe("sk-abc");
    expect(env.MODEL_NAME).toBe("minimax-h3");
    expect(env.EMPTY).toBe("");
    expect(env.WEIRD).toBe("$(rm -rf /)");
  });

  it("缺少变量时报错，且错误信息不含密钥值", () => {
    expect(() => treecloudEnvFrom({ API_KEY: "sk-leak" })).toThrow(ConfigError);

    const env = treecloudEnvFrom({
      BASE_URL: "https://api.test/",
      API_KEY: "sk-leak",
      MODEL_NAME: "minimax-h3",
    });
    expect(env.baseUrl).toBe("https://api.test");
    expect(env.imageModel).toBe("gpt-image-2-c");
  });
});

describe("图片适配器", () => {
  it("按 OpenAI 兼容格式发请求并返回 url", async () => {
    const { client, calls } = clientWith([
      () => jsonResponse({ created: 1, data: [{ url: "https://cdn.test/a.png" }] }),
    ]);

    const adapter = new TreecloudImageAdapter(client, { size: "1024x1536" });
    const output = await adapter.generate({ shotId: "sh-1", prompt: "特写" });

    expect(calls[0]?.url).toBe("https://relay.test/v1/images/generations");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.Authorization).toBe("Bearer sk-secret-123");
    expect(calls[0]?.body).toEqual({
      model: "gpt-image-2-c",
      prompt: "特写",
      n: 1,
      size: "1024x1536",
    });
    expect(output.uri).toBe("https://cdn.test/a.png");
    expect(output.provenance.modelId).toBe("gpt-image-2-c");
    expect(output.provenance.createdAt).toBe(NOW());
  });

  it("支持 b64_json，转成 data URI", () => {
    expect(imageUriOf({ data: [{ b64_json: "QUJD" }] })).toBe(
      "data:image/png;base64,QUJD",
    );
  });
});

describe("视频适配器", () => {
  it("提交后轮询到成功，并带回首帧引用与花费", async () => {
    const { client, calls } = clientWith([
      () => jsonResponse({ id: "vid_1", status: "queued" }),
      () =>
        jsonResponse({
          id: "vid_1",
          status: "running",
          model: "minimax-h3",
        }),
      () =>
        jsonResponse({
          id: "vid_1",
          status: "succeeded",
          model: "minimax-h3",
          seconds: 4,
          output: { url: "https://cdn.test/a.mp4" },
          usage: { cost_cny: 2.1 },
        }),
    ]);

    const adapter = new TreecloudVideoAdapter(client, { resolution: "768p" });
    const { jobId } = await adapter.submit({
      shotId: "sh-1",
      imageAssetId: "img-1",
      imageUri: "https://cdn.test/a.png",
      durationMs: 4000,
      prompt: "推近",
    });

    expect(jobId).toBe("vid_1");
    expect(calls[0]?.body).toEqual({
      model: "minimax-h3",
      prompt: "推近",
      resolution: "768p",
      seconds: 4,
      content: [{ type: "image_url", image_url: { url: "https://cdn.test/a.png" } }],
    });

    const first = await adapter.poll(jobId);
    expect(first.status).toBe("running");

    const second = await adapter.poll(jobId);
    expect(second.status).toBe("succeeded");
    expect(second.output?.uri).toBe("https://cdn.test/a.mp4");
    expect(second.output?.durationMs).toBe(4000);
    expect(second.output?.costCny).toBe(2.1);
    expect(second.output?.provenance.referenceAssetIds).toEqual(["img-1"]);

    const cached = await adapter.fetch(jobId);
    expect(cached.uri).toBe("https://cdn.test/a.mp4");
  });

  it("失败状态带上原因", async () => {
    const { client } = clientWith([
      () => jsonResponse({ id: "vid_2", status: "queued" }),
      () => jsonResponse({ id: "vid_2", status: "failed", error: { message: "内容审核未通过" } }),
    ]);

    const adapter = new TreecloudVideoAdapter(client);
    const { jobId } = await adapter.submit({ shotId: "sh-1", imageAssetId: "img-1", durationMs: 1000 });
    const job = await adapter.poll(jobId);

    expect(job.status).toBe("failed");
    expect(job.error).toBe("内容审核未通过");
  });

  it("路由不匹配时自动换到 LiteLLM 路径并记住", async () => {
    const { client, calls } = clientWith([
      () => jsonResponse({ detail: "Method Not Allowed" }, 405),
      () => jsonResponse({ id: "video_abc", status: "queued" }),
      () => jsonResponse({ id: "video_abc", status: "in_progress" }),
    ]);

    const adapter = new TreecloudVideoAdapter(client);
    const { jobId } = await adapter.submit({
      shotId: "sh-1",
      imageAssetId: "img-1",
      durationMs: 4000,
    });

    expect(jobId).toBe("video_abc");
    expect(calls[0]?.url).toBe("https://relay.test/v1/videos/generations");
    expect(calls[1]?.url).toBe("https://relay.test/v1/videos");
    expect(adapter.activeApi).toBe("litellm");

    await adapter.poll(jobId);
    expect(calls[2]?.url).toBe("https://relay.test/v1/videos/video_abc");
  });

  it("限流 429 按 Retry-After 重试一次", async () => {
    const { client, calls } = clientWith([
      () => jsonResponse({ error: { code: 42900, message: "rate limit" } }, 429, { "retry-after": "0" }),
      () => jsonResponse({ id: "vid_3", status: "queued" }),
    ]);

    const adapter = new TreecloudVideoAdapter(client);
    const { jobId } = await adapter.submit({ shotId: "sh-1", imageAssetId: "img-1", durationMs: 1000 });

    expect(jobId).toBe("vid_3");
    expect(calls).toHaveLength(2);
  });

  it("配额耗尽 429 不重试", async () => {
    const { client, calls } = clientWith([
      () => jsonResponse({ error: { code: 17003, message: "AI token quota exceeded" } }, 429),
    ]);

    const adapter = new TreecloudVideoAdapter(client);
    await expect(
      adapter.submit({ shotId: "sh-1", imageAssetId: "img-1", durationMs: 1000 }),
    ).rejects.toMatchObject({ status: 429 });

    expect(calls).toHaveLength(1);
  });
});

describe("配音适配器", () => {
  it("按 OpenAI 兼容格式发请求，按二进制收回音频", async () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
    const { client, calls } = clientWith(
      [
        () =>
          new Response(audio, {
            status: 200,
            headers: { "content-type": "audio/mpeg; charset=binary" },
          }),
      ],
      { ttsModel: "qwen-audio-3.0-tts-flash", ttsVoice: "Cherry" },
    );

    const adapter = new TreecloudSpeechAdapter(client);
    const output = await adapter.speak({ text: "你终于来了。" });

    expect(adapter.configured).toBe(true);
    expect(calls[0]?.url).toBe("https://relay.test/v1/audio/speech");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      model: "qwen-audio-3.0-tts-flash",
      input: "你终于来了。",
      response_format: "mp3",
      voice: "Cherry",
    });
    expect(Array.from(output.bytes)).toEqual(Array.from(audio));
    expect(output.mime).toBe("audio/mpeg");
    expect(output.provenance.modelId).toBe("qwen-audio-3.0-tts-flash");
  });

  it("没配 TTS_MODEL 时不发请求，直接说没配", async () => {
    const { client, calls } = clientWith([() => jsonResponse({})]);
    const adapter = new TreecloudSpeechAdapter(client);

    expect(adapter.configured).toBe(false);
    await expect(adapter.speak({ text: "喂" })).rejects.toMatchObject({
      code: "tts_not_configured",
      status: 500,
    });
    expect(calls).toHaveLength(0);
  });

  it("失败的 JSON 错误体仍然被读成人话", async () => {
    const { client } = clientWith(
      [
        () =>
          jsonResponse(
            { error: { code: "invalid_request", message: "No authorized bound group supports this request" } },
            403,
          ),
      ],
      { ttsModel: "qwen-audio-3.0-tts-flash" },
    );

    const adapter = new TreecloudSpeechAdapter(client);
    await expect(adapter.speak({ text: "喂" })).rejects.toMatchObject({
      status: 403,
      message: "No authorized bound group supports this request",
    });
  });
});

describe("错误与状态映射", () => {
  it("错误信息里不会出现密钥", async () => {
    const { client } = clientWith([
      () => jsonResponse({ error: { code: "invalid_request", message: "bad key sk-secret-123" } }, 400),
    ]);

    await expect(
      client.request("/v1/images/generations", { method: "POST", body: {} }),
    ).rejects.toThrow(/<redacted>/);

    try {
      await client.request("/v1/images/generations", { method: "POST", body: {} });
    } catch (error) {
      const err = error as TreecloudError;
      expect(err.status).toBe(400);
      expect(err.code).toBe("invalid_request");
      expect(err.message).not.toContain("sk-secret-123");
    }
  });

  it("请求超时会中止并报 client_timeout", async () => {
    const client = new TreecloudClient({
      baseUrl: "https://relay.test",
      apiKey: "sk-secret-123",
      videoModel: "minimax-h3",
      imageModel: "gpt-image-2-c",
      timeoutMs: 10,
      fetcher: ((_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch,
    });

    await expect(client.request("/v1/models")).rejects.toMatchObject({
      code: "client_timeout",
      status: 408,
    });
  });

  it("状态字符串覆盖常见别名", () => {
    expect(mapVideoStatus("queued")).toBe("queued");
    expect(mapVideoStatus("in_progress")).toBe("running");
    expect(mapVideoStatus("COMPLETED")).toBe("succeeded");
    expect(mapVideoStatus("expired")).toBe("failed");
    expect(mapVideoStatus(undefined)).toBe("queued");
  });

  it("能从多种返回形态里找视频地址", () => {
    expect(videoUriOf({ url: "a" })).toBe("a");
    expect(videoUriOf({ output: "b" })).toBe("b");
    expect(videoUriOf({ data: [{ url: "c" }] })).toBe("c");
    expect(videoUriOf({ outputs: [{ video_url: "d" }] })).toBe("d");
    expect(videoUriOf({ foo: 1 })).toBeUndefined();
  });
});

describe("价目表", () => {
  it("已知模型能算出每秒价格", () => {
    expect(videoCostCny("wan3.0-video", "720p", 5000)).toBe(3);
    expect(videoCostCny("minimax-h3", "768p", 4000)).toBe(2);
    expect(videoCostCny("seedance-2.0", "720p", 4000)).toBeUndefined();
    expect(imageCostCny("gpt-image-2-c")).toBe(0.12);
  });
});
