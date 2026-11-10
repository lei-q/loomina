"use client";

import { useEffect, useMemo, useState } from "react";
import { Scene } from "@/components/scene";
import { LockIcon } from "@/components/icons";
import { TopBar } from "@/components/top-bar";
import { fetchImagePrice } from "@/lib/image-price";
import { shotLabel, toKeyframeView, filterKeyframeCells, keyframeTally, type KeyframeCell, type KeyframeFilter } from "@/lib/read-model";
import { useWorkbench } from "@/lib/workbench-store";
import { cn } from "@/lib/utils";

const PREVIEW = "aspect-[9/16] w-full";

const FILTERS: { key: KeyframeFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "missing-first", label: "缺首帧" },
  { key: "missing-last", label: "缺尾帧" },
  { key: "complete", label: "两帧齐" },
];

function Cell({
  cell,
  busy,
  batchRunning,
  quoteCny,
  onGenerate,
}: {
  cell: KeyframeCell;
  /** 正在生成哪一帧 */
  busy: "first" | "last" | null;
  /** 批量补帧进行中：别的格子也不要插队 */
  batchRunning: boolean;
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
              disabled={cell.locked || busy !== null || batchRunning}
              title={
                cell.locked
                  ? "这一镜已锁定"
                  : has
                    ? "重生成，按同一资产位覆盖"
                    : "生成"
              }
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
  const generateMissingFrames = useWorkbench((state) => state.generateMissingFrames);
  const batch = useWorkbench((state) => state.batch);
  const stopBatch = useWorkbench((state) => state.stopBatch);

  useEffect(() => {
    void hydrate();
    void fetchImagePrice().then((price) => {
      if (price) setImagePrice(price);
    });
  }, [hydrate, setImagePrice]);

  const view = useMemo(() => toKeyframeView(project), [project]);
  // 只想补缺的时候，十二格一起看反而找不到要补的那几格
  const [filter, setFilter] = useState<KeyframeFilter>("all");
  const tally = useMemo(() => keyframeTally(view.cells), [view.cells]);
  const cells = useMemo(() => filterKeyframeCells(view.cells, filter), [view.cells, filter]);
  // 批量只补没锁的格子：锁定是闸门，批量不是绕过去的理由
  const missingFirst = view.cells.filter((cell) => !cell.locked && !cell.hasFirst).length;
  const missingLast = view.cells.filter((cell) => !cell.locked && !cell.hasLast).length;
  const batchPrice = (count: number) =>
    imageCny === undefined ? `${count} 张` : `${count} 张 · ¥${(count * imageCny).toFixed(2)}`;

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

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="按缺帧筛选">
              {FILTERS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                  className={cn(
                    "tnum flex items-baseline gap-1.5 rounded-token border px-2.5 py-1 text-[10.5px] transition-colors duration-[var(--dur)]",
                    filter === key
                      ? "border-line-2 bg-surface text-text"
                      : "border-line text-muted hover:border-line-2 hover:text-text",
                  )}
                >
                  <span>{label}</span>
                  <span className="text-[9px] text-muted-2">{tally[key]}</span>
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {batch ? (
                <>
                  <span className="tnum text-[10.5px] text-muted" aria-live="polite">
                    补{batch.frame === "first" ? "首" : "尾"}帧 {batch.done} / {batch.total}
                  </span>
                  <button
                    type="button"
                    onClick={stopBatch}
                    disabled={batch.stop}
                    title="当前这一张发出去了，停下在它结束后生效"
                    className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
                  >
                    {batch.stop ? "停下中…" : "停下"}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void generateMissingFrames("first")}
                    disabled={missingFirst === 0 || readOnly}
                    title="按镜号顺序补首帧：跳过锁定的镜头，一张失败就停"
                    className="tnum rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:pointer-events-none disabled:opacity-40"
                  >
                    补缺首帧 <span className="text-[9px] text-muted-2">{batchPrice(missingFirst)}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void generateMissingFrames("last")}
                    disabled={missingLast === 0 || readOnly}
                    title="按镜号顺序补尾帧：跳过锁定的镜头，一张失败就停"
                    className="tnum rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:pointer-events-none disabled:opacity-40"
                  >
                    补缺尾帧 <span className="text-[9px] text-muted-2">{batchPrice(missingLast)}</span>
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {cells.map((cell) => {
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
                  batchRunning={Boolean(batch)}
                  quoteCny={imageCny}
                  onGenerate={(frame) => void generateKeyframe(cell.id, frame)}
                />
              );
            })}
          </div>

          {cells.length === 0 && (
            <p className="mt-10 text-center text-[11px] text-muted-2">
              {filter === "complete"
                ? "还没有两帧都齐的镜头。"
                : "这一档没有镜头：想看的帧都已经有了。"}
            </p>
          )}

          {readOnly && (
            <p className="mt-6 text-[10px] text-muted-2">另一个标签页在编辑：这一页只读，刷新后才能接管。</p>
          )}
        </div>
      </main>
    </div>
  );
}
