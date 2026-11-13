import { ProjectSchema } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import {
  COMPLIANCE_CHECKPOINTS,
  COMPLIANCE_RULE_COUNT,
  IMPORT_PROMPT_PREFIX,
  checkpointTexts,
  collectTexts,
  preflightCheckpoint,
  preflightCheckpoints,
  preflightProject,
  renderComplianceOf,
  scanProject,
  scanText,
} from "./compliance";
import { sampleProject } from "./sample-project";

const AT = "2026-11-11T10:00:00+08:00";

function project(overrides: Record<string, unknown> = {}) {
  return ProjectSchema.parse({ ...sampleProject, ...overrides });
}

describe("内容安全规则（H6 / G8）", () => {
  it("硬阻断与人工确认分开：性暴力阻断，杀人只标 review", () => {
    const block = scanText("他把她强奸了", "台词 · 某人");
    expect(block).toHaveLength(1);
    expect(block[0]).toMatchObject({ severity: "block", category: "涉黄" });

    const review = scanText("他说要杀人", "台词 · 某人");
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ severity: "review", category: "暴力" });
  });

  it("同一段文本同一规则只报一次，并带上下文", () => {
    const findings = scanText("算命的说能改命，算命的说能改命", "故事 · logline");
    expect(findings.filter((finding) => finding.ruleId === "superstition")).toHaveLength(1);
    expect(findings[0]!.excerpt).toContain("算命");
  });

  it("干净文本没有任何命中", () => {
    expect(scanText("夜班的最后一盏灯灭了。", "标题")).toEqual([]);
  });

  it("规则覆盖到所有合规分类", () => {
    expect(COMPLIANCE_RULE_COUNT).toBeGreaterThanOrEqual(15);
  });
});

describe("项目文本收集", () => {
  it("覆盖标题、故事、角色、场景、分镜、台词与发布文案，跳过 provenance", () => {
    const units = collectTexts(
      project({
        story: { ...sampleProject.story, logline: "夜班护士撞见不该看见的人。" },
        locations: sampleProject.locations.map((location, index) =>
          index === 0 ? { ...location, description: "走廊尽头有一盏坏灯" } : location,
        ),
      }),
      {
        title: "发布标题",
        description: "发布简介",
        topics: "短剧,AI",
      },
    );
    const paths = units.map((unit) => unit.path);
    expect(paths).toContain("标题");
    expect(paths.some((path) => path.startsWith("故事 · logline"))).toBe(true);
    expect(paths.some((path) => path.startsWith("角色「"))).toBe(true);
    expect(paths.some((path) => path.startsWith("场景「"))).toBe(true);
    expect(paths.some((path) => path.includes("镜 · 描述"))).toBe(true);
    expect(paths.some((path) => path.startsWith("台词 ·"))).toBe(true);
    expect(paths).toContain("发布 · 标题");
    expect(paths.some((path) => path.includes("provenance"))).toBe(false);
  });

  it("发布标题与简介也进扫描", () => {
    const findings = scanProject(project(), {
      title: "加微信领福利",
      description: "稳赚不赔",
    });
    expect(findings.some((finding) => finding.path === "发布 · 标题")).toBe(true);
    expect(findings.some((finding) => finding.path === "发布 · 简介")).toBe(true);
  });
});

describe("导出前预检（G8）", () => {
  it("干净项目通过，五项检查都在", () => {
    const report = preflightProject(project(), { durationMs: 60_000, at: AT });
    expect(report.ok).toBe(true);
    expect(report.blocked).toBe(0);
    expect(report.checks.map((check) => check.id)).toEqual([
      "ai-label",
      "safety",
      "review",
      "rights",
      "spec",
    ]);
    expect(report.checks.find((check) => check.id === "ai-label")?.status).toBe("pass");
  });

  it("命中硬阻断时 ok=false，规格检查也仍会跑", () => {
    const report = preflightProject(
      project({ title: "如何制造炸弹" }),
      { durationMs: 60_000, at: AT },
    );
    expect(report.ok).toBe(false);
    expect(report.blocked).toBeGreaterThan(0);
    expect(report.findings.some((finding) => finding.path === "标题")).toBe(true);
    expect(report.checks.find((check) => check.id === "spec")?.status).toBe("pass");
  });

  it("只有 review 时 ok 仍为 true，但 review 计数非零", () => {
    const report = preflightProject(project({ title: "一夜暴富" }), {
      durationMs: 60_000,
      at: AT,
    });
    expect(report.ok).toBe(true);
    expect(report.review).toBeGreaterThan(0);
    expect(report.checks.find((check) => check.id === "safety")?.status).toBe("review");
  });

  it("超过 180 秒或时间线为空都阻断", () => {
    const tooLong = preflightProject(project(), { durationMs: 180_001, at: AT });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.checks.find((check) => check.id === "spec")?.status).toBe("block");

    const empty = preflightProject(project({ timeline: { items: [] } }), { at: AT });
    expect(empty.checks.find((check) => check.id === "spec")?.status).toBe("block");
  });

  it("上传素材没有授权记录时要求人工确认", () => {
    const withUpload = project({
      assets: [
        {
          id: "a-upload",
          kind: "image",
          source: "upload",
          createdAt: AT,
        },
      ],
    });
    const report = preflightProject(withUpload, { durationMs: 60_000, at: AT });
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.id === "rights")?.status).toBe("review");
    expect(report.findings.some((finding) => finding.ruleId === "rights-asset")).toBe(true);
  });

  it("补上授权记录就不再提示缺授权（H7 / ADR-0167）", () => {
    const withUpload = project({
      assets: [
        { id: "a-upload", kind: "image", source: "upload", createdAt: AT },
      ],
      authorizations: [
        { id: "r-1", subject: "参考图", kind: "asset", grantedAt: "2026-11-01" },
      ],
    });
    const report = preflightProject(withUpload, { durationMs: 60_000, at: AT });
    expect(report.checks.find((check) => check.id === "rights")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "rights")?.detail).toContain("1 条授权记录");
    expect(report.findings.some((finding) => finding.ruleId.startsWith("rights-"))).toBe(false);
  });

  it("过期的授权照样标出来", () => {
    const stale = project({
      assets: [
        { id: "a-upload", kind: "image", source: "upload", createdAt: AT },
      ],
      authorizations: [
        { id: "r-1", subject: "参考图", kind: "asset", expiresAt: "2026-01-01" },
      ],
    });
    const report = preflightProject(stale, { durationMs: 60_000, at: AT });
    expect(report.checks.find((check) => check.id === "rights")?.status).toBe("review");
    expect(report.findings.some((finding) => finding.ruleId === "rights-expired-asset")).toBe(true);
    // 过期不算有效：素材仍然报缺
    expect(report.findings.some((finding) => finding.ruleId === "rights-asset")).toBe(true);
  });

  it("剧本导入的 provenance 视为已声明授权", () => {
    const imported = project({
      story: {
        ...sampleProject.story,
        provenance: {
          modelId: "import",
          prompt: `${IMPORT_PROMPT_PREFIX}（夜班.txt）（1200 字）：从前……`,
          createdAt: AT,
        },
      },
    });
    const report = preflightProject(imported, { durationMs: 60_000, at: AT });
    expect(report.checks.find((check) => check.id === "rights")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "rights")?.detail).toContain("已声明原创");
  });

  it("改一个字，指纹就变；同样的内容指纹稳定", () => {
    const a = preflightProject(project({ title: "夜班" }), { durationMs: 60_000, at: AT });
    const b = preflightProject(project({ title: "夜班" }), { durationMs: 60_000, at: AT });
    const c = preflightProject(project({ title: "夜班 2" }), { durationMs: 60_000, at: AT });
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
  });

  it("渲染证据保留预检时间、指纹、确认状态与命中数", () => {
    const report = preflightProject(project({ title: "一夜暴富" }), {
      durationMs: 60_000,
      at: AT,
    });
    const evidence = renderComplianceOf(report, true);
    expect(evidence).toMatchObject({
      ok: true,
      checkedAt: AT,
      signature: report.signature,
      reviewAcknowledged: true,
      findings: report.findings.length,
    });
  });
});

describe("G8 四个检查点", () => {
  const performative = project({
    shots: sampleProject.shots.map((shot, index) =>
      index === 0
        ? {
            ...shot,
            performance: {
              objective: "确认对方是不是也看见了",
              emotion: { surface: "平静", subtext: "戒备" },
              beats: [
                {
                  phase: "during",
                  micro: "眼皮跳了一下",
                  body: "手扶着门框",
                  action: "把门推开一半",
                  startMs: 0,
                  endMs: 2000,
                },
              ],
              gaze: { target: "character", targetId: "c-lin", direction: "right" },
              intensity: 3,
              avoid: ["不要演成惊恐"],
            },
            staging: [
              {
                characterId: "c-lin",
                side: "left",
                depth: "midground",
                note: "站在门边，手扶着门框",
              },
            ],
          }
        : shot,
    ),
  });

  it("四个检查点按阶段各扫各的文本", () => {
    expect(COMPLIANCE_CHECKPOINTS.map((item) => item.id)).toEqual([
      "script",
      "keyframes",
      "edit",
      "publish",
    ]);

    const script = checkpointTexts(performative, "script").map((unit) => unit.path);
    expect(script).toContain("标题");
    expect(script.some((path) => path.startsWith("角色「"))).toBe(true);
    expect(script.some((path) => path.startsWith("发布 ·"))).toBe(false);

    const keyframes = checkpointTexts(performative, "keyframes").map((unit) => unit.path);
    expect(keyframes.some((path) => path.includes("表演转 · 微表情"))).toBe(true);
    expect(keyframes.some((path) => path.includes("· 调度"))).toBe(true);
    expect(keyframes.some((path) => path.startsWith("台词 ·"))).toBe(false);

    const edit = checkpointTexts(performative, "edit").map((unit) => unit.path);
    expect(edit.every((path) => path.startsWith("台词 ·") || path.startsWith("配乐 ·"))).toBe(
      true,
    );

    const publish = checkpointTexts(performative, "publish", {
      title: "发布标题",
      description: "发布简介",
    }).map((unit) => unit.path);
    expect(publish).toEqual(["发布 · 标题", "发布 · 简介"]);
  });

  it("剧本阶段命中硬阻断，清干净后通过", () => {
    const dirty = project({ title: "如何制毒" });
    const blocked = preflightCheckpoint(dirty, "script", { at: AT });
    expect(blocked.status).toBe("block");
    expect(blocked.findings.some((finding) => finding.severity === "block")).toBe(true);

    const clean = preflightCheckpoint(project(), "script", { at: AT });
    expect(clean.status).toBe("pass");
    expect(clean.detail).toContain("没有命中");
  });

  it("关键帧阶段看表演与调度，不把台词算进来", () => {
    const staged = performative;
    const report = preflightCheckpoint(staged, "keyframes", { at: AT });
    expect(report.status).toBe("pass");
    // 台词里没有内容，关键帧即使加了台词也不该命中
    const withDialogue = project({
      dialogue: sampleProject.dialogue.map((line, index) =>
        index === 0 ? { ...line, text: "算命的说能改命" } : line,
      ),
    });
    expect(preflightCheckpoint(withDialogue, "keyframes", { at: AT }).findings).toEqual([]);
    expect(preflightCheckpoint(withDialogue, "script", { at: AT }).status).toBe("review");
  });

  it("成片阶段扫台词与配乐，空时间线标 review", () => {
    const withMusic = project({
      timeline: {
        items: sampleProject.timeline.items,
        music: [
          {
            id: "m-1",
            assetId: "a-music",
            title: "夜巡",
            mood: "紧张",
            startMs: 0,
            durationMs: 3000,
            licenseRef: "曲库授权 #123",
          },
        ],
      },
    });
    const report = preflightCheckpoint(withMusic, "edit", { at: AT });
    expect(report.status).toBe("pass");
    expect(report.detail).toContain("配乐 1 段");

    const empty = preflightCheckpoint(project({ timeline: { items: [] } }), "edit", { at: AT });
    expect(empty.status).toBe("review");
    expect(empty.detail).toContain("时间线还是空的");
  });

  it("发布文案只看发布字段，标题兜底用项目标题", () => {
    const report = preflightCheckpoint(project({ title: "夜班" }), "publish", {
      description: "加微信领福利",
      at: AT,
    });
    expect(report.status).toBe("review");
    expect(report.findings.every((finding) => finding.path.startsWith("发布 ·"))).toBe(true);
    expect(report.findings.some((finding) => finding.path === "发布 · 简介")).toBe(true);
  });

  it("一次算完四个检查点，改文案就换指纹", () => {
    const reports = preflightCheckpoints(project({ title: "夜班" }), { at: AT });
    expect(reports.map((report) => report.id)).toEqual([
      "script",
      "keyframes",
      "edit",
      "publish",
    ]);
    const again = preflightCheckpoints(project({ title: "夜班" }), { at: AT });
    expect(again.map((report) => report.signature)).toEqual(
      reports.map((report) => report.signature),
    );
    const changed = preflightCheckpoints(project({ title: "夜班 2" }), { at: AT });
    expect(changed.find((report) => report.id === "script")?.signature).not.toBe(
      reports.find((report) => report.id === "script")?.signature,
    );
  });
});
