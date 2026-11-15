import { describe, expect, it } from "vitest";
import {
  doctorMessages,
  doctorSnapshotOf,
  parseDoctorReply,
  type DoctorSnapshot,
} from "./doctor-ai";
import { toScriptView } from "./read-model";
import { sampleProject } from "./sample-project";
import { analyzeScript } from "./script-doctor";

const snapshotOf = (mode: "strengthenHook" | "trimExposition" = "strengthenHook") => {
  const report = analyzeScript(sampleProject);
  return doctorSnapshotOf(sampleProject, toScriptView(sampleProject), report, mode);
};

describe("剧本医生模型快照（A18）", () => {
  it("把场、镜与台词压成快照，id 都给到模型", () => {
    const snapshot = snapshotOf();
    const all = snapshot.scenes.flatMap((scene) => scene.shots);
    expect(all.length).toBe(sampleProject.shots.length);
    expect(all[0]?.id).toBe(sampleProject.shots[0]?.id);
    const lineIds = all.flatMap((shot) => shot.dialogue.map((line) => line.id));
    expect(lineIds).toContain("d-01");
    // 本地报告的相关提示也带上，作为起点
    expect(snapshot.notes.length).toBeGreaterThan(0);
  });

  it("动作与台词的超长文本被截断，不把整篇塞给模型", () => {
    const long = "灯".repeat(600);
    const project = {
      ...sampleProject,
      shots: sampleProject.shots.map((shot, index) =>
        index === 0 ? { ...shot, description: long } : shot,
      ),
    };
    const snapshot = doctorSnapshotOf(
      project,
      toScriptView(project),
      analyzeScript(project),
      "strengthenHook",
    );
    const first = snapshot.scenes[0]?.shots[0];
    expect(first?.description.length).toBeLessThanOrEqual(400);
    expect(first?.description.endsWith("…")).toBe(true);
  });

  it("技能（C18）：剧本阶段的技能进系统提示词", () => {
    const messages = doctorMessages(snapshotOf("trimExposition"), [
      {
        id: "sk-1",
        name: "对白要短",
        description: "",
        stage: "script",
        body: "每句台词不超过 10 个字。",
        enabled: true,
        createdAt: "2026-11-15T00:00:00Z",
      },
    ]);
    expect(messages[0]!.content).toContain("每句台词不超过 10 个字");
  });

  it("提示词里写明模式、可用 id 与字数上限", () => {
    const messages = doctorMessages(snapshotOf("trimExposition"));
    const system = messages[0]!.content;
    expect(system).toContain("trimExposition");
    expect(system).toContain("最多 3 条");
    const user = messages[1]!.content;
    expect(user).toContain("d-01");
    expect(user).toContain("SH-01");
  });
});

describe("解析模型改写（A18）", () => {
  const snapshot = snapshotOf();

  it("合法的三条按类型拆好，并写出去处", () => {
    const parsed = parseDoctorReply(
      JSON.stringify({
        reason: "把开场改成她先开口",
        items: [
          { kind: "dialogue", lineId: "d-01", text: "你早就知道，对吧。", why: "保留原句" },
          { kind: "shot", shotId: "s-01", text: "周把灯关掉，回头。", why: "动作更早" },
          { kind: "story", field: "logline", text: "夜班保安发现秘密。", why: "更直" },
        ],
      }),
      snapshot,
    );
    expect(parsed?.items).toHaveLength(3);
    expect(parsed?.items[0]).toMatchObject({ kind: "dialogue", target: "SH-01 · 周" });
    expect(parsed?.items[1]).toMatchObject({ kind: "shot", target: "SH-01 · 动作" });
    expect(parsed?.items[2]).toMatchObject({ kind: "story", target: "一句话梗概" });
  });

  it("引用不存在的 id 被丢掉；一条不剩就当没读出", () => {
    const partial = parseDoctorReply(
      JSON.stringify({
        items: [
          { kind: "dialogue", lineId: "d-999", text: "不存在的台词" },
          { kind: "shot", shotId: "s-999", text: "不存在的动作" },
          { kind: "story", field: "tone", text: "冷" },
        ],
      }),
      snapshot,
    );
    expect(partial?.items).toHaveLength(1);
    expect(partial?.items[0]).toMatchObject({ kind: "story", field: "tone" });

    const none = parseDoctorReply(
      JSON.stringify({ items: [{ kind: "dialogue", lineId: "d-999", text: "无" }] }),
      snapshot,
    );
    expect(none).toBeNull();
  });

  it("字段越界 / 多出来的键 / 空数组都按「没读懂」", () => {
    expect(parseDoctorReply("不是 JSON", snapshot)).toBeNull();
    expect(
      parseDoctorReply(
        JSON.stringify({
          items: [{ kind: "dialogue", lineId: "d-01", text: "短", extra: 1 }],
        }),
        snapshot,
      ),
    ).toBeNull();
    expect(
      parseDoctorReply(
        JSON.stringify({ items: [{ kind: "story", field: "title", text: "标题" }] }),
        snapshot,
      ),
    ).toBeNull();
    expect(parseDoctorReply(JSON.stringify({ items: [] }), snapshot)).toBeNull();
  });

  it("台词超长被拒，不截断后偷偷写进去", () => {
    const long = "灯".repeat(200);
    expect(
      parseDoctorReply(
        JSON.stringify({ items: [{ kind: "dialogue", lineId: "d-01", text: long }] }),
        snapshot,
      ),
    ).toBeNull();
  });

  it("接受带 ```json 围栏的输出", () => {
    const parsed = parseDoctorReply(
      [
        "```json",
        JSON.stringify({ items: [{ kind: "shot", shotId: "s-01", text: "他关灯。" }] }),
        "```",
      ].join("\n"),
      snapshot,
    );
    expect(parsed?.items[0]).toMatchObject({ kind: "shot", shotId: "s-01" });
  });

  it("快照的默认字段可以省：解析时补空", () => {
    const minimal: DoctorSnapshot = {
      mode: "strengthenHook",
      title: "",
      story: { logline: "", synopsis: "", genre: "", audience: "", tone: "" },
      scenes: [],
      notes: [],
    };
    expect(parseDoctorReply(JSON.stringify({ items: [] }), minimal)).toBeNull();
  });
});
