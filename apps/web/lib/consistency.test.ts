import { ProjectSchema, type Project } from "@loomina/ir";
import { describe, expect, it } from "vitest";
import { analyzeConsistency } from "./consistency";
import { sampleProject } from "./sample-project";

/** 每个用例拿一份独立副本，别把示例项目改脏。 */
function clone(): Project {
  return ProjectSchema.parse(JSON.parse(JSON.stringify(sampleProject)));
}

function shotOf(project: Project, id: string) {
  return project.shots.find((shot) => shot.id === id)!;
}

describe("一致性体检（B14，ADR-0097）", () => {
  it("示例项目：12 镜，两个特写待复核，其余通过", () => {
    const report = analyzeConsistency(sampleProject);

    expect(report.summary.shots).toBe(12);
    expect(report.summary.pass).toBe(10);
    expect(report.summary.review).toBe(2);
    expect(report.summary.fail).toBe(0);
    expect(report.summary.unknown).toBe(0);
    expect(report.attention.map((item) => item.label)).toEqual(["SH-07", "SH-05"]);

    const s05 = report.shots.find((item) => item.shotId === "s-05")!;
    expect(s05.overall).toBe(89);
    expect(s05.threshold).toBe(90);
    expect(s05.verdict).toBe("review");
    // 周没有表情 / 服装参考，但这一镜还有道具参考图，取两者平均
    const wardrobe = s05.dimensions.find((item) => item.key === "wardrobe")!;
    expect(wardrobe.score).toBe(75);
    expect(s05.issues.some((issue) => issue.message.includes("不可变特征"))).toBe(true);
  });

  it("身份 / 场景 / 服化道都按结构化锚点打分", () => {
    const report = analyzeConsistency(sampleProject);
    const s03 = report.shots.find((item) => item.shotId === "s-03")!;
    expect(s03.dimensions.find((item) => item.key === "identity")?.score).toBe(100);
    expect(s03.dimensions.find((item) => item.key === "scene")?.score).toBe(100);
    expect(s03.dimensions.find((item) => item.key === "wardrobe")?.score).toBe(100);

    // 道具参考图缺失，服化道直接 0
    const project = clone();
    project.props.find((prop) => prop.id === "p-cup")!.referenceImages = [];
    const next = analyzeConsistency(project);
    const s09 = next.shots.find((item) => item.shotId === "s-09")!;
    expect(s09.dimensions.find((item) => item.key === "wardrobe")?.score).toBe(0);
    expect(s09.issues.some((issue) => issue.message.includes("搪瓷杯"))).toBe(true);
  });

  it("三视图缺格会扣身份分并给出补图建议", () => {
    const project = clone();
    const lin = project.characters.find((character) => character.id === "c-lin")!;
    delete lin.sheet.front;
    delete lin.sheet.threeQuarter;

    const report = analyzeConsistency(project);
    const s03 = report.shots.find((item) => item.shotId === "s-03")!;
    const identity = s03.dimensions.find((item) => item.key === "identity")!;
    expect(identity.score).toBeLessThan(100);
    const issue = s03.issues.find((item) => item.dimension === "identity")!;
    expect(issue.message).toContain("三视图");
    expect(issue.fix).toContain("定妆页");
  });

  it("场景缺主镜时场景分归零", () => {
    const project = clone();
    const corridor = project.locations.find((item) => item.id === "loc-corridor")!;
    delete corridor.masterShotId;

    const report = analyzeConsistency(project);
    const s01 = report.shots.find((item) => item.shotId === "s-01")!;
    expect(s01.dimensions.find((item) => item.key === "scene")?.score).toBe(0);
    expect(s01.issues.some((issue) => issue.message.includes("主镜"))).toBe(true);
  });

  it("特效镜头用了少数模型时风格分下降", () => {
    const project = clone();
    project.takes.find((take) => take.id === "t-12")!.provenance.modelId = "other-video";

    const report = analyzeConsistency(project);
    const s12 = report.shots.find((item) => item.shotId === "s-12")!;
    expect(s12.dimensions.find((item) => item.key === "style")?.score).toBe(60);
    expect(s12.issues.some((issue) => issue.message.includes("other-video"))).toBe(true);
  });

  it("溯源分只奖励真正记录下来的东西", () => {
    const project = clone();
    const take = project.takes.find((item) => item.id === "t-03")!;
    take.provenance.referenceAssetIds = ["a-lin-front"];
    take.provenance.prompt = "她站在门口";
    take.provenance.seed = 42;

    const report = analyzeConsistency(project);
    const s03 = report.shots.find((item) => item.shotId === "s-03")!;
    expect(s03.dimensions.find((item) => item.key === "provenance")?.score).toBe(100);
    expect(s03.issues.some((issue) => issue.dimension === "provenance")).toBe(false);
  });

  it("没有 take 的镜头只算准备度，结论是未知而不是通过", () => {
    const project = clone();
    shotOf(project, "s-03").takeIds = [];

    const report = analyzeConsistency(project);
    const s03 = report.shots.find((item) => item.shotId === "s-03")!;
    expect(s03.verdict).toBe("unknown");
    expect(s03.dimensions.find((item) => item.key === "style")?.score).toBeNull();
    expect(s03.dimensions.find((item) => item.key === "provenance")?.score).toBeNull();
    expect(report.summary.unknown).toBe(1);
  });

  it("景别越近，通过线越高：同一个 89 分在中景过、特写不过", () => {
    const project = clone();
    shotOf(project, "s-05").shotSize = "medium";

    const report = analyzeConsistency(project);
    const s05 = report.shots.find((item) => item.shotId === "s-05")!;
    expect(s05.overall).toBe(89);
    expect(s05.threshold).toBe(85);
    expect(s05.verdict).toBe("pass");

    shotOf(project, "s-05").shotSize = "wide";
    const wide = analyzeConsistency(project).shots.find((item) => item.shotId === "s-05")!;
    expect(wide.threshold).toBe(80);
    expect(wide.verdict).toBe("pass");

    shotOf(project, "s-05").shotSize = "close";
    const close = analyzeConsistency(project).shots.find((item) => item.shotId === "s-05")!;
    expect(close.threshold).toBe(90);
    expect(close.verdict).toBe("review");
  });

  it("空项目不除零", () => {
    const project = clone();
    project.shots = [];
    project.scenes = [];

    const report = analyzeConsistency(project);
    expect(report.shots).toEqual([]);
    expect(report.summary).toMatchObject({
      shots: 0,
      pass: 0,
      review: 0,
      fail: 0,
      unknown: 0,
      average: 0,
    });
  });

  it("光影 / 空间 / 表演明确写未测，不混进总分", () => {
    const report = analyzeConsistency(sampleProject);
    expect(report.notMeasured.map((item) => item.key)).toEqual([
      "lighting",
      "spatial",
      "performance",
    ]);
    for (const shot of report.shots) {
      expect(shot.dimensions.map((item) => item.key)).toEqual([
        "identity",
        "wardrobe",
        "scene",
        "style",
        "provenance",
      ]);
    }
  });
});
