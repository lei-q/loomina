"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { GateConfirm } from "@/components/gate-confirm";
import { stageStateOf, type StageKey } from "@/lib/stage-flow";
import { useWorkbench } from "@/lib/workbench-store";
import { cn } from "@/lib/utils";

/**
 * 阶段闸门条（F8 / F9）：每个阶段页底部一条，说清现状与下一步。
 *
 * 确认后会进入下一步；「回退本阶段」只删这一阶段的确认记录，
 * 不碰下游——下游各自会因为签名变化显示「内容改过」。
 */
export function StageGate({ stage }: { stage: StageKey }) {
  const project = useWorkbench((state) => state.project);
  const readOnly = useWorkbench((state) => state.readOnly);
  const confirmGate = useWorkbench((state) => state.confirmGate);
  const reopenGate = useWorkbench((state) => state.reopenGate);
  const mode = useWorkbench((state) => state.mode);
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const stageState = useMemo(() => stageStateOf(project, stage), [project, stage]);

  // 自由工作台把闸门收起来：全部展开时不该再有一条底栏提醒走到哪（F8）
  if (mode === "free") return null;

  const locked = stageState.gate === "confirmed";

  const statusLabel =
    stageState.gate === "confirmed"
      ? "已确认"
      : stageState.gate === "stale"
        ? "内容改过"
        : stageState.readiness === "empty"
          ? "还没内容"
          : stageState.readiness === "ready"
            ? "可以确认"
            : "还差一点";

  const statusTone =
    stageState.gate === "confirmed"
      ? "border-line-2 text-text"
      : stageState.gate === "stale"
        ? "border-pick/60 text-pick"
        : "border-dashed border-line text-muted-2";

  return (
    <>
      <footer
        aria-label="阶段闸门"
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line bg-surface px-6 py-2"
      >
        <span
          className={cn(
            "shrink-0 rounded-token border px-1.5 py-px text-[8.5px] tracking-[.08em]",
            statusTone,
          )}
        >
          {statusLabel}
        </span>
        <p className="min-w-0 text-[10px] leading-[1.6] text-muted">
          <span className="text-text">{stageState.name}</span>
          <span className="text-muted-2"> · {stageState.summary}</span>
          {stageState.gate === "stale" && (
            <span className="text-pick"> · 确认之后内容改过，需要再确认一次</span>
          )}
          {stageState.gate === "none" && stageState.missing.length > 0 && (
            <span className="text-muted-2"> · {stageState.missing.join("；")}</span>
          )}
          {stageState.gate === "confirmed" && stageState.confirmedAt && (
            <span className="tnum text-muted-2">
              {" "}
              · 确认于 {stageState.confirmedAt.slice(5, 10)}
              {stageState.note ? ` ·「${stageState.note}」` : ""}
            </span>
          )}
          {locked && <span className="text-muted-2"> · 改内容要先回退本阶段</span>}
        </p>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {readOnly ? (
            <span className="text-[9.5px] text-muted-2">只读：另一个标签页在编辑</span>
          ) : (
            <>
              {stageState.gate === "confirmed" ? (
                <>
                  {stageState.next && (
                    <Link
                      href={stageState.next.href}
                      className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                    >
                      进入{stageState.next.name} →
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={() => setOpen(true)}
                    className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                  >
                    回退本阶段
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setOpen(true)}
                  disabled={!stageState.canConfirm}
                  title={stageState.canConfirm ? undefined : stageState.missing.join("；")}
                  className="rounded-token border border-text bg-text px-2.5 py-1 text-[10px] text-bg transition-opacity duration-[var(--dur)] hover:opacity-85 disabled:pointer-events-none disabled:opacity-35"
                >
                  {stageState.gate === "stale"
                    ? "重新确认"
                    : stageState.missing.length > 0
                      ? `确认${stageState.name}，继续`
                      : stageState.confirmLabel}
                </button>
              )}
            </>
          )}
        </div>
      </footer>

      {open && (
        <GateConfirm
          state={stageState}
          onClose={() => setOpen(false)}
          onConfirm={(note, override) => {
            const ok = confirmGate(stage, note, override);
            if (ok && stageState.next) router.push(stageState.next.href);
            return ok;
          }}
          onReopen={stageState.gate !== "none" ? () => reopenGate(stage) : undefined}
        />
      )}
    </>
  );
}
