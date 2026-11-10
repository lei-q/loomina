"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { TopBar } from "@/components/top-bar";
import { shotLabel, toVoiceView, type VoiceLine, type VoiceRole } from "@/lib/read-model";
import { useWorkbench } from "@/lib/workbench-store";
import { cn } from "@/lib/utils";

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
      src={line.audioUri}
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
        placeholder="http(s):// 或 data:audio/…"
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
  const generateVoice = useWorkbench((state) => state.generateVoice);
  const attachVoice = useWorkbench((state) => state.attachVoice);
  const fitLineToAudio = useWorkbench((state) => state.fitLineToAudio);
  const setCharacterVoice = useWorkbench((state) => state.setCharacterVoice);
  const setBudget = useWorkbench((state) => state.setBudget);

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
    return () => {
      alive = false;
    };
  }, [hydrate, setVoiceInfo]);

  const view = useMemo(() => toVoiceView(project), [project]);
  const canSpeak = Boolean(voiceInfo?.model);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
      <TopBar
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
            <h2 className="text-[11px] tracking-[.06em] text-text">一句一句配</h2>
            <ul className="mt-2 border-t border-line">
              {view.lines.map((line) => {
                const busy = jobs[`${line.id}:voice`]?.kind === "voice";
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
                          {role?.voice && (
                            <span className="text-[8.5px] text-muted-2">音色 {role.voice}</span>
                          )}
                        </div>

                        <p className="mt-1 text-[11.5px] leading-[1.7] text-text">{line.text}</p>

                        {line.audioUri && (
                          <LineAudio
                            key={line.audioUri}
                            line={line}
                            onMeasure={(ms) => fitLineToAudio(line.id, ms)}
                          />
                        )}

                        <AttachBox
                          readOnly={Boolean(readOnly)}
                          onAttach={(uri) => attachVoice(line.id, uri)}
                        />
                      </div>

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
                        className="shrink-0 rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:pointer-events-none disabled:opacity-40"
                      >
                        {busy ? "出声中…" : line.state === "voiced" ? "重配" : "出声"}
                      </button>
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
    </div>
  );
}
