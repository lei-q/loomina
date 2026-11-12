import { imagePrice, videoPrice } from "@loomina/gateway/pricing";
import {
  MODALITIES,
  MODALITY_LABEL,
  type Modality,
  type ModelRecord,
} from "./config-types";
import { probeTrends, type ProbeReportView, type ProbeTrend } from "./probes";

/**
 * 模型能力矩阵（B12 / H16 第一版）。
 *
 * 只写三类东西：
 *   1. 代码实际会发送的能力（首帧、时长、seed、参考图、运镜…）；
 *   2. 已保存配置里的值（分辨率、音色、商用条款备注）；
 *   3. 价目表与最近一次 S1 测绘的实测值。
 *
 * 供应商侧没验证过的能力标 `unknown`，不按「应该支持」猜。
 * 这张矩阵目前只做诊断，不参与网关路由或降级——路由要等失败率与条款补齐。
 */

export type CapabilitySource = "code" | "config" | "unknown";

export type CapabilityFact = {
  key: string;
  label: string;
  value: string;
  source: CapabilitySource;
};

export type PriceView =
  | {
      kind: "known";
      cny: number;
      unit: "per_second" | "per_image" | "per_million_tokens" | "per_thousand_chars";
      basis: string;
    }
  | { kind: "unknown"; reason: string };

export type ProbeMatch = {
  report: ProbeReportView;
  /** 模型与分辨率都对上；false 时报告仍可参考，但不能直接当这个配置的通过率 */
  exact: boolean;
  note: string;
};

export type ModelCapabilityView = {
  id: string;
  label: string;
  model: string;
  modality: Modality;
  modalityLabel: string;
  providerId: string;
  providerName: string;
  isDefault: boolean;
  terms?: string;
  facts: CapabilityFact[];
  price: PriceView;
  probe?: ProbeMatch;
};

export type CapabilityGroup = {
  modality: Modality;
  label: string;
  models: ModelCapabilityView[];
};

export type CapabilityMatrix = {
  groups: CapabilityGroup[];
  /** 一个模型都没配的模态 */
  unconfigured: Modality[];
  modelCount: number;
  /** 没有写商用条款备注的模型数 */
  termsUnconfirmed: number;
};

export type CapabilityResponse = CapabilityMatrix & {
  /** 矩阵读的是已保存的配置；false 表示当前仍是 env 临时视图 */
  saved: boolean;
  configPath: string;
  generatedAt: string;
  /** 最近几次 S1 测绘，按时间倒序 */
  probes: ProbeReportView[];
  /** 按模型的走势与实测单价（H16） */
  trends: ProbeTrend[];
};

/** 能力矩阵只需要这两列，绝不把含密钥的 ProviderRecord 传进来。 */
export type CapabilityConfig = {
  providers: { id: string; name: string }[];
  models: ModelRecord[];
  defaults: Partial<Record<Modality, string>>;
  saved: boolean;
  path: string;
};

export const PRICE_UNIT_LABEL: Record<"per_second" | "per_image", string> = {
  per_second: "秒",
  per_image: "张",
};

export function buildCapabilityResponse(
  input: CapabilityConfig,
  probes: ProbeReportView[],
  now: Date = new Date(),
  trends: ProbeTrend[] = probeTrends(probes),
): CapabilityResponse {
  return {
    ...buildCapabilityMatrix(input, probes),
    saved: input.saved,
    configPath: input.path,
    generatedAt: now.toISOString(),
    probes,
    trends,
  };
}

export function buildCapabilityMatrix(
  input: CapabilityConfig,
  probes: ProbeReportView[],
): CapabilityMatrix {
  const providerName = (id: string) =>
    input.providers.find((provider) => provider.id === id)?.name ?? id;

  const groups = MODALITIES.map((modality) => ({
    modality,
    label: MODALITY_LABEL[modality],
    models: input.models
      .filter((model) => model.modality === modality)
      .map((model) => ({
        id: model.id,
        label: model.label,
        model: model.model,
        modality,
        modalityLabel: MODALITY_LABEL[modality],
        providerId: model.providerId,
        providerName: providerName(model.providerId),
        isDefault: input.defaults[modality] === model.id,
        ...(model.terms ? { terms: model.terms } : {}),
        facts: factsOf(model),
        price: priceOf(model),
        ...probeOf(model, probes),
      })),
  }));

  return {
    groups,
    unconfigured: MODALITIES.filter(
      (modality) => !input.models.some((model) => model.modality === modality),
    ),
    modelCount: input.models.length,
    termsUnconfirmed: input.models.filter((model) => !model.terms?.trim()).length,
  };
}

function factsOf(model: ModelRecord): CapabilityFact[] {
  const code = (key: string, label: string, value: string): CapabilityFact => ({
    key,
    label,
    value,
    source: "code",
  });
  const fromConfig = (key: string, label: string, value: string): CapabilityFact => ({
    key,
    label,
    value,
    source: "config",
  });
  const unknown = (key: string, label: string, value: string): CapabilityFact => ({
    key,
    label,
    value,
    source: "unknown",
  });

  switch (model.modality) {
    case "video":
      return [
        code("first-frame", "首帧", "支持 · 作为 content[].image_url 提交"),
        code("last-frame", "尾帧", "不支持 · 网关没有尾帧字段"),
        code("references", "多参考图", "不支持 · 只传一张首帧"),
        code("duration", "时长", "1–8 秒 · 按整秒提交"),
        fromConfig(
          "resolution",
          "分辨率",
          model.resolution || "未填 · 跟随服务端 VIDEO_RESOLUTION",
        ),
        code("camera", "运镜", "仅提示词 · CameraSpec 编进 prompt"),
        code("seed", "种子", "不支持 · 请求里不传 seed"),
        code("audio", "音频输入", "不支持"),
        unknown("concurrency", "并发", "未测"),
        unknown("latency", "延迟", "未测 · 看 S1 报告"),
      ];
    case "image":
      return [
        code("references", "参考图", "不支持 · 当前只走文本生成，收不了图"),
        code("size", "尺寸", "由服务端 IMAGE_SIZE 决定，不按模型区分"),
        code("seed", "种子", "不支持 · 请求里不传 seed"),
        code("count", "一次多张", "不支持 · 一次请求一张"),
        unknown("concurrency", "并发", "未测"),
        unknown("latency", "延迟", "未测"),
      ];
    case "text":
      return [
        code("output", "输出", "JSON · 按 zod 结构校验，不合规直接报错"),
        code("max-tokens", "max_tokens", "故事生成 16000；其它调用不设上限"),
        code("temperature", "temperature", "不传 · 用供应商默认值"),
        code("stream", "流式", "未使用 · 等整段返回"),
        unknown("context", "上下文窗口", "未测 · 以供应商文档为准"),
      ];
    case "tts":
      return [
        fromConfig("voice", "音色", model.voice ? `已配：${model.voice}` : "跟随服务端默认"),
        code("format", "输出格式", "mp3"),
        code("emotion", "语速 / 情绪", "不支持 · 请求里没有这些字段"),
        code("clone", "声音克隆", "不提供"),
      ];
    case "asr":
      return [
        code("input", "输入", "音频文件 · multipart 上传"),
        code("timestamps", "时间码", "请求 verbose_json；供应商不给分段就是空数组"),
        code("language", "语言", "默认 zh"),
        code("empty", "空音轨", "直接报错，不猜内容"),
        unknown("formats", "支持格式", "以供应商文档为准"),
      ];
  }
}

function priceOf(model: ModelRecord): PriceView {
  if (model.modality === "video") {
    // 作者填的自定义单价优先（H22）：按 token 结算、价目表没有的模型也能报价
    if (model.perSecondCny !== undefined) {
      return {
        kind: "known",
        cny: model.perSecondCny,
        unit: "per_second",
        basis: "作者填的自定义单价",
      };
    }
    if (!model.resolution) {
      return { kind: "unknown", reason: "没有填分辨率，对不上价目表" };
    }
    const quote = videoPrice(model.model, model.resolution);
    if (!quote) {
      return {
        kind: "unknown",
        reason: `价目表里没有 ${model.model} @ ${model.resolution}（可能按 token 计价，或未收录）`,
      };
    }
    return {
      kind: "known",
      cny: quote.cnyPerSecond,
      unit: "per_second",
      basis: `${quote.model} @ ${quote.resolution}`,
    };
  }

  if (model.modality === "image") {
    if (model.perImageCny !== undefined) {
      return {
        kind: "known",
        cny: model.perImageCny,
        unit: "per_image",
        basis: "作者填的自定义单价",
      };
    }
    const quote = imagePrice(model.model);
    if (!quote) {
      return {
        kind: "unknown",
        reason: `${model.model} 不是按张计价的通道，离线估不出单价`,
      };
    }
    return {
      kind: "known",
      cny: quote.cnyPerImage,
      unit: "per_image",
      basis: quote.model,
    };
  }

  if (model.modality === "text" || model.modality === "tts") {
    // 文本与配音没有公开价目，只能由作者按账单填（H4 / R28 / R39）
    if (model.unitPriceCny === undefined) {
      return {
        kind: "unknown",
        reason:
          model.modality === "text"
            ? "按 token 计价，没有公开单价；在设置页填「元 / 百万 token」之后才算得出钱"
            : "按字计价，没有公开单价；在设置页填「元 / 千字」之后才算得出钱",
      };
    }
    return {
      kind: "known",
      cny: model.unitPriceCny,
      unit: model.modality === "text" ? "per_million_tokens" : "per_thousand_chars",
      basis: "作者按账单填写",
    };
  }

  return { kind: "unknown", reason: "按 token 计价，没有公开换算公式；以实际账单为准" };
}

function probeOf(
  model: ModelRecord,
  probes: ProbeReportView[],
): { probe?: ProbeMatch } {
  if (model.modality !== "video" && model.modality !== "image") return {};
  const wanted = model.model;
  const report = probes.find((item) =>
    model.modality === "video" ? item.videoModel === wanted : item.imageModel === wanted,
  );
  if (!report) return {};

  if (model.modality === "image") {
    return { probe: { report, exact: true, note: "同一图像模型" } };
  }

  const configured = model.resolution;
  const reported = report.resolution;
  const exact = Boolean(configured && reported && configured === reported);
  const note = exact
    ? "模型与分辨率都对上"
    : !configured
      ? "本模型没填分辨率，报告的分辨率无法对上"
      : !reported
        ? "报告没写分辨率"
        : `报告是 ${reported}，本模型配的是 ${configured}`;
  return { probe: { report, exact, note } };
}
