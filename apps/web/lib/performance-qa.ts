/**
 * 表演 QA（B18 / PERFORMANCE.md §十）。
 *
 * 这里查的是**表演设计本身**够不够让模型演出戏：这一镜要什么、给没给微表情、
 * 视线看的人在不在这镜里、起转落写全没有、情绪强度配不配景别。
 *
 * 不做视频抽帧、不做表情识别、不做视线检测——那要 VLM，当前仓库没有。
 * 所以报告只说「设计里缺了什么、哪里自相矛盾」，不说「演得好不好」。
 * 与 B14 一致性体检同一个立场：用一个算术分数假装看过画面，比不做更糟。
 */

import type { Project, Shot } from "@loomina/ir";

export type PerformanceQaRule = "emotion" | "gaze" | "action" | "size" | "continuity";

export const PERFORMANCE_QA_RULE_LABEL: Record<PerformanceQaRule, string> = {
  emotion: "情绪",
  gaze: "视线",
  action: "动作",
  size: "景别",
  continuity: "连续",
};

export type PerformanceQaFinding = {
  rule: PerformanceQaRule;
  /** fail 是自相矛盾（看的人不在这镜里），review 是建议（特写没写微表情） */
  severity: "fail" | "review";
  message: string;
  fix: string;
};

/** 这一景别靠什么演戏（PERFORMANCE.md §十：特写看微表情，中景看姿态，全景看调度） */
export type PerformanceFocus = "micro" | "body" | "staging";

export const PERFORMANCE_FOCUS_LABEL: Record<PerformanceFocus, string> = {
  micro: "微表情",
  body: "姿态",
  staging: "调度",
};

export function performanceFocusOf(size: Shot["shotSize"]): PerformanceFocus {
  if (size === "close" || size === "extreme-close") return "micro";
  if (size === "medium") return "body";
  return "staging";
}

export type ShotPerformanceQa = {
  shotId: string;
  no: number;
  label: string;
  shotSize: Shot["shotSize"];
  /** 这一景别看什么 */
  focus: PerformanceFocus;
  /** unknown = 还没写表演设计，不算失败 */
  verdict: "pass" | "review" | "fail" | "unknown";
  findings: PerformanceQaFinding[];
};

export type PerformanceQaReport = {
  shots: ShotPerformanceQa[];
  summary: { shots: number; pass: number; review: number; fail: number; unknown: number };
  /** 要改的镜头：fail 在前，同档按镜号 */
  attention: ShotPerformanceQa[];
};

/** 强度副词：模型看到「极度崩溃」只会画得更夸张（PERFORMANCE.md §十一「过火」） */
const INTENSITY_ADVERB = /非常|极度|极其|疯狂|崩溃|歇斯底里|暴怒|狂喜|剧烈|拼命/;

const INTENSE_BEATS = new Set(["hook", "climax"]);

function shotLabel(no: number): string {
  return `SH-${String(no).padStart(2, "0")}`;
}

/** 场次顺序 → 场内镜序；孤儿镜头补在后面。与分镜检查同一口径。 */
function orderedShots(project: Project): { shot: Shot; no: number }[] {
  const byId = new Map(project.shots.map((shot) => [shot.id, shot]));
  const seen = new Set<string>();
  const out: { shot: Shot; no: number }[] = [];
  for (const scene of [...project.scenes].sort((a, b) => a.index - b.index)) {
    for (const shotId of scene.shotIds) {
      const shot = byId.get(shotId);
      if (!shot || seen.has(shotId)) continue;
      seen.add(shotId);
      out.push({ shot, no: out.length + 1 });
    }
  }
  for (const shot of project.shots) {
    if (seen.has(shot.id)) continue;
    out.push({ shot, no: out.length + 1 });
  }
  return out;
}

/** 相邻镜在不在同一场：跨场不判情绪连续（换场换情绪是正常的） */
function sameScene(project: Project, a: Shot, b: Shot): boolean {
  return a.sceneId === b.sceneId && Boolean(project.scenes.find((scene) => scene.id === a.sceneId));
}

function qaOfShot(
  project: Project,
  shot: Shot,
  no: number,
  previous?: Shot,
): ShotPerformanceQa {
  const focus = performanceFocusOf(shot.shotSize);
  const base: ShotPerformanceQa = {
    shotId: shot.id,
    no,
    label: shotLabel(no),
    shotSize: shot.shotSize,
    focus,
    verdict: "pass",
    findings: [],
  };
  const performance = shot.performance;
  if (!performance || !performance.objective.trim()) {
    return { ...base, verdict: "unknown" };
  }

  const findings: PerformanceQaFinding[] = [];
  const add = (
    rule: PerformanceQaRule,
    severity: PerformanceQaFinding["severity"],
    message: string,
    fix: string,
  ) => findings.push({ rule, severity, message, fix });

  const beats = performance.beats;
  const hasMicro = beats.some((beat) => beat.micro.trim().length > 0);
  const hasBody = beats.some((beat) => beat.body.trim().length > 0);
  const surface = performance.emotion.surface.trim();
  const intensity = performance.intensity;
  const close = shot.shotSize === "close" || shot.shotSize === "extreme-close";

  // —— 景别阈值：这一景别靠什么演戏，就得写什么 ——
  if (focus === "micro" && !hasMicro) {
    add(
      "size",
      "fail",
      `${shotLabel(no)} 是特写，却没写微表情：模型会给一张中性脸。`,
      "在起 / 转 / 落里写一句嘴角、眼睑或呼吸的变化。",
    );
  }
  if (focus === "body" && !hasBody) {
    add(
      "size",
      "review",
      `${shotLabel(no)} 是中景，却没写姿态：只靠表情撑不住半个身子。`,
      "写一句肩膀、重心或手的姿态，例如「肩膀松下来，手还攥着杯子」。",
    );
  }
  if (focus === "staging" && shot.staging.length === 0) {
    add(
      "size",
      "review",
      `${shotLabel(no)} 是全景，却没写调度：谁在左、谁在前都没说，模型自己摆。`,
      "在「调度」里标一下每个人物的左右与前后。",
    );
  }

  // —— 面瘫：有表演设计，但一个表情、一个动作都没有 ——
  if (!surface && !hasMicro && !hasBody) {
    add(
      "emotion",
      "fail",
      `${shotLabel(no)} 整镜没有表面情绪，也没有表情或动作：会是一张中性脸。`,
      "至少写一句表面情绪，或一拍微表情。",
    );
  }

  // —— 过火：特写里堆强度，或把情绪写成强度副词 ——
  if (close && intensity >= 5) {
    add(
      "emotion",
      "review",
      `${shotLabel(no)} 特写给了 5 级强度：情绪越强动作越小，特写里容易狰狞。`,
      "降到 3 级，把差别写进微表情而不是幅度。",
    );
  }
  if (surface && INTENSITY_ADVERB.test(surface)) {
    add(
      "emotion",
      "review",
      `${shotLabel(no)} 的表面情绪写成了强度副词（「${surface.slice(0, 12)}」）：模型只会画得更夸张。`,
      "改成具体微动作：手指发抖、喉结动了一下、笑到一半收住。",
    );
  }

  // —— 情绪配不配这一拍 ——
  if (shot.beat && INTENSE_BEATS.has(shot.beat) && intensity < 3) {
    add(
      "emotion",
      "review",
      `${shotLabel(no)} 属于钩子 / 高潮拍，只有 ${intensity} 级强度：这一拍看不出戏。`,
      "提到 3–4 级，或把强度写进微表情与视线。",
    );
  }
  if ((shot.beat === "setup" || shot.beat === "resolution") && intensity >= 5) {
    add(
      "emotion",
      "review",
      `${shotLabel(no)} 属于铺垫 / 收束拍，给了 5 级强度：这一拍容易过火。`,
      "降到 3 级以下，把力气留给转折与高潮。",
    );
  }
  if (
    (shot.purpose === "emotion" || shot.purpose === "reaction") &&
    !surface
  ) {
    add(
      "emotion",
      "review",
      `${shotLabel(no)} 是情绪 / 反应镜，却没写表面情绪：观众不知道该看出什么。`,
      "补一句表面情绪，潜台词可以空着。",
    );
  }

  // —— 视线：看的人必须在这一镜里，看镜头要配景别 ——
  const gaze = performance.gaze;
  if (gaze.target === "character" && gaze.targetId && !shot.characterIds.includes(gaze.targetId)) {
    const name = project.characters.find((item) => item.id === gaze.targetId)?.name ?? "那个人";
    add(
      "gaze",
      "fail",
      `${shotLabel(no)} 的视线看「${name}」，但 TA 不在这一镜里。`,
      "把 TA 加进这一镜的出场人物，或改成看画外。",
    );
  }
  if (gaze.target === "prop" && gaze.targetId && !shot.propIds.includes(gaze.targetId)) {
    const name = project.props.find((item) => item.id === gaze.targetId)?.name ?? "那件道具";
    add(
      "gaze",
      "fail",
      `${shotLabel(no)} 的视线看「${name}」，但这件道具不在这一镜里。`,
      "把道具加进这一镜，或改成看画外。",
    );
  }
  if (gaze.target === "camera" && !close) {
    add(
      "gaze",
      "review",
      `${shotLabel(no)} 不是特写却看镜头：除非故意破第四面墙，否则观众会出戏。`,
      "改成看画外或看人；真要破第四面墙，就换特写。",
    );
  }
  if (gaze.target === "character" && gaze.targetId) {
    const mark = shot.staging.find((item) => item.characterId === gaze.targetId);
    const opposite =
      (mark?.side === "left" && gaze.direction === "right") ||
      (mark?.side === "right" && gaze.direction === "left");
    if (opposite) {
      const name = project.characters.find((item) => item.id === gaze.targetId)?.name ?? "对方";
      add(
        "gaze",
        "review",
        `${shotLabel(no)} 的视线朝${gaze.direction === "left" ? "左" : "右"}，但「${name}」标在画面${mark!.side === "left" ? "左" : "右"}：方向可能写反了。`,
        "按画面左右改视线方向，或改调度里的左右。",
      );
    }
  }

  // —— 动作完整：起转落写全，起 / 落只定住那一刻 ——
  if (beats.length === 0) {
    add(
      "action",
      "review",
      `${shotLabel(no)} 没有起转落：视频提示词只剩一句情绪，中间会空转。`,
      "至少补一拍「转」，写镜头中段发生什么。",
    );
  } else if (beats.length === 1 && shot.durationMs >= 4000) {
    add(
      "action",
      "review",
      `${shotLabel(no)} 有 ${(shot.durationMs / 1000).toFixed(1)} 秒，却只写了一拍：中间没有变化。`,
      "拆成起 / 落两拍，或补一拍「转」。",
    );
  }
  const lastEnd = Math.max(0, ...beats.map((beat) => beat.endMs));
  if (beats.length > 0 && lastEnd < shot.durationMs * 0.6) {
    add(
      "action",
      "review",
      `${shotLabel(no)} 的节拍只写到 ${(lastEnd / 1000).toFixed(1)} 秒，后面 ${((shot.durationMs - lastEnd) / 1000).toFixed(1)} 秒空着。`,
      "把最后一拍的结束时间拉到镜头结尾。",
    );
  }
  for (const beat of beats) {
    if ((beat.phase === "before" || beat.phase === "after") && beat.action?.trim()) {
      add(
        "action",
        "review",
        `${shotLabel(no)} 的「${beat.phase === "before" ? "起" : "落"}」拍里写了动作：首尾帧只需要定住的那一刻。`,
        "把动作挪到「转」拍，首尾帧只留表情与姿态。",
      );
    }
  }

  // —— 情绪连续：从高到低断崖式下跌，中间该有一个反应镜头 ——
  if (previous && sameScene(project, previous, shot)) {
    const before = previous.performance;
    if (
      before &&
      before.intensity >= 4 &&
      intensity <= 2 &&
      shot.purpose !== "reaction" &&
      shot.purpose !== "transition"
    ) {
      add(
        "continuity",
        "review",
        `上一镜 ${before.intensity} 级情绪直接掉到这一镜 ${intensity} 级：剪辑点上会跳。`,
        "中间补一个反应镜头，或把这一镜标成「反应」。",
      );
    }
  }

  const verdict = findings.some((item) => item.severity === "fail")
    ? "fail"
    : findings.length > 0
      ? "review"
      : "pass";
  return { ...base, verdict, findings };
}

/**
 * 全片表演 QA。只读、不写事件：发现问题靠作者回表演面板改。
 */
export function analyzePerformanceQa(project: Project): PerformanceQaReport {
  const ordered = orderedShots(project);
  const shots = ordered.map(({ shot, no }, index) =>
    qaOfShot(project, shot, no, index > 0 ? ordered[index - 1]!.shot : undefined),
  );
  const summary = {
    shots: shots.length,
    pass: shots.filter((item) => item.verdict === "pass").length,
    review: shots.filter((item) => item.verdict === "review").length,
    fail: shots.filter((item) => item.verdict === "fail").length,
    unknown: shots.filter((item) => item.verdict === "unknown").length,
  };
  const attention = shots
    .filter((item) => item.verdict === "fail" || item.verdict === "review")
    .sort((a, b) => {
      if (a.verdict !== b.verdict) return a.verdict === "fail" ? -1 : 1;
      return a.no - b.no;
    });
  return { shots, summary, attention };
}

/** 顶栏角标：要改的镜头数（fail + review），未写表演设计的不算 */
export function performanceQaCount(report: PerformanceQaReport): number {
  return report.summary.fail + report.summary.review;
}
