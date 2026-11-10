import { useState } from "react";
import type { Frame } from "@loomina/pipeline";
import { Scene } from "@/components/scene";
import { shotLabel, type StageShot, type StageView } from "@/lib/read-model";
import { cn } from "@/lib/utils";

const FRAME = "h-[min(56vh,500px)] aspect-[9/16]";

function Neighbour({ shot }: { shot: StageShot }) {
  return (
    <figure className="hidden shrink-0 flex-col items-center gap-2 lg:flex">
      <figcaption className="tnum text-[9px] text-muted-2">{shotLabel(shot.no)}</figcaption>
      <div className={cn(FRAME, "relative overflow-hidden rounded-token border border-white/[.06] bg-surface opacity-[.48]")}>
        {shot.keyframeUri ? (
          <img src={shot.keyframeUri} alt={`${shotLabel(shot.no)} 首帧`} className="h-full w-full object-cover" />
        ) : (
          <Scene kind={shot.art} className="h-full w-full" />
        )}
      </div>
    </figure>
  );
}

const FRAME_LABEL: Record<Frame, string> = { first: "首帧", last: "尾帧" };

const TAKE_STATUS_CN: Record<string, string> = {
  approved: "留用",
  rejected: "淘汰",
  draft: "待定",
};

function Current({
  shot,
  subtitle,
  generating,
  generatingVideo,
  quoteCny,
  videoCnyPerSecond,
  characters,
  props,
  scenePropIds,
  readOnly,
  onGenerate,
  onGenerateVideo,
  onAttachVideo,
  onRemoveNote,
  onToggleCharacter,
  onToggleProp,
  onMoveCharacter,
  onMoveProp,
}: {
  shot: StageShot;
  subtitle: string;
  /** 这一镜哪一帧正在生成（两帧可以同时跑，ADR-0038） */
  generating: Frame | null;
  /** 这一镜正在出视频（ADR-0083） */
  generatingVideo: boolean;
  /** 生成一张要多少钱；价目不知道就不给（ADR-0035） */
  quoteCny?: number;
  /** 出视频一秒钟要多少钱；不知道就不给（ADR-0083） */
  videoCnyPerSecond?: number;
  /** 全部人物：给这一镜点名（ADR-0065） */
  characters: { id: string; name: string }[];
  /** 全部道具：给这一镜点名（ADR-0066） */
  props: { id: string; name: string }[];
  /** 这一场里出现过的道具：道具签可以只列这些（ADR-0078） */
  scenePropIds: string[];
  readOnly: boolean;
  onGenerate: (frame: Frame) => void;
  onGenerateVideo: () => void;
  /** 贴一条视频地址当 take：供应商不通时的兜底（ADR-0083） */
  onAttachVideo: (uri: string) => void;
  onRemoveNote: (note: string) => void;
  onToggleCharacter: (characterId: string) => void;
  onToggleProp: (propId: string) => void;
  onMoveCharacter: (characterId: string, delta: -1 | 1) => void;
  onMoveProp: (propId: string, delta: -1 | 1) => void;
}) {
  // 出场的人按点名顺序排在前面：顺序就是提示词里的顺序（ADR-0077）
  const ordered = [
    ...shot.characterIds.flatMap((id) => characters.filter((character) => character.id === id)),
    ...characters.filter((character) => !shot.characterIds.includes(character.id)),
  ];
  const orderedProps = [
    ...shot.propIds.flatMap((id) => props.filter((prop) => prop.id === id)),
    ...props.filter((prop) => !shot.propIds.includes(prop.id)),
  ];
  // 道具签只列这一场用过的：道具一多，一排签会盖住舞台（ADR-0078）
  const [sceneOnly, setSceneOnly] = useState(false);
  const visibleProps = sceneOnly
    ? orderedProps.filter((prop) => scenePropIds.includes(prop.id))
    : orderedProps;
  // 正在看哪一帧 / 哪一拍：首帧是视频的起点，尾帧是落点（ADR-0038 / ADR-0083）
  const [shown, setShown] = useState<Frame | "video">("first");
  // 多 Take 时点某一拍就切到那一拍；没点就跟随最近一拍
  const [shownTakeId, setShownTakeId] = useState<string | undefined>();
  const [draftUri, setDraftUri] = useState("");
  const frames: Array<{ key: Frame; uri?: string; has: boolean }> = [
    { key: "first", uri: shot.keyframeUri, has: shot.hasKeyframe },
    { key: "last", uri: shot.lastKeyframeUri, has: shot.hasLastFrame },
  ];
  const shownFrame: Frame = shown === "video" ? "first" : shown;
  const shownUri = shownFrame === "first" ? shot.keyframeUri : shot.lastKeyframeUri;
  const shownHas = shownFrame === "first" ? shot.hasKeyframe : shot.hasLastFrame;
  // 出图之后画面输入改过：这一帧已经对不上这一镜（ADR-0057）
  const shownStale = shownFrame === "first" ? shot.staleFirst : shot.staleLast;
  const staleOf = (frame: Frame) => (frame === "first" ? shot.staleFirst : shot.staleLast);
  // 看视频时默认看最近一只有片的 take；点某一拍的签就看那一拍
  const latestTakeWithVideo = [...shot.takes].reverse().find((take) => take.uri);
  const displayTake =
    shot.takes.find((take) => take.id === shownTakeId) ?? latestTakeWithVideo;
  const videoUri = displayTake?.uri;
  const videoShown = shown === "video";
  const hasAnyVideo = shot.takes.some((take) => take.uri);
  const videoQuote =
    videoCnyPerSecond === undefined ? undefined : shot.dur * videoCnyPerSecond;

  return (
    <figure className="flex shrink-0 flex-col items-center gap-2">
      <figcaption className="tnum flex items-baseline gap-2 text-[9px] text-muted">
        <b className="font-medium text-text">{shotLabel(shot.no)}</b>
        <span className="text-muted-2">
          {shot.size} · {shot.angle}
        </span>
        <span>{shot.dur.toFixed(1)}s</span>
        <span className="text-muted-2">TAKE {shot.take ?? "—"}</span>
      </figcaption>

      <div className={cn(FRAME, "relative overflow-hidden rounded-token border border-white/[.075] bg-surface")}>
        {videoShown && videoUri ? (
          <video
            src={videoUri}
            poster={shot.keyframeUri}
            controls
            playsInline
            loop
            className="h-full w-full object-cover"
          />
        ) : shownUri ? (
          <img
            src={shownUri}
            alt={`${shotLabel(shot.no)} ${FRAME_LABEL[shownFrame]}`}
            className="h-full w-full object-cover"
          />
        ) : (
          <Scene kind={shot.art} className="h-full w-full" />
        )}

        {!videoShown && shownStale && generating !== shownFrame && (
          <span
            title={`${FRAME_LABEL[shownFrame]}出图之后改过：${shownStale.reasons.join("、")}，建议重生成`}
            className="absolute bottom-1.5 left-1.5 rounded-[1px] bg-pick/85 px-1 text-[8.5px] leading-[1.5] text-white"
          >
            过期
          </span>
        )}

        {!videoShown && generating === shownFrame && (
          <span className="absolute inset-0 grid place-items-center bg-bg/75 text-[11px] text-text">
            生成中…
          </span>
        )}

        {videoShown && generatingVideo && (
          <span className="absolute inset-0 grid place-items-center bg-bg/75 px-6 text-center text-[11px] leading-[1.8] text-text">
            出片中… 一两分钟，别关页面
          </span>
        )}

        {videoShown && !videoUri && !generatingVideo && (
          <span className="absolute inset-0 grid place-items-center bg-bg/60 px-6 text-center text-[10.5px] leading-[1.8] text-muted">
            这一镜还没有片子：出一次视频，或在下面贴一条地址
          </span>
        )}

        {/* 字幕烧在画面里：审片时看到的就是观众看到的；放视频时让开原生控件（ADR-0083） */}
        <p
          className={cn(
            "absolute inset-x-[8%] text-center text-[15px] leading-[1.45] text-white [text-shadow:0_1px_3px_rgba(0,0,0,.9)]",
            videoShown ? "bottom-[16%]" : "bottom-[6%]",
          )}
        >
          {subtitle}
        </p>
      </div>

      {/* 多 Take：每一拍的状态与钱都摆出来，点一下看那一拍（ADR-0083） */}
      {shot.takes.length > 0 && (
        <div className="flex max-w-[360px] flex-wrap items-center justify-center gap-x-1.5 gap-y-1">
          <span className="tnum text-[9px] tracking-[.14em] text-muted-2">TAKE</span>
          {shot.takes.map((take) => {
            const active = displayTake?.id === take.id && videoShown;
            return (
              <button
                key={take.id}
                type="button"
                aria-pressed={active}
                disabled={!take.uri}
                onClick={() => {
                  setShownTakeId(take.id);
                  setShown("video");
                }}
                title={
                  take.uri
                    ? `看第 ${take.no} 拍 · ${TAKE_STATUS_CN[take.status] ?? take.status}`
                    : `第 ${take.no} 拍还没有片子`
                }
                className={cn(
                  "tnum flex items-baseline gap-1 rounded-[1px] border px-1.5 py-[1px] text-[9.5px] transition-colors duration-[var(--dur)]",
                  active
                    ? "border-line-2 bg-surface text-text"
                    : "border-line text-muted-2 hover:border-line-2 hover:text-text",
                  "disabled:pointer-events-none disabled:opacity-35",
                )}
              >
                <span>{take.no}</span>
                <span className="text-[8.5px] text-muted-2">
                  {TAKE_STATUS_CN[take.status] ?? take.status}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* 首尾两帧并排选：点哪格，大画面就看哪一帧（ADR-0038） */}
      <div className="flex items-center gap-2">
        <div role="group" aria-label="关键帧与视频" className="flex items-end gap-1.5">
          {/* 视频格：一直摆着，没片子时点进去走「出视频 / 贴地址」（ADR-0083） */}
          <button
            type="button"
            aria-pressed={videoShown}
            onClick={() => setShown("video")}
            title={hasAnyVideo ? "看这一镜的片子" : "这一镜还没有片子：出视频，或贴一条地址"}
            className="group flex flex-col items-center gap-1"
          >
            <span
              className={cn(
                "relative block h-14 aspect-[9/16] overflow-hidden rounded-[2px] border bg-surface transition-colors duration-[var(--dur)]",
                videoShown
                  ? "border-line-2"
                  : "border-line opacity-60 group-hover:opacity-90",
                !hasAnyVideo && "border-dashed",
              )}
            >
              {shot.keyframeUri ? (
                <img src={shot.keyframeUri} alt="" className="h-full w-full object-cover" />
              ) : (
                <Scene kind={shot.art} className="h-full w-full" />
              )}
              <span
                className={cn(
                  "absolute inset-0 grid place-items-center text-[13px] text-white",
                  hasAnyVideo ? "bg-black/35" : "bg-black/55 text-muted-2",
                )}
              >
                ▶
              </span>
              {generatingVideo && (
                <span className="absolute inset-0 grid place-items-center bg-bg/75 text-[8px] text-text">
                  ……
                </span>
              )}
            </span>
            <span className={cn("text-[9px]", videoShown ? "text-text" : "text-muted-2")}>
              视频
            </span>
          </button>

          {frames.map((frame) => (
            <button
              key={frame.key}
              type="button"
              aria-pressed={shown === frame.key}
              onClick={() => setShown(frame.key)}
              className="group flex flex-col items-center gap-1"
            >
              <span
                className={cn(
                  "relative block h-14 aspect-[9/16] overflow-hidden rounded-[2px] border bg-surface transition-colors duration-[var(--dur)]",
                  shown === frame.key
                    ? "border-line-2"
                    : "border-line opacity-60 group-hover:opacity-90",
                )}
              >
                {frame.uri ? (
                  <img src={frame.uri} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Scene kind={shot.art} className="h-full w-full" />
                )}
                {generating === frame.key && (
                  <span className="absolute inset-0 grid place-items-center bg-bg/75 text-[8px] text-text">
                    ……
                  </span>
                )}
                {staleOf(frame.key) && (
                  <span
                    title={`出图之后改过：${staleOf(frame.key)?.reasons.join("、")}，这一帧已对不上`}
                    className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-pick"
                  />
                )}
              </span>
              <span
                className={cn(
                  "text-[9px]",
                  shown === frame.key ? "text-text" : "text-muted-2",
                )}
              >
                {FRAME_LABEL[frame.key]}
              </span>
            </button>
          ))}
        </div>

        <span className="h-8 w-px bg-line" />

        {videoShown ? (
          generatingVideo ? (
            <span className="tnum text-[10px] text-muted">出片中 · 一两分钟</span>
          ) : shot.locked ? (
            <span className="tnum text-[10px] text-muted-2">镜头已锁定 · 只读</span>
          ) : (
            <div className="flex flex-col items-start gap-1.5">
              <button
                type="button"
                onClick={onGenerateVideo}
                title={
                  shot.hasKeyframe
                    ? "从首帧出视频：重拍会多一拍 take，不覆盖旧的"
                    : "先出一张首帧，才能让它动起来"
                }
                disabled={!shot.hasKeyframe}
                className="tnum flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:pointer-events-none disabled:opacity-40"
              >
                {hasAnyVideo ? "重拍视频" : "出视频"}
                {videoQuote !== undefined && (
                  <span className="text-[9px] text-muted-2">¥{videoQuote.toFixed(2)}</span>
                )}
              </button>

              {/* 供应商配额不通时的兜底：贴一条已经有片子的地址（ADR-0083） */}
              <details className="text-[9.5px] text-muted-2">
                <summary className="cursor-pointer select-none hover:text-muted">贴视频地址导入</summary>
                <form
                  className="mt-1 flex items-center gap-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!draftUri.trim()) return;
                    onAttachVideo(draftUri);
                    setDraftUri("");
                  }}
                >
                  <input
                    type="text"
                    value={draftUri}
                    onChange={(event) => setDraftUri(event.target.value)}
                    placeholder="https://… 或 data:video/mp4;base64,…"
                    className="w-[190px] rounded-token border border-line bg-surface px-2 py-1 text-[9.5px] text-text placeholder:text-muted-2 focus:border-line-2 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={!draftUri.trim()}
                    title="当作一拍 take 挂到这一镜上：不花钱，也不改首尾帧"
                    className="rounded-token border border-line px-2 py-1 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
                  >
                    导入
                  </button>
                </form>
              </details>
            </div>
          )
        ) : generating === shown ? (
          <span className="tnum text-[10px] text-muted">生成中 · {FRAME_LABEL[shown]}</span>
        ) : shot.locked ? (
          <span className="tnum text-[10px] text-muted-2">镜头已锁定 · 只读</span>
        ) : (
          <button
            type="button"
            onClick={() => onGenerate(shown)}
            className="tnum flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            {shownHas ? "重生成" : "生成"}
            {FRAME_LABEL[shown]}
            {quoteCny !== undefined && (
              <span className="text-[9px] text-muted-2">¥{quoteCny.toFixed(2)}</span>
            )}
          </button>
        )}
      </div>

      {/* 真正送出的提示词：说了什么、改了什么，在这里对得上（ADR-0040） */}
      <details className="max-w-[340px] text-[9.5px] text-muted-2">
        <summary className="cursor-pointer select-none hover:text-muted">这一镜会送出的提示词</summary>
        <p className="mt-1 max-h-[8.5rem] overflow-y-auto whitespace-pre-wrap text-[10px] leading-[1.7] text-muted-2">
          {videoShown
            ? shot.prompts.video
            : shown === "first"
              ? shot.prompts.first
              : shot.prompts.last}
        </p>
      </details>

      {/* 一句话指令改出来的补充要求：说过什么要看得见（ADR-0039） */}
      {shot.notes.length > 0 && (
        <div className="flex max-w-[340px] flex-wrap items-center justify-center gap-x-2 gap-y-1">
          <span className="tnum text-[9px] tracking-[.14em] text-muted-2">补充</span>
          {shot.notes.map((note) => (
            <span
              key={note}
              className="flex items-center gap-1 rounded-[1px] border border-dashed border-line px-1.5 py-[1px] text-[10px] text-muted"
            >
              {note}
              {!shot.locked && (
                <button
                  type="button"
                  aria-label={`划掉补充：${note}`}
                  onClick={() => onRemoveNote(note)}
                  className="text-[10px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-pick"
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* 这一镜里有谁：点名即出场，锚点与提示词立刻跟上（ADR-0065） */}
      {/* 已经出场的人按出场顺序排在前面——顺序就是提示词里的顺序（ADR-0077） */}
      <div className="flex max-w-[360px] flex-wrap items-center justify-center gap-x-2 gap-y-1">
        <span className="tnum text-[9px] tracking-[.14em] text-muted-2">出场</span>
        {ordered.map((character) => {
          const present = shot.characterIds.includes(character.id);
          const disabled = readOnly || shot.locked;
          const at = shot.characterIds.indexOf(character.id);
          return (
            <span
              key={character.id}
              className={cn(
                "flex items-center rounded-token border text-[10px] transition-colors duration-[var(--dur)]",
                present
                  ? "border-line-2 bg-surface text-text"
                  : "border-line text-muted-2 hover:border-line-2 hover:text-text",
              )}
            >
              <button
                type="button"
                aria-pressed={present}
                disabled={disabled}
                onClick={() => onToggleCharacter(character.id)}
                title={
                  shot.locked
                    ? "这一镜已锁定，先解锁再改出场人物"
                    : present
                      ? `把${character.name}从这一镜里拿掉`
                      : `让${character.name}出现在这一镜里`
                }
                className={cn(
                  "rounded-token py-[1px] pl-2 text-[10px] transition-colors duration-[var(--dur)]",
                  present && !disabled && shot.characterIds.length > 1 ? "pr-1" : "pr-2",
                  "disabled:cursor-default disabled:opacity-40",
                )}
              >
                {character.name}
              </button>
              {present && !disabled && shot.characterIds.length > 1 && (
                <span className="flex items-center gap-px border-l border-line pl-0.5 pr-0.5">
                  <button
                    type="button"
                    aria-label={`把${character.name}往前挪`}
                    disabled={at === 0}
                    onClick={() => onMoveCharacter(character.id, -1)}
                    title="往前挪一位：他在提示词里排得更前"
                    className="px-0.5 text-[10px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-text disabled:opacity-25"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    aria-label={`把${character.name}往后挪`}
                    disabled={at === shot.characterIds.length - 1}
                    onClick={() => onMoveCharacter(character.id, 1)}
                    title="往后挪一位：他在提示词里排得更后"
                    className="px-0.5 text-[10px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-text disabled:opacity-25"
                  >
                    ›
                  </button>
                </span>
              )}
            </span>
          );
        })}
        {characters.length === 0 && <span className="text-[10px] text-muted-2">还没有人物</span>}
      </div>

      {/* 这一镜里有哪些道具：与人物同一套点签，锚点会带上道具参考（ADR-0066） */}
      <div className="flex max-w-[360px] flex-wrap items-center justify-center gap-x-2 gap-y-1">
        <span className="tnum text-[9px] tracking-[.14em] text-muted-2">道具</span>
        {props.length > 0 && (
          <button
            type="button"
            aria-pressed={sceneOnly}
            onClick={() => setSceneOnly((on) => !on)}
            title={
              sceneOnly
                ? "现在只列这一场用过的道具：点一下列出全部"
                : "道具太多时，只列这一场用过的"
            }
            className={cn(
              "-ml-1 rounded-[1px] px-1 py-[1px] text-[9px] transition-colors duration-[var(--dur)]",
              sceneOnly
                ? "border border-line-2 text-text"
                : "border border-dashed border-line text-muted-2 hover:border-line-2 hover:text-text",
            )}
          >
            只列本场
          </button>
        )}
        {visibleProps.map((prop) => {
          const present = shot.propIds.includes(prop.id);
          const disabled = readOnly || shot.locked;
          const at = shot.propIds.indexOf(prop.id);
          return (
            <span
              key={prop.id}
              className={cn(
                "flex items-center rounded-token border text-[10px] transition-colors duration-[var(--dur)]",
                present
                  ? "border-line-2 bg-surface text-text"
                  : "border-line text-muted-2 hover:border-line-2 hover:text-text",
              )}
            >
              <button
                type="button"
                aria-pressed={present}
                disabled={disabled}
                onClick={() => onToggleProp(prop.id)}
                title={
                  shot.locked
                    ? "这一镜已锁定，先解锁再改出场道具"
                    : present
                      ? `把${prop.name}从这一镜里拿掉`
                      : `让${prop.name}出现在这一镜里`
                }
                className={cn(
                  "rounded-token py-[1px] pl-2 text-[10px] transition-colors duration-[var(--dur)]",
                  present && !disabled && shot.propIds.length > 1 ? "pr-1" : "pr-2",
                  "disabled:cursor-default disabled:opacity-40",
                )}
              >
                {prop.name}
              </button>
              {present && !disabled && shot.propIds.length > 1 && (
                <span className="flex items-center gap-px border-l border-line pl-0.5 pr-0.5">
                  <button
                    type="button"
                    aria-label={`把${prop.name}往前挪`}
                    disabled={at === 0}
                    onClick={() => onMoveProp(prop.id, -1)}
                    title="往前挪一位：它在提示词里排得更前"
                    className="px-0.5 text-[10px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-text disabled:opacity-25"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    aria-label={`把${prop.name}往后挪`}
                    disabled={at === shot.propIds.length - 1}
                    onClick={() => onMoveProp(prop.id, 1)}
                    title="往后挪一位：它在提示词里排得更后"
                    className="px-0.5 text-[10px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-text disabled:opacity-25"
                  >
                    ›
                  </button>
                </span>
              )}
            </span>
          );
        })}
        {props.length === 0 && <span className="text-[10px] text-muted-2">还没有道具</span>}
        {props.length > 0 && visibleProps.length === 0 && (
          <span className="text-[10px] text-muted-2">这一场还没用过道具。点「只列本场」列全部。</span>
        )}
      </div>

      {/* 这一镜带进生成的参考图：审片时就知道生成靠什么钉住（ADR-0029） */}
      {(shot.anchors.labels.length > 0 || shot.anchors.missing.length > 0) && (
        <div className="flex max-w-[340px] flex-wrap items-center justify-center gap-x-2.5 gap-y-1">
          <span className="tnum text-[9px] tracking-[.14em] text-muted-2">锚点</span>
          {shot.anchors.labels.map((label) => (
            <span key={label} className="text-[10px] text-muted">
              {label}
            </span>
          ))}
          {shot.anchors.missing.map((item) => (
            <span
              key={item}
              className="rounded-[1px] border border-dashed border-line-2 px-1.5 py-[1px] text-[9.5px] text-muted-2"
            >
              缺 {item}
            </span>
          ))}
        </div>
      )}
    </figure>
  );
}

export type StageProps = {
  view: StageView;
  /** 当前镜哪一帧在生成 */
  generating: Frame | null;
  /** 当前镜正在出视频（ADR-0083） */
  generatingVideo: boolean;
  /** 生成一张要多少钱；价目不知道就不给 */
  quoteCny?: number;
  /** 出一秒视频要多少钱；价目不知道就不给 */
  videoCnyPerSecond?: number;
  readOnly: boolean;
  onGenerateKeyframe: (frame: Frame) => void;
  onGenerateVideo: () => void;
  onAttachVideo: (uri: string) => void;
  onRemoveNote: (note: string) => void;
  onToggleCharacter: (characterId: string) => void;
  onToggleProp: (propId: string) => void;
  onMoveCharacter: (characterId: string, delta: -1 | 1) => void;
  onMoveProp: (propId: string, delta: -1 | 1) => void;
};

export function Stage({
  view,
  generating,
  generatingVideo,
  quoteCny,
  videoCnyPerSecond,
  readOnly,
  onGenerateKeyframe,
  onGenerateVideo,
  onAttachVideo,
  onRemoveNote,
  onToggleCharacter,
  onToggleProp,
  onMoveCharacter,
  onMoveProp,
}: StageProps) {
  const current = view.shots[view.current]!;
  const prev = view.shots[view.current - 1];
  const next = view.shots[view.current + 1];
  // 这一场里出现过的道具：只列本场时用（ADR-0078）
  const scenePropIds = [
    ...new Set(
      view.shots
        .filter((shot) => shot.sceneId === current.sceneId)
        .flatMap((shot) => shot.propIds),
    ),
  ];

  return (
    // 内容比一屏高时（比如展开提示词）要能滚：用 m-auto 居中，溢出时自动贴顶
    <main className="flex min-h-0 flex-1 overflow-y-auto px-6 py-4">
      <div className="m-auto flex items-center gap-7">
        {prev && <Neighbour shot={prev} />}
        <Current
          shot={current}
          subtitle={view.subtitle}
          generating={generating}
          generatingVideo={generatingVideo}
          quoteCny={quoteCny}
          videoCnyPerSecond={videoCnyPerSecond}
          characters={view.characters}
          props={view.props}
          scenePropIds={scenePropIds}
          readOnly={readOnly}
          onGenerate={onGenerateKeyframe}
          onGenerateVideo={onGenerateVideo}
          onAttachVideo={onAttachVideo}
          onRemoveNote={onRemoveNote}
          onToggleCharacter={onToggleCharacter}
          onToggleProp={onToggleProp}
          onMoveCharacter={onMoveCharacter}
          onMoveProp={onMoveProp}
        />
        {next && <Neighbour shot={next} />}
      </div>
    </main>
  );
}
