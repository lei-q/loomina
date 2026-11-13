import { describe, expect, it } from "vitest";
import { ProjectSchema, applyEvent, rebuild, type Project, type ProjectEvent } from "@loomina/ir";
import {
  MUSIC_STATE_OF_BEAT,
  analyzeMusicCurve,
  motifTargetLabel,
  motifUsage,
  planMusicFill,
} from "./music-curve";

const AT = "2026-11-12T10:00:00+08:00";

/** 自动初剪后的时间线：每一镜各占一段，与分镜的拍对齐 */
function timelineOf(shots: { id: string; durationMs: number }[]) {
  let at = 0;
  return shots.map((shot, index) => {
    const item = {
      id: `tl-${index + 1}`,
      shotId: shot.id,
      takeId: "t-1",
      startMs: at,
      durationMs: shot.durationMs,
    };
    at += shot.durationMs;
    return item;
  });
}

function makeProject(): Project {
  const shots = [0, 1, 2, 3].map((index) => ({
    id: `s-${index + 1}`,
    sceneId: "sc-1",
    index,
    durationMs: 4000,
    description: `第 ${index + 1} 镜`,
    shotSize: "medium" as const,
    camera: { angle: "eye" as const, movement: "static" as const, focalMm: 35 },
    characterIds: ["c-a"],
    dialogueIds: [],
    beat: (["hook", "setup", "turn", "endHook"] as const)[index]!,
  }));
  return ProjectSchema.parse({
    id: "p-music",
    title: "音乐曲线测试",
    version: 0,
    story: {
      relationships: [{ fromCharacterId: "c-a", toCharacterId: "c-b", tension: "谁先开口" }],
    },
    locations: [{ id: "loc-1", name: "走廊" }],
    characters: [
      { id: "c-a", name: "林" },
      { id: "c-b", name: "周" },
    ],
    scenes: [{ id: "sc-1", index: 0, locationId: "loc-1", shotIds: shots.map((shot) => shot.id) }],
    shots,
    timeline: {
      items: timelineOf(shots),
      music: [],
    },
    takes: [
      {
        id: "t-1",
        shotId: "s-1",
        assetId: "a-video",
        status: "draft",
        costCny: 0,
        provenance: { modelId: "m", createdAt: AT },
      },
    ],
    assets: [
      {
        id: "a-music",
        kind: "audio",
        source: "upload",
        uri: "data:audio/mpeg;base64,AAAA",
        mime: "audio/mpeg",
        durationMs: 8000,
        createdAt: AT,
      },
    ],
  });
}

function withCue(project: Project, patch: Record<string, unknown> = {}): Project {
  return applyEvent(project, {
    type: "timeline.music.updated",
    at: AT,
    music: [
      {
        id: "mc-1",
        assetId: "a-music",
        title: "夜班主题",
        mood: "克制",
        startMs: 0,
        durationMs: 16_000,
        gainDb: -18,
        duckDb: 15,
        ducking: true,
        loop: true,
        role: "bed",
        licenseRef: "自己录制",
        ...patch,
      } as never,
    ],
  });
}

describe("音乐情绪曲线（C10 / ADR-0125）", () => {
  it("每一拍按 SOUND.md 的表格给一个建议状态", () => {
    const curve = analyzeMusicCurve(makeProject());
    expect(curve.beats).toBe(4);
    expect(curve.lines.map((line) => line.state)).toEqual([
      MUSIC_STATE_OF_BEAT.hook,
      MUSIC_STATE_OF_BEAT.setup,
      MUSIC_STATE_OF_BEAT.turn,
      MUSIC_STATE_OF_BEAT.endHook,
    ]);
    expect(MUSIC_STATE_OF_BEAT.hook).toBe("enter");
    expect(MUSIC_STATE_OF_BEAT.endHook).toBe("unresolved");
  });

  it("没有配乐时覆盖率 0%，留白等于全片", () => {
    const curve = analyzeMusicCurve(makeProject());
    expect(curve.covered).toBe(0);
    expect(curve.coveragePct).toBe(0);
    expect(curve.silenceMs).toBe(curve.totalMs);
    expect(curve.lines.every((line) => line.silent)).toBe(true);
  });

  it("一条铺满的 cue 覆盖全部拍", () => {
    const curve = analyzeMusicCurve(withCue(makeProject()));
    expect(curve.covered).toBe(curve.beats);
    expect(curve.coveragePct).toBe(100);
    expect(curve.silenceMs).toBe(0);
  });

  it("只盖到前半段时，后半段算留白", () => {
    const curve = analyzeMusicCurve(withCue(makeProject(), { durationMs: 8000 }));
    expect(curve.covered).toBe(2);
    expect(curve.silenceMs).toBe(8000);
    expect(curve.lines.filter((line) => line.silent).map((line) => line.shotNos[0])).toEqual([
      3, 4,
    ]);
  });

  it("cue 起点没落在拍边界上时被点名，但不拦", () => {
    const curve = analyzeMusicCurve(withCue(makeProject(), { startMs: 1500, durationMs: 4000 }));
    expect(curve.misaligned).toHaveLength(1);
    expect(curve.misaligned[0]).toMatchObject({ cueId: "mc-1", startMs: 1500, nearestBeatMs: 0 });
  });

  it("按曲线铺：只补没有覆盖的拍，连续同状态合并", () => {
    const project = withCue(makeProject(), { durationMs: 4000 });
    const plan = planMusicFill(project, project.timeline.music[0]!);
    // 剩下 setup / turn / endHook 三拍，状态都不同，所以三条
    expect(plan.cues.map((cue) => [cue.startMs, cue.durationMs])).toEqual([
      [4000, 4000],
      [8000, 4000],
      [12_000, 4000],
    ]);
    // 转折与尾钩那一段是 hit，其余是 bed
    expect(plan.cues[1]!.role).toBe("hit");
    expect(plan.overflow).toBe(false);
  });

  it("连续且状态相同的留白拍合成一条 cue", () => {
    const project = ProjectSchema.parse({
      ...makeProject(),
      shots: [0, 1, 2].map((index) => ({
        id: `s-${index + 1}`,
        sceneId: "sc-1",
        index,
        durationMs: 4000,
        description: `第 ${index + 1} 镜`,
        shotSize: "medium",
        camera: { angle: "eye", movement: "static", focalMm: 35 },
        characterIds: [],
        dialogueIds: [],
        beat: "setup",
      })),
      scenes: [{ id: "sc-1", index: 0, locationId: "loc-1", shotIds: ["s-1", "s-2", "s-3"] }],
    });
    // 同一场里同 beat 的镜头本来就归到一拍：这里只有一拍
    const plan = planMusicFill(project, {
      assetId: "a-music",
      title: "床",
      mood: "",
      licenseRef: "自己录制",
      gainDb: -18,
      duckDb: 15,
      ducking: true,
      loop: true,
    });
    expect(plan.cues).toHaveLength(1);
    expect(plan.cues[0]!.durationMs).toBe(12_000);
  });

  it("铺到成片之外会被事件拒：按曲线铺先按成片长度裁掉", () => {
    // 分镜有 4 拍共 16 秒，时间线只排了第一镜（4 秒）
    const base = makeProject();
    const project = withCue(
      {
        ...base,
        timeline: { ...base.timeline, items: base.timeline.items.slice(0, 1), music: [] },
      },
      { durationMs: 4000 },
    );
    const plan = planMusicFill(project, project.timeline.music[0]!);
    expect(plan.cues).toHaveLength(0);
    // 时间线拉到 8 秒：只补落在成片里的那一拍
    const longer = {
      ...project,
      timeline: {
        ...project.timeline,
        items: [
          ...project.timeline.items,
          { id: "tl-2", shotId: "s-2", takeId: "t-1", startMs: 4000, durationMs: 4000 },
        ],
      },
    };
    const clipped = planMusicFill(longer, longer.timeline.music[0]!);
    expect(clipped.cues.map((cue) => [cue.startMs, cue.durationMs])).toEqual([[4000, 4000]]);
  });

  it("超过渲染清单 4 条上限时如实报出来", () => {
    const shots = Array.from({ length: 7 }, (_, index) => ({
      id: `s-${index + 1}`,
      sceneId: `sc-${index + 1}`,
      index,
      durationMs: 3000,
      description: `第 ${index + 1} 镜`,
      shotSize: "medium" as const,
      camera: { angle: "eye" as const, movement: "static" as const, focalMm: 35 },
      characterIds: [],
      dialogueIds: [],
      beat: (["hook", "setup", "escalation", "turn", "climax", "resolution", "endHook"] as const)[
        index
      ]!,
    }));
    const project = ProjectSchema.parse({
      ...makeProject(),
      shots,
      scenes: shots.map((shot) => ({
        id: shot.sceneId,
        index: shots.indexOf(shot),
        locationId: "loc-1",
        shotIds: [shot.id],
      })),
      timeline: { items: timelineOf(shots), music: [] },
    });
    const plan = planMusicFill(project, {
      assetId: "a-music",
      title: "床",
      mood: "",
      licenseRef: "自己录制",
      gainDb: -18,
      duckDb: 15,
      ducking: true,
      loop: true,
    });
    expect(plan.overflow).toBe(true);
    expect(plan.cues).toHaveLength(4);
    expect(plan.skipped).toBe(3);
  });

  it("动机：用量按 cue 数与时长的合计，目标名从角色 / 关系里读", () => {
    const project = applyEvent(withCue(makeProject()), {
      type: "motif.updated",
      at: AT,
      motif: {
        id: "m-lin",
        label: "林晚的灯",
        targetKind: "character",
        targetId: "c-a",
        assetId: "a-music",
        licenseRef: "自己录制",
        note: "",
      },
    });
    const motif = project.motifs[0]!;
    expect(motifTargetLabel(project, motif)).toBe("林");
    const linked = applyEvent(project, {
      type: "timeline.music.updated",
      at: AT,
      music: project.timeline.music.map((cue) => ({ ...cue, motifId: "m-lin" })),
    });
    expect(motifUsage(linked, "m-lin")).toEqual({ cues: 1, durationMs: 16_000 });
    const curve = analyzeMusicCurve(linked);
    expect(curve.lines[0]!.cues[0]!.motifLabel).toBe("林晚的灯");
  });

  it("纯函数：同一份项目两次结果一致", () => {
    const project = withCue(makeProject());
    expect(JSON.stringify(analyzeMusicCurve(project))).toBe(
      JSON.stringify(analyzeMusicCurve(project)),
    );
  });
});

describe("动机事件（C10 / ADR-0125）", () => {
  const motif = {
    id: "m-lin",
    label: "林晚的灯",
    targetKind: "character" as const,
    targetId: "c-a",
    assetId: "a-music",
    licenseRef: "自己录制",
    note: "",
  };

  it("motif.updated 按 id 幂等替换", () => {
    const first = applyEvent(makeProject(), { type: "motif.updated", at: AT, motif });
    expect(first.motifs).toHaveLength(1);
    const second = applyEvent(first, {
      type: "motif.updated",
      at: AT,
      motif: { ...motif, label: "林晚的灯（改）" },
    });
    expect(second.motifs).toHaveLength(1);
    expect(second.motifs[0]!.label).toBe("林晚的灯（改）");
  });

  it("同一个目标只能有一个动机", () => {
    const project = applyEvent(makeProject(), { type: "motif.updated", at: AT, motif });
    expect(() =>
      applyEvent(project, {
        type: "motif.updated",
        at: AT,
        motif: { ...motif, id: "m-2", label: "另一个" },
      }),
    ).toThrow(/同一个目标只能有一个动机/);
  });

  it("动机必须挂音频资产、写授权、目标真实存在", () => {
    const project = makeProject();
    expect(() =>
      applyEvent(project, {
        type: "motif.updated",
        at: AT,
        motif: { ...motif, assetId: "a-video" },
      }),
    ).toThrow(/音频资产/);
    expect(() =>
      applyEvent(project, {
        type: "motif.updated",
        at: AT,
        motif: { ...motif, licenseRef: "  " },
      }),
    ).toThrow(/授权/);
    expect(() =>
      applyEvent(project, {
        type: "motif.updated",
        at: AT,
        motif: { ...motif, targetId: "c-nope" },
      }),
    ).toThrow(/不存在的角色/);
  });

  it("关系动机用 from->to 编码，两端必须写在 story.relationships 里", () => {
    const project = makeProject();
    const ok = applyEvent(project, {
      type: "motif.updated",
      at: AT,
      motif: { ...motif, targetKind: "relationship", targetId: "c-a->c-b" },
    });
    expect(ok.motifs).toHaveLength(1);
    expect(motifTargetLabel(ok, ok.motifs[0]!)).toBe("林 ↔ 周");
    expect(() =>
      applyEvent(project, {
        type: "motif.updated",
        at: AT,
        motif: { ...motif, targetKind: "relationship", targetId: "c-b->c-a" },
      }),
    ).toThrow(/不存在的关系/);
  });

  it("motif.removed 清掉 cue 的 motifId，但保留 cue", () => {
    const project = applyEvent(withCue(makeProject()), { type: "motif.updated", at: AT, motif });
    const linked = applyEvent(project, {
      type: "timeline.music.updated",
      at: AT,
      music: project.timeline.music.map((cue) => ({ ...cue, motifId: "m-lin" })),
    });
    const removed = applyEvent(linked, { type: "motif.removed", at: AT, motifId: "m-lin" });
    expect(removed.motifs).toHaveLength(0);
    expect(removed.timeline.music).toHaveLength(1);
    expect(removed.timeline.music[0]!.motifId).toBeUndefined();
    expect("motifId" in removed.timeline.music[0]!).toBe(false);
  });

  it("cue 不能指向不存在的动机", () => {
    expect(() =>
      applyEvent(makeProject(), {
        type: "timeline.music.updated",
        at: AT,
        music: [
          {
            id: "mc-1",
            assetId: "a-music",
            title: "床",
            mood: "",
            startMs: 0,
            durationMs: 4000,
            gainDb: -18,
            duckDb: 15,
            ducking: true,
            loop: true,
            role: "bed",
            motifId: "m-nope",
            licenseRef: "自己录制",
          },
        ],
      }),
    ).toThrow(/不存在的动机/);
  });

  it("删角色时，指向含这个人关系动机一起清掉，角色动机保留", () => {
    let project = makeProject();
    project = applyEvent(project, {
      type: "motif.updated",
      at: AT,
      motif: { ...motif, targetKind: "relationship", targetId: "c-a->c-b", label: "他们俩" },
    });
    project = applyEvent(project, {
      type: "motif.updated",
      at: AT,
      motif: { ...motif, id: "m-loc", targetKind: "location", targetId: "loc-1", label: "走廊" },
    });
    // 删 c-a 前先把出场与台词清掉：这里只有 s-* 点着 c-a
    for (const shot of project.shots) {
      project = applyEvent(project, {
        type: "shot.updated",
        at: AT,
        shotId: shot.id,
        patch: { characterIds: [] },
      });
    }
    const removed = applyEvent(project, { type: "character.removed", at: AT, characterId: "c-a" });
    expect(removed.motifs.map((item) => item.label)).toEqual(["走廊"]);
  });

  it("关系被删掉时，指向它的动机一起清掉", () => {
    let project = applyEvent(makeProject(), {
      type: "motif.updated",
      at: AT,
      motif: { ...motif, targetKind: "relationship", targetId: "c-a->c-b", label: "他们俩" },
    });
    project = applyEvent(project, {
      type: "story.updated",
      at: AT,
      patch: { relationships: [] },
    });
    expect(project.motifs).toHaveLength(0);
  });

  it("旧日志没有 role / motifs 也能回放", () => {
    const events: ProjectEvent[] = [
      { type: "project.created", at: AT, project: makeProject() },
      {
        type: "timeline.music.updated",
        at: AT,
        music: [
          {
            id: "mc-old",
            assetId: "a-music",
            title: "旧配乐",
            mood: "",
            startMs: 0,
            durationMs: 4000,
            gainDb: -18,
            duckDb: 15,
            ducking: true,
            loop: true,
            role: "bed",
            licenseRef: "自己录制",
          },
        ],
      },
    ];
    const project = rebuild(events);
    expect(project.timeline.music[0]!.role).toBe("bed");
    expect(project.motifs).toEqual([]);
  });
});
