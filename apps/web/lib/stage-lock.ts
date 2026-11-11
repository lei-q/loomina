/**
 * 阶段硬锁（F8）。
 *
 * 阶段式模式下，已经确认、且确认之后没改过的阶段是「定稿」：
 * 再改它的内容要先「回退本阶段」，否则确认就只是一句口号。
 * 自由工作台里不锁——全部展开本来就是为了随手改。
 *
 * 判断不靠调用点自觉：store 的每一次写入都会先过这里，
 * 看这次写入会不会让某个已确认阶段的内容指纹变掉。
 */

import type { Project, ProjectEvent } from "@loomina/ir";
import { STAGE_META, stageSignature, type StageKey } from "./stage-flow";

export type WorkbenchMode = "guided" | "free";

export type StageLock = {
  stage: StageKey;
  name: string;
  href: string;
  /** 给人看的一句话 */
  message: string;
};

/**
 * 这次写入是否碰了某个已确认阶段。
 *
 * - 只有阶段式模式锁；
 * - 闸门自己的事件（确认 / 回退）与全局回滚不锁——它们就是用来动闸门的；
 * - 已经「内容改过」的阶段不锁：它本来就要重新确认。
 */
export function stageLockViolation(
  before: Project,
  after: Project,
  fresh: ProjectEvent[],
  mode: WorkbenchMode,
): StageLock | undefined {
  if (mode !== "guided") return undefined;
  if (fresh.length === 0) return undefined;
  if (
    fresh.some(
      (event) =>
        event.type === "gate.confirmed" ||
        event.type === "gate.reopened" ||
        event.type === "project.restored",
    )
  ) {
    return undefined;
  }

  for (const meta of STAGE_META) {
    const record = before.gates.find((gate) => gate.stage === meta.key);
    if (!record) continue;
    // 确认后又改过（stale）：不锁，改完重新确认即可
    if (record.signature !== stageSignature(before, meta.key)) continue;
    if (stageSignature(after, meta.key) === record.signature) continue;
    return {
      stage: meta.key,
      name: meta.name,
      href: meta.href,
      message: `「${meta.name}」已确认：要改这里，先在底部闸门点「回退本阶段」——或者切到自由工作台。`,
    };
  }
  return undefined;
}

/** 当前阶段是不是被锁住了（页面用它决定要不要把编辑控件收起来） */
export function stageLockOf(
  project: Project,
  stage: StageKey,
  mode: WorkbenchMode,
): StageLock | undefined {
  if (mode !== "guided") return undefined;
  const record = project.gates.find((gate) => gate.stage === stage);
  if (!record) return undefined;
  if (record.signature !== stageSignature(project, stage)) return undefined;
  const meta = STAGE_META.find((item) => item.key === stage);
  if (!meta) return undefined;
  return {
    stage,
    name: meta.name,
    href: meta.href,
    message: `「${meta.name}」已确认：要改这里，先回退本阶段，或切到自由工作台。`,
  };
}
