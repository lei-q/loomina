import { describe, expect, it } from "vitest";
import { normalizeConfig, toPublicConfig } from "./app-config";
import { isModelId, type ConfigFile } from "./config-types";

/**
 * 配置的校验与脱敏（H22 / ADR-0094）。
 *
 * 只测纯函数：normalizeConfig 不碰磁盘，toPublicConfig 只做形状转换。
 * 密钥是否落盘、文件权限由手工验证覆盖。
 */

const PREVIOUS: ConfigFile = {
  version: 1,
  providers: [
    { id: "treecloud", name: "Treecloud", baseUrl: "https://api.example.com", apiKey: "sk-old" },
  ],
  models: [
    {
      id: "treecloud:deepseek-v4.1-flash-1017",
      providerId: "treecloud",
      modality: "text",
      model: "deepseek-v4.1-flash-1017",
      label: "Treecloud / deepseek-v4.1-flash-1017",
    },
  ],
  defaults: { text: "treecloud:deepseek-v4.1-flash-1017" },
};

const VALID = {
  providers: [
    { id: "deepseek", name: "DeepSeek 官方", baseUrl: "https://api.deepseek.com/" },
    { id: "relay", name: "中转", baseUrl: "https://relay.example.com/v1", apiKey: "sk-new" },
  ],
  models: [
    {
      id: "deepseek:deepseek-v4.1-pro",
      providerId: "deepseek",
      modality: "text" as const,
      model: "deepseek-v4.1-pro",
    },
    {
      id: "deepseek:deepseek-v4.1-flash-1017",
      providerId: "deepseek",
      modality: "text" as const,
      model: "deepseek-v4.1-flash-1017",
      label: "Flash",
    },
    {
      id: "relay:minimax-h3",
      providerId: "relay",
      modality: "video" as const,
      model: "minimax-h3",
      resolution: "720p",
    },
  ],
  defaults: {
    text: "deepseek:deepseek-v4.1-flash-1017",
    video: "relay:minimax-h3",
  },
};

describe("normalizeConfig", () => {
  it("接受多供应商、同模态多模型，并按请求写默认", () => {
    const result = normalizeConfig(VALID, PREVIOUS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.providers).toHaveLength(2);
    expect(result.config.models).toHaveLength(3);
    expect(result.config.defaults).toEqual({
      text: "deepseek:deepseek-v4.1-flash-1017",
      video: "relay:minimax-h3",
    });
    // Base URL 去掉结尾斜杠
    expect(result.config.providers[1]!.baseUrl).toBe("https://relay.example.com/v1");
  });

  it("保留商用条款备注，去掉首尾空白，空串等于没写", () => {
    const result = normalizeConfig(
      {
        ...VALID,
        models: [
          {
            ...VALID.models[2]!,
            terms: "  商用需单独申请  ",
          },
          {
            ...VALID.models[0]!,
            terms: "   ",
          },
        ],
        defaults: { video: "relay:minimax-h3", text: "deepseek:deepseek-v4.1-pro" },
      },
      PREVIOUS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.models[0]!.terms).toBe("商用需单独申请");
    expect(result.config.models[1]!.terms).toBeUndefined();
  });

  it("id 必须唯一，模型不能指向不存在的供应商", () => {    const duplicate = normalizeConfig(
      { ...VALID, providers: [VALID.providers[0], VALID.providers[0]] },
      PREVIOUS,
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error).toContain("id 重复");

    const orphan = normalizeConfig(
      {
        ...VALID,
        models: [
          {
            id: "ghost:minimax-h3",
            providerId: "ghost",
            modality: "video",
            model: "minimax-h3",
          },
        ],
        defaults: { video: "ghost:minimax-h3" },
      },
      PREVIOUS,
    );
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) expect(orphan.error).toContain("不存在");
  });

  it("同一供应商、同一模态下的同一个模型不接受重复", () => {
    const duplicateModel = normalizeConfig(
      {
        ...VALID,
        models: [
          ...VALID.models,
          {
            id: "deepseek:deepseek-v4.1-pro-2",
            providerId: "deepseek",
            modality: "text" as const,
            model: "deepseek-v4.1-pro",
          },
        ],
      },
      PREVIOUS,
    );
    expect(duplicateModel.ok).toBe(false);
    if (!duplicateModel.ok) expect(duplicateModel.error).toContain("重复");
  });

  it("Base URL 只收 http(s)，不带账号、查询串和锚点", () => {
    for (const bad of [
      "ftp://api.example.com",
      "https://user:pass@api.example.com",
      "https://api.example.com?key=1",
      "https://api.example.com#x",
      "不是网址",
    ]) {
      const result = normalizeConfig(
        { ...VALID, providers: [{ id: "x", name: "X", baseUrl: bad }], models: [], defaults: {} },
        PREVIOUS,
      );
      expect(result.ok, bad).toBe(false);
    }
  });

  it("某种模态有模型时必须指定默认，且默认必须同模态", () => {
    const missing = normalizeConfig({ ...VALID, defaults: { video: "relay:minimax-h3" } }, PREVIOUS);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("文本模型必须指定一个默认");

    const wrong = normalizeConfig(
      { ...VALID, defaults: { text: "relay:minimax-h3", video: "relay:minimax-h3" } },
      PREVIOUS,
    );
    expect(wrong.ok).toBe(false);
  });

  it("apiKey 缺省沿用旧值，空字符串清空", () => {
    const keep = normalizeConfig(
      {
        providers: [
          { id: "treecloud", name: "Treecloud", baseUrl: "https://api.example.com" },
        ],
        models: PREVIOUS.models,
        defaults: PREVIOUS.defaults,
      },
      PREVIOUS,
    );
    expect(keep.ok).toBe(true);
    if (keep.ok) expect(keep.config.providers[0]!.apiKey).toBe("sk-old");

    const clear = normalizeConfig(
      {
        providers: [
          {
            id: "treecloud",
            name: "Treecloud",
            baseUrl: "https://api.example.com",
            apiKey: "",
          },
        ],
        models: PREVIOUS.models,
        defaults: PREVIOUS.defaults,
      },
      PREVIOUS,
    );
    expect(clear.ok).toBe(true);
    if (clear.ok) expect(clear.config.providers[0]!.apiKey).toBeUndefined();
  });

  it("模型 id 只允许约定字符", () => {
    expect(isModelId("deepseek:deepseek-v4.1-flash-1017")).toBe(true);
    expect(isModelId("a/b")).toBe(false);
    expect(isModelId("")).toBe(false);
  });
});

describe("toPublicConfig", () => {
  const loaded = normalizeConfig(VALID, PREVIOUS);
  if (!loaded.ok) throw new Error("测试配置本身不合法");

  it("返回里不含 apiKey，只给「有没有」", () => {
    const publicConfig = toPublicConfig(
      { config: loaded.config, path: "/tmp/config.json", saved: true },
      {},
    );
    const json = JSON.stringify(publicConfig);
    expect(json).not.toContain("sk-new");
    expect(publicConfig.providers[0]).toMatchObject({ hasKey: false, keyFromEnv: false });
    expect(publicConfig.providers[1]).toMatchObject({ hasKey: true, keyFromEnv: false });
  });

  it("目录按模态分组，给出真实模型名与供应商名", () => {
    const publicConfig = toPublicConfig(
      { config: loaded.config, path: "/tmp/config.json", saved: true },
      {},
    );
    expect(publicConfig.catalog.text.map((item) => item.model)).toEqual([
      "deepseek-v4.1-pro",
      "deepseek-v4.1-flash-1017",
    ]);
    expect(publicConfig.catalog.video[0]).toMatchObject({
      providerName: "中转",
      model: "minimax-h3",
    });
    expect(publicConfig.catalog.image).toEqual([]);
  });

  it("env 供应商没写密钥时，标记密钥来自 secrity.env", () => {
    const sealed: ConfigFile = {
      version: 1,
      providers: [{ id: "env", name: "默认供应商（secrity.env）", baseUrl: "https://api.example.com" }],
      models: PREVIOUS.models,
      defaults: PREVIOUS.defaults,
    };
    const publicConfig = toPublicConfig(
      { config: sealed, path: "/tmp/config.json", saved: true },
      { API_KEY: "sk-from-env" },
    );
    expect(publicConfig.providers[0]).toMatchObject({ hasKey: true, keyFromEnv: true });
    expect(JSON.stringify(publicConfig)).not.toContain("sk-from-env");
  });
});

describe("对象存储配置（H3 / ADR-0128 §7）", () => {
  const STORAGE = {
    kind: "s3" as const,
    endpoint: "http://127.0.0.1:9000",
    bucket: "loomina-assets",
    region: "us-east-1",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    pathStyle: true,
  };

  it("存下来之后整份替换，path-style 原样保留", () => {
    const result = normalizeConfig({ ...VALID, storage: STORAGE }, PREVIOUS);
    expect(result.ok).toBe(true);
    expect(result.ok && result.config.storage).toEqual(STORAGE);
  });

  it("不传 storage 就沿用上一份", () => {
    const withStorage: ConfigFile = { ...PREVIOUS, storage: STORAGE };
    const result = normalizeConfig(VALID, withStorage);
    expect(result.ok && result.config.storage).toEqual(STORAGE);
  });

  it("传 null 表示清掉，回到本机资产库", () => {
    const withStorage: ConfigFile = { ...PREVIOUS, storage: STORAGE };
    const result = normalizeConfig({ ...VALID, storage: null }, withStorage);
    expect(result.ok && result.config.storage).toBeUndefined();
  });

  it("密钥缺省表示沿用已保存的", () => {
    const withStorage: ConfigFile = { ...PREVIOUS, storage: STORAGE };
    const { secretAccessKey: _omit, ...withoutSecret } = STORAGE;
    const result = normalizeConfig({ ...VALID, storage: withoutSecret }, withStorage);
    expect(result.ok && result.config.storage?.secretAccessKey).toBe("test-secret-key");
  });

  it("endpoint 必须是 http(s)，且不带账号、查询串", () => {
    const bad = (endpoint: string) =>
      normalizeConfig({ ...VALID, storage: { ...STORAGE, endpoint } }, PREVIOUS);
    expect(bad("ftp://127.0.0.1:9000").ok).toBe(false);
    expect(bad("http://user:pass@127.0.0.1:9000").ok).toBe(false);
    expect(bad("http://127.0.0.1:9000/?a=1").ok).toBe(false);
    expect(bad("not a url").ok).toBe(false);
  });

  it("桶名按 S3 规则校验", () => {
    const bad = (bucket: string) =>
      normalizeConfig({ ...VALID, storage: { ...STORAGE, bucket } }, PREVIOUS);
    expect(bad("AB").ok).toBe(false); // 大写与太短
    expect(bad("UPPER-case").ok).toBe(false);
    expect(bad("has_underscore").ok).toBe(false);
    expect(bad("ok-bucket").ok).toBe(true);
  });

  it("区域与 Access Key 必填", () => {
    const noRegion = normalizeConfig({ ...VALID, storage: { ...STORAGE, region: "" } }, PREVIOUS);
    expect(noRegion.ok).toBe(false);
    const noKey = normalizeConfig({ ...VALID, storage: { ...STORAGE, accessKeyId: "" } }, PREVIOUS);
    expect(noKey.ok).toBe(false);
    // 首次配置时没有可沿用的密钥：必须填
    const noSecret = normalizeConfig(
      { ...VALID, storage: { ...STORAGE, secretAccessKey: "" } },
      PREVIOUS,
    );
    expect(noSecret.ok).toBe(false);
  });

  it("脱敏后的配置只有主机与桶，没有任何密钥", () => {
    const loaded = {
      config: { ...PREVIOUS, storage: STORAGE },
      path: "/tmp/config.json",
      saved: true,
    };
    const publicConfig = toPublicConfig(loaded, {});
    expect(publicConfig.storage.configured).toBe(true);
    expect(publicConfig.storage.endpointHost).toBe("127.0.0.1:9000");
    expect(publicConfig.storage.endpoint).toBe("http://127.0.0.1:9000");
    expect(publicConfig.storage.bucket).toBe("loomina-assets");
    const serialized = JSON.stringify(publicConfig);
    expect(serialized).not.toContain("test-secret-key");
    expect(serialized).not.toContain("test-access-key");
  });
});
