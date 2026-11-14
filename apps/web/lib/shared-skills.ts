import type { Project, ProjectSkill } from "@loomina/ir";
import type { WorkspaceProject } from "@/lib/workspace-assets";

/**
 * 跨空间取技能（C.5 / ADR-0202）。
 *
 * 技能是作者写好的固定要求（「不要现代物品」「袖口总是卷起」），
 * 下一集重抄一遍没有意义。这里只从别的空间读出清单；
 * 取用把内容抄成当前项目的一条新技能（自己的 id），不共享同一个对象。
 */

export type SharedSkill = {
  workspaceId: string;
  workspaceName: string;
  skill: ProjectSkill;
  /** 已经在本空间里有一模一样的一条（名字 + 内容相同）：列出来但不让取 */
  duplicate: boolean;
};

/** 同一条技能：名字与内容都一样才算（启用状态与说明不算） */
function sameSkill(left: ProjectSkill, right: ProjectSkill): boolean {
  return left.name.trim() === right.name.trim() && left.body.trim() === right.body.trim();
}

/**
 * 本机别的空间里能取的技能（纯函数）。
 *
 * 同名不同内容也算另一样：作者可能在不同集里把同一句要求写细了，
 * 两条都该看得见。同一个空间里重复定义的同一条只列一次。
 */
export function sharedSkillsOf(spaces: WorkspaceProject[], current: Project): SharedSkill[] {
  const list: SharedSkill[] = [];
  const seen = new Set<string>();
  for (const space of spaces) {
    for (const skill of space.project.skills) {
      const key = `${skill.name.trim()}\u0000${skill.body.trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        workspaceId: space.id,
        workspaceName: space.name,
        skill,
        duplicate: current.skills.some((item) => sameSkill(item, skill)),
      });
    }
  }
  // 能取的排前面；同一批里保持来源顺序（工作空间列表本来就是最近用过的在前）
  return list.sort((a, b) => Number(a.duplicate) - Number(b.duplicate));
}