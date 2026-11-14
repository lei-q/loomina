
/**
 * 生成路径的核心：阶段硬锁的第二道闸 + 出一张图。
 *
 * 从 `workbench-store.ts` 拆出（2026-11-15）。这两个函数是所有「会花钱的 action」
 * 共用的入口，cast 组的生成动作全靠它们，所以先于 cast 组本身拆出来。
 *
 * 收 `Store`（get / set）而不是直接引 store：切片与主 store 都要用，
 * 传进来才不会循环。
 */

import { applyEvent, type GateStage, type ProjectEvent } from "@loomina/ir";
import { stageLockOf } from "@/lib/stage-lock";
import { persistAsset } from "@/lib/asset-client";
import type { CastImageRequest } from "@/lib/generate-image";
import { findCachedAsset, referenceHashesOf, reuseAssetEvents } from "@/lib/generation-cache";
import { imagePlanOf } from "@/lib/image-plan";
import { modelIdFor } from "@/lib/model-choice";
import { shotSpendOf, spendOf } from "@/lib/read-model";
import type { GenerateJob, WorkbenchState } from "./workbench-types";
import { clipReason, promptKeyOf, referenceNotice, withPromptOverride } from "./workbench-helpers";

type Store = {
  get: () => WorkbenchState;
  set: (partial: Partial<WorkbenchState>) => void;
};

/** 时间戳：由 store 传入（严格递增，同一毫秒里的两次操作不能同组） */
type Stamp = () => string;

/**
 * 阶段硬锁（F8）的第二道闸：花钱 / 调接口之前先问一句。
 *
 * 写状态的闸口能拦住「改了没生效」，但生成是先请求、后落事件——
 * 等快照写回才拦就白花了钱。所以每个会花钱的动作开头先过这里。
 */
export function lockedStage(
  { get, set }: Store,
  stage: GateStage,
): boolean {
  const { project, mode } = get();
  const lock = stageLockOf(project, stage, mode);
  if (!lock) return false;
  set({ lockedNotice: lock.message });
  return true;
}

/**
 * 出一张图，落一条 `asset.updated`。
 *
 * 失败写一句人话并返回 false：批量生成据此停下，不把后面的也浪费掉。
 */
export async function generateOne(
  { get, set }: Store,
  stamp: Stamp,
  input: {
    /** 进度记在谁头上：角色 / 场景 / 道具的 id */
    key: string;
    /** 出错时点名的对象 */
    label: string;
    assetId: string;
    job: GenerateJob;
    body: Record<string, unknown>;
    /** 这一张属于哪一镜：单镜上限按它算（H10） */
    shotId?: string;
    /** 这张图还要改项目结构时，在这里追加事件（例如首帧挂回镜头） */
    after?: (assetId: string, at: string) => ProjectEvent | ProjectEvent[] | undefined;
    /** 溯源里记下这一张引用了哪些已锁定的锚点 */
    referenceAssetIds?: string[];
    /**
     * 随请求真正发出去的参考图（B2 / ADR-0162）。
     *
     * 只传地址与标签：字节由服务端从资产库读，浏览器不重复上传。
     * 不传就是纯文生图——这和以前一样，不改任何已有路径的行为。
     */
    references?: { assetId: string; uri?: string; label: string }[];
  },
): Promise<boolean> {
  const setJob = (value: GenerateJob | undefined) =>
    set({ jobs: { ...get().jobs, [input.key]: value } });

  // 提交前拦：知道单价、且这一张会超预算，就不发请求（准则 P14 / H10）。
  // 不知道单价时不拦——报不出价的时候宁可如实说，也不假拦。
  const unit = get().imageCny;
  if (unit !== undefined) {
    const project = get().project;
    const { spent } = spendOf(project);
    const budget = project.budgetCny;
    const keep = project.onBudgetExceed === "keep";
    if (spent + unit > budget) {
      set({
        castError: keep
          ? `「${input.label}」超出预算：这一笔 ¥${unit.toFixed(2)}，已花 ¥${spent.toFixed(2)} / 预算 ¥${budget.toFixed(2)}。按「超预算保留现有结果」，这次不重新生成，这一镜沿用手上已有的画面。`
          : `「${input.label}」超出预算：这一笔 ¥${unit.toFixed(2)}，已花 ¥${spent.toFixed(2)} / 预算 ¥${budget.toFixed(2)}。先提高预算再生成。`,
      });
      return false;
    }
    // 单镜上限（H10）：先到的那条拦
    const shot = input.shotId
      ? project.shots.find((item) => item.id === input.shotId)
      : undefined;
    if (shot?.budgetCny !== undefined) {
      const shotSpend = shotSpendOf(project, shot.id);
      if (shotSpend.spent + unit > shot.budgetCny) {
        set({
          castError: keep
            ? `「${input.label}」超出这一镜的上限：这一笔 ¥${unit.toFixed(2)}，这一镜已花 ¥${shotSpend.spent.toFixed(2)} / 上限 ¥${shot.budgetCny.toFixed(2)}。按「超预算保留现有结果」，这次不重新生成，这一镜沿用手上已有的画面。`
            : `「${input.label}」超出这一镜的上限：这一笔 ¥${unit.toFixed(2)}，这一镜已花 ¥${shotSpend.spent.toFixed(2)} / 上限 ¥${shot.budgetCny.toFixed(2)}。先在分镜页提高单镜上限，或改项目预算。`,
        });
        return false;
      }
    }
  }

  // 结果缓存（H14 / ADR-0208）：同一套输入（模型 + 最终提示词 + 参考图内容）
  // 已经出过，就直接把那张图接到这一格的资产位上——不发请求、不花钱。
  // 提示词用与服务端同一个 `imagePlanOf`：两边各写一遍就会漂。
  if (get().reuseCache) {
    const plan = imagePlanOf(input.body as unknown as CastImageRequest);
    const prompt = withPromptOverride(get, promptKeyOf(input)).prompt ?? plan.prompt;
    // 参考图按内容指纹比，id 列表与出处里记的 `referenceAssetIds` 完全一致：
    // 两侧用不同的列表，等于把「同一套输入」判成两套（这里踩过一次）
    const referenceHashes = referenceHashesOf(
      get().project,
      input.referenceAssetIds ?? [],
    );
    // 模型可能没被固定 / 选定（服务端会用该模态的默认模型）。
    // 这种情况下键里用空串占位：只要两次都是「没选模型」，用的就是同一个默认模型。
    const imageModel = modelIdFor("image", get().project.models) ?? "";
    // 不排除这一格自己：重生成时「这一格上一次出的图」正是要复用的对象，
    // 输入没变就该命中它（排除自己会让缓存永不命中）
    const hit = findCachedAsset(get().project, {
      modelId: imageModel,
      prompt,
      referenceHashes,
    });
    if (hit) {
      const at = stamp();
      const events = reuseAssetEvents({
        assetId: input.assetId,
        hit,
        at,
        referenceAssetIds: input.referenceAssetIds ?? [],
      });
      const extra = input.after?.(input.assetId, at);
      const appended = [
        ...events,
        ...(extra === undefined ? [] : Array.isArray(extra) ? extra : [extra]),
      ];
      let project = get().project;
      for (const item of appended) project = applyEvent(project, item);
      set({
        project,
        events: [...get().events, ...appended],
        castError: undefined,
        generationNotice: `复用了同一套输入已经出过的那张图（模型 ${hit.modelId}）：没有重新生成，也没花钱。想换一张就关掉「结果复用」再生成。`,
      });
      return true;
    }
  }

  setJob(input.job);
  set({ generationNotice: undefined });
  try {
    const response = await fetch("/api/asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input.body,
        modelId: modelIdFor("image", get().project.models),
        ...(input.references?.length ? { references: input.references } : {}),
      }),
    });
    const payload = (await response.json()) as {
      uri?: string;
      model?: string;
      prompt?: string;
      cny?: number;
      error?: string;
      references?: {
        mode?: "edits" | "prompt-only";
        sent?: number;
        missing?: string[];
        /** 其中几张太大、出图前压过（B2 / ADR-0206） */
        fitted?: number;
      };
    };
    if (!response.ok || !payload.uri) {
      throw new Error(payload.error ?? `生成失败（${response.status}）`);
    }

    const at = stamp();
    // 大图先进本机资产库（H3 / ADR-0128）：事件里只留地址，日志不背 base64
    const uri = await persistAsset(payload.uri);
    const event: ProjectEvent = {
      type: "asset.updated",
      at,
      asset: {
        id: input.assetId,
        kind: "image",
        source: "generated",
        uri,
        mime: "image/png",
        // 价目表给了单价就记上；没给就让 costCny 缺省，界面如实说"无价目"
        costCny: typeof payload.cny === "number" ? payload.cny : undefined,
        provenance: {
          modelId: payload.model ?? "unknown",
          prompt: payload.prompt,
          referenceAssetIds: input.referenceAssetIds ?? [],
          createdAt: at,
        },
        createdAt: at,
      },
    };
    const extra = input.after?.(input.assetId, at);
    const appended = [
      event,
      ...(extra === undefined ? [] : Array.isArray(extra) ? extra : [extra]),
    ];
    let project = get().project;
    for (const item of appended) project = applyEvent(project, item);
    set({ project, events: [...get().events, ...appended], generationNotice: referenceNotice(payload.references) });
    setJob(undefined);
    return true;
  } catch (error) {
    setJob(undefined);
    set({
      castError:
        error instanceof Error ? `「${input.label}」${error.message}` : "生成失败",
    });
    return false;
  }
}
