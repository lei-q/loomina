"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BEAT_SHEETS,
  beatSheetById,
  beatWindows,
  formatSeconds,
  GENRE_MATRIX,
  genreById,
  importStoryMessages,
  storyMessages,
  genreReadiness,
  SHOT_ANGLE_CN,
  SHOT_MIN_MS,
  SHOT_PADDING_MS,
  SHOT_SIZE_CN,
  SOURCE_MAX_CHARS,
  type StoryDraft,
} from "@loomina/pipeline";
import { TopBar } from "@/components/top-bar";
import { StageGate } from "@/components/stage-gate";
import { ModelPicker } from "@/components/model-picker";
import { PromptEditor } from "@/components/prompt-editor";
import { LoglineScoreCard, LoglineWorkshop } from "@/components/logline-score";
import { StoryBiblePanel } from "@/components/story-bible-panel";
import { estimateDialogueMs } from "@/lib/dialogue";
import { useModelCatalog, useModelChoice } from "@/lib/model-choice";
import { useWorkbench } from "@/lib/workbench-store";

const DEFAULT_GENRE = "逆袭打脸";

const IDEAS = [
  "外卖员每天给顶层公寓送餐，直到董事长当众喊他「少主」。",
  "离婚当天，她捡到了前夫失忆的弟弟。",
  "新来的保洁阿姨，一眼看出豪门太太的玉镯是假的。",
] as const;

const MOVE_CN: Record<StoryDraft["scenes"][number]["shots"][number]["movement"], string> = {
  static: "固定",
  push: "推近",
  pull: "拉远",
  pan: "摇镜",
  tilt: "俯仰",
  handheld: "手持",
};

const TIME_CN: Record<StoryDraft["scenes"][number]["timeOfDay"], string> = {
  day: "日",
  night: "夜",
  dawn: "晨",
  dusk: "昏",
};

const SPACE_CN: Record<StoryDraft["scenes"][number]["space"], string> = {
  int: "内景",
  ext: "外景",
};

/** 「12.4k token」：用量是供应商给的事实，金额要作者填了单价才算得出来（H4） */
function storyTokensOf(usage: { promptTokens?: number; completionTokens?: number }): string {
  const units = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
  return units >= 1000 ? `${(units / 1000).toFixed(1)}k token` : `${units} token`;
}

type StoryOrigin = "idea" | "import";
type StoryResult = {
  draft: StoryDraft;
  model: string;
  origin: StoryOrigin;
  /** 这一次生成花的钱与用量（H4）；没填文本单价或供应商没报 token 时缺省 */
  cny?: number;
  usage?: { promptTokens?: number; completionTokens?: number };
};

const MODES: { key: StoryOrigin; label: string; note: string }[] = [
  {
    key: "idea",
    label: "从想法开始",
    note: "写一句想法或一段大纲，模型把它长成一条 60–90 秒的短剧。",
  },
  {
    key: "import",
    label: "导入剧本 txt",
    note: "选一个 txt 或粘贴原文，模型把它改成一条 60–90 秒单集。会保留人物关系、核心冲突与结局，允许合并次要人物与场次；不是逐字导入。",
  },
];

export function StoryScreen() {
  const router = useRouter();
  const project = useWorkbench((state) => state.project);
  const hydrate = useWorkbench((state) => state.hydrate);
  const storageError = useWorkbench((state) => state.storageError);
  const readOnly = useWorkbench((state) => state.readOnly);
  const startProjectFromStory = useWorkbench((state) => state.startProjectFromStory);
  const setBudget = useWorkbench((state) => state.setBudget);
  const promptOverrides = useWorkbench((state) => state.promptOverrides);
  const setPromptOverride = useWorkbench((state) => state.setPromptOverride);

  const [info, setInfo] = useState<{ model?: string }>({});
  const [textModelId] = useModelChoice("text");
  const catalog = useModelCatalog();
  const activeModel =
    catalog?.catalog.text.find((option) => option.id === textModelId)?.model ?? info.model;
  const [infoError, setInfoError] = useState<string>();
  const [mode, setMode] = useState<StoryOrigin>("idea");
  const [idea, setIdea] = useState("");
  const [source, setSource] = useState("");
  const [fileName, setFileName] = useState<string>();
  const [rights, setRights] = useState(false);
  const [reading, setReading] = useState(false);
  const [genre, setGenre] = useState<string>(DEFAULT_GENRE);
  const [beatSheetId, setBeatSheetId] = useState<string>("60s");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<StoryResult>();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void hydrate();
    void (async () => {
      try {
        const response = await fetch("/api/story");
        const payload = (await response.json()) as { model?: string; error?: string };
        if (!response.ok) throw new Error(payload.error || "读不到文本模型配置");
        setInfo(payload);
      } catch (caught) {
        setInfoError(caught instanceof Error ? caught.message : "读不到文本模型配置");
      }
    })();
  }, [hydrate]);

  const inputReady =
    mode === "idea"
      ? idea.trim().length > 0
      : source.trim().length > 0 && source.length <= SOURCE_MAX_CHARS && rights;
  const canGenerate = Boolean(info.model) && inputReady && !busy && !reading;

  const stats = useMemo(() => {
    if (!result) return undefined;
    const draft = result.draft;
    const shots = draft.scenes.flatMap((scene) => scene.shots);
    const lines = shots.flatMap((shot) => shot.dialogue);
    const durationMs = shots.reduce((sum, shot) => {
      const dialogueMs = shot.dialogue.reduce(
        (total, line) => total + estimateDialogueMs(line.text),
        0,
      );
      return (
        sum +
        (shot.dialogue.length > 0 ? dialogueMs + SHOT_PADDING_MS : SHOT_MIN_MS)
      );
    }, 0);
    return {
      characters: draft.characters.length,
      locations: draft.locations.length,
      scenes: draft.scenes.length,
      shots: shots.length,
      lines: lines.length,
      seconds: Math.round(durationMs / 100) / 10,
    };
  }, [result]);

  const genreProfile = genreById(genre);
  const readiness = genreProfile ? genreReadiness(genreProfile) : undefined;
  const beatSheet = beatSheetById(beatSheetId) ?? BEAT_SHEETS[0]!;
  const beatOverlay = beatWindows(beatSheet, stats ? stats.seconds * 1000 : undefined);

  // 这一页真正会发出去的两条消息（ADR-0148）：默认按当前输入拼出来，改了就用改的
  const promptMessages = useMemo(() => {
    const built =
      mode === "import"
        ? importStoryMessages(source, genre, beatSheet)
        : storyMessages(idea, genre, beatSheet);
    return {
      system: built.find((message) => message.role === "system")?.content ?? "",
      user: built.find((message) => message.role === "user")?.content ?? "",
    };
  }, [mode, source, idea, genre, beatSheet]);

  function switchMode(next: StoryOrigin) {
    if (next === mode) return;
    setMode(next);
    setError(undefined);
    setResult(undefined);
    setConfirming(false);
  }

  async function readFile(file: File) {
    setError(undefined);
    setReading(true);
    try {
      const isText =
        file.type === "text/plain" || /\.txt$/i.test(file.name);
      if (!isText) throw new Error("只收 .txt 纯文本。");
      if (file.size > 2 * 1024 * 1024) {
        throw new Error("文件超过 2 MB，先截取一段再导入。");
      }
      const buffer = await file.arrayBuffer();
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        // 国内 txt 常见 GBK / GB18030，UTF-8 解不出时再试一次
        text = new TextDecoder("gb18030").decode(buffer);
      }
      setSource(text.replace(/^﻿/, ""));
      setFileName(file.name);
      setResult(undefined);
      setConfirming(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读不了这个文件");
    } finally {
      setReading(false);
    }
  }

  async function generate() {
    if (!canGenerate) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    setConfirming(false);
    try {
      const system = promptOverrides["story:system"]?.trim();
      const user = promptOverrides["story:user"]?.trim();
      const response = await fetch("/api/story", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          {
            ...(mode === "import" ? { source, genre } : { idea, genre }),
            beatSheet: beatSheetId,
            ...(textModelId ? { modelId: textModelId } : {}),
            ...(system || user
              ? { prompt: { ...(system ? { system } : {}), ...(user ? { user } : {}) } }
              : {}),
          },
        ),
      });
      const payload = (await response.json().catch(() => null)) as
        | (Omit<StoryResult, "origin"> & { error?: string })
        | null;
      if (!response.ok) throw new Error(payload?.error || "生成失败");
      if (!payload?.draft) throw new Error("服务端没有返回故事草稿");
      setResult({
        draft: payload.draft,
        model: payload.model,
        origin: mode,
        ...(typeof payload.cny === "number" ? { cny: payload.cny } : {}),
        ...(payload.usage ? { usage: payload.usage } : {}),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "生成失败");
    } finally {
      setBusy(false);
    }
  }

  function startProject() {
    if (!result) return;
    const prompt =
      result.origin === "import"
        ? `导入剧本${fileName ? `（${fileName}）` : ""}（${source.length} 字）：${source.slice(0, 300)}`
        : idea;
    if (
      startProjectFromStory(result.draft, {
        modelId: result.model,
        idea: prompt,
        ...(result.cny !== undefined ? { costCny: result.cny } : {}),
        ...(result.usage &&
        (result.usage.promptTokens !== undefined || result.usage.completionTokens !== undefined)
          ? {
              usage: {
                units: (result.usage.promptTokens ?? 0) + (result.usage.completionTokens ?? 0),
                unit: "tokens" as const,
              },
            }
          : {}),
      })
    ) {
      router.push("/script");
    } else {
      setError(useWorkbench.getState().castError ?? "故事没能开工");
      setConfirming(false);
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
      <TopBar
        title={project.title}
        version={project.version}
        stage="故事"
        spentCny={0}
        budgetCny={project.budgetCny}
        storageError={storageError}
        readOnly={readOnly}
        onBudgetChange={setBudget}
      />

      <main className="min-h-0 flex-1 overflow-y-auto px-5 pb-14 pt-7 sm:px-8">
        <div className="mx-auto w-full max-w-[980px]">
          <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
            <div>
              <h1 className="text-[20px] leading-none tracking-[.02em] text-text">故事</h1>
              <p className="mt-2.5 max-w-[62ch] text-[12px] leading-[1.7] text-muted">
                一次生成会同时给出 logline、人物弧光、地点、场次与分镜初稿；
                看过之后再决定要不要拿它开工。生成不写项目，确认才写。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <dl className="tnum flex items-baseline gap-5 text-[10.5px]">
                <div className="flex items-baseline gap-1.5">
                  <dt className="text-muted-2">当前项目</dt>
                  <dd className="text-muted">
                    {project.scenes.length} 场 / {project.shots.length} 镜
                  </dd>
                </div>
              </dl>
              <ModelPicker modality="text" />
            </div>
          </header>

          <div className="mt-5 flex flex-wrap items-center gap-1.5">
            {MODES.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => switchMode(item.key)}
                aria-pressed={mode === item.key}
                className={
                  mode === item.key
                    ? "rounded-token border border-line-2 bg-line px-3 py-1.5 text-[11px] text-text"
                    : "rounded-token border border-line px-3 py-1.5 text-[11px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                }
              >
                {item.label}
              </button>
            ))}
            <span className="text-[10px] leading-[1.7] text-muted-2">
              {MODES.find((item) => item.key === mode)?.note}
            </span>
          </div>

          <section className="mt-3 rounded-token border border-line bg-surface p-4 sm:p-5">
            {mode === "idea" ? (
              <>
                <label htmlFor="story-idea" className="text-[11px] tracking-[.06em] text-muted">
                  一句话 / 大纲
                </label>
                <textarea
                  id="story-idea"
                  value={idea}
                  onChange={(event) => setIdea(event.target.value)}
                  rows={5}
                  maxLength={2000}
                  placeholder="例：外卖员每天给顶层公寓送餐，直到董事长当众喊他「少主」——他白天送餐，晚上查父亲坠楼的真相。"
                  className="mt-2 w-full resize-y rounded-token border border-line bg-bg px-3 py-2.5 text-[12.5px] leading-[1.8] text-text placeholder:text-muted-2 focus:border-line-2 focus:outline-none"
                />
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-1.5">
                    {IDEAS.map((sample) => (
                      <button
                        key={sample}
                        type="button"
                        onClick={() => setIdea(sample)}
                        className="rounded-token border border-line px-2 py-1 text-left text-[9.5px] leading-[1.5] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-muted"
                      >
                        {sample}
                      </button>
                    ))}
                  </div>
                  <span className="tnum text-[9px] text-muted-2">{idea.length} / 2000</span>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="story-source" className="text-[11px] tracking-[.06em] text-muted">
                    剧本文本（txt）
                  </label>
                  <label className="cursor-pointer rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text">
                    {reading ? "正在读…" : fileName ? `已选：${fileName}` : "选择 txt 文件"}
                    <input
                      id="story-file"
                      type="file"
                      accept=".txt,text/plain"
                      className="sr-only"
                      disabled={reading || busy}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void readFile(file);
                      }}
                    />
                  </label>
                </div>
                <textarea
                  id="story-source"
                  value={source}
                  onChange={(event) => {
                    setSource(event.target.value);
                    setFileName(undefined);
                    setResult(undefined);
                    setConfirming(false);
                  }}
                  rows={10}
                  placeholder="把小说或剧本贴到这里，或选一个 txt。UTF-8 / GBK 都行；一次最多 2 万字，超过先截一段。"
                  className="mt-2 w-full resize-y rounded-token border border-line bg-bg px-3 py-2.5 text-[12px] leading-[1.8] text-text placeholder:text-muted-2 focus:border-line-2 focus:outline-none"
                />
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[9.5px] leading-[1.6] text-muted-2">
                    目标是 60–90 秒单集：会压缩与合并，原文不会原样保存。文字会作为一次模型请求的输入发给文本供应商。
                  </span>
                  <span
                    className={
                      source.length > SOURCE_MAX_CHARS
                        ? "tnum text-[9px] text-pick"
                        : "tnum text-[9px] text-muted-2"
                    }
                  >
                    {source.length} / {SOURCE_MAX_CHARS}
                  </span>
                </div>
                <label className="mt-3 flex cursor-pointer items-center gap-2 border-t border-line pt-3 text-[10px] leading-[1.7] text-muted">
                  <input
                    id="story-rights"
                    type="checkbox"
                    checked={rights}
                    onChange={(event) => setRights(event.target.checked)}
                    className="accent-pick"
                  />
                  我确认有权使用这段文字（原创或已获授权）。
                </label>
                {source.length > SOURCE_MAX_CHARS && (
                  <p className="mt-2 text-[10px] text-pick">
                    超过 {SOURCE_MAX_CHARS} 字：先截一段，或拆成几集分别导入。
                  </p>
                )}
              </>
            )}

            <div className="mt-4 border-t border-line pt-4">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[10px] text-muted-2">题材</span>
                {GENRE_MATRIX.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setGenre(item.name)}
                    aria-pressed={genre === item.name}
                    title={`${item.audience} · 可行性 ${item.feasibility} · 竞争 ${item.competition}`}
                    className={
                      genre === item.name
                        ? "rounded-token border border-line-2 bg-line px-2.5 py-1 text-[10.5px] text-text"
                        : "rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                    }
                  >
                    {item.name}
                    <span className="ml-1 text-[8.5px] text-muted-2">{item.priority}</span>
                  </button>
                ))}
              </div>
              {genreProfile && readiness && (
                <p
                  className={`mt-2 text-[9.5px] leading-[1.7] ${
                    readiness.tone === "warn" ? "text-pick" : "text-muted-2"
                  }`}
                >
                  「{genreProfile.name}」· {readiness.level} · {readiness.reason}
                </p>
              )}

              <details className="mt-2.5 rounded-token border border-line bg-bg px-3 py-2">
                <summary className="cursor-pointer text-[10px] leading-[1.7] text-muted">
                  题材矩阵 · 12 个题材的受众 / 可行性 / 竞争
                </summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[520px] text-left text-[9.5px] leading-[1.6]">
                    <thead className="text-muted-2">
                      <tr className="border-b border-line">
                        <th className="py-1 pr-3 font-normal">题材</th>
                        <th className="py-1 pr-3 font-normal">受众</th>
                        <th className="py-1 pr-3 font-normal">AI 可行性</th>
                        <th className="py-1 pr-3 font-normal">竞争</th>
                        <th className="py-1 pr-3 font-normal">优先级</th>
                        <th className="py-1 font-normal">建议</th>
                      </tr>
                    </thead>
                    <tbody>
                      {GENRE_MATRIX.map((item) => (
                        <tr key={item.id} className="border-b border-line last:border-0">
                          <td className="py-1 pr-3 text-muted">{item.name}</td>
                          <td className="py-1 pr-3 text-muted-2">{item.audience}</td>
                          <td className="py-1 pr-3 text-muted-2">{item.feasibility}</td>
                          <td className="py-1 pr-3 text-muted-2">{item.competition}</td>
                          <td className="py-1 pr-3 text-muted-2">{item.priority}</td>
                          <td className="py-1 text-muted-2">{item.advice}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[9px] leading-[1.6] text-muted-2">
                  首发聚焦都市情感 / 逆袭打脸 / 甜宠霸总：室内、少人、对话驱动，正好落在模型强项上。古装、萌宝、动作类会放大一致性与群演风险。
                </p>
              </details>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[10px] text-muted-2">节拍表</span>
                {BEAT_SHEETS.map((sheet) => (
                  <button
                    key={sheet.id}
                    type="button"
                    onClick={() => setBeatSheetId(sheet.id)}
                    aria-pressed={beatSheetId === sheet.id}
                    className={
                      beatSheetId === sheet.id
                        ? "rounded-token border border-line-2 bg-line px-2.5 py-1 text-[10.5px] text-text"
                        : "rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                    }
                  >
                    {sheet.name}
                  </button>
                ))}
                <span className="text-[9px] leading-[1.6] text-muted-2">{beatSheet.note}</span>
              </div>

              <details className="mt-2.5 rounded-token border border-line bg-bg px-3 py-2">
                <summary className="cursor-pointer text-[10px] leading-[1.7] text-muted">
                  节拍时间窗 · {beatSheet.name}（{beatSheet.beats.length} 拍）
                  {result ? ` · 按这条草稿 ${stats?.seconds.toFixed(1)}s 换算` : ""}
                </summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[460px] text-left text-[9.5px] leading-[1.6]">
                    <thead className="text-muted-2">
                      <tr className="border-b border-line">
                        <th className="py-1 pr-3 font-normal">时间</th>
                        <th className="py-1 pr-3 font-normal">Beat</th>
                        <th className="py-1 font-normal">任务</th>
                      </tr>
                    </thead>
                    <tbody>
                      {beatOverlay.map((beat, index) => (
                        <tr key={`${beat.label}-${index}`} className="border-b border-line last:border-0">
                          <td className="tnum py-1 pr-3 text-muted">
                            {formatSeconds(beat.startMs / 1000)}–{formatSeconds(beat.endMs / 1000)}
                          </td>
                          <td className="py-1 pr-3 text-muted">{beat.label}</td>
                          <td className="py-1 text-muted-2">{beat.task}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[9px] leading-[1.6] text-muted-2">
                  {result
                    ? "时间窗按这条草稿的总时长等比换算；当前生成仍是 60–90 秒、10–14 镜。"
                    : `按模板名义时长 ${beatSheet.nominalSeconds}s 显示；生成后换成草稿的实际时长。`}
                </p>
              </details>

              <LoglineWorkshop genreId={genre} />
            </div>

            <StoryBiblePanel />

            <div className="mt-4 border-t border-line pt-3">
              <PromptEditor
                defaultOpen
                tabs={[
                  { key: "story:system", label: "系统提示词", prompt: promptMessages.system },
                  { key: "story:user", label: "用户消息", prompt: promptMessages.user },
                ]}
                values={promptOverrides}
                onChange={setPromptOverride}
                readOnly={Boolean(readOnly)}
                note="这次生成真正发出去的两条消息；改过的版本只用于之后这一次生成，不写进项目。"
              />
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <span className="text-[9.5px] leading-[1.6] text-muted-2">
                生成会带上所选题材与节拍表；结果仍先在内存里，确认才写项目。
              </span>
              <button
                type="button"
                onClick={() => void generate()}
                disabled={!canGenerate}
                title={
                  !info.model
                    ? "还没配文本模型：服务端加上 TEXT_MODEL 之后才能生成"
                    : mode === "import"
                      ? !source.trim()
                        ? "先粘贴或选择一个 txt"
                        : source.length > SOURCE_MAX_CHARS
                          ? `超过 ${SOURCE_MAX_CHARS} 字，先截一段`
                          : !rights
                            ? "先确认你有权使用这段文字"
                            : "把原文改成一条 60–90 秒单集，不写项目"
                      : !idea.trim()
                        ? "先写一句想法或一段大纲"
                        : "生成故事骨架，不写项目"
                }
                className="ml-auto rounded-token border border-line-2 px-3.5 py-1.5 text-[11.5px] text-text transition-colors duration-[var(--dur)] hover:border-text disabled:cursor-not-allowed disabled:border-line disabled:text-muted-2"
              >
                {busy
                  ? "正在生成…"
                  : mode === "import"
                    ? "改编成剧本"
                    : "生成故事"}
              </button>
            </div>

            {!info.model && (
              <p className="mt-3 border-t border-line pt-3 text-[10px] leading-[1.7] text-muted-2">
                {infoError
                  ? infoError
                  : "还没配文本模型：服务端在 secrity.env 里加上 TEXT_MODEL 之后才能生成。断句、场次与时间线仍然可以手改。"}
              </p>
            )}
            {info.model && busy && (
              <p className="mt-3 border-t border-line pt-3 text-[10px] leading-[1.7] text-muted-2">
                {mode === "import"
                  ? `正在让 ${activeModel} 读剧本、合并场次并拆成分镜，通常要 40–100 秒。不要关页面。`
                  : `正在让 ${activeModel} 写故事、拆场次与分镜，通常要 40–100 秒。不要关页面。`}
              </p>
            )}
            {error && (
              <p className="mt-3 border-t border-line pt-3 text-[10.5px] leading-[1.7] text-pick">
                {error}
              </p>
            )}
          </section>

          {result && stats && (
            <section className="mt-8">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-4">
                <div>
                  <div className="flex flex-wrap items-baseline gap-2.5">
                    <h2 className="text-[17px] leading-tight tracking-[.02em] text-text">
                      {result.draft.title}
                    </h2>
                    <span className="tnum text-[9px] text-muted-2">
                      由 {result.model} {result.origin === "import" ? "改编" : "生成"}
                      {/* 文本按 token 计价（H4）：填了单价才有金额，没填就只报用量 */}
                      {result.cny !== undefined
                        ? ` · ¥${result.cny.toFixed(4)}`
                        : result.usage
                          ? ` · ${storyTokensOf(result.usage)}（未定价）`
                          : ""}
                    </span>
                    {result.origin === "import" && (
                      <span className="rounded-token border border-line px-1.5 py-0.5 text-[9px] text-muted-2">
                        改编稿 · 原文 {source.length} 字
                      </span>
                    )}
                  </div>
                  <p className="mt-2 max-w-[58ch] text-[13px] leading-[1.8] text-text">
                    {result.draft.logline}
                  </p>
                  <p className="mt-2 max-w-[66ch] text-[11.5px] leading-[1.8] text-muted">
                    {result.draft.synopsis}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5 text-[9.5px]">
                    {[result.draft.genre, result.draft.audience, result.draft.tone].map(
                      (item) => (
                        <span
                          key={item}
                          className="rounded-token border border-line px-2 py-0.5 text-muted-2"
                        >
                          {item}
                        </span>
                      ),
                    )}
                  </div>
                </div>
                <dl className="tnum grid grid-cols-3 gap-x-6 gap-y-2 text-[10px] sm:grid-cols-2">
                  {[
                    ["人物", `${stats.characters}`],
                    ["地点", `${stats.locations}`],
                    ["场次", `${stats.scenes}`],
                    ["镜头", `${stats.shots}`],
                    ["台词", `${stats.lines}`],
                    ["估时", `${stats.seconds.toFixed(1)}s`],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-muted-2">{label}</dt>
                      <dd className="mt-0.5 text-[13px] text-text">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <div className="mt-4">
                <LoglineScoreCard text={result.draft.logline} genreId={genre} />
              </div>

              <div className="mt-6 grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
                <div className="space-y-3">
                  <h3 className="text-[10px] tracking-[.12em] text-muted-2">人物与弧光</h3>
                  {result.draft.characters.map((character) => (
                    <article
                      key={character.name}
                      className="rounded-token border border-line bg-surface p-3.5"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h4 className="text-[13px] text-text">{character.name}</h4>
                        <span className="text-[9.5px] text-muted-2">{character.role}</span>
                      </div>
                      <p className="mt-1.5 text-[10.5px] leading-[1.7] text-muted">
                        {character.appearance}
                      </p>
                      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10px] leading-[1.6]">
                        {[
                          ["要", character.want],
                          ["缺", character.need],
                          ["伤", character.wound],
                          ["缺陷", character.flaw],
                          ["秘密", character.secret],
                          ["选择", character.agency],
                        ]
                          .filter(([, value]) => value)
                          .map(([label, value]) => (
                            <div key={label} className="flex gap-1.5">
                              <dt className="shrink-0 text-muted-2">{label}</dt>
                              <dd className="text-muted">{value}</dd>
                            </div>
                          ))}
                      </dl>
                      {character.arc && (
                        <p className="mt-2 border-t border-line pt-2 text-[10px] leading-[1.7] text-muted-2">
                          这一集：{character.arc}
                        </p>
                      )}
                    </article>
                  ))}
                </div>

                <div className="space-y-5">
                  <div>
                    <h3 className="text-[10px] tracking-[.12em] text-muted-2">关系张力</h3>
                    {result.draft.relationships.length === 0 ? (
                      <p className="mt-2 text-[10px] text-muted-2">这次没有给出关系描述。</p>
                    ) : (
                      <ul className="mt-2 space-y-2">
                        {result.draft.relationships.map((relation) => (
                          <li
                            key={`${relation.from}-${relation.to}`}
                            className="border-l border-line-2 pl-2.5 text-[10.5px] leading-[1.7]"
                          >
                            <span className="text-text">
                              {relation.from} → {relation.to}
                            </span>
                            <span className="mt-0.5 block text-muted-2">{relation.tension}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <h3 className="text-[10px] tracking-[.12em] text-muted-2">地点与道具</h3>
                    <ul className="mt-2 space-y-2">
                      {result.draft.locations.map((location) => (
                        <li key={location.name} className="text-[10.5px] leading-[1.7]">
                          <span className="text-text">
                            {location.name}
                            <span className="ml-1.5 text-[9px] text-muted-2">
                              {SPACE_CN[location.space]} · {TIME_CN[location.timeOfDay]}
                            </span>
                          </span>
                          <span className="mt-0.5 block text-muted-2">{location.description}</span>
                        </li>
                      ))}
                    </ul>
                    {result.draft.props.length > 0 && (
                      <p className="mt-2 text-[10px] leading-[1.7] text-muted-2">
                        道具：
                        {result.draft.props.map((prop) => prop.name).join(" / ")}
                      </p>
                    )}
                  </div>

                  <div>
                    <h3 className="text-[10px] tracking-[.12em] text-muted-2">钩子</h3>
                    <p className="mt-2 text-[10.5px] leading-[1.7] text-muted">
                      <span className="text-muted-2">开场　</span>
                      {result.draft.openingHook || "（从第一镜推断）"}
                    </p>
                    <p className="mt-1.5 text-[10.5px] leading-[1.7] text-muted">
                      <span className="text-muted-2">结尾　</span>
                      {result.draft.endingHook}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-8">
                <h3 className="text-[10px] tracking-[.12em] text-muted-2">场次与分镜初稿</h3>
                <div className="mt-3 space-y-5">
                  {result.draft.scenes.map((scene, sceneIndex) => (
                    <section key={`${scene.locationName}-${sceneIndex}`}>
                      <div className="flex flex-wrap items-baseline gap-2.5 border-b border-line pb-2">
                        <span className="tnum text-[10px] text-muted-2">
                          第 {sceneIndex + 1} 场
                        </span>
                        <h4 className="text-[12.5px] text-text">{scene.locationName}</h4>
                        <span className="text-[9.5px] text-muted-2">
                          {SPACE_CN[scene.space]} · {TIME_CN[scene.timeOfDay]}
                        </span>
                        <span className="tnum ml-auto text-[9.5px] text-muted-2">
                          {scene.shots.length} 镜
                        </span>
                      </div>
                      <ol className="mt-2 divide-y divide-line">
                        {scene.shots.map((shot, shotIndex) => {
                          const shotNumber =
                            result.draft.scenes
                              .slice(0, sceneIndex)
                              .reduce((total, item) => total + item.shots.length, 0) +
                            shotIndex +
                            1;
                          const dialogueMs = shot.dialogue.reduce(
                            (total, line) => total + estimateDialogueMs(line.text),
                            0,
                          );
                          const durationMs =
                            shot.dialogue.length > 0
                              ? dialogueMs + SHOT_PADDING_MS
                              : SHOT_MIN_MS;
                          return (
                            <li key={shotIndex} className="grid gap-2 py-2.5 sm:grid-cols-[54px_1fr]">
                              <span className="tnum text-[9.5px] text-muted-2">
                                SH-{String(shotNumber).padStart(2, "0")}
                              </span>
                              <div>
                                <p className="text-[11.5px] leading-[1.7] text-text">
                                  {shot.description}
                                </p>
                                <p className="tnum mt-1 text-[9px] tracking-[.03em] text-muted-2">
                                  {SHOT_SIZE_CN[shot.shotSize]} · {SHOT_ANGLE_CN[shot.angle]} ·{" "}
                                  {MOVE_CN[shot.movement]} · {shot.focalMm}mm ·{" "}
                                  {(durationMs / 1000).toFixed(1)}s
                                  {shot.characterNames.length > 0 &&
                                    ` · ${shot.characterNames.join("、")}`}
                                </p>
                                {shot.dialogue.map((line, lineIndex) => (
                                  <p
                                    key={lineIndex}
                                    className="mt-1 text-[11px] leading-[1.7] text-muted"
                                  >
                                    <span className="text-muted-2">{line.characterName}：</span>
                                    {line.text}
                                  </p>
                                ))}
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    </section>
                  ))}
                </div>
              </div>

              <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                <p className="max-w-[58ch] text-[10px] leading-[1.7] text-muted-2">
                  草稿只在内存里，刷新就没了。开工会在事件日志末尾写一条新的 project.created：
                  当前项目会被整条换掉，旧事件仍留在本地，但这个界面只从新项目往后走。
                </p>
                {readOnly ? (
                  <span className="text-[10.5px] text-muted-2">另一个标签页在编辑：这里只读。</span>
                ) : confirming ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={startProject}
                      className="rounded-token border border-pick px-3.5 py-1.5 text-[11.5px] text-pick transition-colors duration-[var(--dur)] hover:bg-pick/10"
                    >
                      确认开工
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(false)}
                      className="rounded-token border border-line px-3 py-1.5 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                    >
                      再想想
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    className="rounded-token border border-line-2 px-3.5 py-1.5 text-[11.5px] text-text transition-colors duration-[var(--dur)] hover:border-text"
                  >
                    用它开工
                  </button>
                )}
              </div>
            </section>
          )}
        </div>
      </main>
      <StageGate stage="story" />
    </div>
  );
}
