import { describe, expect, it } from "vitest";
import type { Shot } from "@loomina/ir";
import {
  INSTRUCTION_AI_MAX_CHARS,
  ShotSnapshotSchema,
  aiReplyToShotPatch,
  describeAiPatch,
  extractJson,
  instructionMessages,
  parseAiReply,
  shotSnapshotOf,
  type ShotSnapshot,
} from "./instruction-ai";

const camera = {
  angle: "eye" as const,
  movement: "static" as const,
  focalMm: 50,
  placement: { position: [0, 1.6, -2] as [number, number, number], target: [0, 1.5, 0] as [number, number, number] },
};

const snapshot: ShotSnapshot = {
  shotNo: 3,
  shotSize: "medium",
  camera,
  durationMs: 3000,
  notes: ["她笑得太早"],
};

function shotOf(patch: Partial<Shot> = {}): Shot {
  return {
    id: "s-03",
    sceneId: "sc-01",
    index: 2,
    durationMs: 3000,
    description: "林把杯子放下",
    promptNotes: ["她笑得太早", "不要笑得太早", "别笑太早", "a", "b", "c", "d", "e", "f"],
    shotSize: "medium",
    camera,
    staging: [],
    characterIds: [],
    propIds: [],
    dialogueIds: [],
    takeIds: [],
    ...patch,
  } as Shot;
}

describe("一句话的模型兜底（H19）", () => {
  it("快照只带当前镜头的公开字段，补充最多取前 8 条", () => {
    const snap = shotSnapshotOf(shotOf(), 3);
    expect(snap.shotNo).toBe(3);
    expect(snap.shotSize).toBe("medium");
    expect(snap.camera).toEqual(camera);
    expect(snap.notes).toHaveLength(8);
    expect(snap.notes[0]).toBe("她笑得太早");
  });

  it("提示里带当前镜头与作者原话，且要求只输出 JSON", () => {
    const messages = instructionMessages("再靠近一点，她手在抖", snapshot);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("只输出 JSON");
    expect(messages[1]?.content).toContain("SH-03");
    expect(messages[1]?.content).toContain("中景");
    expect(messages[1]?.content).toContain("她笑得太早");
    expect(messages[1]?.content).toContain("再靠近一点，她手在抖");
  });

  it("能从带代码块的输出里取出 JSON", () => {
    expect(extractJson('好的：\n```json\n{"patch":{"shotSize":"close"}}\n```')).toEqual({
      patch: { shotSize: "close" },
    });
    expect(extractJson('{"patch":{"durationMs":2500}}')).toEqual({
      patch: { durationMs: 2500 },
    });
    expect(extractJson("没有 JSON")).toBeUndefined();
    expect(extractJson("{坏掉的}")).toBeUndefined();
  });

  it("schema 越界、多出来的键、空补丁都当没听懂", () => {
    expect(parseAiReply('{"patch":{"shotSize":"close"}}')?.patch.shotSize).toBe("close");
    expect(parseAiReply('{"patch":{"shotSize":"gigantic"}}')).toBeNull();
    expect(parseAiReply('{"patch":{"durationMs":900}}')).toBeNull();
    expect(parseAiReply('{"patch":{"shotSize":"close","weather":"rain"}}')).toBeNull();
    expect(parseAiReply('{"patch":{}}')).toBeNull();
    expect(parseAiReply('{"reason":"只说了个理由"}')).toBeNull();
  });

  it("把补丁转成事件补丁：机位保留焦段与坐标，只换角度 / 运镜", () => {
    const reply = parseAiReply('{"patch":{"cameraAngle":"low","cameraMovement":"push"}}')!;
    const patch = aiReplyToShotPatch(reply, snapshot)!;
    expect(patch.camera).toEqual({ ...camera, angle: "low", movement: "push" });
    expect(patch.camera?.focalMm).toBe(50);
    expect(patch.camera?.placement).toEqual(camera.placement);
  });

  it("与现值相同的字段不写；全部相同时返回 null", () => {
    const same = parseAiReply('{"patch":{"shotSize":"medium","durationMs":3000}}')!;
    expect(aiReplyToShotPatch(same, snapshot)).toBeNull();

    const mixed = parseAiReply('{"patch":{"shotSize":"medium","durationMs":2500}}')!;
    expect(aiReplyToShotPatch(mixed, snapshot)).toEqual({ durationMs: 2500 });
  });

  it("已有的补充不重复追加", () => {
    const dup = parseAiReply('{"patch":{"note":"她笑得太早"}}')!;
    expect(aiReplyToShotPatch(dup, snapshot)).toBeNull();

    const fresh = parseAiReply('{"patch":{"note":"手别抖"}}')!;
    expect(aiReplyToShotPatch(fresh, snapshot)).toEqual({ note: "手别抖" });
  });

  it("给界面的一句话说明改了什么", () => {
    const text = describeAiPatch(
      { shotSize: "close", durationMs: 2500 },
      "想要更近一点",
    );
    expect(text).toContain("模型这样理解：想要更近一点");
    expect(text).toContain("景别改为特写");
    expect(text).toContain("时长改为 2.5s");
  });

  it("快照的 schema 拦下越界字段与过长的补充", () => {
    expect(ShotSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      ShotSnapshotSchema.safeParse({ ...snapshot, camera: { ...camera, angle: "sideways" } })
        .success,
    ).toBe(false);
    expect(
      ShotSnapshotSchema.safeParse({ ...snapshot, notes: Array(13).fill("x") }).success,
    ).toBe(false);
  });

  it("一句话最多 200 字：路由与界面用同一个上限", () => {
    expect(INSTRUCTION_AI_MAX_CHARS).toBe(200);
  });
});
