import { describe, expect, it } from "vitest";
import { FakeImageAdapter, FakeVideoAdapter } from "@loomina/gateway";
import {
  clone,
  ProjectSchema,
  validateProject,
  type Project,
} from "@loomina/ir";
import minimalJson from "../../../examples/minimal.json";
import {
  AnchorError,
  buildMasterPrompt,
  buildPropPrompt,
  buildSheetPrompt,
  buildKeyframePrompt,
  buildShotPrompt,
  runMinimalChain,
  shotMaterial,
} from "../src/index";

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

describe("提示词里的道具", () => {
  it("关键道具用名称与描述进提示词", () => {
    const project = load();
    project.props.push({
      id: "p-cup",
      name: "搪瓷杯",
      description: "白底蓝边，杯沿磕了一块",
      referenceImages: [],
    });
    project.shots[0]!.propIds = ["p-cup"];

    const prompt = buildShotPrompt(project, project.shots[0]!);
    expect(prompt).toContain("道具：搪瓷杯，白底蓝边，杯沿磕了一块");
  });
});

describe("首帧提示词（ADR-0037）", () => {
  it("与镜头提示词同源，但明确是定住这一刻的静帧", () => {
    const project = load();
    const shot = project.shots[0]!;
    const prompt = buildKeyframePrompt(shotMaterial(project, shot));

    expect(prompt).toContain("首帧画面");
    expect(prompt).toContain("无字幕");
    expect(prompt).toContain(shot.description);
    expect(prompt).toContain("mm");
  });

  it("尾帧（ADR-0038）与首帧同源，只把起势换成收势", () => {
    const project = load();
    const material = shotMaterial(project, project.shots[0]!);
    const first = buildKeyframePrompt(material, "first");
    const last = buildKeyframePrompt(material, "last");

    expect(first).toContain("动作起势");
    expect(last).toContain("动作收势");
    expect(last).not.toContain("动作起势");
    expect(last).toContain(project.shots[0]!.description);
    expect(last).not.toContain("c-");
  });

  it("人物锚点照旧原样带上，不含 id", () => {
    const project = load();
    const shot = project.shots.find((item) => item.characterIds.length > 0) ?? project.shots[0]!;
    const prompt = buildKeyframePrompt(shotMaterial(project, shot));

    for (const character of project.characters.filter((item) => shot.characterIds.includes(item.id))) {
      expect(prompt).toContain(character.name);
      for (const keep of character.mustNotChange) expect(prompt).toContain(keep);
    }
    expect(prompt).not.toContain("c-");
  });
});

describe("三视图提示词", () => {
  it("带上人物固定串与角度，四格同源", () => {
    const project = load();
    const lin = project.characters[0]!;
    const front = buildSheetPrompt(lin, "front");
    const back = buildSheetPrompt(lin, "back");

    expect(front).toContain("正面");
    expect(back).toContain("背面");
    expect(front).toContain("林晚");
    expect(front).toContain("左眼下的痣");
    expect(front).toContain("纯浅灰背景");
  });
});

describe("主镜与道具提示词", () => {
  it("主镜是空镜，只交代空间与光线", () => {
    const prompt = buildMasterPrompt({ name: "走廊" });

    expect(prompt).toContain("空镜");
    expect(prompt).toContain("走廊");
    expect(prompt).toContain("无人入画");
  });

  it("道具带上名称与描述，单人静物", () => {
    const prompt = buildPropPrompt({
      name: "搪瓷杯",
      description: "白底蓝边，杯沿磕了一块",
    });

    expect(prompt).toContain("搪瓷杯");
    expect(prompt).toContain("杯沿磕了一块");
    expect(prompt).toContain("单件静物");
  });

  it("道具没有描述时不留空句", () => {
    const prompt = buildPropPrompt({ name: "台灯", description: "" });

    expect(prompt).not.toContain("。。");
    expect(prompt.startsWith("道具参考图：台灯。单件静物")).toBe(true);
  });
});
