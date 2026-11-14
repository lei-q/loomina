import { ProjectSkillSchema, type ProjectSkill } from "@loomina/ir";

/**
 * 技能的导入 / 导出（C18 第二档 / ADR-0210）。
 *
 * 导出的是一份纯文本包：只带名字 / 说明 / 阶段 / 内容 / 启用状态，
 * **不带 id 与 createdAt**——id 是本机生成的，带过去只会撞车。
 * 导入时逐条校验、重编 id，坏数据跳过并计数，不污染项目。
 *
 * 纯函数：不读盘、不发请求。
 */

export const SKILLS_FILE_FORMAT = "loomina.skills";
export const SKILLS_FILE_VERSION = 1;
/** 一个包最多几条：再多就是「技能库」，那是另一个功能 */
export const SKILLS_FILE_MAX = 100;
/** 文件大小上限：技能是短文本，200 KB 已经远超常见体量 */
export const SKILLS_FILE_BYTES = 200 * 1024;

export type SkillFile = {
  format: typeof SKILLS_FILE_FORMAT;
  version: number;
  exportedAt: string;
  skills: Pick<ProjectSkill, "name" | "description" | "stage" | "body" | "enabled">[];
};

/** 导出：只留可跨机器复用的字段 */
export function skillsFileOf(skills: ProjectSkill[], at: string): SkillFile {
  return {
    format: SKILLS_FILE_FORMAT,
    version: SKILLS_FILE_VERSION,
    exportedAt: at,
    skills: skills.map(({ name, description, stage, body, enabled }) => ({
      name,
      description,
      stage,
      body,
      enabled,
    })),
  };
}

export type SkillImport = {
  /** 能加的：id 已重编、createdAt 用现在 */
  skills: ProjectSkill[];
  /** 名字 + 内容已经在项目里的条数 */
  duplicates: number;
  /** 格式不对、被丢掉的条数 */
  invalid: number;
};

/** 同一条技能：名字与内容都 trim 后相同（与跨空间取用同一口径） */
function sameSkill(left: Pick<ProjectSkill, "name" | "body">, right: Pick<ProjectSkill, "name" | "body">) {
  return left.name.trim() === right.name.trim() && left.body.trim() === right.body.trim();
}

/**
 * 解析一个技能包。
 *
 * `tag` 用来重编 id（`sk-<tag>-<序号>`），保证同一批导入的 id 互不相同；
 * 与项目里已有 id 撞了的由调用方再补后缀。
 */
export function parseSkillsFile(
  raw: unknown,
  input: { existing: ProjectSkill[]; at: string; tag: string },
): SkillImport {
  const result: SkillImport = { skills: [], duplicates: 0, invalid: 0 };
  if (!raw || typeof raw !== "object") return result;
  const file = raw as Partial<SkillFile>;
  if (file.format !== SKILLS_FILE_FORMAT || !Array.isArray(file.skills)) return result;

  const known = [...input.existing];
  for (const [index, item] of file.skills.slice(0, SKILLS_FILE_MAX).entries()) {
    const parsed = ProjectSkillSchema.safeParse({
      ...(item as Record<string, unknown>),
      id: `sk-${input.tag}-${index}`,
      createdAt: input.at,
    });
    if (!parsed.success) {
      result.invalid += 1;
      continue;
    }
    if (known.some((skill) => sameSkill(skill, parsed.data))) {
      result.duplicates += 1;
      continue;
    }
    known.push(parsed.data);
    result.skills.push(parsed.data);
  }
  return result;
}

/** 文件大小 / 条数的前置检查：超了如实拒绝，不截断 */
export function skillsFileProblem(bytes: number, count: number): string | undefined {
  if (bytes > SKILLS_FILE_BYTES) return "文件超过 200 KB：技能是短文本，先看看是不是选错了文件。";
  if (count > SKILLS_FILE_MAX) return `一个包最多 ${SKILLS_FILE_MAX} 条技能：请拆成几个文件。`;
  return undefined;
}