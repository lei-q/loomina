"use client";

import { useEffect, useMemo, useState } from "react";
import type { Project, RightsRecord, RightsRecordInput } from "@loomina/ir";
import {
  RIGHTS_KINDS,
  RIGHTS_KIND_LABEL,
  isExpired,
  rightsReport,
  rightsTargets,
} from "@/lib/rights";
import { cn } from "@/lib/utils";

export type RightsPanelProps = {
  project: Project;
  onSave: (record: RightsRecordInput) => boolean;
  onRemove: (rightsId: string) => boolean;
  readOnly?: boolean;
  onClose: () => void;
};

type Draft = {
  id: string;
  subject: string;
  kind: RightsRecord["kind"];
  targetId: string;
  grantor: string;
  grantedAt: string;
  expiresAt: string;
  evidence: string;
  note: string;
};

function emptyDraft(): Draft {
  return {
    id: "",
    subject: "",
    kind: "portrait",
    targetId: "",
    grantor: "",
    grantedAt: "",
    expiresAt: "",
    evidence: "",
    note: "",
  };
}

function draftOf(record: RightsRecord): Draft {
  return {
    id: record.id,
    subject: record.subject,
    kind: record.kind,
    targetId: record.targetId ?? "",
    grantor: record.grantor,
    grantedAt: record.grantedAt,
    expiresAt: record.expiresAt,
    evidence: record.evidence,
    note: record.note,
  };
}

function todayText(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 授权记录（H7 / ADR-0167）。
 *
 * 肖像、声音、素材、音乐四类按对象留档：谁给的、什么时候给的、什么时候到期、凭证在哪。
 * 不校验合同真伪；只保证导出前看得见缺哪一条、哪一条过期了。
 */
export function RightsPanel({
  project,
  onSave,
  onRemove,
  readOnly = false,
  onClose,
}: RightsPanelProps) {
  const report = useMemo(() => rightsReport(project, todayText()), [project]);
  const targets = useMemo(() => rightsTargets(project), [project]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [flash, setFlash] = useState("");
  const [confirming, setConfirming] = useState<string>();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));

  /** 选一个对象就顺手把名字与类型带上，少打两次字 */
  const pickTarget = (id: string) => {
    const target = targets.find((item) => item.id === id);
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            targetId: id,
            ...(target && !prev.subject ? { subject: target.label.split(" · ")[1] ?? target.label } : {}),
            ...(target ? { kind: target.kind } : {}),
          }
        : prev,
    );
  };

  /** 从缺的一条直接开表：缺什么就预填什么 */
  const fillGap = (kind: RightsRecord["kind"], subject: string, targetId?: string) => {
    setFlash("");
    setDraft({
      ...emptyDraft(),
      kind,
      subject,
      ...(targetId ? { targetId } : {}),
      grantedAt: todayText(),
    });
  };

  const submit = () => {
    if (!draft) return;
    if (!draft.subject.trim()) {
      setFlash("先写授权对象：这张脸是谁、这段声音是谁。");
      return;
    }
    const record: RightsRecordInput = {
      id: draft.id || `rights-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      subject: draft.subject.trim(),
      kind: draft.kind,
      ...(draft.targetId ? { targetId: draft.targetId } : {}),
      grantor: draft.grantor.trim(),
      grantedAt: draft.grantedAt.trim(),
      expiresAt: draft.expiresAt.trim(),
      evidence: draft.evidence.trim(),
      note: draft.note.trim(),
    };
    if (onSave(record)) {
      setFlash("已记进授权记录。");
      setDraft(null);
    } else {
      setFlash(readOnly ? "项目是只读的，这次没有记上。" : "没记上：检查一下字段。");
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="授权记录"
        className="flex h-full w-[470px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">授权记录</h2>
            <span className="tnum text-[9px] text-muted-2">
              {report.total} 条 · {report.valid} 条有效
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
            只留档，不拦生成。导出前的合规预检会按这里的记录说缺哪一条、哪一条过期了；
            合同与授权书在你自己手里，这里只记它放在哪。
          </p>

          <section className="mt-3 border border-line px-3 py-2.5">
            <p className="text-[10.5px] text-text">{report.verdict}</p>
            {report.gaps.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {report.gaps.map((gap) => (
                  <li
                    key={`${gap.kind}-${gap.targetId ?? gap.subject}`}
                    className="flex items-start justify-between gap-2 text-[9.5px] leading-[1.65]"
                  >
                    <span className="min-w-0">
                      <span className="text-pick">
                        缺{RIGHTS_KIND_LABEL[gap.kind]}
                      </span>
                      <span className="ml-1 text-muted">
                        {gap.subject}：{gap.reason}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() => fillGap(gap.kind, gap.subject, gap.targetId)}
                      className="shrink-0 rounded-token border border-line px-1.5 py-0.5 text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
                    >
                      补一条
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {report.expired.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {report.expired.map((record) => (
                  <li key={record.id} className="text-[9.5px] leading-[1.65]">
                    <span className="text-pick">已过期</span>
                    <span className="ml-1 text-muted">
                      {record.subject}（到期 {record.expiresAt}）
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {draft ? (
            <section className="mt-3 border border-pick/60 px-3 py-2.5">
              <h3 className="text-[10.5px] tracking-[.06em] text-text">
                {draft.id ? "改这一条" : "新记一条"}
              </h3>
              <div className="mt-2 space-y-1.5">
                <div className="flex gap-1.5">
                  <label className="min-w-0 flex-1">
                    <span className="text-[9px] text-muted-2">类型</span>
                    <select
                      id="rights-kind"
                      value={draft.kind}
                      onChange={(event) =>
                        set("kind", event.target.value as RightsRecord["kind"])
                      }
                      className="mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                    >
                      {RIGHTS_KINDS.map((kind) => (
                        <option key={kind} value={kind} className="bg-surface text-text">
                          {RIGHTS_KIND_LABEL[kind]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="min-w-0 flex-1">
                    <span className="text-[9px] text-muted-2">挂在谁身上（可空）</span>
                    <select
                      id="rights-target"
                      value={draft.targetId}
                      onChange={(event) => pickTarget(event.target.value)}
                      className="mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                    >
                      <option value="" className="bg-surface text-text">
                        不挂具体对象
                      </option>
                      {targets.map((target) => (
                        <option key={target.id} value={target.id} className="bg-surface text-text">
                          {target.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="block">
                  <span className="text-[9px] text-muted-2">授权对象</span>
                  <input
                    id="rights-subject"
                    value={draft.subject}
                    onChange={(event) => set("subject", event.target.value)}
                    placeholder="林晚的肖像"
                    maxLength={60}
                    className="mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                  />
                </label>
                <div className="flex gap-1.5">
                  <label className="min-w-0 flex-1">
                    <span className="text-[9px] text-muted-2">授权方</span>
                    <input
                      id="rights-grantor"
                      value={draft.grantor}
                      onChange={(event) => set("grantor", event.target.value)}
                      placeholder="本人 / 经纪公司"
                      maxLength={60}
                      className="mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                    />
                  </label>
                  <label className="w-[96px] shrink-0">
                    <span className="text-[9px] text-muted-2">授权日</span>
                    <input
                      id="rights-granted"
                      value={draft.grantedAt}
                      onChange={(event) => set("grantedAt", event.target.value)}
                      placeholder="2026-11-13"
                      maxLength={20}
                      className="mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                    />
                  </label>
                  <label className="w-[96px] shrink-0">
                    <span className="text-[9px] text-muted-2">到期日</span>
                    <input
                      id="rights-expires"
                      value={draft.expiresAt}
                      onChange={(event) => set("expiresAt", event.target.value)}
                      placeholder="空 = 不限期"
                      maxLength={20}
                      className="mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                    />
                  </label>
                </div>
                <label className="block">
                  <span className="text-[9px] text-muted-2">凭证在哪</span>
                  <input
                    id="rights-evidence"
                    value={draft.evidence}
                    onChange={(event) => set("evidence", event.target.value)}
                    placeholder="合同编号 / 存放路径 / 邮件日期"
                    maxLength={200}
                    className="mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="text-[9px] text-muted-2">备注</span>
                  <input
                    id="rights-note"
                    value={draft.note}
                    onChange={(event) => set("note", event.target.value)}
                    placeholder="授权范围：仅本片 / 全平台 / 期限"
                    maxLength={200}
                    className="mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none"
                  />
                </label>
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={submit}
                  disabled={readOnly}
                  className="rounded-token border border-pick bg-pick px-2.5 py-1 text-[10px] text-white transition-opacity duration-[var(--dur)] enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  记下来
                </button>
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  取消
                </button>
                {flash && <span className="text-[9px] text-muted">{flash}</span>}
              </div>
            </section>
          ) : (
            <button
              type="button"
              disabled={readOnly}
              onClick={() => {
                setFlash("");
                setDraft({ ...emptyDraft(), grantedAt: todayText() });
              }}
              className="mt-3 w-full rounded-token border border-line px-3 py-1.5 text-[10px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
            >
              记一条授权
            </button>
          )}

          {flash && !draft && <p className="mt-2 text-[9.5px] text-muted">{flash}</p>}

          <section className="mt-4">
            <h3 className="text-[10.5px] tracking-[.06em] text-text">全部记录</h3>
            {project.authorizations.length === 0 ? (
              <p className="mt-1.5 text-[9.5px] leading-[1.7] text-muted-2">
                还没有授权记录。全用模型生成、不碰真人素材时，这里空着也没问题。
              </p>
            ) : (
              <ul className="mt-1.5 border-t border-line">
                {project.authorizations.map((record) => {
                  const expired = isExpired(record, todayText());
                  return (
                    <li key={record.id} className="border-b border-line py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className="shrink-0 rounded-token border border-line px-1 py-0.5 text-[8.5px] text-muted-2">
                            {RIGHTS_KIND_LABEL[record.kind]}
                          </span>
                          <span className="min-w-0 break-words text-[10.5px] text-text">
                            {record.subject}
                          </span>
                          {expired && <span className="shrink-0 text-[8.5px] text-pick">已过期</span>}
                        </span>
                        <span className="flex shrink-0 items-baseline gap-1.5">
                          <button
                            type="button"
                            disabled={readOnly}
                            onClick={() => {
                              setFlash("");
                              setDraft(draftOf(record));
                            }}
                            className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-text disabled:opacity-40"
                          >
                            改
                          </button>
                          {confirming === record.id ? (
                            <button
                              type="button"
                              onClick={() => {
                                const ok = onRemove(record.id);
                                setConfirming(undefined);
                                setFlash(ok ? "已删掉这条留档。" : "没删掉。");
                              }}
                              className="text-[9px] text-pick"
                            >
                              确认删
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={readOnly}
                              onClick={() => setConfirming(record.id)}
                              className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-text disabled:opacity-40"
                            >
                              删
                            </button>
                          )}
                        </span>
                      </div>
                      <p className={cn("mt-0.5 text-[9px] leading-[1.65] text-muted-2")}>
                        {[
                          record.grantor ? `授权方 ${record.grantor}` : "",
                          record.grantedAt ? `授权日 ${record.grantedAt}` : "",
                          record.expiresAt ? `到期 ${record.expiresAt}` : "不限期",
                          record.evidence ? `凭证 ${record.evidence}` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {record.note && (
                        <p className="mt-0.5 break-words text-[9px] leading-[1.65] text-muted">
                          {record.note}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
