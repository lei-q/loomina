import { describe, expect, it } from "vitest";
import { presignUrl } from "@/lib/s3-sigv4";
import {
  listS3Objects,
  putS3Object,
  readS3Object,
  removeS3Object,
  s3KeyOf,
  s3ObjectRef,
} from "@/lib/s3-store";

/**
 * 对象存储端到端（H3 / ADR-0129 §3）。
 *
 * 需要一台真的 S3 兼容服务。默认跳过；本地验证时这样跑：
 *
 * ```sh
 * LOOMINA_S3_E2E=1 \
 * LOOMINA_S3_ENDPOINT=http://127.0.0.1:9000 \
 * LOOMINA_S3_BUCKET=loomina-assets \
 * LOOMINA_S3_ACCESS_KEY_ID=… LOOMINA_S3_SECRET_ACCESS_KEY=… \
 * pnpm --filter @loomina/web test lib/s3-store.e2e.test.ts
 * ```
 *
 * 单测（`s3-sigv4.test.ts`）锁的是「算得对不对」；这一份锁的是「服务器认不认」。
 * 两者都要有：签名算对了但编码错一处，服务端照样 403。
 */
const ENABLED = process.env.LOOMINA_S3_E2E === "1";

const config = {
  endpoint: (process.env.LOOMINA_S3_ENDPOINT ?? "http://127.0.0.1:9000").replace(/\/+$/, ""),
  bucket: process.env.LOOMINA_S3_BUCKET ?? "loomina-assets",
  region: process.env.LOOMINA_S3_REGION ?? "us-east-1",
  accessKeyId: process.env.LOOMINA_S3_ACCESS_KEY_ID ?? "",
  secretAccessKey: process.env.LOOMINA_S3_SECRET_ACCESS_KEY ?? "",
  pathStyle: true,
};

/** 建桶用预签名 PUT；桶已存在时 S3 返回 409，MinIO 也一样，不算失败 */
async function ensureBucket(): Promise<void> {
  const url = presignUrl({
    method: "PUT",
    target: { endpoint: config.endpoint, bucket: config.bucket, key: "", pathStyle: true },
    region: config.region,
    credentials: config,
    expiresSeconds: 120,
  });
  const response = await fetch(url, { method: "PUT" });
  if (!response.ok && response.status !== 409) {
    throw new Error(`建桶失败（${response.status}）：${await response.text()}`);
  }
}

describe.skipIf(!ENABLED)("对象存储端到端（需要一台真的 S3 兼容服务）", () => {
  it("写、读、列、删走完一遍", async () => {
    await ensureBucket();
    const bytes = Buffer.from(`loomina e2e ${Date.now()}`, "utf8");
    const stored = await putS3Object(config, { bytes, mime: "image/png" });

    expect(stored.uri.startsWith(`s3://${config.bucket}/`)).toBe(true);
    expect(s3ObjectRef(stored.uri)?.key).toMatch(/^assets\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);

    // 同一段字节再写一次：key 由内容哈希决定，所以地址不变
    const again = await putS3Object(config, { bytes, mime: "image/png" });
    expect(again.uri).toBe(stored.uri);

    const read = await readS3Object(config, stored.uri);
    expect(read).not.toBeNull();
    expect(Buffer.from(read!.bytes).toString("utf8")).toBe(bytes.toString("utf8"));

    const listed = await listS3Objects(config, { prefix: "assets/" });
    expect(listed.some((item) => item.uri === stored.uri)).toBe(true);

    expect(await removeS3Object(config, stored.uri)).toBe(true);
    expect(await readS3Object(config, stored.uri)).toBeNull();
  });

  it("中文与特殊字符的 key 服务端也认", async () => {
    await ensureBucket();
    const key = `assets/zz/中文 名字+(1)~_${Date.now()}.txt`;
    const url = presignUrl({
      method: "PUT",
      target: { endpoint: config.endpoint, bucket: config.bucket, key, pathStyle: true },
      region: config.region,
      credentials: config,
      expiresSeconds: 120,
    });
    const put = await fetch(url, { method: "PUT", body: Buffer.from("中文 ok", "utf8") });
    expect(put.status).toBe(200);

    const read = await readS3Object(config, `s3://${config.bucket}/${key}`);
    expect(read).not.toBeNull();
    expect(Buffer.from(read!.bytes).toString("utf8")).toBe("中文 ok");

    await removeS3Object(config, `s3://${config.bucket}/${key}`);
  });

  it("不存在的对象读回 null，不抛错", async () => {
    const missing = `s3://${config.bucket}/${s3KeyOf("0".repeat(64), "png")}`;
    expect(await readS3Object(config, missing)).toBeNull();
  });

  it("签名过期会被服务端拒绝", async () => {
    await ensureBucket();
    const url = presignUrl({
      method: "GET",
      target: { endpoint: config.endpoint, bucket: config.bucket, key: "assets/none.png", pathStyle: true },
      region: config.region,
      credentials: config,
      expiresSeconds: 1,
      now: new Date(Date.now() - 60_000),
    });
    const response = await fetch(url, { method: "GET" });
    expect(response.ok).toBe(false);
    expect([403, 404]).toContain(response.status);
  });
});
