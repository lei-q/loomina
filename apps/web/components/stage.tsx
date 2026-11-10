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

function Current({
  shot,
  subtitle,
  generating,
  quoteCny,
  onGenerate,
}: {
  shot: StageShot;
  subtitle: string;
  /** 这一镜的首帧正在生成 */
  generating: boolean;
  /** 生成一张首帧要多少钱；价目不知道就不给（ADR-0035） */
  quoteCny?: number;
  onGenerate: () => void;
}) {
  return (
    <figure className="flex shrink-0 flex-col items-center gap-2">
      <figcaption className="tnum flex items-baseline gap-2 text-[9px] text-muted">
        <b className="font-medium text-text">{shotLabel(shot.no)}</b>
        <span>{shot.dur.toFixed(1)}s</span>
        <span className="text-muted-2">TAKE {shot.take ?? "—"}</span>
      </figcaption>

      <div className={cn(FRAME, "relative overflow-hidden rounded-token border border-white/[.075] bg-surface")}>
        {shot.keyframeUri ? (
          <img src={shot.keyframeUri} alt={`${shotLabel(shot.no)} 首帧`} className="h-full w-full object-cover" />
        ) : (
          <Scene kind={shot.art} className="h-full w-full" />
        )}

        {generating && (
          <span className="absolute inset-0 grid place-items-center bg-bg/75 text-[11px] text-text">
            生成中…
          </span>
        )}

        {/* 字幕烧在画面里：审片时看到的就是观众看到的 */}
        <p className="absolute inset-x-[8%] bottom-[6%] text-center text-[15px] leading-[1.45] text-white [text-shadow:0_1px_3px_rgba(0,0,0,.9)]">
          {subtitle}
        </p>
      </div>

      {/* 首帧：视频的起点（ADR-0037）。有了图就先看它，再做后续生成 */}
      <div className="flex items-center gap-2">
        {generating ? (
          <span className="tnum text-[10px] text-muted">生成中 · 首帧</span>
        ) : shot.locked ? (
          <span className="tnum text-[10px] text-muted-2">镜头已锁定 · 只读</span>
        ) : (
          <button
            type="button"
            onClick={onGenerate}
            className="tnum flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            {shot.hasKeyframe ? "重生成首帧" : "生成首帧"}
            {quoteCny !== undefined && (
              <span className="text-[9px] text-muted-2">¥{quoteCny.toFixed(2)}</span>
            )}
          </button>
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
  /** 当前镜的首帧是否在生成 */
  generating: boolean;
  /** 生成一张首帧要多少钱；价目不知道就不给 */
  quoteCny?: number;
  onGenerateKeyframe: () => void;
};

export function Stage({ view, generating, quoteCny, onGenerateKeyframe }: StageProps) {
  const current = view.shots[view.current]!;
  const prev = view.shots[view.current - 1];
  const next = view.shots[view.current + 1];

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center gap-7 px-6 py-4">
      {prev && <Neighbour shot={prev} />}
      <Current
        shot={current}
        subtitle={view.subtitle}
        generating={generating}
        quoteCny={quoteCny}
        onGenerate={() => onGenerateKeyframe()}
      />
      {next && <Neighbour shot={next} />}
    </main>
  );
}
