"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { StageGate } from "@/components/stage-gate";
import { TopBar } from "@/components/top-bar";
import { PromptEditor } from "@/components/prompt-editor";
import { SharedAudioPicker } from "@/components/shared-audio-picker";
import { VoicePerformancePanel } from "@/components/voice-performance-panel";
import { shotLabel, toVoiceView, type VoiceLine, type VoiceRole } from "@/lib/read-model";
import {
  DEFAULT_PERFORMANCE,
  instructionsOf,
  summarizePerformance,
} from "@/lib/voice-performance";
import { useWorkbench } from "@/lib/workbench-store";
import { cn } from "@/lib/utils";
import { assetHref } from "@/lib/asset-uri";

/**
 * 声音页（ADR-0085）：一句台词一条音轨。
 *
 * 这里有两条路：让供应商念（需要 TTS_MODEL），或把自己的录音贴进来。
 * 音轨挂上之后浏览器会量出真实时长，再把 IR 里的台词与镜头校正到它（准则 P5）。
 */
function RoleRow({
  role,
  fallbackVoice,
  readOnly,
  onSave,
}: {
  role: VoiceRole;
  /** 没单独指定时用它 */
  fallbackVoice?: string;
  readOnly: boolean;
  onSave: (voice: string) => void;
}) {
  const [draft, setDraft] = useState(role.voice ?? "");

  // 外部改了音色（撤销 / 重放）时跟上
  useEffect(() => {
    setDraft(role.voice ?? "");
  }, [role.voice]);

  const commit = () => {
    if (draft.trim() === (role.voice ?? "")) return;
    onSave(draft);
  };

  return (
    <div className="flex items-center gap-2 rounded-token border border-line px-2.5 py-1.5">
      <span className="text-[10.5px] text-text">{role.name}</span>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setDraft(role.voice ?? "");
        }}
        disabled={readOnly}
        placeholder={fallbackVoice ? `默认 ${fallbackVoice}` : "默认音色"}
        aria-label={`${role.name} 的音色`}
        className="w-[86px] min-w-0 rounded-token border border-line bg-transparent px-1.5 py-0.5 text-[10px] text-text placeholder:text-muted-2 focus:border-line-2 focus:outline-none disabled:opacity-45"
      />
      <span className="tnum ml-auto text-[9px] text-muted-2">
        {role.voiced} / {role.lines} 句
      </span>
    </div>
  );
}

/**
 * 挂上的音轨：浏览器读得到真实时长时，把它写回 IR。
 * 无头环境里连 WAV 都解不开，这时什么都不写——界面仍然标「有声」。
 */
function LineAudio({ line, onMeasure }: { line: VoiceLine; onMeasure: (ms: number) => void }) {
  const measured = useRef(false);

  return (
    <audio
      controls
      preload="metadata"
      src={assetHref(line.audioUri)}
      onLoadedMetadata={(event) => {
        if (measured.current) return;
        measured.current = true;
        const seconds = event.currentTarget.duration;
        if (Number.isFinite(seconds) && seconds > 0) onMeasure(seconds * 1000);
      }}
      className="mt-1.5 h-8 w-[268px] max-w-full"
    />
  );
}

function AttachBox({
  readOnly,
  onAttach,
}: {
  readOnly: boolean;
  onAttach: (uri: string) => void;
}) {
  const [draft, setDraft] = useState("");

  return (
    <div className="mt-1 flex items-center gap-1">
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          if (!draft.trim()) return;
          onAttach(draft);
          setDraft("");
        }}
        disabled={readOnly}
        placeholder="http(s):// / data:audio/ / 本机资产库…"
        aria-label="音轨地址"
        className="w-[148px] min-w-0 rounded-token border border-line bg-transparent px-1.5 py-0.5 text-[9.5px] text-text placeholder:text-muted-2 focus:border-line-2 focus:outline-none disabled:opacity-45"
      />
      <button
        type="button"
        onClick={() => {
          if (!draft.trim()) return;
          onAttach(draft);
          setDraft("");
        }}
        disabled={readOnly || !draft.trim()}
        className="shrink-0 rounded-token border border-line px-1.5 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
      >
        贴上
      </button>
    </div>
  );
}

export function VoiceScreen() {
  const project = useWorkbench((state) => state.project);
  const hydrate = useWorkbench((state) => state.hydrate);
  const readOnly = useWorkbench((state) => state.readOnly);
  const storageError = useWorkbench((state) => state.storageError);
  const castError = useWorkbench((state) => state.castError);
  const jobs = useWorkbench((state) => state.jobs);
  const voiceInfo = useWorkbench((state) => state.voiceInfo);
  const setVoiceInfo = useWorkbench((state) => state.setVoiceInfo);
  const asrInfo = useWorkbench((state) => state.asrInfo);
  const asrResult = useWorkbench((state) => state.asrResult);
  const setAsrInfo = useWorkbench((state) => state.setAsrInfo);
  const transcribeLine = useWorkbench((state) => state.transcribeLine);
  const applyAsrText = useWorkbench((state) => state.applyAsrText);
  const dismissAsrResult = useWorkbench((state) => state.dismissAsrResult);
  const generateVoice = useWorkbench((state) => state.generateVoice);
  const generateMissingVoice = useWorkbench((state) => state.generateMissingVoice);
  const updatePerformance = useWorkbench((state) => state.updatePerformance);
  const adoptVoiceTake = useWorkbench((state) => state.adoptVoiceTake);
  const removeVoiceTake = useWorkbench((state) => state.removeVoiceTake);
  const attachVoice = useWorkbench((state) => state.attachVoice);
  const fitLineToAudio = useWorkbench((state) => state.fitLineToAudio);
  const setCharacterVoice = useWorkbench((state) => state.setCharacterVoice);
  const setBudget = useWorkbench((state) => state.setBudget);
  const promptOverrides = useWorkbench((state) => state.promptOverrides);
  const setPromptOverride = useWorkbench((state) => state.setPromptOverride);
  const [batch, setBatch] = useState<{ running: boolean; note?: string }>({ running: false });

  useEffect(() => {
    void hydrate();
    let alive = true;
    void fetch("/api/voice")
      .then((response) => response.json())
      .then((payload: { model?: string; voice?: string }) => {
        if (alive) setVoiceInfo(payload ?? {});
      })
      .catch(() => {
        // 读不到配置不是致命事：页面照常能贴音轨
        if (alive) setVoiceInfo({});
      });
    void fetch("/api/transcribe")
      .then((response) => response.json())
      .then((payload: { model?: string }) => {
        if (alive) setAsrInfo(payload ?? {});
      })
      .catch(() => {
        // 同上：没有识别模型，仍然可以出声与贴音轨
        if (alive) setAsrInfo({});
      });
    return () => {
      alive = false;
    };
  }, [hydrate, setVoiceInfo, setAsrInfo]);

  const view = useMemo(() => toVoiceView(project), [project]);
  const missingLines = view.lines.filter(
    (line) => line.state !== "voiced" && line.text.trim().length > 0,
  ).length;
  const canSpeak = Boolean(voiceInfo?.model);
  /** 哪一句展开了「表演」折叠：一次只开一个，避免整页拉得很长 */
  const [openPerformance, setOpenPerformance] = useState<string>();
  const canTranscribe = Boolean(asrInfo?.model);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
      <TopBar
        skillStages={["voice"]}
        title={view.title}
        version={view.version}
        stage="声音"
        spentCny={view.spent}
        budgetCny={view.budget}
        unpriced={view.unpriced}
        spendBreakdown={view.spend}
        storageError={storageError}
        readOnly={readOnly}
        onBudgetChange={setBudget}
      />

      {castError && (
        <p className="shrink-0 px-6 pb-1 pt-2 text-[10.5px] leading-[1.6] text-pick">{castError}</p>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-[980px]">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <div>
              <h1 className="text-[13px] tracking-[.06em] text-text">声音</h1>
              <p className="mt-1 text-[10.5px] leading-[1.6] text-muted-2">
                一句台词一条音轨。音轨挂上之后按它的真实时长校正镜头——镜头服从配音，不是反过来。
              </p>
            </div>
            <dl className="tnum flex items-baseline gap-5 text-[10.5px]">
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-2">已配</dt>
                <dd className="text-muted">
                  {view.voiced} / {view.total} 句
                </dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-2">台词总长</dt>
                <dd className="text-muted">{view.totalSec.toFixed(1)}s</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-2">已配有声</dt>
                <dd className="text-muted">{view.voicedSec.toFixed(1)}s</dd>
              </div>
            </dl>
          </div>

          <section aria-label="角色音色" className="mt-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[11px] tracking-[.06em] text-text">谁的声音</h2>
              <p className="text-[9.5px] text-muted-2">
                {canSpeak
                  ? `用 ${voiceInfo?.model} 出声；空着就用默认音色`
                  : "还没配配音模型：服务端加上 TTS_MODEL 后才能出声，现在可以先贴自己的音轨"}
              </p>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {view.roles.map((role) => (
                <RoleRow
                  key={role.id}
                  role={role}
                  fallbackVoice={voiceInfo?.voice}
                  readOnly={Boolean(readOnly)}
                  onSave={(voice) => setCharacterVoice(role.id, voice)}
                />
              ))}
              {view.roles.length === 0 && (
                <p className="text-[10.5px] text-muted-2">还没有人物：先去定妆页加人。</p>
              )}
            </div>
          </section>

          <section aria-label="台词与音轨" className="mt-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[11px] tracking-[.06em] text-text">一句一句配</h2>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={Boolean(readOnly) || !canSpeak || batch.running || missingLines === 0}
                  onClick={() => {
                    setBatch({ running: true });
                    void generateMissingVoice().then((result) => {
                      setBatch({
                        running: false,
                        note:
                          result.attempted === 0
                            ? "没有要补的句子。"
                            : result.failedLineId
                              ? `补了 ${result.done} 句，后面一句失败就停了：先看上面的原因。`
                              : `补完 ${result.done} 句。`,
                      });
                    });
                  }}
                  title={
                    !canSpeak
                      ? "还没配配音模型：加上 TTS_MODEL 之后才能批量出声"
                      : "按台词顺序补还没音轨的句子；跳过锁定镜头，失败即停"
                  }
                  className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
                >
                  {batch.running ? "一句一句念…" : `补缺 ${missingLines} 句`}
                </button>
                <p className="text-[9.5px] text-muted-2">
                  {canTranscribe
                    ? `用 ${asrInfo?.model} 识别：结果先看一眼，再决定要不要替换台词`
                    : "还没配识别模型：服务端加上 ASR_MODEL 后才能识别音轨"}
                </p>
              </div>
            </div>
            {batch.note && <p className="mt-1 text-[9.5px] text-muted-2">{batch.note}</p>}
            <ul className="mt-2 border-t border-line">
              {view.lines.map((line) => {
                const busy = jobs[`${line.id}:voice`]?.kind === "voice";
                const busyAsr = jobs[`${line.id}:asr`]?.kind === "asr";
                const result = asrResult?.lineId === line.id ? asrResult : undefined;
                const role = view.roles.find((item) => item.id === line.characterId);
                return (
                  <li key={line.id} className="border-b border-line py-3">
                    <div className="flex items-start gap-3">
                      <span className="tnum w-[54px] shrink-0 pt-px text-[9.5px] text-muted-2">
                        {shotLabel(line.no)}
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="text-[10.5px] text-muted">{line.characterName}</span>
                          <span className="tnum text-[9px] text-muted-2">
                            {line.dur.toFixed(1)}s
                            {line.audioDur !== undefined ? ` · 音轨 ${line.audioDur.toFixed(1)}s` : ""}
                          </span>
                          <span
                            className={cn(
                              "rounded-token border px-1 py-px text-[8.5px]",
                              line.state === "voiced"
                                ? "border-line-2 text-text"
                                : "border-dashed border-line text-muted-2",
                            )}
                          >
                            {line.state === "voiced" ? "有声" : "还没配"}
                          </span>
                          {line.stale && (
                            <span
                              className="rounded-token border border-pick/60 px-1 py-px text-[8.5px] text-pick"
                              title="音轨是按旧台词念的：重配才会对上现在这句"
                            >
                              旧台词
                            </span>
                          )}
                          {role?.voice && (
                            <span className="text-[8.5px] text-muted-2">音色 {role.voice}</span>
                          )}
                          {line.performance && (
                            <span
                              className="rounded-token border border-line px-1 py-px text-[8.5px] text-muted-2"
                              title="这一句有表演参数：下一次出声按它念"
                            >
                              {summarizePerformance(line.performance)}
                            </span>
                          )}
                          {line.takes > 0 && (
                            <span className="tnum text-[8.5px] text-muted-2">
                              试听台 {line.takes} 版
                              {line.adoptedTakeId ? " · 已采用其中一版" : ""}
                            </span>
                          )}
                        </div>

                        <p className="mt-1 text-[11.5px] leading-[1.7] text-text">{line.text}</p>

                        {/* 这一句念的时候会带上的提示词（ADR-0148）：表演参数拼出来的 instructions */}
                        <PromptEditor
                          className="mt-1.5"
                          tabs={[
                            {
                              key: `voice:${line.id}`,
                              label: "念白",
                              prompt: instructionsOf(line.performance ?? DEFAULT_PERFORMANCE) ?? "",
                            },
                          ]}
                          values={promptOverrides}
                          onChange={setPromptOverride}
                          readOnly={Boolean(readOnly)}
                          maxChars={300}
                          note="随台词一起发给配音模型：只写怎么念，不改字。没写就只把台词原样送出去。"
                        />

                        {line.audioUri && (
                          <LineAudio
                            key={line.audioUri}
                            line={line}
                            onMeasure={(ms) => fitLineToAudio(line.id, ms)}
                          />
                        )}

                        {result && (
                          <div className="mt-1.5 border border-dashed border-line-2 px-2 py-1.5">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                              <span className="text-[8.5px] tracking-[.06em] text-muted-2">
                                识别结果
                              </span>
                              <span className="text-[8.5px] text-muted-2">
                                {result.model}
                                {result.segments.length > 0
                                  ? ` · ${result.segments.length} 段`
                                  : ""}
                              </span>
                            </div>
                            <p className="mt-1 text-[11px] leading-[1.7] text-text">
                              {result.text}
                            </p>
                            <div className="mt-1.5 flex gap-2">
                              <button
                                type="button"
                                onClick={() => applyAsrText(line.id, result.text)}
                                disabled={Boolean(readOnly)}
                                className="rounded-token border border-pick bg-pick px-2 py-0.5 text-[9.5px] text-white transition-opacity duration-[var(--dur)] hover:opacity-90 disabled:opacity-40"
                              >
                                用这句替换
                              </button>
                              <button
                                type="button"
                                onClick={dismissAsrResult}
                                className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                              >
                                忽略
                              </button>
                            </div>
                          </div>
                        )}

                        <AttachBox
                          readOnly={Boolean(readOnly)}
                          onAttach={(uri) => attachVoice(line.id, uri)}
                        />

                        {!readOnly && (
                          <SharedAudioPicker
                            usedUri={line.audioUri}
                            onPick={(uri) => attachVoice(line.id, uri, "library")}
                          />
                        )}

                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              setOpenPerformance((current) =>
                                current === line.id ? undefined : line.id,
                              )
                            }
                            aria-expanded={openPerformance === line.id}
                            className={cn(
                              "rounded-token border px-1.5 py-px text-[8.5px] transition-colors duration-[var(--dur)]",
                              openPerformance === line.id
                                ? "border-line-2 text-text"
                                : "border-line text-muted-2 hover:border-line-2 hover:text-text",
                            )}
                          >
                            表演{line.performance ? " · 已调" : ""}
                          </button>
                          {line.takes > 0 && (
                            <span className="tnum text-[8.5px] text-muted-2">
                              {line.takes} 版
                            </span>
                          )}
                        </div>

                        {openPerformance === line.id && (
                          <VoicePerformancePanel
                            line={line}
                            takes={project.voiceTakes
                              .filter((take) => take.lineId === line.id)
                              .slice()
                              .reverse()}
                            adoptedAssetId={
                              project.dialogue.find((item) => item.id === line.id)?.audioAssetId
                            }
                            readOnly={Boolean(readOnly)}
                            canSpeak={canSpeak}
                            onSave={(performance) => updatePerformance(line.id, performance)}
                            onGenerateTake={() => void generateVoice(line.id, { keepTake: true })}
                            onAdoptTake={(takeId) => adoptVoiceTake(takeId)}
                            onRemoveTake={(takeId) => removeVoiceTake(takeId)}
                          />
                        )}
                      </div>

                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <button
                          type="button"
                          onClick={() => void generateVoice(line.id)}
                          disabled={Boolean(readOnly) || busy || !canSpeak}
                          title={
                            !canSpeak
                              ? "还没配配音模型：加上 TTS_MODEL 之后才能出声"
                              : line.state === "voiced"
                                ? "重新念一遍：换掉这一句的旧音轨"
                                : "让供应商念这一句"
                          }
                          className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:pointer-events-none disabled:opacity-40"
                        >
                          {busy ? "出声中…" : line.state === "voiced" ? "重配" : "出声"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void transcribeLine(line.id)}
                          disabled={
                            Boolean(readOnly) || busyAsr || !canTranscribe || !line.audioUri
                          }
                          title={
                            !canTranscribe
                              ? "还没配识别模型：加上 ASR_MODEL 之后才能识别"
                              : !line.audioUri
                                ? "这一句还没有音轨可识别"
                                : "听这一句，把文字校回来"
                          }
                          className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:pointer-events-none disabled:opacity-40"
                        >
                          {busyAsr ? "识别中…" : "识别"}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {view.lines.length === 0 && (
              <p className="mt-8 text-center text-[11px] text-muted-2">
                还没有台词：去分镜页加一句，这里才有得配。
              </p>
            )}
          </section>

          <p className="mt-6 text-[9.5px] leading-[1.7] text-muted-2">
            音轨存在本地日志里（IndexedDB），刷新不丢。供应商不通时，「贴音轨」收 http(s):// 或
            data:audio/ 地址。
          </p>

          {readOnly && (
            <p className="mt-2 text-[10px] text-muted-2">另一个标签页在编辑：这一页只读，刷新后才能接管。</p>
          )}
        </div>
      </main>
      <StageGate stage="voice" />
    </div>
  );
}
