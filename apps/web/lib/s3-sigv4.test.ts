import { describe, expect, it } from "vitest";
import {
  MAX_EXPIRES_SECONDS,
  UNSIGNED_PAYLOAD,
  amzDateOf,
  canonicalQueryString,
  canonicalRequest,
  objectUrlOf,
  presignUrl,
  sha256Hex,
  signatureOf,
  stringToSign,
  uriEncode,
} from "./s3-sigv4";

/**
 * 测试向量全部来自 AWS 官方文档（S3 API Reference 的 SigV4 示例）。
 *
 * 用的是文档里公开的示例凭据——它们不是任何真实账号的密钥，
 * 写在测试里正合适：官方示例的意义就是「任何人照着算都该得到同一个签名」。
 */
const DOC_CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const DOC_DATE = new Date("2013-05-24T00:00:00Z");
const SCOPE = "20130524/us-east-1/s3/aws4_request";

describe("URI 编码（SigV4 第一处坑）", () => {
  it("只保留 A-Z a-z 0-9 - _ . ~", () => {
    expect(uriEncode("AZaz09-_.~")).toBe("AZaz09-_.~");
  });

  it("空格是 %20，不是 +；保留字符全部转义", () => {
    expect(uriEncode("a b")).toBe("a%20b");
    expect(uriEncode("a+b=c&d")).toBe("a%2Bb%3Dc%26d");
    expect(uriEncode("(1)")).toBe("%281%29");
  });

  it("`/` 默认转义，按路径编码时保留", () => {
    expect(uriEncode("a/b")).toBe("a%2Fb");
    expect(uriEncode("a/b", false)).toBe("a/b");
  });

  it("中文按 UTF-8 字节、大写十六进制", () => {
    // 「林」= E6 9E 97
    expect(uriEncode("林")).toBe("%E6%9E%97");
    expect(uriEncode("项目")).toBe("%E9%A1%B9%E7%9B%AE");
  });

  it("星号与感叹号也转义：它们不在 AWS 的免编码集里", () => {
    expect(uriEncode("a*b!c")).toBe("a%2Ab%21c");
  });
});

describe("规范化查询串（第二处坑）", () => {
  it("先按键、再按值排序，值也编码", () => {
    expect(
      canonicalQueryString([
        ["prefix", "J"],
        ["max-keys", "2"],
      ]),
    ).toBe("max-keys=2&prefix=J");
  });

  it("同名参数按值排序", () => {
    expect(
      canonicalQueryString([
        ["a", "z"],
        ["a", "b"],
      ]),
    ).toBe("a=b&a=z");
  });

  it("排序看的是编码后的字符串", () => {
    // `%E6…` 编码后排在 `b` 之后（`%` = 0x25 < `b`）——按原始中文排会得到另一个顺序
    expect(
      canonicalQueryString([
        ["b", "1"],
        ["a", "林"],
      ]),
    ).toBe("a=%E6%9E%97&b=1");
  });

  it("空查询串就是空串", () => {
    expect(canonicalQueryString([])).toBe("");
  });
});

describe("官方测试向量：GET Object", () => {
  it("规范化请求与文档一致", () => {
    const creq = canonicalRequest({
      method: "GET",
      path: "/test.txt",
      query: [],
      headers: {
        Host: "examplebucket.s3.amazonaws.com",
        Range: "bytes=0-9",
        "x-amz-content-sha256": EMPTY_SHA256,
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: EMPTY_SHA256,
    });
    expect(creq).toBe(
      [
        "GET",
        "/test.txt",
        "",
        "host:examplebucket.s3.amazonaws.com",
        "range:bytes=0-9",
        `x-amz-content-sha256:${EMPTY_SHA256}`,
        "x-amz-date:20130524T000000Z",
        "",
        "host;range;x-amz-content-sha256;x-amz-date",
        EMPTY_SHA256,
      ].join("\n"),
    );
    expect(sha256Hex(creq)).toBe("7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972");
  });

  it("签名与文档一致", () => {
    const creq = canonicalRequest({
      method: "GET",
      path: "/test.txt",
      query: [],
      headers: {
        Host: "examplebucket.s3.amazonaws.com",
        Range: "bytes=0-9",
        "x-amz-content-sha256": EMPTY_SHA256,
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: EMPTY_SHA256,
    });
    const signature = signatureOf({
      secretAccessKey: DOC_CREDENTIALS.secretAccessKey,
      dateStamp: "20130524",
      region: "us-east-1",
      service: "s3",
      stringToSign: stringToSign({
        amzDate: "20130524T000000Z",
        scope: SCOPE,
        canonicalRequest: creq,
      }),
    });
    expect(signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });
});

describe("官方测试向量：PUT Object", () => {
  it("载荷哈希与签名都与文档一致", () => {
    const body = "Welcome to Amazon S3.";
    const payloadHash = sha256Hex(body);
    expect(payloadHash).toBe("44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");

    const creq = canonicalRequest({
      method: "PUT",
      // 文档里的 key 是 `test$file.text`；`$` 必须编码成 %24
      path: "/test$file.text",
      query: [],
      headers: {
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        Host: "examplebucket.s3.amazonaws.com",
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": "20130524T000000Z",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payloadHash,
    });
    expect(creq.split("\n")[1]).toBe("/test%24file.text");

    const signature = signatureOf({
      secretAccessKey: DOC_CREDENTIALS.secretAccessKey,
      dateStamp: "20130524",
      region: "us-east-1",
      service: "s3",
      stringToSign: stringToSign({
        amzDate: "20130524T000000Z",
        scope: SCOPE,
        canonicalRequest: creq,
      }),
    });
    expect(signature).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });
});

describe("官方测试向量：预签名 GET", () => {
  it("整条 URL 与文档逐字一致", () => {
    const url = presignUrl({
      method: "GET",
      target: {
        endpoint: "https://s3.amazonaws.com",
        bucket: "examplebucket",
        key: "test.txt",
        pathStyle: false,
      },
      region: "us-east-1",
      credentials: DOC_CREDENTIALS,
      expiresSeconds: 86400,
      now: DOC_DATE,
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt" +
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z" +
        "&X-Amz-Expires=86400" +
        "&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("载荷是 UNSIGNED-PAYLOAD，不是空串的哈希", () => {
    // 两者算出来的签名不同；预签名 URL 必须用前者，否则浏览器 PUT 上去会 403
    const base = {
      method: "PUT" as const,
      target: {
        endpoint: "https://s3.amazonaws.com",
        bucket: "examplebucket",
        key: "test.txt",
        pathStyle: false,
      },
      region: "us-east-1",
      credentials: DOC_CREDENTIALS,
      expiresSeconds: 600,
      now: DOC_DATE,
    };
    const unsigned = presignUrl(base);
    const withEmptyHash = presignUrl({ ...base, payloadHash: EMPTY_SHA256 });
    expect(unsigned).toContain("X-Amz-Signature=");
    expect(withEmptyHash).not.toBe(unsigned);
    // 默认值就是 UNSIGNED-PAYLOAD：同一份输入两次结果一致
    expect(presignUrl({ ...base, payloadHash: UNSIGNED_PAYLOAD })).toBe(unsigned);
  });
});

describe("地址拼装", () => {
  it("virtual-hosted：bucket 在域名前", () => {
    expect(
      objectUrlOf({
        endpoint: "https://s3.us-east-1.amazonaws.com",
        bucket: "loomina",
        key: "a/b.png",
        pathStyle: false,
      }),
    ).toEqual({
      url: "https://loomina.s3.us-east-1.amazonaws.com/a/b.png",
      path: "/a/b.png",
      encodedPath: "/a/b.png",
    });
  });

  it("path-style：bucket 在路径里（MinIO / 自建网关只认这种）", () => {
    expect(
      objectUrlOf({
        endpoint: "http://127.0.0.1:9000",
        bucket: "loomina",
        key: "a/b.png",
        pathStyle: true,
      }),
    ).toEqual({
      url: "http://127.0.0.1:9000/loomina/a/b.png",
      path: "/loomina/a/b.png",
      encodedPath: "/loomina/a/b.png",
    });
  });

  it("key 里的斜杠保留、每一段单独编码", () => {
    const { url, path, encodedPath } = objectUrlOf({
      endpoint: "https://s3.us-east-1.amazonaws.com",
      bucket: "loomina",
      key: "项目/第一集 定妆.png",
      pathStyle: true,
    });
    expect(url).toBe(
      "https://s3.us-east-1.amazonaws.com/loomina/%E9%A1%B9%E7%9B%AE/%E7%AC%AC%E4%B8%80%E9%9B%86%20%E5%AE%9A%E5%A6%86.png",
    );
    // 原始路径留着中文：规范化请求会自己编码一次，这里再编码就是双重编码
    expect(path).toBe("/loomina/项目/第一集 定妆.png");
    expect(encodedPath).toBe(
      "/loomina/%E9%A1%B9%E7%9B%AE/%E7%AC%AC%E4%B8%80%E9%9B%86%20%E5%AE%9A%E5%A6%86.png",
    );
  });

  it("空 key（列桶）拼到 bucket 上，不带尾斜杠以外的多余段", () => {
    expect(
      objectUrlOf({
        endpoint: "http://127.0.0.1:9000",
        bucket: "loomina",
        key: "",
        pathStyle: true,
      }).url,
    ).toBe("http://127.0.0.1:9000/loomina");
  });

  it("endpoint 带子路径时保留", () => {
    expect(
      objectUrlOf({
        endpoint: "https://gw.example.com/oss/",
        bucket: "b",
        key: "k.png",
        pathStyle: true,
      }).path,
    ).toBe("/oss/b/k.png");
  });
});

describe("有效期与参数校验", () => {
  const base = {
    method: "GET" as const,
    target: {
      endpoint: "https://s3.us-east-1.amazonaws.com",
      bucket: "loomina",
      key: "a.png",
      pathStyle: true,
    },
    region: "us-east-1",
    credentials: DOC_CREDENTIALS,
    now: DOC_DATE,
  };

  it("超过 7 天直接报错，不悄悄夹取", () => {
    expect(() => presignUrl({ ...base, expiresSeconds: MAX_EXPIRES_SECONDS + 1 })).toThrow(/有效期/);
    expect(() => presignUrl({ ...base, expiresSeconds: 0 })).toThrow(/有效期/);
    expect(() => presignUrl({ ...base, expiresSeconds: 10.5 })).toThrow(/有效期/);
  });

  it("缺凭据或 bucket 直接报错", () => {
    expect(() =>
      presignUrl({ ...base, credentials: { accessKeyId: "", secretAccessKey: "x" } }),
    ).toThrow(/Access Key/);
    expect(() =>
      presignUrl({ ...base, target: { ...base.target, bucket: "" } }),
    ).toThrow(/bucket/);
  });

  it("额外查询参数不许冒用 X-Amz- 前缀", () => {
    expect(() => presignUrl({ ...base, query: [["X-Amz-Foo", "1"]] })).toThrow(/X-Amz-/);
    // 正常参数照收，并进签名
    const withPrefix = presignUrl({ ...base, query: [["prefix", "第一集/"]] });
    expect(withPrefix).toContain("prefix=%E7%AC%AC%E4%B8%80%E9%9B%86%2F");
  });

  it("临时凭据要把 session token 放进查询串并参与签名", () => {
    const withToken = presignUrl({
      ...base,
      credentials: { ...DOC_CREDENTIALS, sessionToken: "FQoGZXIvYXdzEBYaDA==" },
    });
    expect(withToken).toContain("X-Amz-Security-Token=FQoGZXIvYXdzEBYaDA%3D%3D");
    const without = presignUrl(base);
    expect(withToken).not.toBe(without);
  });

  it("默认有效期 10 分钟（ADR-0128 §7）", () => {
    expect(presignUrl(base)).toContain("X-Amz-Expires=600");
  });

  it("区域进凭据范围：换区域签名就变", () => {
    expect(presignUrl({ ...base, region: "ap-east-1" })).not.toBe(presignUrl(base));
  });
});

describe("时间格式", () => {
  it("ISO 时间 → 两种签名用格式", () => {
    expect(amzDateOf(new Date("2026-11-12T10:00:00.000Z"))).toEqual({
      amzDate: "20261112T100000Z",
      dateStamp: "20261112",
    });
  });
});

describe("中文 key 只编码一次（回归：端到端 403）", () => {
  /**
   * 真实踩到的 bug：`objectUrlOf` 先把 key 编码成 `%E9%A1%B9…`，
   * `canonicalRequest` 又编码一次变成 `%25E9…`，服务端按单次编码重算，
   * 签名对不上 → 403。单测里看不出来（两边都用同一个函数），
   * 是 MinIO 端到端跑出来的。这条锁住它。
   */
  it("URL 里是单次编码，规范化请求用的是原始路径", () => {
    const target = {
      endpoint: "http://127.0.0.1:9000",
      bucket: "b",
      key: "项目/第一集 定妆.png",
      pathStyle: true,
    };
    const { url, path, encodedPath } = objectUrlOf(target);
    expect(url).toContain("/b/%E9%A1%B9%E7%9B%AE/");
    expect(url).not.toContain("%25");
    expect(path).toBe("/b/项目/第一集 定妆.png");
    expect(encodedPath).toBe(url.slice("http://127.0.0.1:9000".length));

    // 规范化请求的第一行路径必须是单次编码的结果
    const creq = canonicalRequest({
      method: "GET",
      path,
      query: [],
      headers: { host: "127.0.0.1:9000" },
      payloadHash: UNSIGNED_PAYLOAD,
    });
    expect(creq.split("\n")[1]).toBe("/b/%E9%A1%B9%E7%9B%AE/%E7%AC%AC%E4%B8%80%E9%9B%86%20%E5%AE%9A%E5%A6%86.png");
    expect(creq.split("\n")[1]).not.toContain("%25");
  });

  it("预签名 URL 里没有双重编码的痕迹", () => {
    const url = presignUrl({
      method: "GET",
      target: {
        endpoint: "https://s3.us-east-1.amazonaws.com",
        bucket: "loomina",
        key: "项目/第一集 定妆.png",
        pathStyle: true,
      },
      region: "us-east-1",
      credentials: DOC_CREDENTIALS,
      now: DOC_DATE,
    });
    expect(url.startsWith("https://s3.us-east-1.amazonaws.com/loomina/%E9%A1%B9%E7%9B%AE/")).toBe(true);
    expect(url).not.toContain("%25");
  });
});
