import { describe, expect, it } from "vitest";
import {
  BEAT_SHEETS,
  beatSheetById,
  beatSheetPrompt,
  beatWindows,
  GENRE_MATRIX,
  genreById,
  genreReadiness,
  LOGLINE_MAX_CANDIDATES,
  LOGLINE_PASS,
  parseLoglineCandidates,
  scoreLogline,
  scoreLoglines,
} from "../src/index";

describe("题材矩阵（A14）", () => {
  it("12 个题材都在，优先级与 STORY.md 一致", () => {
    expect(GENRE_MATRIX).toHaveLength(12);
    expect(GENRE_MATRIX.filter((genre) => genre.priority === "P0").map((genre) => genre.name)).toEqual([
      "都市情感",
      "逆袭打脸",
      "甜宠霸总",
    ]);
    expect(genreById("古装宫斗")?.feasibility).toBe("低");
  });

  it("旧界面的叫法仍能识别", () => {
    expect(genreById("都市逆袭")?.name).toBe("逆袭打脸");
    expect(genreById("甜宠")?.name).toBe("甜宠霸总");
    expect(genreById("悬疑")?.name).toBe("悬疑复仇");
    expect(genreById("不存在的题材")).toBeUndefined();
  });

  it("首发题材是推荐，低可行性题材要慎重", () => {
    expect(genreReadiness(genreById("都市情感")!).level).toBe("推荐");
    expect(genreReadiness(genreById("家庭伦理")!).level).toBe("可做");
    const palace = genreReadiness(genreById("古装宫斗")!);
    expect(palace.level).toBe("慎重");
    expect(palace.tone).toBe("warn");
    expect(genreReadiness(genreById("乡村年代")!).level).toBe("暂缓");
  });
});

describe("logline 六维评分（A15）", () => {
  const genre = genreById("逆袭打脸")!;

  it("欲望、阻挡、代价、反差与具体物件都写到的候选拿高分", () => {
    const score = scoreLogline(
      "外卖员想要证明父亲没偷公司机密，却被董事长当众开除、全家净身出户，直到他在电梯里捡到那份合同。",
      genre,
    );
    expect(score.total).toBeGreaterThanOrEqual(24);
    expect(score.verdict).toBe("优先");
    expect(score.dims).toHaveLength(6);
    expect(score.dims.find((dim) => dim.key === "conflict")!.score).toBe(5);
    expect(score.dims.find((dim) => dim.key === "stake")!.score).toBeGreaterThanOrEqual(4);
  });

  it("抽象、没人阻挡的句子会被判淘汰", () => {
    const score = scoreLogline("她觉得很孤独，心情一直很低落，回忆过去。", genre);
    expect(score.total).toBeLessThan(LOGLINE_PASS);
    expect(score.verdict).toBe("淘汰");
    expect(score.weak.map((dim) => dim.key)).toContain("conflict");
    expect(score.weak.map((dim) => dim.key)).toContain("visual");
  });

  it("空文本不崩，高概念拿最低分", () => {
    const score = scoreLogline("   ");
    expect(score.dims.find((dim) => dim.key === "highConcept")!.score).toBe(1);
    expect(score.total).toBe(13);
    expect(score.verdict).toBe("淘汰");
  });

  it("没有选题材时受众匹配按通用 3 分，并说明原因", () => {
    const score = scoreLogline("离婚当天，她捡到了前夫失忆的弟弟。");
    expect(score.dims.find((dim) => dim.key === "audience")!.score).toBe(3);
    expect(score.dims.find((dim) => dim.key === "audience")!.reason).toContain("没有选题材");
  });

  it("一行一个候选，最多 10 条", () => {
    const raw = Array.from({ length: 13 }, (_, index) => `候选 ${index}`).join("\n\n");
    expect(parseLoglineCandidates(raw)).toHaveLength(LOGLINE_MAX_CANDIDATES);
    expect(scoreLoglines(raw, genre)).toHaveLength(LOGLINE_MAX_CANDIDATES);
  });
});

describe("节拍表模板（A17）", () => {
  it("三套模板：60 秒、3 分钟、系列", () => {
    expect(BEAT_SHEETS.map((sheet) => sheet.id)).toEqual(["60s", "3min", "series"]);
    expect(beatSheetById("60s")?.name).toBe("60 秒单集");
    expect(beatSheetById("unknown")).toBeUndefined();
  });

  it("60 秒表与 STORY.md 的时间窗一致，且首尾相接", () => {
    const sheet = beatSheetById("60s")!;
    expect(sheet.beats.map((beat) => [beat.startSec, beat.endSec])).toEqual([
      [0, 3],
      [3, 10],
      [10, 25],
      [25, 40],
      [40, 55],
      [55, 60],
    ]);
    for (let index = 1; index < sheet.beats.length; index += 1) {
      expect(sheet.beats[index]!.startSec).toBe(sheet.beats[index - 1]!.endSec);
    }
  });

  it("3 分钟表有两段升级与一个收束", () => {
    const sheet = beatSheetById("3min")!;
    expect(sheet.beats.filter((beat) => beat.label.startsWith("升级"))).toHaveLength(2);
    expect(sheet.beats.at(-2)?.beat).toBe("resolution");
    expect(sheet.beats.at(-1)?.beat).toBe("endHook");
  });

  it("按实际时长等比换算；没给时长就用名义时长", () => {
    const sheet = beatSheetById("60s")!;
    expect(beatWindows(sheet, 90_000).at(-1)).toMatchObject({ startMs: 82_500, endMs: 90_000 });
    expect(beatWindows(sheet).at(1)).toMatchObject({ startMs: 3_000, endMs: 10_000 });
  });

  it("提示词包含模板名、时间窗与任务，并保留 60–90 秒的生成目标", () => {
    const prompt = beatSheetPrompt(beatSheetById("60s")!);
    expect(prompt).toContain("60 秒单集");
    expect(prompt).toContain("hook 0–3s");
    expect(prompt).toContain("留钩");
    expect(prompt).toContain("60–90 秒");
  });
});
