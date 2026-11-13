"use client";

import type { PlatformId } from "@/lib/platforms";
import { formatSize } from "@/lib/platforms";
import type { VersionPlan } from "@/lib/multi-platform";
import { cn } from "@/lib/utils";

export type MultiPlatformPanelProps = {
  /** 每个平台这一版会出成什么形状、能不能出（G9） */
  plans: VersionPlan[];
  /** 已经勾上的平台 */
  selected: PlatformId[];
  onToggle: (platform: PlatformId) => void;
  /** 依次导出勾上的版本；返回一句人话结果 */
  onExport: () => void;
  /** 导出中：进度一句话 */
  stage?: string;
  busy: boolean;
  /** 已经导出过的那几版（这一次打开面板之后的） */
  results: { platform: PlatformId; name: string; bytes: number; fileName: string }[];
  /** 项目当前的画幅：面板头部要说清「以它为准，平台不收时自动换」 */
  frameLabel: string;
  /**
   * 内容侧没过（文案硬阻断 / 待确认没勾）：平台规格不在这里算，每个平台各自判。
   * 有值就禁掉导出并原样说出来。
   */
  gateReason?: string;
  readOnly?: boolean;
  onClose: () => void;
};

/**
 * 多平台版本渲染（G9 / ADR-0171）。
 *
 * 一条片子发几个平台，就按几个平台的规格各出一版：形状跟着平台走，
 * 角标位置也跟着平台走（`badgePlacementOf` 同一张表）。一次勾选、一次点导出，
 * 依次渲完、依次下载——不并发，因为本机渲染队列同一时间只跑一条。
 */
export function MultiPlatformPanel({
  plans,
  selected,
  onToggle,
  onExport,
  stage,
  busy,
  results,
  frameLabel,
  gateReason,
  readOnly = false,
  onClose,
}: MultiPlatformPanelProps) {
  const usable = plans.filter((plan) => selected.includes(plan.platform) && !plan.blocker);
  const blocked = plans.filter((plan) => selected.includes(plan.platform) && plan.blocker);
  const changed = usable.filter((plan) => plan.changesFrame);

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="多平台版本"
        className="flex h-full w-[460px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">多平台版本</h2>
            <span className="tnum text-[9px] text-muted-2">
              {usable.length} 版 · 当前 {frameLabel}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-token border border-line px-2 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            关闭
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <p className="text-[9.5px] leading-[1.7] text-muted-2">
            勾几个平台就出几版：形状按平台规格走，角标位置也跟着平台换。
            一次只渲一版（本机渲染队列同一时间只跑一条），几版依次渲完、依次下载。
            浏览器可能会问「是否允许下载多个文件」，选允许。
          </p>

          <ul className="mt-3 flex flex-col gap-1.5">
            {plans.map((plan) => {
              const active = selected.includes(plan.platform);
              const aspectText = plan.spec.aspectRatios.join(" / ");
              return (
                <li key={plan.platform}>
                  <button
                    type="button"
                    disabled={readOnly || busy}
                    onClick={() => onToggle(plan.platform)}
                    aria-pressed={active}
                    className={cn(
                      "w-full border px-2.5 py-2 text-left transition-colors duration-[var(--dur)] disabled:opacity-40",
                      active ? "border-pick bg-pick/10" : "border-line hover:border-line-2",
                      plan.blocker && "opacity-60",
                    )}
                  >
                    <span className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-[10.5px] text-text">
                        {active ? "✓ " : ""}
                        {plan.spec.name}
                      </span>
                      <span className="tnum text-[8.5px] text-muted-2">
                        {plan.frame.aspect} · {plan.size.width}×{plan.size.height}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[9px] leading-[1.6] text-muted-2">
                      {plan.blocker ? (
                        <span className="text-pick">{plan.blocker}</span>
                      ) : plan.changesFrame ? (
                        <>
                          平台收 {aspectText}；这一版会把画幅换成 {plan.frame.aspect}
                          （{plan.frame.fit === "crop" ? "裁切" : plan.frame.fit === "blur" ? "模糊填充" : "留边"}），
                          项目里的设置不动。
                        </>
                      ) : (
                        <>平台收 {aspectText}；与当前画幅一致。</>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="mt-3 border border-line px-3 py-2.5">
            <p className="text-[8.5px] tracking-[.06em] text-muted-2">这一次会导出</p>
            <p className="mt-1 text-[9.5px] leading-[1.7] text-text">
              {usable.length === 0
                ? "还没有勾选能出的平台。"
                : usable.map((plan) => plan.spec.name).join(" / ")}
            </p>
            {changed.length > 0 && (
              <p className="mt-1 text-[9px] leading-[1.6] text-muted-2">
                其中 {changed.length} 版的画幅与项目当前设置不同：这些版本按平台形状出，
                下载文件名带平台名，别和当前这一版混在一起。
              </p>
            )}
            {blocked.length > 0 && (
              <p className="mt-1 text-[9px] leading-[1.6] text-pick">
                有 {blocked.length} 个勾上的平台出不了（原因写在卡片里）：先改画幅或时长，再回来。
              </p>
            )}
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                disabled={readOnly || busy || usable.length === 0 || Boolean(gateReason)}
                onClick={onExport}
                className="rounded-token border border-pick bg-pick px-2.5 py-1 text-[10px] text-white transition-opacity duration-[var(--dur)] enabled:hover:opacity-90 disabled:opacity-40"
              >
                {busy ? "正在导出…" : `导出 ${usable.length} 版`}
              </button>
              {busy && stage && <span className="text-[9px] text-muted">{stage}</span>}
            </div>
            {gateReason && (
              <p className="mt-1.5 text-[9px] leading-[1.6] text-pick">{gateReason}</p>
            )}
          </div>

          {results.length > 0 && (
            <section className="mt-4 border-t border-line pt-3">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">这次导出的版本</h3>
              <ul className="mt-1.5 flex flex-col gap-1">
                {results.map((result) => (
                  <li
                    key={`${result.platform}-${result.fileName}`}
                    className="flex flex-wrap items-baseline justify-between gap-2 border border-line px-2.5 py-1.5 text-[9.5px]"
                  >
                    <span className="text-text">{result.name}</span>
                    <span className="tnum text-muted-2">
                      {formatSize(result.bytes)} · {result.fileName}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[9px] leading-[1.6] text-muted-2">
                每一版都记进了发布记录（平台 / 档位 / 文件 / 体积）：去「台账」里贴回执。
              </p>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
