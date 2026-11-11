import { describe, expect, it } from "vitest";
import { applyEvent, type Project } from "@loomina/ir";
import { sampleProject } from "./sample-project";
import {
  STAGE_META,
  nextOpenStage,
  stageSignature,
  stageStateOf,
  stageStates,
} from "./stage-flow";

const AT = "2026-11-11T10:00:00Z";

function withStory(project: Project = sampleProject): Project {
  return applyEvent(project, {
    type: "project.created",
    at: AT,
    project: {
      ...project,
      story: {
        ...project.story,
        logline: "两个夜班保安互相试探，谁先承认灯是谁关的。",
        synopsis: "一个普通的夜班，两个人都不肯先说出真相。",
      },
    },
  });
}

function confirm(project: Project, stage: Parameters<typeof stageSignature>[1]): Project {
  return applyEvent(project, {
    type: "gate.confirmed",
    at: AT,
    stage,
    signature: stageSignature(project, stage),
  });
}

describe("阶段式创作流（F8）", () => {
  it("七个阶段按故事到成片的顺序排好", () => {
    const states = stageStates(sampleProject);
    expect(states.map((state) => state.key)).toEqual([
      "story",
      "script",
      "cast",
      "storyboard",
      "keyframes",
      "voice",
      "edit",
    ]);
    expect(states.map((state) => state.name)).toEqual([
      "故事",
      "剧本",
      "定妆",
      "分镜",
      "关键帧",
      "声音",
      "成片",
    ]);
    expect(STAGE_META).toHaveLength(7);
  });

  it("空故事不可确认；补上 logline 与梗概后可确认", () => {
    const empty = stageStateOf(sampleProject, "story");
    expect(empty.readiness).toBe("empty");
    expect(empty.canConfirm).toBe(false);
    expect(empty.missing).toContain("还差一句 logline");

    const ready = stageStateOf(withStory(), "story");
    expect(ready.readiness).toBe("ready");
    expect(ready.canConfirm).toBe(true);
    expect(ready.missing).toEqual([]);
  });

  it("每个阶段都有自己的下一步，成片没有", () => {
    expect(stageStateOf(sampleProject, "story").next?.href).toBe("/script");
    expect(stageStateOf(sampleProject, "voice").next?.href).toBe("/edit");
    expect(stageStateOf(sampleProject, "edit").next).toBeUndefined();
  });

  it("下一步指向第一个还没确认的阶段", () => {
    let project = sampleProject;
    expect(nextOpenStage(stageStates(project))?.key).toBe("story");
    for (const meta of STAGE_META) {
      project = confirm(project, meta.key);
    }
    expect(nextOpenStage(stageStates(project))).toBeUndefined();
  });

  it("成片时间线已有内容，成片阶段可确认", () => {
    const edit = stageStateOf(sampleProject, "edit");
    expect(edit.readiness).toBe("ready");
    expect(edit.canConfirm).toBe(true);
    expect(edit.summary).toContain("2 段");
  });
});

describe("阶段确认与过期（F9）", () => {
  it("确认后是 confirmed，内容一改就 stale", () => {
    let project = withStory();
    project = confirm(project, "story");
    expect(stageStateOf(project, "story").gate).toBe("confirmed");

    const changed = applyEvent(project, {
      type: "project.created",
      at: AT,
      project: { ...project, title: "夜班（改）" },
    });
    expect(stageStateOf(changed, "story").gate).toBe("stale");
    expect(stageStateOf(changed, "story").canConfirm).toBe(true);
  });

  it("签名只覆盖本阶段：改人物不动故事签名，改人物会动定妆签名", () => {
    const storyBefore = stageSignature(sampleProject, "story");
    const castBefore = stageSignature(sampleProject, "cast");
    const changed = applyEvent(sampleProject, {
      type: "character.updated",
      at: AT,
      characterId: "c-lin",
      patch: { appearance: "短发，浅灰外套" },
    });
    expect(stageSignature(changed, "story")).toBe(storyBefore);
    expect(stageSignature(changed, "cast")).not.toBe(castBefore);
  });

  it("同一份内容总得到同一个签名", () => {
    expect(stageSignature(sampleProject, "storyboard")).toBe(
      stageSignature(sampleProject, "storyboard"),
    );
  });

  it("确认后解锁定妆会让定妆阶段过期（签名含锁定状态）", () => {
    let project = confirm(sampleProject, "cast");
    expect(stageStateOf(project, "cast").gate).toBe("confirmed");
    project = applyEvent(project, {
      type: "approval.updated",
      at: AT,
      approval: {
        id: "ap-1",
        targetType: "character",
        targetId: "c-lin",
        status: "approved",
        lockedAssetIds: [],
      },
    });
    expect(stageStateOf(project, "cast").gate).toBe("stale");
  });

  it("回退闸门后回到未确认，记录被删掉", () => {
    let project = confirm(sampleProject, "script");
    project = applyEvent(project, { type: "gate.reopened", at: AT, stage: "script" });
    expect(project.gates).toEqual([]);
    expect(stageStateOf(project, "script").gate).toBe("none");
  });
});

describe("声音确认（A9）", () => {
  it("还没有配音时不可确认，缺几句说清楚", () => {
    const voice = stageStateOf(sampleProject, "voice");
    expect(voice.readiness).not.toBe("ready");
    expect(voice.canConfirm).toBe(false);
    expect(voice.missing[0]).toContain("还没有配音");
    expect(voice.summary).toContain("0 / 4 句有声");
  });

  it("每一句都挂上音轨后可确认，换音色会让确认过期", () => {
    const audioAsset = {
      id: "a-voice-all",
      kind: "audio" as const,
      source: "upload" as const,
      uri: "data:audio/mpeg;base64,SUQz",
      mime: "audio/mpeg",
      createdAt: AT,
    };
    let project = applyEvent(sampleProject, {
      type: "asset.updated",
      at: AT,
      asset: audioAsset,
    });
    for (const line of sampleProject.dialogue) {
      project = applyEvent(project, {
        type: "dialogue.updated",
        at: AT,
        lineId: line.id,
        patch: { audioAssetId: audioAsset.id },
      });
    }
    const voice = stageStateOf(project, "voice");
    expect(voice.readiness).toBe("ready");
    expect(voice.canConfirm).toBe(true);
    expect(voice.summary).toContain("4 / 4 句有声");

    project = confirm(project, "voice");
    expect(stageStateOf(project, "voice").gate).toBe("confirmed");

    project = applyEvent(project, {
      type: "character.updated",
      at: AT,
      characterId: "c-lin",
      patch: { voiceProfileId: "voice-lin-2" },
    });
    expect(stageStateOf(project, "voice").gate).toBe("stale");
  });
});

describe("A12 覆盖率硬闸门", () => {
  it("分镜阶段给出可豁免缺口：覆盖率不满时不直接挡确认", () => {
    const state = stageStateOf(sampleProject, "storyboard");
    // 示例项目每镜都有描述 → 硬缺口为空
    expect(state.missing).toEqual([]);
    expect(state.canConfirm).toBe(true);
    // 但覆盖率不满，缺口进 waivable 而不是 missing
    expect(state.waivable.length).toBeGreaterThan(0);
    expect(state.waivable[0]).toContain("覆盖率");
  });

  it("覆盖率满时没有可豁免缺口", () => {
    // 同一场里相邻两镜交替信息 / 情绪，每一拍就都齐了。
    // 单镜的场（sc-3）永远凑不出一拍两镜，这里把它去掉，只验证「齐了就不报」。
    const seenInScene = new Map<string, number>();
    const multiShotScenes = new Set(
      ["sc-1", "sc-2", "sc-4", "sc-5"],
    );
    const covered: Project = {
      ...sampleProject,
      shots: sampleProject.shots
        .filter((shot) => multiShotScenes.has(shot.sceneId))
        .map((shot) => {
        const at = seenInScene.get(shot.sceneId) ?? 0;
        seenInScene.set(shot.sceneId, at + 1);
          return {
            ...shot,
            beat: "setup" as const,
            purpose: at % 2 === 0 ? ("information" as const) : ("emotion" as const),
          };
        }),
    };
    const state = stageStateOf(covered, "storyboard");
    expect(state.waivable).toEqual([]);
  });

  it("还有没描述的镜头时，只报硬缺口，不重复报覆盖率", () => {
    const blank: Project = {
      ...sampleProject,
      shots: sampleProject.shots.map((shot, index) =>
        index === 0 ? { ...shot, description: "" } : shot,
      ),
    };
    const state = stageStateOf(blank, "storyboard");
    expect(state.missing.join()).toContain("动作描述");
    expect(state.waivable).toEqual([]);
    expect(state.canConfirm).toBe(false);
  });

  it("其他阶段没有可豁免缺口", () => {
    for (const key of ["story", "script", "cast", "keyframes", "voice", "edit"] as const) {
      expect(stageStateOf(sampleProject, key).waivable).toEqual([]);
    }
  });
});
