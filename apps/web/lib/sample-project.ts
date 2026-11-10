import { ProjectSchema, type ProjectInput } from "@loomina/ir";

/**
 * 示例项目「夜班」：一份符合 Project IR 的最小项目，
 * 用来把前端三带撑满。解析一次，schema 不合法在构建时就炸。
 *
 * 换成真实数据时，只有这个文件被替换——读模型与组件不动。
 */
const raw: ProjectInput = {
  id: "demo-night-shift",
  title: "夜班",
  version: 3,

  locations: [
    { id: "loc-corridor", name: "走廊", templateId: "corridor" },
    { id: "loc-door", name: "门口", templateId: "doorway" },
    { id: "loc-table", name: "桌边", templateId: "table" },
  ],

  characters: [
    { id: "c-lin", name: "林", appearance: "短发，深色外套", voiceProfileId: "voice-lin" },
    { id: "c-zhou", name: "周", appearance: "高个，衬衫袖口卷起", voiceProfileId: "voice-zhou" },
  ],

  scenes: [
    { id: "sc-1", index: 0, locationId: "loc-corridor", shotIds: ["s-01", "s-02", "s-03"] },
    { id: "sc-2", index: 1, locationId: "loc-table", shotIds: ["s-04", "s-05"] },
    { id: "sc-3", index: 2, locationId: "loc-corridor", shotIds: ["s-06"] },
    { id: "sc-4", index: 3, locationId: "loc-door", shotIds: ["s-07", "s-08"] },
    { id: "sc-5", index: 4, locationId: "loc-table", shotIds: ["s-09", "s-10", "s-11", "s-12"] },
  ],

  dialogue: [
    { id: "d-01", characterId: "c-zhou", text: "你早就知道，对吧。", durationMs: 2600 },
    { id: "d-02", characterId: "c-lin", text: "知道了又怎样。", durationMs: 2100 },
    { id: "d-03", characterId: "c-zhou", text: "灯是我关的。", durationMs: 1800 },
    { id: "d-04", characterId: "c-lin", text: "那就当没看见。", durationMs: 2300 },
  ],

  shots: [
    {
      id: "s-01", sceneId: "sc-1", index: 0, durationMs: 3100,
      description: "走廊尽头，灯管闪了一下",
      shotSize: "wide", camera: { angle: "eye", movement: "static", focalMm: 24 },
      characterIds: [], dialogueIds: ["d-01"], takeIds: ["t-01"], locked: false,
    },
    {
      id: "s-02", sceneId: "sc-1", index: 1, durationMs: 2400,
      description: "走廊尽头，门缝里透出一条光",
      shotSize: "medium", camera: { angle: "eye", movement: "push", focalMm: 35 },
      characterIds: ["c-lin"], dialogueIds: [], takeIds: ["t-02"], locked: false,
    },
    {
      id: "s-03", sceneId: "sc-1", index: 2, durationMs: 2400,
      description: "她站在门口，没有进来",
      shotSize: "close", camera: { angle: "eye", movement: "static", focalMm: 50 },
      characterIds: ["c-lin"], dialogueIds: ["d-02"], takeIds: ["t-03"], locked: false,
    },
    {
      id: "s-04", sceneId: "sc-2", index: 0, durationMs: 3800,
      description: "两个人隔着桌子，谁也没动",
      shotSize: "medium", camera: { angle: "eye", movement: "static", focalMm: 40 },
      characterIds: ["c-lin", "c-zhou"], dialogueIds: ["d-03"], takeIds: ["t-04"], locked: false,
    },
    {
      id: "s-05", sceneId: "sc-2", index: 1, durationMs: 1900,
      description: "他伸手关掉了台灯",
      shotSize: "close", camera: { angle: "low", movement: "static", focalMm: 50 },
      characterIds: ["c-zhou"], dialogueIds: [], takeIds: ["t-05"], locked: false,
    },
    {
      id: "s-06", sceneId: "sc-3", index: 2, durationMs: 4200,
      description: "走廊空了，灯还亮着",
      shotSize: "wide", camera: { angle: "eye", movement: "pan", focalMm: 24 },
      characterIds: [], dialogueIds: [], takeIds: ["t-06"], locked: false,
    },
    {
      id: "s-07", sceneId: "sc-4", index: 0, durationMs: 2000,
      description: "门被从外面带上",
      shotSize: "close", camera: { angle: "eye", movement: "static", focalMm: 50 },
      characterIds: ["c-zhou"], dialogueIds: [], takeIds: ["t-07"], locked: false,
    },
    {
      id: "s-08", sceneId: "sc-4", index: 1, durationMs: 2600,
      description: "她终于抬头",
      shotSize: "close", camera: { angle: "eye", movement: "static", focalMm: 85 },
      characterIds: ["c-lin"], dialogueIds: ["d-04"], takeIds: ["t-08"], locked: true,
    },
    {
      id: "s-09", sceneId: "sc-5", index: 0, durationMs: 3000,
      description: "杯子还在原来的位置",
      shotSize: "medium", camera: { angle: "high", movement: "static", focalMm: 35 },
      characterIds: [], dialogueIds: [], takeIds: ["t-09"], locked: false,
    },
    {
      id: "s-10", sceneId: "sc-5", index: 1, durationMs: 1600,
      description: "灯管灭了",
      shotSize: "wide", camera: { angle: "eye", movement: "static", focalMm: 24 },
      characterIds: [], dialogueIds: [], takeIds: ["t-10"], locked: false,
    },
    {
      id: "s-11", sceneId: "sc-5", index: 2, durationMs: 2200,
      description: "锁扣轻轻响了一声",
      shotSize: "close", camera: { angle: "eye", movement: "static", focalMm: 50 },
      characterIds: ["c-lin"], dialogueIds: [], takeIds: ["t-11"], locked: false,
    },
    {
      id: "s-12", sceneId: "sc-5", index: 3, durationMs: 3400,
      description: "两个人影重叠在一起",
      shotSize: "medium", camera: { angle: "low", movement: "static", focalMm: 40 },
      characterIds: ["c-lin", "c-zhou"], dialogueIds: [], takeIds: ["t-12"], locked: false,
    },
  ],

  takes: [
    { id: "t-01", shotId: "s-01", assetId: "a-01", status: "rejected", costCny: 1.58, provenance: { modelId: "minimax-h3", createdAt: "2026-11-09T21:02:00+08:00" } },
    { id: "t-02", shotId: "s-02", assetId: "a-02", status: "approved", costCny: 2.12, provenance: { modelId: "minimax-h3", createdAt: "2026-11-09T21:06:00+08:00" } },
    { id: "t-03", shotId: "s-03", assetId: "a-03", status: "draft", costCny: 2.12, provenance: { modelId: "minimax-h3", createdAt: "2026-11-09T21:11:00+08:00" } },
    { id: "t-04", shotId: "s-04", assetId: "a-04", status: "draft", costCny: 3.10, provenance: { modelId: "minimax-h3", createdAt: "2026-11-09T21:18:00+08:00" } },
    { id: "t-05", shotId: "s-05", assetId: "a-05", status: "approved", costCny: 1.90, provenance: { modelId: "minimax-h3", createdAt: "2026-11-09T21:24:00+08:00" } },
    { id: "t-06", shotId: "s-06", assetId: "a-06", status: "draft", costCny: 1.02, provenance: { modelId: "minimax-h3", createdAt: "2026-11-09T21:31:00+08:00" } },
    { id: "t-07", shotId: "s-07", assetId: "a-07", status: "draft", costCny: 1.64, provenance: { modelId: "minimax-h3", createdAt: "2026-11-09T21:36:00+08:00" } },
    { id: "t-08", shotId: "s-08", assetId: "a-08", status: "approved", costCny: 0.86, provenance: { modelId: "minimax-h3", createdAt: "2026-11-09T21:41:00+08:00" } },
    { id: "t-09", shotId: "s-09", assetId: "a-09", status: "draft", costCny: 1.24, provenance: { modelId: "minimax-h3", createdAt: "2026-11-09T21:48:00+08:00" } },
    { id: "t-10", shotId: "s-10", assetId: "a-10", status: "rejected", costCny: 1.20, provenance: { modelId: "minimax-h3", createdAt: "2026-11-09T21:52:00+08:00" } },
    { id: "t-11", shotId: "s-11", assetId: "a-11", status: "draft", costCny: 0.98, provenance: { modelId: "minimax-h3", createdAt: "2026-11-09T21:57:00+08:00" } },
    { id: "t-12", shotId: "s-12", assetId: "a-12", status: "draft", costCny: 1.20, provenance: { modelId: "minimax-h3", createdAt: "2026-11-09T22:01:00+08:00" } },
  ],

  timeline: {
    items: [
      { id: "tl-01", shotId: "s-01", takeId: "t-01", startMs: 0, durationMs: 3100 },
      { id: "tl-02", shotId: "s-02", takeId: "t-02", startMs: 3100, durationMs: 2400 },
    ],
  },

  publishPackages: [],
};

export const sampleProject = ProjectSchema.parse(raw);
