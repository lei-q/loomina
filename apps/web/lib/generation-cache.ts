import type { Asset, Project, ProjectEvent } from "@loomina/ir";

/**
 * 结果缓存与复用（H14 / ADR-0208）。
 *
 * 同一套输入（模型 + 最终提示词 + 参考图内容）第二次生成时，不该再花一次钱。
 * 「同一套输入」的判定必须是**所见即所得**：键由服务端同样会发出的那段提示词
 * 与真实参考图指纹组成，客户端与服务器各写一遍就会漂（所以提示词编译抽到了
 * `image-plan.ts`）。
 *
 * 缓存本身不另存一份：已经出来的图就在项目资产里，键从资产溯源里现算。
 * 纯函数：不读盘、不发请求。
 */

/** 缓存键的一段：模型 + 提示词 + 参考图内容指纹，按固定顺序拼再哈希 */
export type CacheKeyInput = {
  /**
   * 空串表示「本机没有固定 / 选定模型」：这时服务端会用它自己的默认模型，
   * 两次请求落到的仍是同一个模型，所以比对时跳过模型这一项（否则永远对不上）。
   */
  modelId: string;
  prompt: string;
  /** 参考图的**内容**指纹，不是资产 id：同一张图换了 id 也算同一张 */
  referenceHashes: string[];
};

/**
 * FNV-1a 32 位：与闸门指纹同一个算法（ADR-0100）。
 *
 * 它不是安全哈希，也不需要——这是本机查找用的键，不是防篡改凭据。
 * 两段不同输入撞到一起的概率在这个量级上可以忽略，而且撞了只会复用一张图。
 */
export function hashKey(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function cacheKeyOf(input: CacheKeyInput): string {
  return hashKey([input.modelId, input.prompt, ...input.referenceHashes].join("\u0000"));
}

/**
 * 资产的内容指纹：优先用地址（内容寻址的地址里已经含 sha256），
 * 没有地址就退回「来源 + 创建时间」——占位资产还没图，本来也不该命中。
 */
export function assetContentHash(asset: Asset): string {
  if (asset.uri) return asset.uri;
  return `no-uri:${asset.source}:${asset.createdAt}`;
}

/** 一组参考图 id 的内容指纹：与出处里记的 `referenceAssetIds` 一一对应 */
export function referenceHashesOf(project: Project, ids: string[]): string[] {
  return ids.map((id) => {
    const asset = project.assets.find((item) => item.id === id);
    return asset ? assetContentHash(asset) : `missing:${id}`;
  });
}

export type CacheHit = {
  asset: Asset;
  /** 这一张当初是哪个模型、什么提示词出来的，界面要如实说 */
  modelId: string;
  prompt?: string;
};

/**
 * 在项目资产里找同一套输入已经出过的图。
 *
 * 只认 `source === "generated"` 且有地址的图：上传 / 导入 / 复用来的图
 * 没有「这次输入」的语义，拿来当缓存命中会让作者以为模型读懂了新提示词。
 * `excludeId` 用来跳过「这一格自己」——重生成同一格时不该命中它自己。
 */
export function findCachedAsset(
  project: Project,
  input: CacheKeyInput,
  options: { excludeId?: string } = {},
): CacheHit | undefined {
  const key = cacheKeyOf(input);
  for (const asset of project.assets) {
    if (asset.source !== "generated" || !asset.uri) continue;
    if (asset.id === options.excludeId) continue;
    const provenance = asset.provenance;
    if (!provenance?.prompt) continue;
    // 没指定模型时跳过模型比对：两次都落到服务端的同一个默认模型
    if (input.modelId && provenance.modelId !== input.modelId) continue;
    const candidate = cacheKeyOf({
      modelId: input.modelId,
      prompt: provenance.prompt,
      referenceHashes: referenceHashesOf(project, provenance.referenceAssetIds ?? []),
    });
    if (candidate === key) {
      return { asset, modelId: provenance.modelId, prompt: provenance.prompt };
    }
  }
  return undefined;
}

/**
 * 复用一次缓存命中：把那张图的**内容**写进这一格的资产位。
 *
 * 不复制字节（地址不变）、不重新生成、不花钱：新资产记录 `source: "library"`。
 * `costCny` **不抹掉**——那是这一格当初真花过的钱，抹掉账面就对不上；
 * 而 `asset.updated` 是浅合并，事件本身不带它也就保留了原值（与 C2 的
 * 关键帧历史复制件同一口径）。溯源保留「当初是哪次生成出来的」，界面据此说复用了哪一次。
 */
export function reuseAssetEvents(input: {
  assetId: string;
  hit: CacheHit;
  at: string;
  referenceAssetIds?: string[];
}): ProjectEvent[] {
  const { review: _review, ...rest } = input.hit.asset;
  const asset: Asset = {
    ...rest,
    id: input.assetId,
    source: "library",
    provenance: {
      ...(input.hit.asset.provenance ?? { modelId: input.hit.modelId }),
      modelId: input.hit.asset.provenance?.modelId ?? input.hit.modelId,
      prompt: input.hit.prompt ?? input.hit.asset.provenance?.prompt,
      referenceAssetIds: input.referenceAssetIds ?? input.hit.asset.provenance?.referenceAssetIds ?? [],
      createdAt: input.at,
    },
  };
  return [{ type: "asset.updated", at: input.at, asset }];
}