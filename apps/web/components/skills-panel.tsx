"use client";

import { useEffect, useMemo, useState } from "react";
import {
  SKILL_BODY_MAX,
  SKILL_NAME_MAX,
  type ProjectSkill,
  type SkillStage,
} from "@loomina/ir";
import {
  SKILL_STAGE_CN,
  SKILL_TOTAL_BUDGET,
  skillCharsOf,
  skillsForStages,
} from "@loomina/pipeline";
import { useWorkbench } from "@/lib/workbench-store";
import { cn } from "@/lib/utils";

export type SkillsPanelProps = {
  /** 这一页会用到哪些阶段；`all` 的技能总是算进来 */
  stages: Array<Exclude<SkillStage, "all">>;
  title?: string;
  onClose: () => void;
};

const STAGE_HINT: Record<Exclude<SkillStage, "all">, string> = {
  story: "拼进故事生成（含导入 txt 改写）的系统提示词",
  script: "拼进剧本医生的系统提示词",
  sheet: "拼进定妆三视图的提示词",
  storyboard: "拼进「一句话改镜头」的解析提示词",
  master: "拼进场景主镜的提示词",
  prop: "拼进道具参考图的提示词",
  keyframe: "拼进关键帧提示词",
  video: "拼进视频提示词（风格句之前）",
  voice: "拼进配音的表演说明",
  music: "配乐生成还没做（C4），该阶段暂不开放",
};

/**
 * 技能抽屉（C18 / ADR-0252）。
 *
 * 每个创作页都有一份：只列**这一页会用到**的技能（同阶段 + 全部阶段），
 * 加 / 改 / 开关 / 删都在这里做；设置页保留全量管理。
 * 技能写进项目日志，回放、换设备都在。
 */
export function SkillsPanel({ stages, title = "技能", onClose }: SkillsPanelProps) {
  const skills = useWorkbench((state) => state.project.skills);
  const readOnly = useWorkbench((state) => state.readOnly);
  const addSkill = useWorkbench((state) => state.addSkill);
  const updateSkill = useWorkbench((state) => state.updateSkill);
  const removeSkill = useWorkbench((state) => state.removeSkill);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [stage, setStage] = useState<Exclude<SkillStage, "all">>(stages[0]!);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  /** 这一页管得到哪条技能：同阶段，或「全部阶段」 */
  const onThisPage = (skill: ProjectSkill) =>
    skill.stage === "all" || (stages as SkillStage[]).includes(skill.stage);

  const relevant = useMemo(() => skillsForStages(skills, stages), [skills, stages]);
  const chars = useMemo(() => skillCharsOf(relevant), [relevant]);
  const over = chars > SKILL_TOTAL_BUDGET;

  const closeForm = () => {
    setOpen(false);
    setEditingId(undefined);
    setName("");
    setDescription("");
    setBody("");
    setStage(stages[0]!);
    setError(undefined);
  };

  const startEdit = (skill: ProjectSkill) => {
    setEditingId(skill.id);
    setName(skill.name);
    setDescription(skill.description);
    setBody(skill.body);
    setStage(
      skill.stage === "all" ? stages[0]! : (skill.stage as Exclude<SkillStage, "all">),
    );
    setError(undefined);
    setOpen(true);
  };

  const submit = () => {
    if (editingId) {
      updateSkill(editingId, { name, description, stage, body });
      closeForm();
      return;
    }
    const id = addSkill({ name, description, stage, body });
    if (!id) {
      setError(useWorkbench.getState().castError ?? "这条技能加不上。");
      return;
    }
    closeForm();
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label={title}
        className="flex h-full w-[470px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">{title}</h2>
            <span className="tnum text-[9px] text-muted-2">
              {relevant.length} 条生效
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-token border border-line px-2 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            关闭
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <p className="text-[9.5px] leading-[1.7] text-muted-2">
            这一页会用到：{stages.map((item) => SKILL_STAGE_CN[item]).join(" / ")}
            ，以及「全部阶段」的技能。关掉只是不加进下一次提示词，不删记录；
            已经生成的内容不会自动重做。
          </p>
          <p
            className={cn(
              "tnum mt-1 text-[9px]",
              over ? "text-pick" : "text-muted-2",
            )}
            title={`单条上限 ${SKILL_BODY_MAX} 字；这里是这一段提示词会多出的字数`}
          >
            本轮拼进 {chars} 字
            {over ? ` · 超过建议上限 ${SKILL_TOTAL_BUDGET} 字，提示词会变长` : ""}
          </p>

          <div className="mt-3 space-y-1.5">
            {relevant.map((skill) => (
              <div
                key={skill.id}
                className="flex flex-wrap items-start gap-2 border border-line px-2.5 py-2"
              >
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => updateSkill(skill.id, { enabled: false })}
                  title="关掉：不加进下一次提示词"
                  className="shrink-0 rounded-[1px] border border-pick/60 px-1.5 py-0.5 text-[9px] text-pick transition-colors duration-[var(--dur)] disabled:opacity-40"
                >
                  生效中
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[10.5px] text-text">{skill.name}</span>
                    <span className="tnum text-[8.5px] text-muted-2">
                      {SKILL_STAGE_CN[skill.stage]}
                    </span>
                  </div>
                  {skill.description && (
                    <p className="mt-0.5 text-[9px] text-muted-2">{skill.description}</p>
                  )}
                  <p className="mt-1 whitespace-pre-wrap break-words text-[9.5px] leading-[1.7] text-muted">
                    {skill.body}
                  </p>
                </div>
                <span className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => startEdit(skill)}
                    title="改名字 / 阶段 / 内容"
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text disabled:opacity-40"
                  >
                    改
                  </button>
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => removeSkill(skill.id)}
                    title="删掉这条技能：事件日志里仍留着记录"
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-pick disabled:opacity-40"
                  >
                    删
                  </button>
                </span>
              </div>
            ))}
            {relevant.length === 0 && (
              <p className="text-[9.5px] text-muted-2">
                这一页还没有可用的技能。比如「场景里不要出现现代物品」。
              </p>
            )}
          </div>

          {/* 关掉的技能也列出来，否则在设置页关了之后这里找不到、打不开 */}
          {skills.some((skill) => !skill.enabled && onThisPage(skill)) && (
            <details className="mt-3">
              <summary className="cursor-pointer text-[9px] text-muted-2">
                已关掉的技能
              </summary>
              <div className="mt-1.5 space-y-1">
                {skills
                  .filter((skill) => !skill.enabled && onThisPage(skill))
                  .map((skill) => (
                    <div key={skill.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[9.5px] text-muted-2">
                        {skill.name} · {SKILL_STAGE_CN[skill.stage]}
                      </span>
                      <button
                        type="button"
                        disabled={readOnly}
                        onClick={() => updateSkill(skill.id, { enabled: true })}
                        className="shrink-0 text-[9px] text-muted-2 hover:text-text disabled:opacity-40"
                      >
                        打开
                      </button>
                    </div>
                  ))}
              </div>
            </details>
          )}

          {open ? (
            <div className="mt-3 space-y-2 border border-dashed border-line-2 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  value={name}
                  maxLength={SKILL_NAME_MAX}
                  aria-label="技能名字"
                  placeholder="技能名字：禁止现代物品"
                  onChange={(event) => setName(event.target.value)}
                  className="min-w-[200px] flex-1 rounded-token border border-line-2 bg-surface px-2 py-1 text-[10.5px] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
                />
                <select
                  value={stage}
                  aria-label="技能用在哪个阶段"
                  onChange={(event) =>
                    setStage(event.target.value as Exclude<SkillStage, "all">)
                  }
                  className="rounded-token border border-line-2 bg-surface px-1.5 py-1 text-[10px] text-text focus:border-pick focus:outline-none"
                >
                  {stages.map((value) => (
                    <option key={value} value={value}>
                      {SKILL_STAGE_CN[value]}
                    </option>
                  ))}
                </select>
              </div>
              <input
                value={description}
                maxLength={200}
                aria-label="技能说明"
                placeholder="给自己看的说明（不进提示词）"
                onChange={(event) => setDescription(event.target.value)}
                className="w-full rounded-token border border-line-2 bg-surface px-2 py-1 text-[10px] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
              />
              <textarea
                value={body}
                maxLength={SKILL_BODY_MAX}
                rows={3}
                aria-label="技能内容"
                placeholder="真正拼进提示词的那一段"
                onChange={(event) => setBody(event.target.value)}
                className="w-full resize-y rounded-token border border-line-2 bg-surface px-2 py-1.5 text-[10.5px] leading-[1.7] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
              />
              <p className="text-[8.5px] leading-[1.6] text-muted-2">
                {STAGE_HINT[stage]}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={submit}
                  disabled={readOnly || !name.trim() || !body.trim()}
                  className="rounded-token border border-line-2 px-2.5 py-1 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick disabled:opacity-40"
                >
                  {editingId ? "存下改动" : "存下这条"}
                </button>
                <button
                  type="button"
                  onClick={closeForm}
                  className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  取消
                </button>
                <span className="tnum text-[8.5px] text-muted-2">
                  {body.length} / {SKILL_BODY_MAX}
                </span>
              </div>
              {error && <p className="text-[9.5px] text-pick">{error}</p>}
            </div>
          ) : (
            !readOnly && (
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="mt-3 rounded-token border border-dashed border-line-2 px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
              >
                ＋ 新建一条技能
              </button>
            )
          )}

          <p className="mt-4 border-t border-line pt-2 text-[9px] leading-[1.7] text-muted-2">
            全量管理（导入 / 导出 / 跨空间取用 / 所有阶段）在设置页的「技能」区。
          </p>
        </div>
      </aside>
    </div>
  );
}
