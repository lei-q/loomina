import type { ProjectSkill, SkillStage } from "@loomina/ir";

/**
 * 技能进提示词（C.5 / ADR-0191）。
 *
 * 技能就是作者写好的、可复用的要求片段。这里只做两件事：按阶段筛选、
 * 按作者排的顺序拼成一句。不解释、不改写、不自动补标点——作者写什么，
 * 模型就看到什么；提示词预览与真实请求用的是同一份函数。
 */

export const SKILL_STAGE_CN: Record<SkillStage, string> = {
  all: "全部阶段",
  story: "故事",
  script: "剧本",
  sheet: "定妆",
  storyboard: "分镜",
  master: "场景主镜",
  prop: "道具",
  keyframe: "关键帧",
  video: "视频",
  voice: "配音",
  music: "配乐",
};

/** 适用于这个阶段的技能：关掉的不算，`all` 与同阶段都算 */
export function skillsForStage(
  skills: ProjectSkill[] | undefined,
  stage: Exclude<SkillStage, "all">,
): ProjectSkill[] {
  return (skills ?? []).filter(
    (skill) => skill.enabled && (skill.stage === "all" || skill.stage === stage),
  );
}

/** 拼成提示词的一句；没有可用技能返回空串，调用方据此不追加 */
export function compileSkills(
  skills: ProjectSkill[] | undefined,
  stage: Exclude<SkillStage, "all">,
): string {
  const active = skillsForStage(skills, stage);
  if (active.length === 0) return "";
  return active
    .map((skill) => `技能「${skill.name}」：${skill.body.trim()}`)
    .join("；");
}

/**
 * 一段提示词里所有生效技能的**总字数建议上限**（ADR-0252）。
 *
 * 单条有 2000 字上限、总数有 20 条上限，但两者相乘是 4 万字——足够把提示词预算吃光。
 * 这里给一个软上限：超过只在界面提示，**不静默截断**（作者写的东西不能不打招呼就少一半）。
 */
export const SKILL_TOTAL_BUDGET = 4000;

/** 一段提示词里会拼进去的技能（多个阶段取并集，`all` 算进去、关掉的不算） */
export function skillsForStages(
  skills: ProjectSkill[] | undefined,
  stages: Array<Exclude<SkillStage, "all">>,
): ProjectSkill[] {
  const wanted = new Set<string>(stages);
  return (skills ?? []).filter(
    (skill) => skill.enabled && (skill.stage === "all" || wanted.has(skill.stage)),
  );
}

/** 这一段提示词会多出多少字 */
export function skillCharsOf(list: ProjectSkill[]): number {
  return list.reduce((sum, skill) => sum + skill.body.trim().length, 0);
}
