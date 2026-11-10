"use client";

import { useEffect, useMemo, useState } from "react";
import { Scene } from "@/components/scene";
import { LockIcon } from "@/components/icons";
import { TopBar } from "@/components/top-bar";
import { fetchImagePrice } from "@/lib/image-price";
import { shotLabel, toKeyframeView, type KeyframeCell } from "@/lib/read-model";
import { useWorkbench } from "@/lib/workbench-store";
import { cn } from "@/lib/utils";

const PREVIEW = "aspect-[9/16] w-full";

function Cell({
  cell,
  busy,
  quoteCny,
  onGenerate,
}: {
  cell: KeyframeCell;
  /** 正在生成哪一帧 */
  busy: "first" | "last" | null;
  quoteCny?: number;
  onGenerate: (frame: "first" | "last") => void;
}) {
  // 两帧都有时，点画面切换看哪一帧；生成动作始终在下面两个按钮上
  const [shown, setShown] = useState<"first" | "last">("first");
  const both = cell.hasFirst && cell.hasLast;
  // 只有尾帧时先看尾帧；数据是异步恢复的，不能只靠初始值
  const frame = !cell.hasFirst && cell.hasLast ? "last" : shown;
  const uri = frame === "first" ? cell.firstUri : cell.lastUri;

  return (
    <figure className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => both && setShown(frame === "first" ? "last" : "first")}
        disabled={!both}
        title={both ? "点一下切换首帧 / 尾帧" : undefined}
        className={cn(
          "relative overflow-hidden rounded-token border border-white/[.075] bg-surface",
          PREVIEW,
          both && "cursor-pointer",
        )}
      >
        {uri ? (
          <img src={uri} alt={`${shotLabel(cell.no)} ${frame === "first" ? "首帧" : "尾帧"}`} className="h-full w-full object-cover" />
        ) : (
          <Scene kind={cell.art} className="h-full w-full" />
        )}

        <span className="tnum absolute left-1.5 top-1 text-[9px] text-white/70">{shotLabel(cell.no)}</span>
        <span className="absolute right-1.5 top-1 flex items-center gap-1">
          {cell.locked && <LockIcon className="h-3 w-3 text-white/70" />}
          {uri && (
            <span className="tnum rounded-[1px] bg-black/45 px-1 text-[8.5px] text-white/80">
              {frame === "first" ? "首" : "尾"}
            </span>
          )}
        </span>

        {busy && (
          <span className="absolute inset-0 grid place-items-center bg-bg/75 text-[10px] text-text">
            生成中…
          </span>
        )}
      </button>

      <div className="flex gap-1">
        {(["first", "last"] as const).map((frame) => {
          const has = frame === "first" ? cell.hasFirst : cell.hasLast;
          return (
            <button
              key={frame}
              type="button"
              onClick={() => onGenerate(frame)}
              disabled={cell.locked || busy !== null}
              title={cell.locked ? "这一镜已锁定" : has ? "重生成，按同一资产位覆盖" : "生成"}
              className={cn(
                "flex flex-1 flex-col items-center rounded-token border border-line px-1 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)]",
                "hover:border-line-2 hover:text-text disabled:pointer-events-none disabled:opacity-40",
              )}
            >
              <span>{frame === "first" ? "首帧" : "尾帧"}</span>
              <span className="tnum text-[8.5px] text-muted-2">
                {quoteCny === undefined ? (has ? "重生成" : "生成") : `¥${quoteCny.toFixed(2)}`}
              </span>
            </button>
          );
        })}
      </div>

      {/* 有没有图，靠一行小字说清，别让人猜 */}
      <figcaption className="tnum text-[8.5px] text-muted-2">
        {cell.size} · {cell.angle} · 首{cell.hasFirst ? "✓" : "—"} · 尾{cell.hasLast ? "✓" : "—"}
      </figcaption>
    </figure>
  );
}

export function KeyframesScreen() {
  const project = useWorkbench((state) => state.project);
  const hydrate = useWorkbench((state) => state.hydrate);
  const jobs = useWorkbench((state) => state.jobs);
  const readOnly = useWorkbench((state) => state.readOnly);
  const storageError = useWorkbench((state) => state.storageError);
  const castError = useWorkbench((state) => state.castError);
  const imageCny = useWorkbench((state) => state.imageCny);
  const setImagePrice = useWorkbench((state) => state.setImagePrice);
  const setBudget = useWorkbench((state) => state.setBudget);
  const generateKeyframe = useWorkbench((state) => state.generateKeyframe);

  useEffect(() => {
    void hydrate();
    void fetchImagePrice().then((price) => {
      if (price) setImagePrice(price);
    });
  }, [hydrate, setImagePrice]);

  const view = useMemo(() => toKeyframeView(project), [project]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
      <TopBar
        title={view.title}
        version={view.version}
        stage="关键帧"
        spentCny={view.spent}
        budgetCny={view.budget}
        unpriced={view.unpriced}
        spendBreakdown={view.spend}
        storageError={storageError}
        readOnly={readOnly}
        onBudgetChange={setBudget}
      />

      {castError && (
        <p className="shrink-0 px-6 pb-1 pt-2 text-[10.5px] leading-[1.6] text-pick">{castError}</p>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-[1180px]">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <div>
              <h1 className="text-[13px] tracking-[.06em] text-text">关键帧</h1>
              <p className="mt-1 text-[10.5px] leading-[1.6] text-muted-2">
                一镜两张：首帧看起势，尾帧看落点。点画面在首尾之间切换，点下面的按钮生成或重生成。
              </p>
            </div>
            <dl className="tnum flex items-baseline gap-5 text-[10.5px]">
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-2">首帧</dt>
                <dd className="text-muted">
                  {view.firstCount} / {view.cells.length}
                </dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-2">尾帧</dt>
                <dd className="text-muted">
                  {view.lastCount} / {view.cells.length}
                </dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-2">关键帧已花</dt>
                <dd className="text-muted">¥{view.keyframeSpend.toFixed(2)}</dd>
              </div>
              {view.keyframeUnpriced > 0 && (
                <div className="flex items-baseline gap-1.5">
                  <dt className="text-muted-2">无价目</dt>
                  <dd className="text-muted-2">{view.keyframeUnpriced} 张</dd>
                </div>
              )}
            </dl>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {view.cells.map((cell) => {
              const busy =
                jobs[`${cell.id}:last`]?.kind === "keyframe"
                  ? "last"
                  : jobs[`${cell.id}:first`]?.kind === "keyframe"
                    ? "first"
                    : null;
              return (
                <Cell
                  key={cell.id}
                  cell={cell}
                  busy={busy}
                  quoteCny={imageCny}
                  onGenerate={(frame) => void generateKeyframe(cell.id, frame)}
                />
              );
            })}
          </div>

          {readOnly && (
            <p className="mt-6 text-[10px] text-muted-2">另一个标签页在编辑：这一页只读，刷新后才能接管。</p>
          )}
        </div>
      </main>
    </div>
  );
}
