import {
  TreecloudClient,
  TreecloudImageAdapter,
  imageCostCny,
  MAX_REFERENCES,
  type ImageReference,
} from "@loomina/gateway";
import {
  type ShotPromptMaterial,
} from "@loomina/pipeline";
import type { Character, Id, Location, Look, ProjectSkill, Prop, SheetView } from "@loomina/ir";
import { gatewayConfigOf, resolveModel } from "@/lib/app-config";
import { imagePlanOf } from "@/lib/image-plan";
import { assertPromptAllowed, type PromptModeration } from "@/lib/moderation";
import { fitReferenceBytes } from "@/lib/reference-compress";
import { fitsHardLimit } from "@/lib/reference-fit";

/**
 * 服务端出图（ADR-0031 / ADR-0032）。
 *
 * 密钥只在服务端：浏览器永远拿不到 `API_KEY`，只拿到一张图的 data URI。
 * 这个文件只能在 Node 运行时里 import，不要被客户端组件直接引用。
 */

export type CastImageRequest =
  | {
      kind: "sheet";
      character: Pick<Character, "name" | "appearance" | "mustNotChange">;
      angle: SheetView;
      /** 画面风格（B7 / I5，ADR-0165）：不给就是默认档 */
      look?: Look;
      /** 技能（C.5 / ADR-0191）：按阶段拼进提示词 */
      skills?: ProjectSkill[];
    }
  | {
      kind: "master";
      location: Pick<Location, "name" | "description">;
      look?: Look;
      skills?: ProjectSkill[];
    }
  | {
      kind: "prop";
      prop: Pick<Prop, "name" | "description">;
      look?: Look;
      skills?: ProjectSkill[];
    }
  | {
      kind: "keyframe";
      shot: ShotPromptMaterial;
      frame?: "first" | "last";
      skills?: ProjectSkill[];
    };

export type GeneratedImage = {
  uri: string;
  model: string;
  prompt: string;
  /** 价目表里的单价（元）；没有这个模型就不给，界面上显示"无价目"（ADR-0033） */
  cny?: number;
  /** 发出请求前的提示词审核结果（H6，ADR-0105） */
  moderation: PromptModeration;
  /** 这次有没有真的把参考图发给供应商（B2 / ADR-0162） */
  references: {
    mode: "edits" | "prompt-only";
    /** 实际发出去几张 */
    sent: number;
    /** 调用方点名要带、但读不到字节或压完仍超上限的几张 */
    missing: string[];
    /** 其中几张贴图前被压过（B2 / ADR-0206）；没压过是 0 */
    fitted?: number;
  };
};

/**
 * 出图报价（H4）：读本机配置后给出的「这个模型现在多少钱一张」。
 *
 * 与 gateway 的 `imagePrice(model)` 不是同一件事：那边只查静态价目表，
 * 这里先解析当前配置（可能带作者填的自定义单价），所以是异步的、带 `modelId`。
 * 名字里带 `Quote` 是为了不与 gateway 那个纯查表函数混为一谈。
 */
export type ImageQuote = {
  model: string;
  /** 价目表里的单价（元 / 张）；没有这个模型就不给 */
  cny?: number;
  /** 配置页里的模型 id */
  modelId?: string;
};

/**
 * 当前出图模型的价目（元 / 张），给"提交前报价"用：只读配置与价目表，
 * 不调接口、不花钱。价目表里没有这个模型时 `cny` 缺省——报不出的价不编造。
 */
export async function imageQuoteOf(modelId?: string): Promise<ImageQuote> {
  const { model } = await resolveModel("image", modelId);
  return {
    model: model.model,
    cny: model.perImageCny ?? imageCostCny(model.model),
    modelId: model.id,
  };
}

/**
 * 把调用方点名的参考图读成字节（B2 / ADR-0162），过大的先压一遍（ADR-0206）。
 *
 * 读不到的不报错、不阻塞生成：如实回一份 `missing` 名单，界面据此说
 * 「这一张没吃到参考图」，比悄悄当它存在更可信（准则 P15）。
 * 压过的张数记在 `fitted` 里，界面另说一句——作者要知道发出去的图被改过。
 */
async function referencesOf(
  refs: { assetId: string; uri: string; label: string }[] | undefined,
  readBytes: ReadAssetBytes,
): Promise<{ references: ImageReference[]; missing: string[]; fitted: number }> {
  const references: ImageReference[] = [];
  const missing: string[] = [];
  let fitted = 0;
  for (const ref of (refs ?? []).slice(0, MAX_REFERENCES)) {
    const file = await readBytes(ref.uri);
    if (!file) {
      missing.push(ref.label);
      continue;
    }
    const compressed = await fitReferenceBytes(file.bytes, file.mime);
    if (!fitsHardLimit(compressed.bytes.byteLength)) {
      // 压过还是太大：如实说，不发一张会被网关过滤掉的图
      missing.push(ref.label);
      continue;
    }
    if (compressed.fitted) fitted += 1;
    references.push({
      bytes: compressed.bytes,
      mime: compressed.mime,
      label: ref.label,
    });
  }
  return { references, missing, fitted };
}

/** 地址 → 字节；由调用方（服务端路由）注入，避免 models 反向依赖 assets */
export type ReadAssetBytes = (
  uri: string,
) => Promise<{ bytes: Uint8Array; mime: string } | null>;

export async function generateCastImage(
  request: CastImageRequest,
  modelId?: string,
  /** 作者手改过的提示词（ADR-0148）：给了就用它，不再拼默认那段 */
  promptOverride?: string,
  /** 调用方点名的参考图（B2 / ADR-0162）：给了就真的发给供应商 */
  refs?: { assetId: string; uri: string; label: string }[],
  /**
   * 地址 → 字节的读取器，由调用方注入。
   *
   * 不在这个文件里直接引 `@/lib/asset-store`：那会让 models 与 assets 互相依赖（M4）。
   * 出图这一侧只关心「拿到字节」，从哪读是资产库的事。
   */
  readBytes?: ReadAssetBytes,
): Promise<GeneratedImage> {
  const resolved = await resolveModel("image", modelId);
  const config = gatewayConfigOf(resolved);
  // 路由的 maxDuration 是 180 秒：客户端超时留在它之内，别让上游把路由先掐掉。
  // 出图实测 48 秒到 2 分钟不等，120 秒会误杀慢样本（2026-11-10）。
  const client = new TreecloudClient({ ...config, timeoutMs: 170_000 });
  const adapter = new TreecloudImageAdapter(client);

  const built = imagePlanOf(request);
  const prompt = promptOverride ?? built.prompt;
  // H6：硬阻断的提示词在这里就停，供应商一次请求都不发
  const moderation = assertPromptAllowed(prompt, "image");
  // 没注入读取器时就没有参考图可读：如实记成全部 missing，而不是假装发过
  const { references, missing, fitted } = await referencesOf(
    refs,
    readBytes ?? (async () => null),
  );
  const output = await adapter.generate({
    // 定妆资产还不属于某一镜，用语义 id 占位，保证溯源能对上是什么东西
    shotId: built.label as Id,
    prompt,
    size: "1024x1536",
    ...(references.length ? { references } : {}),
    ...(refs?.length ? { referenceAssetIds: refs.map((ref) => ref.assetId as Id) } : {}),
  });

  return {
    uri: output.uri,
    model: output.provenance.modelId,
    prompt,
    cny: resolved.model.perImageCny ?? imageCostCny(output.provenance.modelId),
    moderation,
    references: {
      mode: output.referenceMode ?? "prompt-only",
      sent: output.referenceCount ?? 0,
      missing,
      ...(fitted > 0 ? { fitted } : {}),
    },
  };
}
