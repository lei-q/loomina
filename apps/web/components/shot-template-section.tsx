"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkbench } from "@/lib/workbench-store";
import { shotLabel, toStageView } from "@/lib/read-model";
import { shotTemplateOf, type ShotTemplate } from "@/lib/shot-template";
import { listShotTemplates, removeShotTemplate, saveShotTemplate } from "@/lib/template-store";
import {
  TEMPLATE_NAME_MAX,
  TEMPLATE_NOTE_MAX,
  findSameShotTemplate,
  renameShotTemplate,
  templateNameProblem,
  templateNoteProblem,
  withShotTemplateNote,
} from "@/lib/template-edit";
import { cn } from "@/lib/utils";

/**
 * 镜头模板（F3 / ADR-0207）。
 *
 * 一套「摄影做法」：景别 / 机位 / 运镜 / 焦段 + 可选光影与构图。
 * 存的是参数，不存动作与台词；套用写一条 `shot.updated`，不花钱。
 */
export function ShotTemplateSection({ readOnly }: { readOnly: boolean }) {
  const project = useWorkbench((state) => state.project);
  const applyShotTemplate = useWorkbench((state) => state.applyShotTemplate);
  const stage = useMemo(() => toStageView(project), [project]);
  const [templates, setTemplates] = useState<ShotTemplate[]>();
  const [shotId, setShotId] = useState(stage.shots[0]?.id ?? "");
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  /** 正在编辑的模板（改名 + 说明） */
  const [editing, setEditing] = useState<{ id: string; name: string; note: string }>();

  const load = useCallback(async () => {
    try {
      setTemplates(await listShotTemplates());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读不到镜头模板。");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 「第 2 场 · 第 3 镜」：与废片库同一口径 */
  const shotPlace = (id: string): string => {
    const shot = project.shots.find((item) => item.id === id);
    if (!shot) return id;
    const scene = project.scenes.find((item) => item.id === shot.sceneId);
    const stageIndex = stage.shots.findIndex((item) => item.id === id);
    const sceneLabel = scene ? `第 ${scene.index + 1} 场` : "未进场次";
    return `${sceneLabel} · ${shotLabel((stageIndex >= 0 ? stageIndex : 0) + 1)}`;
  };

  const save = async () => {
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) {
      setError("先挑一镜。");
      return;
    }
    const id = `st-${Date.now().toString(36)}`;
    const template = shotTemplateOf(project, shot, {
      id,
      name: name.trim() || `${shotPlace(shot.id)} 的做法`,
      at: new Date().toISOString(),
      shotLabel: shotPlace(shot.id),
    });
    const same = findSameShotTemplate(templates ?? [], template);
    if (same) {
      setNotice(`这套拍法已经存过了：「${same.name}」。改名字或删掉旧的那份都行。`);
      return;
    }
    try {
      await saveShotTemplate(template);
      setName("");
      setNotice(`存下了「${template.name}」。`);
      setError(undefined);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模板没存上。");
    }
  };

  const apply = (template: ShotTemplate) => {
    const ok = applyShotTemplate(shotId, template);
    setNotice(
      ok
        ? `套上了「${template.name}」：只换了景别 / 机位 / 运镜 / 焦段${template.lighting ? " / 光影" : ""}${template.composition ? " / 构图" : ""}，动作与台词没动。`
        : (useWorkbench.getState().castError ?? "这一镜套不上。"),
    );
  };

  const drop = async (template: ShotTemplate) => {
    await removeShotTemplate(template.id);
    setNotice(`删掉了「${template.name}」：正在用的项目不受影响。`);
    await load();
  };

  /** 存回改名 / 说明：只动这两个字段，createdAt 与 from 保留 */
  const commitEdit = async (template: ShotTemplate) => {
    if (!editing || editing.id !== template.id) return;
    const problem = templateNameProblem(editing.name) ?? templateNoteProblem(editing.note);
    if (problem) {
      setError(problem);
      return;
    }
    setError(undefined);
    try {
      const renamed = withShotTemplateNote(
        renameShotTemplate(template, editing.name),
        editing.note,
      );
      await saveShotTemplate(renamed);
      setEditing(undefined);
      setNotice(`改好了：「${renamed.name}」。`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "改不了这个模板。");
    }
  };

  /** 导出：一个 JSON 文件，只读备份；导入另开 ADR */
  const exportAll = () => {
    const list = templates ?? [];
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `loomina-shot-templates-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice(`导出了 ${list.length} 份镜头模板。`);
  };

  return (
    <section className="mt-9 border-t border-line pt-5" aria-label="镜头模板">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[12px] tracking-[.04em]">镜头模板</h2>
          <span className="tnum text-[9px] text-muted-2">F3</span>
        </div>
        <span className="tnum text-[9.5px] text-muted-2">
          {templates ? `${templates.length} 份` : "读不到模板仓"}
        </span>
      </div>
      <p className="mt-1 max-w-[640px] text-[9.5px] leading-[1.7] text-muted-2">
        存的是「拍法」：景别、机位、运镜、焦段，外加光影与构图模板。动作、台词、时长、
        出场人物与道具不带走——换的是拍法，不是内容。套用写一条镜头改动，不花钱。
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          aria-label="从哪一镜存模板"
          value={shotId}
          onChange={(event) => setShotId(event.target.value)}
          className="rounded-token border border-line bg-surface px-1.5 py-0.5 text-[10px] text-text"
        >
          {stage.shots.map((shot) => (
            <option key={shot.id} value={shot.id}>
              {shotPlace(shot.id)} · {shot.action.slice(0, 14) || "（没有动作）"}
            </option>
          ))}
        </select>
        <input
          value={name}
          aria-label="镜头模板名字"
          placeholder="模板名字（不填用镜号）"
          onChange={(event) => setName(event.target.value)}
          className="w-[200px] rounded-token border border-line bg-surface px-2 py-1 text-[10px] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
        />
        <button
          type="button"
          disabled={readOnly || !shotId}
          onClick={() => void save()}
          className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
        >
          把这一镜存成模板
        </button>
        <button
          type="button"
          onClick={exportAll}
          disabled={(templates?.length ?? 0) === 0}
          title="导出一个 JSON 文件：只读备份，换机器后不能导入（另开 ADR 再做）"
          className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
        >
          导出全部
        </button>
      </div>

      <ul className="mt-2 space-y-1">
        {(templates ?? []).map((template) => (
          <li
            key={template.id}
            className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line/60 pt-1.5 first:border-t-0 first:pt-0"
          >
            {editing?.id === template.id ? (
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <input
                    value={editing.name}
                    maxLength={TEMPLATE_NAME_MAX}
                    aria-label="模板名字"
                    onChange={(event) => {
                        const value = event.target.value;
                        setEditing((prev) => (prev ? { ...prev, name: value } : prev));
                      }}
                    className="w-[140px] rounded-token border border-line-2 bg-surface px-1.5 py-0.5 text-[10px] text-text focus:border-pick focus:outline-none"
                  />
                  <input
                    value={editing.note}
                    maxLength={TEMPLATE_NOTE_MAX}
                    aria-label="模板说明"
                    placeholder="说明（可选）"
                    onChange={(event) => {
                        const value = event.target.value;
                        setEditing((prev) => (prev ? { ...prev, note: value } : prev));
                      }}
                    className="min-w-0 flex-1 rounded-token border border-line bg-surface px-1.5 py-0.5 text-[9.5px] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
                  />
                </span>
              </span>
            ) : (
              <span className="min-w-0">
                <span className="text-[10px] text-text">{template.name}</span>
                <span className="tnum ml-2 text-[9px] text-muted-2">
                  {template.shotSize} · {template.angle} · {template.movement} · {template.focalMm}mm
                  {template.lighting ? " · 光影" : ""}
                  {template.composition ? " · 构图" : ""}
                </span>
                <span className="ml-2 text-[8.5px] text-muted-2">
                  来自「{template.from.title}」{template.from.shotLabel}
                </span>
                {template.note && (
                  <span className="mt-0.5 block text-[9px] text-muted-2">{template.note}</span>
                )}
              </span>
            )}
            <span className="flex items-center gap-2">
              {editing?.id === template.id ? (
                <>
                  <button
                    type="button"
                    onClick={() => void commitEdit(template)}
                    disabled={readOnly}
                    className="rounded-token border border-line-2 px-2 py-0.5 text-[9.5px] text-text transition-colors duration-[var(--dur)] hover:bg-text/10 disabled:opacity-40"
                  >
                    存
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(undefined)}
                    className="text-[9px] text-muted-2 hover:text-text"
                  >
                    算了
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    setEditing({ id: template.id, name: template.name, note: template.note ?? "" })
                  }
                  disabled={readOnly}
                  title="改名字或加说明：不会重置保存时间与来历"
                  className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text disabled:opacity-40"
                >
                  改
                </button>
              )}
              <button
                type="button"
                disabled={readOnly || !shotId}
                onClick={() => apply(template)}
                title="把这一套拍法套到上面挑的那一镜；动作与台词不动"
                className={cn(
                  "rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)]",
                  "enabled:hover:border-pick enabled:hover:text-pick disabled:opacity-40",
                )}
              >
                套到这一镜
              </button>
              <button
                type="button"
                onClick={() => void drop(template)}
                disabled={readOnly}
                className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-pick/60 enabled:hover:text-pick disabled:opacity-40"
              >
                删
              </button>
            </span>
          </li>
        ))}
      </ul>
      {templates && templates.length === 0 && (
        <p className="mt-1.5 text-[9px] text-muted-2">
          还没有镜头模板：挑一镜摆好景别与机位，再回来存一份。
        </p>
      )}

      {notice && <p className="mt-2 text-[9.5px] leading-[1.7] text-muted">{notice}</p>}
      {error && <p className="mt-2 text-[9.5px] leading-[1.7] text-pick">{error}</p>}
    </section>
  );
}