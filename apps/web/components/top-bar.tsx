import Link from "next/link";
import { cn } from "@/lib/utils";
import { ExportIcon, Logomark } from "@/components/icons";

/** 阶段是一列，但只有已经做出来的两步可以点。 */
const stages = [
  { name: "故事", href: null },
  { name: "剧本", href: null },
  { name: "定妆", href: "/cast" },
  { name: "分镜", href: "/" },
  { name: "关键帧", href: null },
  { name: "声音", href: null },
  { name: "成片", href: null },
] as const;

export type StageName = (typeof stages)[number]["name"];

export type TopBarProps = {
  title: string;
  version: number;
  stage: StageName;
  spentCny?: number;
  budgetCny?: number;
};

export function TopBar({ title, version, stage, spentCny, budgetCny }: TopBarProps) {
  return (
    <header className="flex h-[46px] shrink-0 items-center gap-6 border-b border-line px-4">
      <div className="flex items-center gap-2">
        <Logomark className="h-[21px] w-[21px] text-text" />
        <span className="text-[13px] tracking-[.08em] text-text">{title}</span>
        <span className="tnum text-[9px] text-muted-2">v{version}</span>
        <span className="tnum rounded-token border border-line px-1.5 py-px text-[8.5px] text-muted-2">示例</span>
      </div>

      <nav aria-label="阶段" className="tnum hidden items-center gap-2.5 text-[10px] text-muted md:flex">
        {stages.map((item, i) => {
          const active = item.name === stage;
          return (
            <span key={item.name} className="flex items-center gap-2.5">
              {i > 0 && <span className="text-line-2">·</span>}
              {item.href ? (
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "transition-colors duration-[var(--dur)] hover:text-text",
                    active ? "text-text" : "text-muted",
                  )}
                >
                  {item.name}
                </Link>
              ) : (
                <span className={active ? "text-text" : "text-muted"}>{item.name}</span>
              )}
            </span>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-4">
        {spentCny !== undefined && (
          <span className="tnum text-[10px] text-muted">
            ¥{spentCny.toFixed(2)}
            <span className="text-muted-2"> / {budgetCny ?? 60}</span>
          </span>
        )}
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
