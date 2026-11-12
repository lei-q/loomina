import type { Asset, Project } from "@loomina/ir";

/**
 * 生成结果复核（H6 / ADR-0132）。
 *
 * 提示词在发出前已经扫过一遍（ADR-0105），但那管不了像素：脸、手、构图、
 * 画面里有没有不该有的东西，只有人看得见。当前没有可用的模型审核服务，
 * 所以这一层不假装有——它把「每一张会进成片的生成结果，作者看过没有」
 * 变成一件能被回答、能被拦住的事。
 *
 * 规则：
 * - 只审**会进成片**的资产：画面轨上的 take、首尾帧、配音。定妆图与参考图
 *   不进成片，不挡导出（它们影响的是生成，不是发布内容）。
 * - 「不可用」是硬阻断：标了它的资产不许进成片。
 * - 「还没看」算「待确认」：不硬拦，但导出前要在预检里勾一下确认——
 *   既不静默放行，也不让示例项目一上来就卡死。
 *
 * 纯函数：不读盘、不发请求。
 */

export type ReviewSubject = {
  assetId: string;
  /** 人话位置，例如「第 3 镜 首帧」「第 5 镜 视频」「台词「你早就知道，对吧。」配音」 */
  where: string;
  kind: Asset["kind"];
  /** 资产地址（data: / loomina:// / s3://）；界面用来显示缩略图或播放 */
  uri?: string;
  /** 有没有地址：没有画面的资产复核不了，单独算一类 */
  hasMedia: boolean;
  /** 资产本身在不在 IR 里；不在就没法记复核，按钮要禁用并说明 */
  exists: boolean;
  review?: Asset["review"];
};

export type ReviewSummary = {
  /** 需要复核的资产总数 */
  total: number;
  passed: number;
  rejected: number;
  /** 还没有复核记录 */
  unreviewed: number;
  /** 没有地址、看不了的资产：不算通过，也不算没看 */
  missing: number;
  /** 被标成不可用的资产 */
  rejectedSubjects: ReviewSubject[];
  unreviewedSubjects: ReviewSubject[];
  /** 没有文件、看不了的条目：列出来但没法复核 */
  missingSubjects: ReviewSubject[];
  /** 全部条目，按「不可用 → 没看 → 看不了 → 已看」排好；界面照这个顺序列 */
  subjects: ReviewSubject[];
  /** 有「不可用」就是 block；只看没看的算 review；全看过算 pass */
  status: "pass" | "review" | "block";
  summary: string;
};

function subjectOf(project: Project, assetId: string, where: string): ReviewSubject | undefined {
  const asset = project.assets.find((item) => item.id === assetId);
  // 资产丢了也算一个要回答的问题：成片里这一格会是空的
  if (!asset) {
    return { assetId, where, kind: "image", hasMedia: false, exists: false };
  }
  return {
    assetId,
    where,
    kind: asset.kind,
    ...(asset.uri ? { uri: asset.uri } : {}),
    hasMedia: Boolean(asset.uri),
    exists: true,
    ...(asset.review ? { review: asset.review } : {}),
  };
}

/**
 * 这一条片子里会进成片的生成结果。
 *
 * 按画面轨与台词逐条列：同一资产被引用两次（例如首帧又被当参考图）只算一次，
 * 位置取第一次出现的那个——复核的是「这张图」，不是「这个引用」。
 */
export function reviewSubjectsOf(project: Project): ReviewSubject[] {
  const subjects: ReviewSubject[] = [];
  const seen = new Set<string>();
  const push = (assetId: string | undefined, where: string) => {
    if (!assetId || seen.has(assetId)) return;
    const subject = subjectOf(project, assetId, where);
    if (!subject) return;
    seen.add(assetId);
    subjects.push(subject);
  };

  const shotNo = new Map<string, number>();
  project.shots.forEach((shot, index) => shotNo.set(shot.id, index + 1));

  // 画面轨：真正进成片的 take
  for (const item of [...project.timeline.items].sort((a, b) => a.startMs - b.startMs)) {
    const take = project.takes.find((entry) => entry.id === item.takeId);
    const no = shotNo.get(item.shotId) ?? 0;
    push(take?.assetId, `第 ${no} 镜 画面`);
  }

  // 首尾帧：没有视频的镜头会拿它当画面，所以同样会进成片
  for (const shot of project.shots) {
    const no = shotNo.get(shot.id) ?? 0;
    push(shot.keyframes.firstAssetId, `第 ${no} 镜 首帧`);
    push(shot.keyframes.lastAssetId, `第 ${no} 镜 尾帧`);
  }

  // 配音：会混进成片的音轨
  for (const line of project.dialogue) {
    const where = `配音「${line.text.slice(0, 12)}${line.text.length > 12 ? "…" : ""}」`;
    push(line.audioAssetId, where);
  }

  return subjects;
}

export function reviewSummaryOf(project: Project): ReviewSummary {
  const subjects = reviewSubjectsOf(project);
  const passedSubjects = subjects.filter((item) => item.review?.status === "passed");
  const passed = passedSubjects.length;
  const rejectedSubjects = subjects.filter((item) => item.review?.status === "rejected");
  const unreviewedSubjects = subjects.filter(
    (item) => !item.review && item.hasMedia,
  );
  const missingSubjects = subjects.filter((item) => !item.hasMedia);
  const missing = missingSubjects.length;
  const rejected = rejectedSubjects.length;
  const unreviewed = unreviewedSubjects.length;
  // 缺文件的条目也算「待确认」：成片里那一格会是空的，得有人认下来
  const status =
    rejected > 0 ? "block" : unreviewed > 0 || missing > 0 ? "review" : "pass";
  return {
    total: subjects.length,
    passed,
    rejected,
    unreviewed,
    missing,
    rejectedSubjects,
    unreviewedSubjects,
    missingSubjects,
    subjects: [...rejectedSubjects, ...unreviewedSubjects, ...missingSubjects, ...passedSubjects],
    status,
    summary:
      rejected > 0
        ? `${rejected} 个生成结果被标为不可用：换掉或重生成，它们不能进成片`
        : unreviewed > 0
          ? `还有 ${unreviewed} 个生成结果没有复核：看一遍再导出`
          : subjects.length === 0
            ? "还没有会进成片的生成结果"
            : missing > 0
              ? // 「没有文件」的条目复核不了，也不能算复核过：如实分开数
                `${passed} 个已看通过，${missing} 条没有文件（成片里会是空的）`
              : `${subjects.length} 个生成结果都复核过了`,
  };
}

/** 复核一条资产后的新资产对象：不改别的字段，只换 `review` */
export function withReview(
  asset: Asset,
  review: Asset["review"],
): Asset {
  if (!review) {
    const { review: _removed, ...rest } = asset;
    return rest;
  }
  return { ...asset, review };
}
