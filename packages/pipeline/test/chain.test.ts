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
  buildVideoPrompt,
  describeSceneTemplate,
  parseInstruction,
  runMinimalChain,
  SCENE_TEMPLATES,
  sceneTemplateById,
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

describe("光影与构图进入提示词（I2 / I4）", () => {
  it("没写光影 / 构图时，提示词与以前逐字一致", () => {
    const project = load();
    const shot = project.shots[0]!;
    const prompt = buildShotPrompt(project, shot);
    expect(prompt).not.toContain("光线：");
    expect(prompt).not.toContain("构图：");
  });

  it("写了光影，镜头 / 首帧 / 视频三条提示词都带上这一句", () => {
    const base = load();
    const shot = { ...base.shots[0]!, lighting: { source: "lamp" as const, position: "side" as const, mood: "modeled" as const, note: "" } };
    const project: Project = { ...base, shots: [shot, ...base.shots.slice(1)] };
    const material = shotMaterial(project, shot);
    expect(buildShotPrompt(project, shot)).toContain("光线：台灯，侧光，明暗过渡清晰");
    expect(buildKeyframePrompt(material)).toContain("光线：台灯");
    expect(buildVideoPrompt(material)).toContain("光线：台灯");
  });

  it("写了构图，提示词带上构图那一句，且排在镜头参数之前", () => {
    const base = load();
    const shot = { ...base.shots[0]!, composition: { rule: "frame" as const, note: "" } };
    const project: Project = { ...base, shots: [shot, ...base.shots.slice(1)] };
    const prompt = buildShotPrompt(project, shot);
    expect(prompt).toContain("构图：框中框构图");
    expect(prompt.indexOf("构图：")).toBeLessThan(prompt.indexOf("mm"));
  });
});

describe("画面风格进入提示词（B7 / I5，ADR-0165）", () => {
  it("默认档的提示词最后一句与旧口径逐字一致", () => {
    const project = load();
    const shot = project.shots[0]!;
    const prompt = buildKeyframePrompt(shotMaterial(project, shot));
    expect(prompt.endsWith("竖屏 9:16，实拍电影质感，自然光，轻微胶片颗粒")).toBe(true);
  });

  it("改了项目风格，镜头 / 首帧 / 视频三条提示词一起变", () => {
    const base = load();
    const shot = base.shots[0]!;
    const project: Project = {
      ...base,
      look: { ...base.look, presetId: "noir" },
    };
    const material = shotMaterial(project, shot);
    expect(buildShotPrompt(project, shot)).toContain("黑色电影质感");
    expect(buildKeyframePrompt(material)).toContain("黑色电影质感");
    expect(buildVideoPrompt(material)).toContain("黑色电影质感");
  });

  it("定妆与道具在默认档仍走棚拍口径", () => {
    const project = load();
    const character = project.characters[0]!;
    expect(buildSheetPrompt(character, "front", project.look)).toContain("柔光棚拍");
    const prop = project.props[0];
    if (prop) expect(buildPropPrompt(prop, project.look)).toContain("柔光棚拍");
  });

  it("改过风格后定妆照接上项目质感，仍保留棚拍", () => {
    const base = load();
    const look = { ...base.look, presetId: "warm" };
    const prompt = buildSheetPrompt(base.characters[0]!, "front", look);
    expect(prompt).toContain("家庭剧质感");
    expect(prompt).toContain("柔光棚拍");
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

  it("视频提示词（ADR-0083）与镜头同源，补的是运动而不是重画", () => {
    const project = load();
    const shot = project.shots[0]!;
    const prompt = buildVideoPrompt(shotMaterial(project, shot));

    expect(prompt).toContain(shot.description);
    expect(prompt).toContain("从首帧起势");
    expect(prompt).toContain("保持人物一致");
    expect(prompt).not.toContain("首帧画面");
    expect(prompt).not.toContain("无字幕");
  });

  it("台词进视频提示词；首尾帧不带台词，静帧不烧字幕（ADR-0107）", () => {
    const project = load();
    const shot = project.shots.find((item) => item.dialogueIds.length > 0) ?? project.shots[0]!;
    const lines = shot.dialogueIds.flatMap((id) => {
      const line = project.dialogue.find((item) => item.id === id);
      return line ? [line] : [];
    });
    const material = shotMaterial(project, shot);
    const video = buildVideoPrompt(material);
    const first = buildKeyframePrompt(material, "first");

    for (const line of lines) {
      expect(video).toContain(line.text);
      expect(first).not.toContain(line.text);
    }
    expect(video).toContain("台词（口型对齐）");
    expect(video).not.toContain("c-");
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
    const prompt = buildMasterPrompt({ name: "走廊", description: "" });

    expect(prompt).toContain("空镜");
    expect(prompt).toContain("走廊");
    expect(prompt).toContain("无人入画");
  });

  it("地点有描述时，描述进主镜提示词（ADR-0063）", () => {
    const prompt = buildMasterPrompt({
      name: "走廊",
      description: "老楼走廊，声控灯，墙皮起了卷",
    });

    expect(prompt).toContain("墙皮起了卷");
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

describe("一句话指令（ADR-0039）", () => {
  const shot = { shotSize: "medium" as const, camera: { angle: "eye" as const, movement: "static" as const, focalMm: 50 }, durationMs: 3000 };

  it("太暗了落成补充要求，不动结构字段", () => {
    const patch = parseInstruction("太暗了", shot);
    expect(patch?.note).toContain("提亮");
    expect(patch?.shotSize).toBeUndefined();
    expect(patch?.camera).toBeUndefined();
  });

  it("太亮走过曝那条，不会被暗部规则吃掉", () => {
    expect(parseInstruction("太亮了", shot)?.note).toContain("压暗");
    expect(parseInstruction("高光过曝", shot)?.note).toContain("压暗");
  });

  it("换个角度按平视 → 仰拍 → 俯拍 → 平视轮换", () => {
    expect(parseInstruction("换个角度", shot)?.camera?.angle).toBe("low");
    expect(
      parseInstruction("换个角度", { ...shot, camera: { ...shot.camera, angle: "low" } })?.camera?.angle,
    ).toBe("high");
    expect(
      parseInstruction("换个角度", { ...shot, camera: { ...shot.camera, angle: "high" } })?.camera?.angle,
    ).toBe("eye");
  });

  it("靠近紧一档、拉远松一档，到头了就不改", () => {
    expect(parseInstruction("靠近一点", shot)?.shotSize).toBe("close");
    expect(parseInstruction("拉远", shot)?.shotSize).toBe("wide");
    expect(parseInstruction("再近一点", { ...shot, shotSize: "extreme-close" })).toBeNull();
    expect(parseInstruction("拉远", { ...shot, shotSize: "wide" })).toBeNull();
  });

  it("手持与稳住改机位运动", () => {
    const handheld = { ...shot, camera: { ...shot.camera, movement: "handheld" as const } };
    expect(parseInstruction("有点晃，稳住", handheld)?.camera?.movement).toBe("static");
    expect(parseInstruction("试试手持", shot)?.camera?.movement).toBe("handheld");
    // 已经是手持再说手持，没有改动
    expect(parseInstruction("手持", handheld)).toBeNull();
  });

  it("快一点 / 慢一点一档 0.5 秒，太快 / 太慢反向，到边界不改", () => {
    expect(parseInstruction("快一点", shot)?.durationMs).toBe(2500);
    expect(parseInstruction("太慢了", shot)?.durationMs).toBe(2500);
    expect(parseInstruction("慢一点", shot)?.durationMs).toBe(3500);
    expect(parseInstruction("太快了", shot)?.durationMs).toBe(3500);
    expect(parseInstruction("快一点", { ...shot, durationMs: 1000 })).toBeNull();
    expect(parseInstruction("慢一点", { ...shot, durationMs: 8000 })).toBeNull();
  });

  it("没听懂就返回 null，不编参数", () => {
    expect(parseInstruction("她笑得太早了", shot)).toBeNull();
    expect(parseInstruction("   ", shot)).toBeNull();
  });

  it("补充要求进提示词，作为一句「补充：…」", () => {
    const project = load();
    const line = project.shots[0]!;
    const withNote = {
      ...line,
      promptNotes: ["整体提亮，补足曝光，阴影保留细节"],
    };
    const prompt = buildKeyframePrompt(shotMaterial({ ...project, shots: [withNote] }, withNote));

    expect(prompt).toContain("补充：整体提亮，补足曝光，阴影保留细节");
    expect(buildShotPrompt({ ...project, shots: [withNote] }, withNote)).toContain("补充：");
  });
});

describe("表演、视线与调度进提示词（B16 / B17 / ADR-0103）", () => {
  function withPerformance(project: Project) {
    const shot = project.shots[0]!;
    shot.performance = {
      objective: "让她相信自己没有被出卖",
      emotion: { surface: "克制", subtext: "其实在试探" },
      beats: [
        { phase: "before", micro: "眼神躲开", body: "手指扣住门框", startMs: 0, endMs: 800 },
        { phase: "after", micro: "嘴角松下来", body: "肩膀落下", startMs: 1800, endMs: 2500 },
      ],
      gaze: { target: "character", targetId: "c-zhou", direction: "right" },
      intensity: 4,
      avoid: ["不要哭出来"],
    };
    return shot;
  }

  it("视频提示词写清目的、情绪、视线与起转落", () => {
    const project = load();
    const shot = withPerformance(project);
    const prompt = buildVideoPrompt(shotMaterial(project, shot));

    expect(prompt).toContain("表演：目的：让她相信自己没有被出卖");
    expect(prompt).toContain("表面情绪：克制");
    expect(prompt).toContain("潜台词：其实在试探");
    expect(prompt).toContain("视线：看人周野，向右");
    expect(prompt).toContain("表演强度 4/5");
    expect(prompt).toContain("不要：不要哭出来");
    expect(prompt).toContain("表演节拍：起：眼神躲开，手指扣住门框；落：嘴角松下来，肩膀落下");
    expect(prompt).not.toContain("c-zhou");
  });

  it("首帧只对起、尾帧只对落（不变量 24）", () => {
    const project = load();
    const shot = withPerformance(project);
    const first = buildKeyframePrompt(shotMaterial(project, shot, { frame: "first" }), "first");
    const last = buildKeyframePrompt(shotMaterial(project, shot, { frame: "last" }), "last");

    expect(first).toContain("这一帧的表演：起：眼神躲开，手指扣住门框");
    expect(first).not.toContain("这一帧的表演：落：");
    expect(last).toContain("这一帧的表演：落：嘴角松下来，肩膀落下");
    expect(last).not.toContain("表演节拍：");
    expect(last).not.toContain("起：眼神躲开");
  });

  it("调度写左右与前后，不带 id", () => {
    const project = load();
    const shot = project.shots[0]!;
    shot.staging = [
      { characterId: "c-lin", side: "left", depth: "foreground", note: "背对门" },
      { propId: "p-cup", side: "right", depth: "background", note: "" },
    ];
    project.props = [
      { id: "p-cup", name: "搪瓷杯", description: "", referenceImages: [] },
    ];
    const prompt = buildShotPrompt(project, shot);

    expect(prompt).toContain("调度：林晚在画面左（前景），背对门；搪瓷杯在画面右（后景）");
    expect(prompt).not.toContain("c-lin");
    expect(prompt).not.toContain("p-cup");
  });

  it("没有表演设计时提示词不凭空补情绪", () => {
    const project = load();
    const prompt = buildVideoPrompt(shotMaterial(project, project.shots[0]!));
    expect(prompt).not.toContain("表演：");
    expect(prompt).not.toContain("视线：");
  });
});

describe("场景模板进提示词（B15 / ADR-0103）", () => {
  it("十个模板齐全，说明里有尺寸、光线与机位", () => {
    expect(SCENE_TEMPLATES).toHaveLength(10);
    expect(SCENE_TEMPLATES.map((template) => template.id)).toContain("elevator");
    const living = sceneTemplateById("living-room")!;
    expect(describeSceneTemplate(living)).toContain("5×4×2.8m");
    expect(describeSceneTemplate(living)).toContain("4300K");
    expect(describeSceneTemplate(living)).toContain("沙发正面");
    expect(sceneTemplateById("apartment-living")?.id).toBe("living-room");
    expect(sceneTemplateById("corridor")).toBeUndefined();
  });

  it("场景模板写进镜头提示词：空间、主光与锚点", () => {
    const project = load();
    const prompt = buildShotPrompt(project, project.shots[0]!);

    expect(prompt).toContain("场景：公寓客厅（公寓客厅模板（窗光 + 顶灯；4300K；光比 3:1；关键位置：");
    expect(prompt).toContain("沙发（中左）");
  });
});
