import type { ProjectSkill, SkillStage } from "@loomina/ir";

/**
 * 技能进提示词（C.5 / ADR-0191）。
 *
 * 技能就是作者写好的、可复用的要求片段。这里只做两件事：按阶段筛选、
 * 按作者排的顺序拼成一句。不解释、不改写、不自动补标点——作者写什么，
 * 模型就看到什么；提示词预览与真实请求用的是同一份函数。
 */

export const SKILL_STAGE_CN: Record<SkillStage, string> = {
  all: "全部",
  sheet: "定妆",
  master: "主镜",
  prop: "道具",
  keyframe: "关键帧",
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
