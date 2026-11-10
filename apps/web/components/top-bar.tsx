import Link from "next/link";
import { cn } from "@/lib/utils";
import type { ProjectRequote } from "@/lib/pricing";
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
  /** 生成过但价目表里没有模型的图，算不进已花（ADR-0033） */
  unpriced?: number;
  /** 本地写入失败：如实说没存住（ADR-0034） */
  storageError?: string;
  /** 整片重做一遍的报价；给了才多一行 */
  allRequote?: ProjectRequote;
};

function Money({ value }: { value?: number }) {
  return <span className="tnum">{value === undefined ? "—" : `¥${value.toFixed(2)}`}</span>;
}

export function TopBar({
  title,
  version,
  stage,
  spentCny,
  budgetCny,
  unpriced = 0,
  storageError,
  allRequote,
}: TopBarProps) {
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
        {storageError && (
          <span
            title={storageError}
            className="tnum text-[9px] tracking-[.08em] text-pick"
          >
            未保存
          </span>
        )}
        {spentCny !== undefined && (
          <details className="relative">
            <summary className="tnum cursor-pointer list-none text-[10px] text-muted transition-colors duration-[var(--dur)] hover:text-text [&::-webkit-details-marker]:hidden">
              ¥{spentCny.toFixed(2)}
              <span className="text-muted-2"> / {budgetCny ?? 60}</span>
            </summary>

            <div className="absolute right-0 top-full z-20 mt-2.5 w-[252px] rounded-token border border-line bg-surface p-3">
              <dl className="space-y-1.5 text-[10.5px]">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-2">已花</dt>
                  <dd className="text-muted">
                    <Money value={spentCny} />
                  </dd>
                </div>
                {allRequote && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-2">全部重做一遍</dt>
                    <dd className="text-text">
                      <Money value={allRequote.totalCny} />
                    </dd>
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-2">预算</dt>
                  <dd className="text-muted">
                    <Money value={budgetCny ?? 60} />
                  </dd>
                </div>
              </dl>
              {unpriced > 0 && (
                <p className="mt-2.5 border-t border-line pt-2 text-[9px] leading-[1.5] text-muted-2">
                  另有 {unpriced} 张定妆图没有价目，没算进已花
                </p>
              )}
              {allRequote && (
                <p className="mt-2.5 border-t border-line pt-2 text-[9px] leading-[1.5] text-muted-2">
                  {allRequote.basis}
                </p>
              )}
            </div>
          </details>
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
