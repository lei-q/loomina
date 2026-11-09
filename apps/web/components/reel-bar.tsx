import { Scene } from "@/components/scene";
import { CheckIcon, RedoIcon } from "@/components/icons";
import type { Project, Shot } from "@/lib/demo";
import { cn } from "@/lib/utils";

function Cell({ shot, current }: { shot: Shot; current: boolean }) {
  return (
    <button
      type="button"
      title={`${shot.no} · ${shot.action}`}
      aria-current={current ? "true" : undefined}
      className={cn(
        "relative aspect-[9/16] h-[80px] shrink-0 overflow-hidden rounded-[1px] border border-white/[.06] bg-surface",
        "transition-opacity duration-[var(--dur)] hover:opacity-100",
        shot.state === "reject" ? "opacity-70" : "opacity-100",
      )}
    >
      <Scene kind={shot.scene} className="h-full w-full" />

      {shot.state === "reject" && <span className="absolute inset-0 bg-black/50" />}

      <span className="tnum absolute bottom-1 left-1 text-[7.5px] text-white/55">
        {String(shot.no).padStart(2, "0")}
      </span>

      {shot.state === "pick" && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-pick" />}
      {shot.state === "reject" && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-reject" />}
      {current && <span className="absolute inset-0 outline outline-1 -outline-offset-1 outline-text" />}
    </button>
  );
}

export function ReelBar({ project }: { project: Project }) {
  const current = project.shots[project.current]!;

  return (
    <footer className="shrink-0 border-t border-line">
      {/* 整条片子常驻：一格一格等比，不折叠 */}
      <div className="reel-scroll h-[104px] overflow-x-auto px-5">
        <div className="mx-auto flex h-full w-max items-center gap-[5px]">
          {project.shots.map((shot) => (
            <Cell key={shot.no} shot={shot} current={shot.no === current.no} />
          ))}
        </div>
      </div>

      {/* 一句话指令 + 两个动作，重做永远带价 */}
      <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
        <label className="flex flex-1 items-center gap-2.5 rounded-token border border-line bg-surface px-3 py-2 focus-within:border-line-2">
          <span className="tnum shrink-0 text-[9px] text-muted-2">SH-{String(current.no).padStart(2, "0")}</span>
          <input
            type="text"
            placeholder="说哪里不对：太暗了 · 换个角度 · 她笑得太早了"
            className="w-full bg-transparent text-[12.5px] text-text placeholder:text-muted-2 focus:outline-none"
          />
          <kbd className="tnum shrink-0 text-[9px] text-muted-2">⌘⏎</kbd>
        </label>

        <button
          type="button"
          className="flex items-center gap-1.5 rounded-token border border-line px-3 py-2 text-[12px] text-text transition-colors duration-[var(--dur)] hover:border-line-2"
        >
          <RedoIcon className="h-3.5 w-3.5" />
          重做
          <span className="tnum text-[9px] text-muted">¥{project.requote.toFixed(2)}</span>
        </button>

        <button
          type="button"
          className="flex items-center gap-1.5 rounded-token bg-text px-3 py-2 text-[12px] text-bg transition-opacity duration-[var(--dur)] hover:opacity-85"
        >
          <CheckIcon className="h-3.5 w-3.5" />
          留用
        </button>
      </div>
    </footer>
  );
}
