import type { Project } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import { sampleProject } from "./sample-project";
import {
  assetContentHash,
  cacheKeyOf,
  findCachedAsset,
  hashKey,
  reuseAssetEvents,
} from "./generation-cache";

const AT = "2026-11-14T00:00:00Z";

function projectWith(overrides: {
  id: string;
  uri: string;
  source?: "generated" | "library" | "upload";
  modelId?: string;
  prompt?: string;
  refs?: string[];
  costCny?: number;
}): Project {
  return {
    ...structuredClone(sampleProject),
    assets: [
      ...structuredClone(sampleProject.assets),
      {
        id: overrides.id,
        kind: "image",
        source: overrides.source ?? "generated",
        uri: overrides.uri,
        costCny: overrides.costCny,
        provenance: {
          modelId: overrides.modelId ?? "gpt-image-2",
          prompt: overrides.prompt ?? "一段提示词",
          referenceAssetIds: overrides.refs ?? [],
          createdAt: AT,
        },
        createdAt: AT,
      },
    ],
  };
}

const key = (over: Partial<Parameters<typeof cacheKeyOf>[0]> = {}) =>
  cacheKeyOf({ modelId: "gpt-image-2", prompt: "一段提示词", referenceHashes: [], ...over });

describe("结果缓存（H14 / ADR-0208）", () => {
  it("同样的输入得到同一个键；模型 / 提示词 / 参考图任一不同就不同", () => {
    expect(key()).toBe(key());
    expect(key()).not.toBe(key({ modelId: "gpt-image-2-c" }));
    expect(key()).not.toBe(key({ prompt: "另一段提示词" }));
    expect(key()).not.toBe(key({ referenceHashes: ["loomina://assets/a.png"] }));
    expect(hashKey("abc")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("命中同一套输入的生成图；跳过这一格自己", () => {
    const project = projectWith({ id: "a-old", uri: "loomina://assets/hit.png", costCny: 0.12 });
    const hit = findCachedAsset(project, { modelId: "gpt-image-2", prompt: "一段提示词", referenceHashes: [] });
    expect(hit?.asset.id).toBe("a-old");
    expect(findCachedAsset(project, { modelId: "gpt-image-2", prompt: "一段提示词", referenceHashes: [] }, { excludeId: "a-old" })).toBeUndefined();
  });

  it("不吃上传 / 导入 / 复用来的图，也不吃没有溯源提示词的图", () => {
    for (const source of ["upload", "library"] as const) {
      const project = projectWith({ id: "a-x", uri: "loomina://assets/x.png", source });
      expect(findCachedAsset(project, { modelId: "gpt-image-2", prompt: "一段提示词", referenceHashes: [] })).toBeUndefined();
    }
    const bare: Project = {
      ...structuredClone(sampleProject),
      assets: [...structuredClone(sampleProject.assets), { id: "a-bare", kind: "image", source: "generated", uri: "loomina://assets/b.png", createdAt: AT }],
    };
    expect(findCachedAsset(bare, { modelId: "gpt-image-2", prompt: "一段提示词", referenceHashes: [] })).toBeUndefined();
  });

  it("参考图按内容指纹比：换了 id 的同一张图也算同一套输入", () => {
    const project = projectWith({
      id: "a-with-ref",
      uri: "loomina://assets/hit.png",
      refs: ["a-lin-front"],
    });
    const sameContent = [assetContentHash(sampleProject.assets.find((item) => item.id === "a-lin-front")!)];
    // 示例资产没有 uri：内容指纹退化成 no-uri:…，与同一资产的 id 指向一致
    expect(findCachedAsset(project, { modelId: "gpt-image-2", prompt: "一段提示词", referenceHashes: sameContent })?.asset.id).toBe("a-with-ref");
  });

  it("复用时写 library、保留当初的花费与溯源（浅合并不抹账）", () => {
    const project = projectWith({ id: "a-old", uri: "loomina://assets/hit.png", costCny: 0.12 });
    const asset = project.assets.find((item) => item.id === "a-old")!;
    asset.review = { status: "passed", at: AT };
    const events = reuseAssetEvents({
      assetId: "a-keyframe-s-03",
      hit: { asset, modelId: "gpt-image-2", prompt: "一段提示词" },
      at: AT,
    });
    expect(events).toHaveLength(1);
    const written = (events[0] as { asset: Project["assets"][number] }).asset;
    expect(written.id).toBe("a-keyframe-s-03");
    expect(written.source).toBe("library");
    expect(written.uri).toBe("loomina://assets/hit.png");
    // 花费是这一格当初真花过的钱，不抹；复核结论不属于这次复用，去掉
    expect(written.costCny).toBe(0.12);
    expect(written.review).toBeUndefined();
    expect(written.provenance?.modelId).toBe("gpt-image-2");
    expect(written.provenance?.prompt).toBe("一段提示词");
  });
});