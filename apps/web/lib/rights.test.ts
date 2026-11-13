import { describe, expect, it } from "vitest";
import { ProjectSchema, type Project } from "@loomina/ir";
import { isExpired, rightsReport, rightsTargets } from "./rights";

function project(patch: Record<string, unknown> = {}): Project {
  return ProjectSchema.parse({
    id: "p-rights",
    title: "授权测试",
    version: 1,
    ...patch,
  });
}

describe("isExpired", () => {
  it("到期日为空表示不限期", () => {
    expect(
      isExpired(
        { id: "r", subject: "x", kind: "portrait", grantor: "", grantedAt: "", expiresAt: "", evidence: "", note: "" },
        "2026-11-13",
      ),
    ).toBe(false);
  });

  it("到期日早于今天算过期，当天不算", () => {
    const record = {
      id: "r",
      subject: "x",
      kind: "portrait" as const,
      grantor: "",
      grantedAt: "",
      expiresAt: "2026-11-12",
      evidence: "",
      note: "",
    };
    expect(isExpired(record, "2026-11-13")).toBe(true);
    expect(isExpired({ ...record, expiresAt: "2026-11-13" }, "2026-11-13")).toBe(false);
  });

  it("带时间的到期日只比日期部分", () => {
    const record = {
      id: "r",
      subject: "x",
      kind: "portrait" as const,
      grantor: "",
      grantedAt: "",
      expiresAt: "2026-11-13T00:00:00Z",
      evidence: "",
      note: "",
    };
    expect(isExpired(record, "2026-11-13")).toBe(false);
    expect(isExpired(record, "2026-11-14")).toBe(true);
  });
});

describe("rightsReport", () => {
  it("全是生成素材、没有音色：没有要授权的，也不报缺", () => {
    const report = rightsReport(project(), "2026-11-13");
    expect(report.gaps).toHaveLength(0);
    expect(report.expired).toHaveLength(0);
    expect(report.verdict).toContain("没有需要授权");
  });

  it("上传的参考图缺肖像授权，补上就消失", () => {
    const withUpload = project({
      assets: [{ id: "a-face", kind: "image", source: "upload", createdAt: "2026-11-01T00:00:00+08:00" }],
      characters: [
        { id: "c-1", name: "林晚", appearance: "", sheet: {}, referenceImages: ["a-face"], mustNotChange: [] },
      ],
    });
    const before = rightsReport(withUpload, "2026-11-13");
    expect(before.gaps).toContainEqual({
      kind: "portrait",
      subject: "林晚",
      targetId: "c-1",
      reason: "用了上传的真人参考图，但没有肖像授权记录",
    });
    // 上传素材本身也要一条素材授权
    expect(before.gaps.some((gap) => gap.kind === "asset")).toBe(true);
    expect(before.verdict).toContain("缺");

    const after = rightsReport(
      ProjectSchema.parse({
        ...withUpload,
        authorizations: [
          { id: "r-1", subject: "林晚的肖像", kind: "portrait", targetId: "c-1" },
          { id: "r-2", subject: "参考图", kind: "asset" },
        ],
      }),
      "2026-11-13",
    );
    expect(after.gaps).toHaveLength(0);
    expect(after.verdict).toContain("2 条授权记录");
  });

  it("配了音色不自动判缺：音色名分不出自带还是克隆", () => {
    const withVoice = project({
      characters: [
        { id: "c-1", name: "周衡", appearance: "", voiceProfileId: "voice-1", sheet: {}, referenceImages: [], mustNotChange: [] },
      ],
    });
    const report = rightsReport(withVoice, "2026-11-13");
    expect(report.gaps).toHaveLength(0);
    expect(report.verdict).toContain("没有需要授权");
  });

  it("过期的授权不算数：既报过期，也仍然报缺", () => {
    const stale = project({
      assets: [{ id: "a-face", kind: "image", source: "upload", createdAt: "2026-11-01T00:00:00+08:00" }],
      characters: [
        { id: "c-1", name: "林晚", appearance: "", sheet: {}, referenceImages: ["a-face"], mustNotChange: [] },
      ],
      authorizations: [
        { id: "r-1", subject: "林晚的肖像", kind: "portrait", targetId: "c-1", expiresAt: "2026-01-01" },
        { id: "r-2", subject: "参考图", kind: "asset", expiresAt: "2026-01-01" },
      ],
    });
    const report = rightsReport(stale, "2026-11-13");
    expect(report.expired).toHaveLength(2);
    expect(report.valid).toBe(0);
    expect(report.total).toBe(2);
    expect(report.gaps.map((gap) => gap.kind).sort()).toEqual(["asset", "portrait"]);
    expect(report.verdict).toContain("已过期");
  });

  it("肖像授权挂在别的角色身上不算：按 targetId 对", () => {
    const report = rightsReport(
      project({
        assets: [{ id: "a-face", kind: "image", source: "upload", createdAt: "2026-11-01T00:00:00+08:00" }],
        characters: [
          { id: "c-1", name: "林晚", appearance: "", sheet: {}, referenceImages: ["a-face"], mustNotChange: [] },
        ],
        authorizations: [
          { id: "r-1", subject: "别人的肖像", kind: "portrait", targetId: "c-9" },
          { id: "r-2", subject: "参考图", kind: "asset" },
        ],
      }),
      "2026-11-13",
    );
    expect(report.gaps).toContainEqual({
      kind: "portrait",
      subject: "林晚",
      targetId: "c-1",
      reason: "用了上传的真人参考图，但没有肖像授权记录",
    });
  });

  it("定妆三视图里有上传的图，同样要求肖像授权", () => {
    const report = rightsReport(
      project({
        assets: [{ id: "a-front", kind: "image", source: "imported", createdAt: "2026-11-01T00:00:00+08:00" }],
        characters: [
          { id: "c-1", name: "林晚", appearance: "", sheet: { front: "a-front" }, referenceImages: [], mustNotChange: [] },
        ],
      }),
      "2026-11-13",
    );
    expect(report.gaps.some((gap) => gap.kind === "portrait")).toBe(true);
  });

  it("没有上传素材时，一条素材授权也不算多余", () => {
    const report = rightsReport(
      project({ authorizations: [{ id: "r-1", subject: "音乐", kind: "music" }] }),
      "2026-11-13",
    );
    expect(report.gaps).toHaveLength(0);
    expect(report.verdict).toContain("1 条授权记录");
  });
});

describe("rightsTargets", () => {
  it("角色按肖像、道具与地点按素材列出来", () => {
    const targets = rightsTargets(
      project({
        characters: [{ id: "c-1", name: "林晚", appearance: "", sheet: {}, referenceImages: [], mustNotChange: [] }],
        props: [{ id: "p-1", name: "搪瓷杯", description: "", referenceImages: [] }],
        locations: [{ id: "loc-1", name: "走廊", templateId: "corridor" }],
      }),
    );
    expect(targets).toEqual([
      { id: "c-1", label: "角色 · 林晚", kind: "portrait" },
      { id: "p-1", label: "道具 · 搪瓷杯", kind: "asset" },
      { id: "loc-1", label: "地点 · 走廊", kind: "asset" },
    ]);
  });
});
