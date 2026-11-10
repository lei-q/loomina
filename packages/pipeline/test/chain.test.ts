import { describe, expect, it } from "vitest";
import { FakeImageAdapter, FakeVideoAdapter } from "@loomina/gateway";
import {
  clone,
  ProjectSchema,
  validateProject,
  type Project,
} from "@loomina/ir";
import minimalJson from "../../../examples/minimal.json";
import { AnchorError, buildShotPrompt, runMinimalChain } from "../src/index";

const NOW = () => "2026-11-09T12:00:00Z";

function load(): Project {
  return ProjectSchema.parse(clone(minimalJson));
}

describe("S0 最小链路", () => {
  it("为每个镜头生成 Take 并记账，结果仍满足不变量", async () => {
    const project = load();
    const inputs: Array<Parameters<FakeImageAdapter["generate"]>[0]> = [];
    const image = new FakeImageAdapter(NOW);
    const spyImage = {
      generate: async (input: Parameters<FakeImageAdapter["generate"]>[0]) => {
        inputs.push(input);
        return image.generate(input);
      },
    };

    const result = await runMinimalChain(project, {
      image: spyImage,
      video: new FakeVideoAdapter(NOW),
      now: NOW,
    });

    expect(result.project.version).toBe(project.version + 1);
    expect(result.project.takes).toHaveLength(project.takes.length + 2);
    expect(result.project.shots[0]!.takeIds).toHaveLength(2);
    expect(result.totalCny).toBeGreaterThan(0);
    expect(result.ledger).toHaveLength(4);
    expect(validateProject(result.project)).toEqual([]);

    // 参考图来自定妆资产，不是 characterIds
    expect(inputs[0]?.referenceAssetIds).toEqual([
      "a-lin-front",
      "a-lin-34",
      "a-living-master",
    ]);
    expect(inputs[0]?.prompt).toContain("左眼下的痣");
    expect(inputs[0]?.prompt).toContain("人物：林晚");
  });

  it("不修改输入项目（非破坏）", async () => {
    const project = load();
    await runMinimalChain(project, {
      image: new FakeImageAdapter(NOW),
      video: new FakeVideoAdapter(NOW),
      now: NOW,
    });

    expect(project.shots[0]!.takeIds).toHaveLength(1);
    expect(project.takes).toHaveLength(2);
  });

  it("锚点不齐时拒绝生成，不调用模型", async () => {
    const project = load();
    delete project.characters[0]!.sheet.back; // 林有近景，缺一格

    let called = false;
    const image = new FakeImageAdapter(NOW);
    const spyImage = {
      generate: async (input: Parameters<typeof image.generate>[0]) => {
        called = true;
        return image.generate(input);
      },
    };

    await expect(
      runMinimalChain(project, {
        image: spyImage,
        video: new FakeVideoAdapter(NOW),
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(AnchorError);

    expect(called).toBe(false);
  });

  it("提示词带上人物与不许变的固定串", () => {
    const project = load();
    const prompt = buildShotPrompt(project, project.shots[0]!);

    expect(prompt).toContain("人物：林晚");
    expect(prompt).toContain("不许变：左眼下的痣、齐肩黑发，中分、米色风衣");
    expect(prompt).toContain("场景：公寓客厅");
  });

  it("输入违反不变量时直接拒绝，不调用模型", async () => {
    const project = load();
    project.shots[0]!.durationMs = 9000;

    let called = false;
    const image = new FakeImageAdapter(NOW);
    const spyImage = {
      generate: async (input: Parameters<typeof image.generate>[0]) => {
        called = true;
        return image.generate(input);
      },
    };

    await expect(
      runMinimalChain(project, {
        image: spyImage,
        video: new FakeVideoAdapter(NOW),
        now: NOW,
      }),
    ).rejects.toThrow();

    expect(called).toBe(false);
  });
});
