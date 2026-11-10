import { Scene } from "@/components/scene";
import { shotLabel, type StageShot, type StageView } from "@/lib/read-model";
import { cn } from "@/lib/utils";

const FRAME = "h-[min(56vh,500px)] aspect-[9/16]";

function Neighbour({ shot }: { shot: StageShot }) {
  return (
    <figure className="hidden shrink-0 flex-col items-center gap-2 lg:flex">
      <figcaption className="tnum text-[9px] text-muted-2">{shotLabel(shot.no)}</figcaption>
      <div className={cn(FRAME, "relative overflow-hidden rounded-token border border-white/[.06] bg-surface opacity-[.48]")}>
        <Scene kind={shot.art} className="h-full w-full" />
      </div>
    </figure>
  );
}

function Current({ shot, subtitle }: { shot: StageShot; subtitle: string }) {
  return (
    <figure className="flex shrink-0 flex-col items-center gap-2">
      <figcaption className="tnum flex items-baseline gap-2 text-[9px] text-muted">
        <b className="font-medium text-text">{shotLabel(shot.no)}</b>
        <span>{shot.dur.toFixed(1)}s</span>
        <span className="text-muted-2">TAKE {shot.take ?? "—"}</span>
      </figcaption>

      <div className={cn(FRAME, "relative overflow-hidden rounded-token border border-white/[.075] bg-surface")}>
        <Scene kind={shot.art} className="h-full w-full" />

        {/* 字幕烧在画面里：审片时看到的就是观众看到的 */}
        <p className="absolute inset-x-[8%] bottom-[6%] text-center text-[15px] leading-[1.45] text-white [text-shadow:0_1px_3px_rgba(0,0,0,.9)]">
          {subtitle}
        </p>
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

export function Stage({ view }: { view: StageView }) {
  const current = view.shots[view.current]!;
  const prev = view.shots[view.current - 1];
  const next = view.shots[view.current + 1];

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center gap-7 px-6 py-4">
      {prev && <Neighbour shot={prev} />}
      <Current shot={current} subtitle={view.subtitle} />
      {next && <Neighbour shot={next} />}
    </main>
  );
}
