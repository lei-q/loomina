import { describe, expect, it } from "vitest";
import { resolveStorage } from "./storage-config";
import type { StorageRecord } from "./config-types";

/**
 * 对象存储的启用与脱敏（H3 / ADR-0128 §7）。
 *
 * 纯函数：配置从哪来、用不用、回给浏览器什么，都在这里定。
 */

const RECORD: StorageRecord = {
  kind: "s3",
  endpoint: "https://s3.us-east-1.amazonaws.com",
  bucket: "loomina-assets",
  region: "us-east-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  pathStyle: false,
};

describe("对象存储的启用", () => {
  it("配了就用对象存储", () => {
    const result = resolveStorage(RECORD, {});
    expect(result.active).toBe("s3");
    expect(result.config?.bucket).toBe("loomina-assets");
    expect(result.public.active).toBe("s3");
  });

  it("没配就退回本机资产库，不说自己配了", () => {
    const result = resolveStorage(undefined, {});
    expect(result.active).toBe("local");
    expect(result.config).toBeUndefined();
    expect(result.public.configured).toBe(false);
    expect(result.public.active).toBe("local");
  });

  it("LOOMINA_ASSET_STORE=local 强制本机，即便配置齐全", () => {
    const result = resolveStorage(RECORD, { LOOMINA_ASSET_STORE: "local" });
    expect(result.active).toBe("local");
    expect(result.config).toBeUndefined();
    expect(result.public.configured).toBe(true); // 配了，但没启用
    expect(result.note).toContain("local");
  });

  it("LOOMINA_ASSET_STORE=s3 但没配置时说明原因", () => {
    const result = resolveStorage(undefined, { LOOMINA_ASSET_STORE: "s3" });
    expect(result.active).toBe("local");
    expect(result.note).toContain("没有可用的对象存储配置");
  });

  it("环境变量优先于配置文件（部署时用）", () => {
    const result = resolveStorage(RECORD, {
      LOOMINA_S3_ENDPOINT: "http://127.0.0.1:9000",
      LOOMINA_S3_BUCKET: "minio-bucket",
      LOOMINA_S3_ACCESS_KEY_ID: "minio",
      LOOMINA_S3_SECRET_ACCESS_KEY: "minio-secret",
      LOOMINA_S3_PATH_STYLE: "1",
    });
    expect(result.active).toBe("s3");
    expect(result.config?.endpoint).toBe("http://127.0.0.1:9000");
    expect(result.config?.bucket).toBe("minio-bucket");
    expect(result.config?.pathStyle).toBe(true);
    expect(result.public.source).toBe("env");
  });

  it("环境变量不全就不算配置（不拿半份凭据去签）", () => {
    const result = resolveStorage(undefined, {
      LOOMINA_S3_ENDPOINT: "http://127.0.0.1:9000",
      LOOMINA_S3_BUCKET: "b",
      // 少了 AK / SK
    });
    expect(result.active).toBe("local");
    expect(result.public.configured).toBe(false);
  });
});

describe("脱敏", () => {
  it("只回主机、桶、区域与来源，不回 AK/SK", () => {
    const result = resolveStorage(RECORD, {});
    const serialized = JSON.stringify(result.public);
    expect(result.public.endpointHost).toBe("s3.us-east-1.amazonaws.com");
    expect(result.public.bucket).toBe("loomina-assets");
    expect(result.public.source).toBe("file");
    expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(serialized).not.toContain("wJalrXUtnFEMI");
  });

  it("endpoint 本身不是凭据：校验时就不许带账号密码，所以可以回传", () => {
    const result = resolveStorage(RECORD, {});
    expect(result.public.endpoint).toBe("https://s3.us-east-1.amazonaws.com");
  });
});
