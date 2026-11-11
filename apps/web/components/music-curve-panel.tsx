"use client";

import { useMemo, useState } from "react";
import type { Motif, MusicCue, Project } from "@loomina/ir";
import {
  MOTIF_TARGET_LABEL,
  MUSIC_STATE_LABEL,
  MUSIC_STATE_TASK,
  analyzeMusicCurve,
  motifTargetLabel,
  motifUsage,
  planMusicFill,
  type MusicState,
} from "@/lib/music-curve";
import { cn } from "@/lib/utils";

/** 状态色：进 / 铺 / 推 / 落 / 峰 / 收 / 未解决，一套渐进的冷→暖→冷 */
const STATE_TONE: Record<MusicState, string> = {
  enter: "#5f7f9e",
  bed: "#3d4a57",
  build: "#8a7a4a",
  drop: "#4a3f52",
  peak: "#a8763f",
  resolve: "#4a6a5c",
  unresolved: "#6a5a72",
};

function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function timecode(ms: number): string {
  const total = Math.max(0, Math.round(ms / 100) / 10);
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export type MusicCurvePanelProps = {
  project: Project;
  readOnly: boolean;
  onFill: (cueId: string) => void;
  onUpdateCue: (
    patch: Partial<Pick<MusicCue, "role" | "motifId">>,
    cueId: string,
  ) => void;
  onUpsertMotif: (input: Omit<Motif, "id"> & { id?: string }) => boolean;
  onRemoveMotif: (motifId: string) => void;
};

/**
 * 音乐情绪曲线与主题动机（C10 / ADR-0125）。
 *
 * 上面是按拍分宽的色块条：颜色是建议状态，实占区间是 cue，没 cue 的拍写「留白」。
 * 中间逐拍一行，点「铺到这一拍」只在有素材时可用。
 * 下面是动机区：一段短素材代表谁 / 哪对关系 / 哪个地点。
 *
 * 建议不是指令：作者可以完全不理，工具不拦。
 */
export function MusicCurvePanel({
  project,
  readOnly,
  onFill,
  onUpdateCue,
  onUpsertMotif,
  onRemoveMotif,
}: MusicCurvePanelProps) {
  const curve = useMemo(() => analyzeMusicCurve(project), [project]);
  const source = project.timeline.music[0];
  const fillPlan = useMemo(
    () => (source ? planMusicFill(project, source) : undefined),
    [project, source],
  );
  const [open, setOpen] = useState(true);

  return (
    <section aria-label="音乐曲线" className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-baseline gap-2 text-left"
        >
          <h3 className="text-[10.5px] tracking-[.06em] text-text">情绪曲线</h3>
          <span className="tnum text-[8.5px] text-muted-2">
            {curve.beats} 拍 · 覆盖 {curve.coveragePct}% · 留白 {fmtSec(curve.silenceMs)}
          </span>
          <span className="text-[8.5px] text-muted-2">{open ? "收起" : "展开"}</span>
        </button>
        <span className="text-[8.5px] tracking-[.06em] text-muted-2">C10</span>
      </div>

      {open && (
        <>
          <CurveBar project={project} />
          <ul className="mt-2 border-t border-line">
            {curve.lines.map((line) => (
              <li key={line.beatId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-line py-1.5">
                <span
                  aria-hidden="true"
                  className="mt-[3px] block h-[8px] w-[8px] shrink-0 rounded-sm"
                  style={{ background: STATE_TONE[line.state] }}
                />
                <span className="text-[9.5px] text-text">
                  {MUSIC_STATE_LABEL[line.state]}
                </span>
                <span className="tnum text-[8.5px] text-muted-2">
                  {timecode(line.startMs)} · {fmtSec(line.durationMs)} · {line.sceneLabel}
                </span>
                <span className="min-w-0 flex-1 text-[8.5px] text-muted-2">
                  {!line.inCut
                    ? "成片之外（先初剪把这一镜排进来）"
                    : line.silent
                      ? `留白（建议${MUSIC_STATE_LABEL[line.state]}：${MUSIC_STATE_TASK[line.state]}）`
                      : line.cues
                          .map((cue) => `${cue.title}${cue.motifLabel ? ` · ${cue.motifLabel}` : ""}`)
                          .join("、")}
                </span>
                {line.silent && line.inCut && source && (
                  <button
                    type="button"
                    onClick={() => onFill(source.id)}
                    disabled={readOnly}
                    title="把第一条配乐铺到所有留白的拍上，边界对齐拍起止"
                    className="shrink-0 rounded-token border border-line px-1.5 py-px text-[8.5px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
                  >
                    按曲线铺
                  </button>
                )}
              </li>
            ))}
            {curve.lines.length === 0 && (
              <li className="py-2 text-[9.5px] text-muted-2">还没有拍：先有镜头才有曲线。</li>
            )}
          </ul>

          {fillPlan && fillPlan.outOfCut > 0 && (
            <p className="mt-1.5 text-[8.5px] leading-[1.6] text-muted-2">
              还有 {fillPlan.outOfCut} 拍在成片时间线之外：分镜排好了，初剪还没把镜头排进来，
              这一段暂时铺不了配乐。
            </p>
          )}
          {fillPlan && fillPlan.overflow && (
            <p className="mt-1.5 text-[8.5px] leading-[1.6] text-pick">
              渲染清单最多 4 条配乐：按曲线铺会多出 {fillPlan.skipped} 段，先合并相邻的拍。
            </p>
          )}
          {curve.misaligned.length > 0 && (
            <p className="mt-1.5 text-[8.5px] leading-[1.6] text-muted-2">
              {curve.misaligned.length} 条配乐的起点没落在拍边界上（
              {curve.misaligned
                .slice(0, 2)
                .map((item) => `${item.title} ${timecode(item.startMs)}→${timecode(item.nearestBeatMs)}`)
                .join("、")}
              ）：不拦，但换拍之后这里会对不上。
            </p>
          )}

          <MotifSection
            project={project}
            readOnly={readOnly}
            onUpsert={onUpsertMotif}
            onRemove={onRemoveMotif}
          />

          <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[8.5px] leading-[1.6] text-muted-2">
              曲线的状态按 SOUND.md 第五节的表查：钩子进、铺垫铺、升级推、转折落、高潮峰、收束收、尾钩留未解决。
              它不知道具体剧情，作者可以不照做。
            </p>
            {project.timeline.music.length > 0 && (
              <span className="tnum shrink-0 text-[8.5px] text-muted-2">
                {project.timeline.music.length} / 4 条配乐
              </span>
            )}
          </div>

          {project.timeline.music.length > 0 && (
            <ul className="mt-1.5 border-t border-line">
              {project.timeline.music.map((cue) => (
                <li key={cue.id} className="flex flex-wrap items-center gap-2 border-b border-line py-1.5">
                  <span className="min-w-0 flex-1 truncate text-[9.5px] text-muted">{cue.title}</span>
                  <label className="flex items-center gap-1 text-[8.5px] text-muted-2">
                    作用
                    <select
                      value={cue.role}
                      disabled={readOnly}
                      onChange={(event) =>
                        onUpdateCue(
                          { role: event.target.value as MusicCue["role"] },
                          cue.id,
                        )
                      }
                      className="rounded-token border border-line bg-transparent px-1 py-0.5 text-[9px] text-text focus:border-line-2 focus:outline-none"
                    >
                      <option value="bed" className="bg-surface">
                        铺底
                      </option>
                      <option value="hit" className="bg-surface">
                        重音
                      </option>
                      <option value="transition" className="bg-surface">
                        转场
                      </option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1 text-[8.5px] text-muted-2">
                    动机
                    <select
                      value={cue.motifId ?? ""}
                      disabled={readOnly || project.motifs.length === 0}
                      onChange={(event) =>
                        onUpdateCue({ motifId: event.target.value }, cue.id)
                      }
                      className="max-w-[120px] rounded-token border border-line bg-transparent px-1 py-0.5 text-[9px] text-text focus:border-line-2 focus:outline-none disabled:opacity-40"
                    >
                      <option value="" className="bg-surface">
                        无
                      </option>
                      {project.motifs.map((motif) => (
                        <option key={motif.id} value={motif.id} className="bg-surface">
                          {motif.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** 色块条：按拍宽铺一条，色块 = 建议状态，底部细条 = cue 实占 */
function CurveBar({ project }: { project: Project }) {
  const curve = analyzeMusicCurve(project);
  if (curve.totalMs === 0) return null;
  return (
    <div className="mt-2">
      <div className="flex h-[18px] w-full overflow-hidden rounded-token border border-line">
        {curve.lines.map((line) => (
          <span
            key={line.beatId}
            title={`${MUSIC_STATE_LABEL[line.state]} · ${fmtSec(line.durationMs)} · ${
              !line.inCut
                ? "成片之外"
                : line.silent
                  ? "留白"
                  : line.cues.map((cue) => cue.title).join("、")
            }`}
            className={cn(
              "relative block h-full border-r border-bg/40 last:border-r-0",
              !line.inCut && "border-dashed",
            )}
            style={{
              width: `${(line.durationMs / curve.totalMs) * 100}%`,
              background: STATE_TONE[line.state],
              opacity: !line.inCut ? 0.25 : line.silent ? 0.55 : 1,
            }}
          >
            <span className="absolute inset-0 flex items-center justify-center text-[8px] text-bg/80">
              {MUSIC_STATE_LABEL[line.state]}
            </span>
          </span>
        ))}
      </div>
      <div className="relative mt-1 h-[3px] w-full rounded-full bg-line">
        {project.timeline.music.map((cue) => (
          <span
            key={cue.id}
            title={`${cue.title} ${timecode(cue.startMs)}–${timecode(cue.startMs + cue.durationMs)}`}
            className="absolute top-0 block h-full rounded-full bg-muted"
            style={{
              left: `${Math.min(100, (cue.startMs / curve.totalMs) * 100)}%`,
              width: `${Math.min(100, (cue.durationMs / curve.totalMs) * 100)}%`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function MotifSection({
  project,
  readOnly,
  onUpsert,
  onRemove,
}: {
  project: Project;
  readOnly: boolean;
  onUpsert: (input: Omit<Motif, "id"> & { id?: string }) => boolean;
  onRemove: (motifId: string) => void;
}) {
  const audioAssets = project.assets.filter((asset) => asset.kind === "audio");
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [targetKind, setTargetKind] = useState<Motif["targetKind"]>("character");
  const [targetId, setTargetId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [license, setLicense] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const targets = useMemo(() => {
    if (targetKind === "character") {
      return project.characters.map((item) => ({ id: item.id, name: item.name }));
    }
    if (targetKind === "location") {
      return project.locations.map((item) => ({ id: item.id, name: item.name }));
    }
    return project.story.relationships.map((item) => {
      const from = project.characters.find((c) => c.id === item.fromCharacterId)?.name ?? item.fromCharacterId;
      const to = project.characters.find((c) => c.id === item.toCharacterId)?.name ?? item.toCharacterId;
      return { id: `${item.fromCharacterId}->${item.toCharacterId}`, name: `${from} ↔ ${to}` };
    });
  }, [project, targetKind]);

  const submit = () => {
    setError("");
    if (!label.trim()) return setError("先给动机起个名字，例如「林晚的灯」。");
    if (!targetId) return setError("选一个对象：人物 / 关系 / 地点。");
    if (!assetId) return setError("选一段音频素材。");
    if (!license.trim()) return setError("写清授权来源，与配乐同一口径。");
    const ok = onUpsert({
      label,
      targetKind,
      targetId,
      assetId,
      licenseRef: license,
      note,
    });
    if (ok) {
      setCreating(false);
      setLabel("");
      setTargetId("");
      setAssetId("");
      setLicense("");
      setNote("");
    }
  };

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[10px] tracking-[.06em] text-text">主题动机</h4>
        <span className="tnum text-[8.5px] text-muted-2">{project.motifs.length} 个</span>
      </div>
      <p className="mt-1 text-[8.5px] leading-[1.6] text-muted-2">
        一段可循环的短素材，代表一个人 / 一对关系 / 一个地点。第一版只做原样重复，变奏等 C4 生成音乐之后。
      </p>

      {project.motifs.length > 0 && (
        <ul className="mt-1.5 border-t border-line">
          {project.motifs.map((motif) => {
            const usage = motifUsage(project, motif.id);
            const target = motifTargetLabel(project, motif);
            return (
              <li key={motif.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-line py-1.5">
                <span className="text-[9.5px] text-text">{motif.label}</span>
                <span className="text-[8.5px] text-muted-2">
                  {MOTIF_TARGET_LABEL[motif.targetKind]} ·{" "}
                  {target ?? <span className="text-pick">目标已删</span>}
                </span>
                <span className="tnum min-w-0 flex-1 text-[8.5px] text-muted-2">
                  已用 {usage.cues} 处{usage.cues > 0 ? ` · ${fmtSec(usage.durationMs)}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(motif.id)}
                  disabled={readOnly}
                  className="shrink-0 rounded-token border border-line px-1.5 py-px text-[8.5px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-pick enabled:hover:text-pick disabled:opacity-40"
                >
                  删
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!creating ? (
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={readOnly || audioAssets.length === 0}
          title={
            audioAssets.length === 0
              ? "先导入一条配乐或音频素材"
              : "新建一个主题动机"
          }
          className="mt-1.5 rounded-token border border-line px-2 py-0.5 text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          ＋ 新建动机
        </button>
      ) : (
        <div className="mt-1.5 space-y-1.5 rounded-token border border-line p-2">
          <div className="grid gap-1.5 sm:grid-cols-2">
            <label className="flex flex-col gap-0.5 text-[8.5px] text-muted-2">
              名字
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="林晚的灯"
                aria-label="动机名字"
                className="rounded-token border border-line bg-transparent px-1.5 py-1 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[8.5px] text-muted-2">
              代表
              <select
                value={targetKind}
                onChange={(event) => {
                  setTargetKind(event.target.value as Motif["targetKind"]);
                  setTargetId("");
                }}
                aria-label="动机对象类型"
                className="rounded-token border border-line bg-transparent px-1 py-1 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
              >
                <option value="character" className="bg-surface">
                  人物
                </option>
                <option value="relationship" className="bg-surface">
                  关系
                </option>
                <option value="location" className="bg-surface">
                  地点
                </option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5 text-[8.5px] text-muted-2">
              哪一个
              <select
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                aria-label="动机目标"
                className="rounded-token border border-line bg-transparent px-1 py-1 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
              >
                <option value="" className="bg-surface">
                  —
                </option>
                {targets.map((item) => (
                  <option key={item.id} value={item.id} className="bg-surface">
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5 text-[8.5px] text-muted-2">
              音频
              <select
                value={assetId}
                onChange={(event) => setAssetId(event.target.value)}
                aria-label="动机音频"
                className="rounded-token border border-line bg-transparent px-1 py-1 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
              >
                <option value="" className="bg-surface">
                  —
                </option>
                {audioAssets.map((asset) => (
                  <option key={asset.id} value={asset.id} className="bg-surface">
                    {asset.id} · {asset.durationMs ? fmtSec(asset.durationMs) : "时长未知"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-0.5 text-[8.5px] text-muted-2">
            授权来源（必填）
            <input
              value={license}
              onChange={(event) => setLicense(event.target.value)}
              placeholder="自己录制 / 曲库授权书编号"
              aria-label="动机授权来源"
              className="rounded-token border border-line bg-transparent px-1.5 py-1 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-0.5 text-[8.5px] text-muted-2">
            备注（可选）
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="用在哪几场、怎么变"
              aria-label="动机备注"
              className="rounded-token border border-line bg-transparent px-1.5 py-1 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
            />
          </label>
          {error && <p className="text-[8.5px] text-pick">{error}</p>}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={submit}
              className="rounded-token border border-line-2 px-2 py-0.5 text-[9px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
            >
              存下动机
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setError("");
              }}
              className="rounded-token border border-line px-2 py-0.5 text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {audioAssets.length === 0 && (
        <p className="mt-1 text-[8.5px] leading-[1.6] text-muted-2">
          动机要挂一段音频：先在上面加一条配乐，或导入一段短素材。
        </p>
      )}
    </div>
  );
}
