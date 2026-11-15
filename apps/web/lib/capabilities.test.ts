import { describe, expect, it } from "vitest";
import type { ModelRecord } from "./config-types";
import { buildCapabilityMatrix, buildCapabilityResponse } from "./capabilities";
import type { ProbeReportView } from "./probes";

const MODELS: ModelRecord[] = [
  {
    id: "relay:minimax-h3",
    providerId: "relay",
    modality: "video",
    model: "minimax-h3",
    label: "中转 / minimax-h3",
    resolution: "768p",
    terms: "商用需单独申请",
  },
  {
    id: "relay:seedance-2.0",
    providerId: "relay",
    modality: "video",
    model: "seedance-2.0",
    label: "中转 / seedance-2.0",
    resolution: "720p",
  },
  {
    id: "relay:gpt-image-2-c",
    providerId: "relay",
    modality: "image",
    model: "gpt-image-2-c",
    label: "中转 / 关键帧",
  },
  {
    id: "relay:deepseek",
    providerId: "relay",
    modality: "text",
    model: "deepseek-v4.1-flash-1017",
    label: "中转 / 文本",
  },
  {
    id: "relay:tts",
    providerId: "relay",
    modality: "tts",
    model: "seedance-2.0",
    label: "中转 / 配音",
    voice: "小满",
  },
];

const CONFIG = {
  providers: [{ id: "relay", name: "中转" }],
  models: MODELS,
  defaults: {
    video: "relay:minimax-h3",
    image: "relay:gpt-image-2-c",
    text: "relay:deepseek",
    tts: "relay:tts",
  } as const,
  saved: true,
  path: "/tmp/config.json",
};

const PROBE: ProbeReportView = {
  file: "probe-2026-11-09T14-06-39-503Z.json",
  startedAt: "2026-11-09T14:06:39.503Z",
  videoModel: "minimax-h3",
  imageModel: "gpt-image-2-c",
  resolution: "768p",
  attempts: 1,
  passed: 0,
  passRate: 0,
  totalCny: 0,
  failureCodes: { deadline_exceeded: 1 },
};

const MATRIX = buildCapabilityMatrix(CONFIG, [PROBE]);

function modelOf(id: string) {
  const model = MATRIX.groups
    .flatMap((group) => group.models)
    .find((item) => item.id === id);
  expect(model).toBeDefined();
  return model!;
}

describe("buildCapabilityMatrix", () => {
  it("按模态分组，标出未配置的模态与未确认条款数", () => {
    expect(MATRIX.groups.map((group) => group.modality)).toEqual([
      "text",
      "image",
      "video",
      "tts",
      "asr",
    ]);
    expect(MATRIX.groups.find((group) => group.modality === "video")?.models).toHaveLength(2);
    expect(MATRIX.unconfigured).toEqual(["asr"]);
    expect(MATRIX.modelCount).toBe(5);
    // 只有 minimax-h3 写了条款备注
    expect(MATRIX.termsUnconfirmed).toBe(4);
  });

  it("视频能力只写代码实际发送的东西", () => {
    const model = modelOf("relay:minimax-h3");
    const facts = Object.fromEntries(model.facts.map((fact) => [fact.key, fact]));
    expect(facts["first-frame"]?.value).toContain("input_reference");
    expect(facts["last-frame"]?.value).toContain("不支持");
    expect(facts.duration?.value).toContain("1–8 秒");
    expect(facts.seed?.value).toContain("不传 seed");
    expect(facts.resolution?.source).toBe("config");
    expect(facts.resolution?.value).toBe("768p");
    expect(model.isDefault).toBe(true);
    expect(model.terms).toBe("商用需单独申请");
  });

  it("价目表查得到时给每秒 / 每张单价", () => {
    expect(modelOf("relay:minimax-h3").price).toEqual({
      kind: "known",
      cny: 0.5,
      unit: "per_second",
      basis: "minimax-h3 @ 768p",
    });
    expect(modelOf("relay:gpt-image-2-c").price).toEqual({
      kind: "known",
      cny: 0.12,
      unit: "per_image",
      basis: "gpt-image-2-c",
    });
  });

  it("价目表没有的状态不编价格", () => {
    const video = modelOf("relay:seedance-2.0").price;
    expect(video.kind).toBe("unknown");
    if (video.kind === "unknown") expect(video.reason).toContain("价目表里没有");

    const text = modelOf("relay:deepseek").price;
    expect(text.kind).toBe("unknown");
    if (text.kind === "unknown") expect(text.reason).toContain("token");
  });

  it("视频没填分辨率时说明为什么报不出价", () => {
    const matrix = buildCapabilityMatrix(
      {
        ...CONFIG,
        models: [{ ...MODELS[0]!, resolution: undefined }],
        defaults: { video: "relay:minimax-h3" },
      },
      [],
    );
    const price = matrix.groups[2]!.models[0]!.price;
    expect(price.kind).toBe("unknown");
    if (price.kind === "unknown") expect(price.reason).toContain("没有填分辨率");
  });

  it("S1 报告按模型匹配；分辨率不同时标出来但仍可参考", () => {
    const matched = modelOf("relay:minimax-h3").probe;
    expect(matched?.exact).toBe(true);
    expect(matched?.report.file).toBe(PROBE.file);

    const mismatched = buildCapabilityMatrix(CONFIG, [
      { ...PROBE, resolution: "720p" },
    ]).groups[2]!.models[0]!.probe;
    expect(mismatched?.exact).toBe(false);
    expect(mismatched?.note).toContain("报告是 720p");
  });

  it("图像只按模型匹配，没有报告的模型如实标没有", () => {
    expect(modelOf("relay:gpt-image-2-c").probe?.exact).toBe(true);
    expect(modelOf("relay:deepseek").probe).toBeUndefined();
    expect(modelOf("relay:tts").probe).toBeUndefined();
    // 第二个视频模型不在报告里
    expect(modelOf("relay:seedance-2.0").probe).toBeUndefined();
  });

  it("配音与识别只列已知能力，未知的标未测", () => {
    const tts = modelOf("relay:tts");
    const facts = Object.fromEntries(tts.facts.map((fact) => [fact.key, fact]));
    expect(facts.voice?.value).toContain("小满");
    expect(facts.voice?.source).toBe("config");
    expect(facts.emotion?.value).toContain("不支持");
    expect(tts.price.kind).toBe("unknown");

    const asr = MATRIX.groups.find((group) => group.modality === "asr");
    expect(asr?.models).toEqual([]);
  });

  it("响应带上配置来源与生成时间，便于界面写清楚看的是哪份配置", () => {
    const at = new Date("2026-11-11T08:00:00Z");
    const response = buildCapabilityResponse(CONFIG, [PROBE], at);
    expect(response.saved).toBe(true);
    expect(response.configPath).toBe("/tmp/config.json");
    expect(response.generatedAt).toBe(at.toISOString());
    expect(response.probes).toEqual([PROBE]);
    expect(response.groups).toHaveLength(5);
  });
});

describe("自定义单价（H22）", () => {
  it("视频填元/秒、图像填元/张时盖过价目表", () => {
    const matrix = buildCapabilityMatrix(
      {
        ...CONFIG,
        models: MODELS.map((model) => {
          if (model.id === "relay:minimax-h3") return { ...model, perSecondCny: 0.9 };
          if (model.id === "relay:gpt-image-2-c") return { ...model, perImageCny: 0.2 };
          if (model.id === "relay:seedance-2.0") return { ...model, perSecondCny: 0.66 };
          return model;
        }),
      },
      [],
    );
    const video = matrix.groups
      .flatMap((group) => group.models)
      .find((model) => model.id === "relay:minimax-h3")!;
    expect(video.price).toMatchObject({
      kind: "known",
      cny: 0.9,
      unit: "per_second",
      basis: "作者填的自定义单价",
    });
    const image = matrix.groups
      .flatMap((group) => group.models)
      .find((model) => model.id === "relay:gpt-image-2-c")!;
    expect(image.price).toMatchObject({
      kind: "known",
      cny: 0.2,
      unit: "per_image",
      basis: "作者填的自定义单价",
    });
    // 价目表里没有的 seedance：填了就能报价
    const seedance = matrix.groups
      .flatMap((group) => group.models)
      .find((model) => model.id === "relay:seedance-2.0")!;
    expect(seedance.price).toMatchObject({ kind: "known", cny: 0.66 });
  });
});
