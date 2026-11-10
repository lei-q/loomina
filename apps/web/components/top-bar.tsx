import { cn } from "@/lib/utils";
import type { StageView } from "@/lib/read-model";
import { ExportIcon, Logomark } from "@/components/icons";

const stages = ["故事", "剧本", "分镜", "关键帧", "声音", "成片"] as const;
const currentStage = "分镜";

export function TopBar({ view }: { view: StageView }) {
  return (
    <header className="flex h-[46px] shrink-0 items-center gap-6 border-b border-line px-4">
      <div className="flex items-center gap-2">
        <Logomark className="h-[21px] w-[21px] text-text" />
        <span className="text-[13px] tracking-[.08em] text-text">{view.title}</span>
        <span className="tnum text-[9px] text-muted-2">v{view.version}</span>
        <span className="tnum rounded-token border border-line px-1.5 py-px text-[8.5px] text-muted-2">示例</span>
      </div>

      <nav aria-label="阶段" className="tnum hidden items-center gap-2.5 text-[10px] text-muted md:flex">
        {stages.map((stage, i) => (
          <span key={stage} className="flex items-center gap-2.5">
            {i > 0 && <span className="text-line-2">·</span>}
            <span className={cn(stage === currentStage ? "text-text" : "text-muted")}>{stage}</span>
          </span>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-4">
        <span className="tnum text-[10px] text-muted">
          ¥{view.spent.toFixed(2)}
          <span className="text-muted-2"> / {view.budget}</span>
        </span>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-token border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
        >
          <ExportIcon className="h-3.5 w-3.5" />
          导出
        </button>
      </div>
    </header>
  );
}
