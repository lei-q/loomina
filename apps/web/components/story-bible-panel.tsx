"use client";

import { useEffect, useMemo, useState } from "react";
import { HOOK_TYPES, scoreHook, type HookPosition } from "@/lib/hooks";
import { useWorkbench } from "@/lib/workbench-store";
import { cn } from "@/lib/utils";

/**
 * 故事圣经（A16）：单独编辑弧光与关系张力。
 *
 * 生成出来的故事只落一次项目；之后要改某个人的 want / 伤口 / 弧光，
 * 不该整份重新生成——那会把别的改过的字一起冲掉。这里每个字段各写一条
 * `story.updated`，只动改过的那一个。
 */

const ARC_FIELDS: { key: ArcKey; label: string; hint: string }[] = [
  { key: "want", label: "要", hint: "表层欲望：这一集里他想拿到什么" },
  { key: "need", label: "缺", hint: "深层需要：他真正缺的是什么" },
  { key: "wound", label: "伤", hint: "过去留下的裂缝" },
  { key: "flaw", label: "缺陷", hint: "让他做错选择的东西" },
  { key: "secret", label: "秘密", hint: "别人还不知道的事" },
  { key: "agency", label: "选择", hint: "他主动做出的选择" },
  { key: "arc", label: "弧光", hint: "这一集从哪走到哪" },
];

type ArcKey = "want" | "need" | "wound" | "flaw" | "secret" | "agency" | "arc";

const HOOK_ROWS: { pos: HookPosition; label: string; hint: string }[] = [
  { pos: "opening", label: "开场钩子", hint: "前 3 秒：让人不划走" },
  { pos: "ending", label: "结尾钩子", hint: "最后一秒：让人点下一集" },
];

export function StoryBiblePanel() {
  const project = useWorkbench((state) => state.project);
  const readOnly = useWorkbench((state) => state.readOnly);
  const editStory = useWorkbench((state) => state.editStory);
  const editArc = useWorkbench((state) => state.editArc);
  const editRelationship = useWorkbench((state) => state.editRelationship);
  const castError = useWorkbench((state) => state.castError);

  const story = project.story;
  const characters = useMemo(
    () =>
      project.characters.map((character) => ({
        id: character.id,
        name: character.name,
      })),
    [project.characters],
  );
  const nameOf = (id: string) =>
    characters.find((character) => character.id === id)?.name ?? id;

  /** 正在改的字段：`arc:<角色>:<字段>` / `rel:<from>:<to>` / `text:<字段>` */
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState("");

  const open = (key: string, value: string) => {
    setEditing(key);
    setDraft(value);
  };

  const close = () => setEditing(undefined);

  const commitText = (key: string) => {
    const ok = editStory({ [key]: draft } as Parameters<typeof editStory>[0]);
    if (ok) close();
  };

  /** 钩子单独走：编辑态与其它字段分开，存的时候仍只写一条 `story.updated` */
  const [hookEditing, setHookEditing] = useState<HookPosition>();
  const [hookDraft, setHookDraft] = useState("");

  const openHook = (pos: HookPosition) => {
    setHookEditing(pos);
    setHookDraft(story.hooks[pos]);
  };

  /** 类型库的例子只填进编辑框，不直接保存：作者改完再按「存」 */
  const applyHookExample = (pos: HookPosition, example: string) => {
    setHookEditing(pos);
    setHookDraft(example);
  };

  const commitHook = () => {
    if (!hookEditing) return;
    const key = hookEditing === "opening" ? "openingHook" : "endingHook";
    const ok = editStory({ [key]: hookDraft } as Parameters<typeof editStory>[0]);
    if (ok) setHookEditing(undefined);
  };

  const commitArc = (characterId: string, field: ArcKey) => {
    const ok = editArc(characterId, { [field]: draft.trim() });
    if (ok) close();
  };

  const commitRelation = (from: string, to: string) => {
    const ok = editRelationship(from, to, draft);
    if (ok) close();
  };

  const filled =
    [story.logline, story.synopsis, story.genre, story.audience, story.tone].filter(
      (item) => item.trim(),
    ).length;

  return (
    <section className="mt-6 rounded-token border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[11px] tracking-[.06em] text-text">故事圣经</h2>
        <span className="tnum text-[9.5px] text-muted-2">
          {story.arcs.length} 条人物弧光 · {story.relationships.length} 对关系 · 5 项里填了 {filled}
        </span>
      </div>
      <p className="mt-1 text-[10px] leading-[1.7] text-muted-2">
        生成之后想改哪一条就改哪一条：每次只写一条 <code>story.updated</code>，别的字不动。
        弧光与关系会进下游提示词，也会被导出前的合规预检读到。
      </p>

      {readOnly && (
        <p className="mt-2 text-[10px] text-pick">另一个标签页在编辑：这里只读。</p>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {(
          [
            ["logline", "Logline"],
            ["synopsis", "梗概"],
            ["genre", "类型"],
            ["audience", "受众"],
            ["tone", "调性"],
          ] as const
        ).map(([key, label]) => {
          const value = story[key];
          const isOpen = editing === `text:${key}`;
          return (
            <div key={key} className="rounded-token border border-line bg-bg px-2.5 py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[9px] tracking-[.1em] text-muted-2">{label}</span>
                {!isOpen && !readOnly && (
                  <button
                    type="button"
                    onClick={() => open(`text:${key}`, value)}
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
                  >
                    改
                  </button>
                )}
              </div>
              {isOpen ? (
                <div className="mt-1 flex items-start gap-1">
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    rows={key === "synopsis" ? 3 : 2}
                    maxLength={key === "synopsis" ? 600 : 200}
                    className="min-w-0 flex-1 resize-none rounded-token border border-line bg-transparent px-1.5 py-1 text-[10.5px] leading-[1.7] text-text focus:border-line-2 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => commitText(key)}
                    className="shrink-0 rounded-token border border-line-2 bg-text/10 px-1.5 py-0.5 text-[9px] text-text hover:bg-text/20"
                  >
                    存
                  </button>
                  <button
                    type="button"
                    onClick={close}
                    className="shrink-0 rounded-token border border-line px-1.5 py-0.5 text-[9px] text-muted hover:border-line-2 hover:text-text"
                  >
                    撤
                  </button>
                </div>
              ) : (
                <p
                  className={cn(
                    "mt-0.5 text-[10.5px] leading-[1.7]",
                    value.trim() ? "text-muted" : "text-muted-2",
                  )}
                >
                  {value.trim() || "还没填"}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[10px] tracking-[.12em] text-muted-2">钩子设计器</h3>
        <span className="tnum text-[9px] text-muted-2">A19 · 分数只是形状，不阻断生成</span>
      </div>
      <p className="mt-1 text-[9.5px] leading-[1.7] text-muted-2">
        开场钩子决定前 3 秒，结尾钩子决定下一集。四个分项是规则打分，不是审美判断；
        改完按「存」才写一条 <code>story.updated</code>。
      </p>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {HOOK_ROWS.map((row) => {
          const editing = hookEditing === row.pos;
          const value = editing ? hookDraft : story.hooks[row.pos];
          const score = scoreHook(value, row.pos);
          return (
            <div
              key={row.pos}
              className="rounded-token border border-line bg-bg px-2.5 py-2"
              aria-label={`${row.label}评分`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[10px] text-text">{row.label}</span>
                  <span className="text-[8.5px] text-muted-2">{row.hint}</span>
                </div>
                {!editing && !readOnly && (
                  <button
                    type="button"
                    onClick={() => openHook(row.pos)}
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
                  >
                    {value.trim() ? "改" : "写"}
                  </button>
                )}
              </div>

              {editing ? (
                <div className="mt-1 flex items-start gap-1">
                  <textarea
                    value={hookDraft}
                    onChange={(event) => setHookDraft(event.target.value)}
                    rows={2}
                    maxLength={120}
                    aria-label={`${row.label}（可编辑）`}
                    className="min-w-0 flex-1 resize-none rounded-token border border-line bg-transparent px-1.5 py-1 text-[10.5px] leading-[1.7] text-text focus:border-line-2 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={commitHook}
                    className="shrink-0 rounded-token border border-line-2 bg-text/10 px-1.5 py-0.5 text-[9px] text-text hover:bg-text/20"
                  >
                    存
                  </button>
                  <button
                    type="button"
                    onClick={() => setHookEditing(undefined)}
                    className="shrink-0 rounded-token border border-line px-1.5 py-0.5 text-[9px] text-muted hover:border-line-2 hover:text-text"
                  >
                    撤
                  </button>
                </div>
              ) : (
                <p
                  className={cn(
                    "mt-0.5 text-[10.5px] leading-[1.7]",
                    value.trim() ? "text-muted" : "text-muted-2",
                  )}
                >
                  {value.trim() || "还没写"}
                </p>
              )}

              {value.trim() && (
                <>
                  <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
                    <span className="tnum text-[14px] text-text">{score.total}</span>
                    <span className="text-[8.5px] text-muted-2">分</span>
                    <span className="text-[8.5px] text-muted-2">
                      {score.types.length > 0 ? score.types.join(" / ") : "未命中固定类型"}
                    </span>
                  </div>
                  <dl className="mt-1 grid grid-cols-4 gap-1">
                    {(
                      [
                        ["好奇", score.curiosity],
                        ["紧迫", score.urgency],
                        ["可视", score.visual],
                        ["新鲜", score.novelty],
                      ] as const
                    ).map(([label, number]) => (
                      <div key={label}>
                        <dt className="tnum text-[8px] text-muted-2">
                          {label} {number}
                        </dt>
                        <dd className="mt-0.5 h-[2px] w-full bg-line">
                          <span
                            className="block h-full bg-text/50"
                            style={{ width: `${number}%` }}
                          />
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-1 text-[8.5px] leading-[1.6] text-muted-2">
                    {score.notes.slice(0, 2).join(" ")}
                  </p>
                </>
              )}
            </div>
          );
        })}
      </div>

      <details className="mt-2 rounded-token border border-line bg-bg px-3 py-2">
        <summary className="cursor-pointer text-[10px] leading-[1.7] text-muted">
          钩子类型库 · {HOOK_TYPES.length} 种写法与例子
        </summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {HOOK_TYPES.map((type) => (
            <div key={type.id} className="rounded-token border border-line px-2.5 py-1.5">
              <div className="flex flex-wrap items-baseline gap-1.5">
                <span className="text-[10px] text-text">{type.name}</span>
                <span className="text-[8.5px] text-muted-2">
                  {type.positions.map((pos) => (pos === "opening" ? "开场" : "结尾")).join(" / ")}
                </span>
              </div>
              <p className="mt-0.5 text-[9px] leading-[1.6] text-muted-2">{type.note}</p>
              <p className="mt-0.5 text-[9px] leading-[1.6] text-muted">{type.pattern}</p>
              <p className="mt-0.5 text-[8.5px] leading-[1.6] text-muted-2">
                例：{type.example}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {type.positions.map((pos) => (
                  <button
                    key={pos}
                    type="button"
                    disabled={readOnly}
                    onClick={() => applyHookExample(pos, type.example)}
                    className="rounded-token border border-line px-1.5 py-0.5 text-[8.5px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
                  >
                    填进{pos === "opening" ? "开场" : "结尾"}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </details>

      <h3 className="mt-5 text-[10px] tracking-[.12em] text-muted-2">人物弧光</h3>
      {story.arcs.length === 0 ? (
        <p className="mt-1.5 text-[10px] leading-[1.7] text-muted-2">
          还没有弧光：故事入口生成时会一起给出；也可以先在剧本页建角色，再回来补。
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {story.arcs.map((arc) => (
            <article
              key={arc.characterId}
              className="rounded-token border border-line bg-bg px-2.5 py-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <h4 className="text-[11px] text-text">{nameOf(arc.characterId)}</h4>
                <span className="text-[9px] text-muted-2">
                  {ARC_FIELDS.filter((field) => arc[field.key].trim()).length} / 7 项
                </span>
              </div>
              <dl className="mt-1.5 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {ARC_FIELDS.map((field) => {
                  const key = `arc:${arc.characterId}:${field.key}`;
                  const isOpen = editing === key;
                  const value = arc[field.key];
                  return (
                    <div key={field.key} className="flex items-baseline gap-1.5">
                      <dt className="shrink-0 text-[9px] text-muted-2" title={field.hint}>
                        {field.label}
                      </dt>
                      {isOpen ? (
                        <div className="flex min-w-0 flex-1 items-center gap-1">
                          <input
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            maxLength={200}
                            autoFocus
                            className="min-w-0 flex-1 rounded-token border border-line bg-transparent px-1 py-0.5 text-[10px] text-text focus:border-line-2 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => commitArc(arc.characterId, field.key)}
                            className="shrink-0 rounded-token border border-line-2 px-1 text-[9px] text-text hover:bg-text/10"
                          >
                            存
                          </button>
                          <button
                            type="button"
                            onClick={close}
                            className="shrink-0 rounded-token border border-line px-1 text-[9px] text-muted hover:border-line-2 hover:text-text"
                          >
                            撤
                          </button>
                        </div>
                      ) : (
                        <dd className="min-w-0 flex-1">
                          <button
                            type="button"
                            disabled={readOnly}
                            onClick={() => open(key, value)}
                            title={`${field.hint}${value.trim() ? "" : " · 点一下补上"}`}
                            className={cn(
                              "block w-full truncate text-left text-[10px] leading-[1.6] transition-colors duration-[var(--dur)] hover:text-text disabled:cursor-default",
                              value.trim() ? "text-muted" : "text-muted-2",
                            )}
                          >
                            {value.trim() || "—"}
                          </button>
                        </dd>
                      )}
                    </div>
                  );
                })}
              </dl>
            </article>
          ))}
        </div>
      )}

      <h3 className="mt-5 text-[10px] tracking-[.12em] text-muted-2">关系张力</h3>
      {story.relationships.length === 0 ? (
        <p className="mt-1.5 text-[10px] leading-[1.7] text-muted-2">
          还没有关系：每对关系要回答「想要 / 害怕 / 隐瞒」里的至少一件。
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {story.relationships.map((relation) => {
            const key = `rel:${relation.fromCharacterId}:${relation.toCharacterId}`;
            const isOpen = editing === key;
            return (
              <li
                key={key}
                className="rounded-token border border-line bg-bg px-2.5 py-1.5"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[10px] text-text">
                    {nameOf(relation.fromCharacterId)} → {nameOf(relation.toCharacterId)}
                  </span>
                  {!isOpen && !readOnly && (
                    <span className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => open(key, relation.tension)}
                        className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
                      >
                        改
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (editRelationship(relation.fromCharacterId, relation.toCharacterId, "")) {
                            setEditing(undefined);
                          }
                        }}
                        title="删掉这条关系（张力写空即可）"
                        className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-pick"
                      >
                        删
                      </button>
                    </span>
                  )}
                </div>
                {isOpen ? (
                  <div className="mt-1 flex items-start gap-1">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={2}
                      maxLength={200}
                      autoFocus
                      className="min-w-0 flex-1 resize-none rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] leading-[1.6] text-text focus:border-line-2 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        commitRelation(relation.fromCharacterId, relation.toCharacterId)
                      }
                      className="shrink-0 rounded-token border border-line-2 px-1.5 py-0.5 text-[9px] text-text hover:bg-text/10"
                    >
                      存
                    </button>
                    <button
                      type="button"
                      onClick={close}
                      className="shrink-0 rounded-token border border-line px-1.5 py-0.5 text-[9px] text-muted hover:border-line-2 hover:text-text"
                    >
                      撤
                    </button>
                  </div>
                ) : (
                  <p
                    className={cn(
                      "mt-0.5 text-[10px] leading-[1.7]",
                      relation.tension.trim() ? "text-muted-2" : "text-pick",
                    )}
                  >
                    {relation.tension.trim() || "还没写张力"}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AddRelationship
        characters={characters}
        existing={story.relationships.map(
          (relation) => `${relation.fromCharacterId}->${relation.toCharacterId}`,
        )}
        disabled={Boolean(readOnly)}
        onAdd={(from, to, tension) => {
          if (editRelationship(from, to, tension)) setEditing(undefined);
        }}
      />

      {castError && (
        <p className="mt-2 text-[10px] leading-[1.6] text-pick">{castError}</p>
      )}
    </section>
  );
}

function AddRelationship({
  characters,
  existing,
  disabled,
  onAdd,
}: {
  characters: { id: string; name: string }[];
  existing: string[];
  disabled: boolean;
  onAdd: (from: string, to: string, tension: string) => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [tension, setTension] = useState("");

  // 角色删掉之后清掉失效的选择
  useEffect(() => {
    if (from && !characters.some((item) => item.id === from)) setFrom("");
    if (to && !characters.some((item) => item.id === to)) setTo("");
  }, [characters, from, to]);

  const duplicated = Boolean(from && to && existing.includes(`${from}->${to}`));
  const invalid = !from || !to || from === to || duplicated || !tension.trim();

  if (characters.length < 2) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <select
        value={from}
        onChange={(event) => setFrom(event.target.value)}
        disabled={disabled}
        className="rounded-token border border-line bg-transparent px-1.5 py-0.5 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
      >
        <option value="" className="bg-surface">
          谁
        </option>
        {characters.map((character) => (
          <option key={character.id} value={character.id} className="bg-surface">
            {character.name}
          </option>
        ))}
      </select>
      <span className="text-[9.5px] text-muted-2">→</span>
      <select
        value={to}
        onChange={(event) => setTo(event.target.value)}
        disabled={disabled}
        className="rounded-token border border-line bg-transparent px-1.5 py-0.5 text-[9.5px] text-text focus:border-line-2 focus:outline-none"
      >
        <option value="" className="bg-surface">
          对谁
        </option>
        {characters.map((character) => (
          <option key={character.id} value={character.id} className="bg-surface">
            {character.name}
          </option>
        ))}
      </select>
      <input
        value={tension}
        onChange={(event) => setTension(event.target.value)}
        maxLength={200}
        placeholder="他们想要 / 害怕 / 隐瞒什么"
        disabled={disabled}
        className="min-w-[180px] flex-1 rounded-token border border-line bg-transparent px-1.5 py-0.5 text-[9.5px] text-text placeholder:text-muted-2 focus:border-line-2 focus:outline-none"
      />
      <button
        type="button"
        disabled={disabled || invalid}
        title={
          from === to && from
            ? "两端不能是同一个人"
            : duplicated
              ? "这对关系已经有了"
              : invalid
                ? "选两个人，再写一句张力"
                : "加一对关系"
        }
        onClick={() => {
          onAdd(from, to, tension);
          setTension("");
        }}
        className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
      >
        加一对
      </button>
    </div>
  );
}
