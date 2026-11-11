import { describe, expect, it } from "vitest";
import { validateProject } from "@loomina/ir";
import {
  importStoryMessages,
  parseStoryDraft,
  projectFromStoryDraft,
  StoryDraftError,
  storyMessages,
} from "../src/story";

const DRAFT = {
  title: "少主归来",
  logline: "外卖员送餐撞破董事会，才知道自己是被夺走人生的继承人。",
  synopsis: "程野每天给顶层公寓送餐，暗中查父亲坠楼的真相。",
  genre: "都市逆袭",
  audience: "喜欢打脸爽感的竖屏用户",
  tone: "冷峻、快节奏",
  openingHook: "餐盒里掉出一张股权转让书。",
  endingHook: "董事长喊他少主，满座高管脸色骤变。",
  characters: [
    {
      name: "程野",
      role: "外卖员 / 继承人",
      appearance: "28 岁，旧骑手服，左手虎口有疤",
      want: "查清父亲坠楼真相",
      need: "承认自己仍然想被家人接住",
      wound: "十岁被赶出家门",
      flaw: "不相信任何人",
      secret: "他早就拿到了父亲留下的 U 盘",
      agency: "当众承认身份，换回母亲",
      arc: "从躲藏到当众亮明身份",
    },
    {
      name: "沈岚",
      role: "董事长",
      appearance: "55 岁，深灰西装，银边眼镜",
    },
  ],
  relationships: [
    { from: "程野", to: "沈岚", tension: "他要真相，她要保住董事会" },
    { from: "程野", to: "不存在的人", tension: "应被丢掉" },
  ],
  locations: [
    {
      name: "集团董事会",
      description: "顶层会议室，长桌、落地窗、暴雨",
      space: "内景",
      timeOfDay: "夜",
    },
  ],
  props: [{ name: "U 盘", description: "银色，挂在餐盒夹层里" }],
  scenes: [
    {
      locationName: "集团董事会",
      space: "内景",
      timeOfDay: "夜",
      shots: [
        {
          description: "程野拎着餐盒推门，满桌高管回头。",
          shotSize: "全景",
          angle: "平视",
          movement: "推近",
          focalMm: "35mm",
          characterNames: ["程野", "沈岚", "不存在的人"],
          propNames: ["U 盘"],
          dialogue: [
            { characterName: "沈岚", text: "你是谁？" },
            { characterName: "程野", text: "送餐的。" },
            { characterName: "不存在的人", text: "这句应被丢掉" },
            { characterName: "程野", text: "第三句应被截掉" },
          ],
        },
        {
          description: "特写：餐盒夹层里的 U 盘。",
          shotSize: "大特写",
          angle: "俯拍",
          movement: "固定",
          focalMm: 50,
          characterNames: [],
          propNames: ["U 盘"],
          dialogue: [],
        },
      ],
    },
  ],
};

describe("故事草稿解析（ADR-0088）", () => {
  it("能剥掉代码围栏并归一中文枚举", () => {
    const draft = parseStoryDraft("```json\n" + JSON.stringify(DRAFT) + "\n```");
    expect(draft.scenes[0]?.space).toBe("int");
    expect(draft.scenes[0]?.timeOfDay).toBe("night");
    expect(draft.scenes[0]?.shots[0]?.shotSize).toBe("wide");
    expect(draft.scenes[0]?.shots[0]?.angle).toBe("eye");
    expect(draft.scenes[0]?.shots[0]?.movement).toBe("push");
    expect(draft.scenes[0]?.shots[0]?.focalMm).toBe(35);
    expect(draft.scenes[0]?.shots[1]?.shotSize).toBe("extreme-close");
    expect(draft.scenes[0]?.shots[1]?.angle).toBe("high");
  });

  it("丢掉不存在的人物、关系，并把每镜台词截到 2 句", () => {
    const draft = parseStoryDraft(JSON.stringify(DRAFT));
    expect(draft.relationships).toHaveLength(1);
    expect(draft.scenes[0]?.shots[0]?.characterNames).toEqual(["程野", "沈岚"]);
    expect(draft.scenes[0]?.shots[0]?.dialogue.map((line) => line.text)).toEqual([
      "你是谁？",
      "送餐的。",
    ]);
  });

  it("没有 JSON 或结构不完整时给人话", () => {
    expect(() => parseStoryDraft("我想写一个故事")).toThrow(StoryDraftError);
    expect(() => parseStoryDraft("{\"title\":\"只有标题\"}")).toThrow(/结构不完整/);
  });

  it("人物、场次、镜头数量会被夹到上限", () => {
    const many = structuredClone(DRAFT);
    many.characters = Array.from({ length: 8 }, (_, index) => ({
      ...DRAFT.characters[0]!,
      name: `人${index}`,
    }));
    many.scenes[0]!.shots = Array.from({ length: 14 }, () => DRAFT.scenes[0]!.shots[1]!);
    const draft = parseStoryDraft(JSON.stringify(many));
    expect(draft.characters).toHaveLength(5);
    expect(draft.scenes[0]?.shots).toHaveLength(10);
  });
});

describe("草稿 → 项目（ADR-0088）", () => {
  it("生成 id、时长与双向引用，并过全部不变量", () => {
    const draft = parseStoryDraft(JSON.stringify(DRAFT));
    const project = projectFromStoryDraft(draft, {
      id: "proj-test",
      at: "2026-11-11T10:00:00Z",
      modelId: "claude-sonnet-5-5",
      idea: "外卖员是继承人",
    });

    expect(project.title).toBe("少主归来");
    expect(project.story.logline).toContain("外卖员");
    expect(project.story.arcs[0]).toMatchObject({
      characterId: "char-1",
      want: "查清父亲坠楼真相",
    });
    expect(project.story.relationships).toEqual([
      { fromCharacterId: "char-1", toCharacterId: "char-2", tension: "他要真相，她要保住董事会" },
    ]);
    expect(project.story.hooks.opening).toBe("餐盒里掉出一张股权转让书。");
    expect(project.story.provenance?.modelId).toBe("claude-sonnet-5-5");
    expect(project.scenes).toHaveLength(1);
    expect(project.shots).toHaveLength(2);
    expect(project.shots[0]?.characterIds).toEqual(["char-1", "char-2"]);
    expect(project.shots[0]?.propIds).toEqual(["prop-1"]);
    expect(project.dialogue).toHaveLength(2);
    expect(project.shots[0]?.dialogueIds).toHaveLength(2);
    // 有台词：全部台词 + 1000ms 表演余量；没台词：5 秒
    expect(project.shots[0]?.durationMs).toBe(1200 + 1200 + 1000);
    expect(project.shots[1]?.durationMs).toBe(5000);
    expect(validateProject(project)).toEqual([]);
  });

  it("提示词里写死短剧约束与枚举", () => {
    const messages = storyMessages("外卖员是继承人", "都市逆袭");
    expect(messages[0]?.content).toContain("只输出 JSON");
    expect(messages[0]?.content).toContain("extreme-close");
    expect(messages[0]?.content).toContain("前 3 秒必须是钩子");
    expect(messages[1]?.content).toContain("都市逆袭");
  });

  it("导入提示词要求保留关系与结局，并说明是改编", () => {
    const messages = importStoryMessages(
      "第一场 夜 咖啡馆\n林夏：你早就知道，对吧？\n周野：知道什么？",
      "悬疑",
    );
    expect(messages[0]?.content).toContain("改写成");
    expect(messages[0]?.content).toContain("不新增原文没有的主要人物");
    expect(messages[0]?.content).toContain("结局意思");
    expect(messages[0]?.content).toContain("只输出 JSON");
    expect(messages[1]?.content).toContain("悬疑");
    expect(messages[1]?.content).toContain("林夏：你早就知道");
  });
});
