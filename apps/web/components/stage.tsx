import { Scene } from "@/components/scene";
import { shotLabel, type Project, type Shot } from "@/lib/demo";
import { cn } from "@/lib/utils";

const FRAME = "h-[min(56vh,500px)] aspect-[9/16]";

function Neighbour({ shot }: { shot: Shot }) {
  return (
    <figure className="hidden shrink-0 flex-col items-center gap-2 lg:flex">
      <figcaption className="tnum text-[9px] text-muted-2">{shotLabel(shot.no)}</figcaption>
      <div className={cn(FRAME, "relative overflow-hidden rounded-token border border-white/[.06] bg-surface opacity-[.48]")}>
        <Scene kind={shot.scene} className="h-full w-full" />
      </div>
    </figure>
  );
}

function Current({ shot, subtitle }: { shot: Shot; subtitle: string }) {
  return (
    <figure className="flex shrink-0 flex-col items-center gap-2">
      <figcaption className="tnum flex items-baseline gap-2 text-[9px] text-muted">
        <b className="font-medium text-text">{shotLabel(shot.no)}</b>
        <span>{shot.dur.toFixed(1)}s</span>
        <span className="text-muted-2">TAKE 2</span>
      </figcaption>

      <div className={cn(FRAME, "relative overflow-hidden rounded-token border border-white/[.075] bg-surface")}>
        <Scene kind={shot.scene} className="h-full w-full" />

        {/* 字幕烧在画面里：审片时看到的就是观众看到的 */}
        <p className="absolute inset-x-[8%] bottom-[6%] text-center text-[15px] leading-[1.45] text-white [text-shadow:0_1px_3px_rgba(0,0,0,.9)]">
          {subtitle}
        </p>
      </div>
    </figure>
  );
}

export function Stage({ project }: { project: Project }) {
  const current = project.shots[project.current]!;
  const prev = project.shots[project.current - 1];
  const next = project.shots[project.current + 1];

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center gap-7 px-6 py-4">
      {prev && <Neighbour shot={prev} />}
      <Current shot={current} subtitle={project.subtitle} />
      {next && <Neighbour shot={next} />}
    </main>
  );
}
