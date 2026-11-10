"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { SHEET_LABELS, type SheetView } from "@loomina/ir";
import { fetchImagePrice } from "@/lib/image-price";
import { Bust } from "@/components/bust";
import { PropObject } from "@/components/prop-object";
import { Scene } from "@/components/scene";
import { TopBar } from "@/components/top-bar";
import {
  toCastView,
  type CastCharacterView,
  type CastLocationView,
  type CastPropView,
} from "@/lib/read-model";
import { useWorkbench } from "@/lib/workbench-store";
import { cn } from "@/lib/utils";

function clock(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 地点模板：只决定主镜画哪种剪影；名字才是给人看的（ADR-0059） */
const LOCATION_TEMPLATES = [
  { id: "corridor", label: "走廊" },
  { id: "doorway", label: "门口" },
  { id: "table", label: "桌边" },
  { id: "door", label: "门厅" },
] as const;

function StatusChip({
  status,
  missing,
  missingText,
}: {
  status: string;
  missing?: number;
  missingText?: string;
}) {
  if (status === "locked") {
    return (
      <span className="tnum flex items-center gap-1.5 text-[9px] text-text">
        <span className="h-[5px] w-[5px] bg-text" />
        已锁定
      </span>
    );
  }
  if (status === "incomplete") {
    return (
      <span className="tnum text-[9px] text-muted-2">
        {missingText ?? (missing !== undefined && missing > 0 ? `缺 ${missing} 格` : "缺 主镜")}
      </span>
    );
  }
  return <span className="tnum text-[9px] text-muted">可锁定</span>;
}

function CharacterRow({
  character,
  readOnly,
  generating,
  quoteCny,
  onGenerate,
  onLock,
  onUnlock,
  onEdit,
}: {
  character: CastCharacterView;
  readOnly: boolean;
  /** 正在生成的那一格 */
  generating?: SheetView;
  /** 这一次生成要花多少（元）；价目不知道就不给 */
  quoteCny?: number;
  onGenerate: () => void;
  onLock: () => void;
  onUnlock: () => void;
  /** 改名字 / 外形描述：成功返回 true，表单据此收起（ADR-0071） */
  onEdit: (name: string, appearance: string) => boolean;
}) {
  const missing = character.panels.filter((panel) => !panel.assetId).length;
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftAppearance, setDraftAppearance] = useState("");

  const beginEdit = () => {
    setDraftName(character.name);
    setDraftAppearance(character.appearance);
    setEditing(true);
  };

  return (
    <section className="border-t border-line py-5">
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-[168px] shrink-0">
          {editing ? (
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (onEdit(draftName, draftAppearance)) setEditing(false);
              }}
            >
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditing(false);
                }}
                autoFocus
                aria-label="人物名字"
                className="w-full rounded-token border border-line-2 bg-surface px-2 py-1.5 text-[13px] text-text focus:border-pick focus:outline-none"
              />
              <textarea
                value={draftAppearance}
                onChange={(event) => setDraftAppearance(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditing(false);
                }}
                rows={3}
                aria-label="外形描述"
                placeholder="外形：短发、深色外套、左眼下一颗痣"
                className="w-full resize-none rounded-token border border-line bg-surface px-2 py-1.5 text-[11.5px] leading-[1.6] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
              />
              <p className="text-[9px] leading-[1.5] text-muted-2">
                外形整句进提示词，200 字以内；三视图与参考图不跟着变。
              </p>
              <div className="flex gap-1.5">
                <button
                  type="submit"
                  className="rounded-token border border-line-2 px-2 py-0.5 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-token border border-line px-2 py-0.5 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  取消
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-2.5">
                <h2 className="text-[17px] leading-none text-text">{character.name}</h2>
                <StatusChip status={character.status} missing={missing} />
                {!readOnly && (
                  <button
                    type="button"
                    onClick={beginEdit}
                    title="改名字或外形描述"
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
                  >
                    改
                  </button>
                )}
              </div>
              <p className="mt-2 text-[11.5px] leading-[1.5] text-muted">
                {character.appearance || "还没写外形描述。"}
              </p>
            </>
          )}
          <p className="tnum mt-4 text-[8.5px] tracking-[.12em] text-muted-2">不许变</p>
          <ul className="mt-1.5 space-y-1">
            {character.mustNotChange.map((item) => (
              <li key={item} className="text-[10.5px] leading-[1.5] text-muted">
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap gap-2">
          {character.panels.map((panel) => (
            <figure key={panel.angle} className="w-[96px]">
              <div
                className={cn(
                  "relative aspect-[9/16] overflow-hidden rounded-[1px] border bg-[#0f1013]",
                  panel.assetId ? "border-line" : "border-dashed border-line-2",
                )}
              >
                {panel.uri ? (
                  <img
                    src={panel.uri}
                    alt={`${character.name} · ${panel.label}`}
                    className="h-full w-full object-cover"
                  />
                ) : panel.assetId ? (
                  <Bust view={panel.angle} className="h-full w-full" />
                ) : (
                  <span className="absolute inset-0 grid place-items-center text-[9px] text-muted-2">
                    待生成
                  </span>
                )}
                {generating === panel.angle && (
                  <span className="absolute inset-0 grid place-items-center bg-bg/75 text-[9px] text-text">
                    生成中…
                  </span>
                )}
              </div>
              <figcaption className="tnum mt-1.5 text-[9px] text-muted-2">{panel.label}</figcaption>
            </figure>
          ))}
        </div>

        <div className="ml-auto flex w-[120px] shrink-0 flex-col items-end gap-2">
          {character.status === "locked" ? (
            <>
              <span className="tnum text-[9px] text-muted-2">{clock(character.lockedAt)} 锁</span>
              <button
                type="button"
                onClick={onUnlock}
                className="rounded-token border border-line px-3 py-1.5 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
              >
                解锁
              </button>
            </>
          ) : (
            <>
              {generating ? (
                <span className="tnum text-[9px] text-muted">生成中 · {SHEET_LABELS[generating]}</span>
              ) : (
                <button
                  type="button"
                  onClick={onGenerate}
                  className="rounded-token border border-line px-3 py-1.5 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  生成三视图
                  {quoteCny !== undefined && (
                    <span className="tnum mt-0.5 block text-[9.5px] text-muted-2">¥{quoteCny.toFixed(2)}</span>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={onLock}
                disabled={character.status === "incomplete"}
                title={
                  character.status === "incomplete"
                    ? "三视图缺格，补齐才能锁"
                    : "锁定后下游只能引用，不能替换"
                }
                className="rounded-token bg-text px-3 py-1.5 text-[11.5px] text-bg transition-opacity duration-[var(--dur)] hover:opacity-85 disabled:pointer-events-none disabled:opacity-30"
              >
                锁定定妆
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function LocationRow({
  location,
  generating,
  quoteCny,
  readOnly,
  onGenerate,
  onLock,
  onUnlock,
  onRename,
  onDescribe,
  onRemove,
  otherLocations,
}: {
  location: CastLocationView;
  /** 主镜正在生成 */
  generating: boolean;
  /** 这一次生成要花多少（元）；价目不知道就不给 */
  quoteCny?: number;
  readOnly: boolean;
  onGenerate: () => void;
  onLock: () => void;
  onUnlock: () => void;
  /** 改名 / 换模板：成功返回 true，表单据此收起 */
  onRename: (name: string, templateId: string) => boolean;
  /** 改场景描述：成功返回 true，表单据此收起（ADR-0063） */
  onDescribe: (description: string) => boolean;
  /** 删掉这个地点：成功返回 true（ADR-0061 / ADR-0062） */
  onRemove: (moveToId?: string) => boolean;
  /** 还有哪些地点可以搬：这一行自己不在里面 */
  otherLocations: { id: string; name: string }[];
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moveTarget, setMoveTarget] = useState(otherLocations[0]?.id ?? "");
  const [draftName, setDraftName] = useState("");
  const [draftTemplate, setDraftTemplate] = useState(location.templateId ?? "doorway");
  const [describing, setDescribing] = useState(false);
  const [draftDescription, setDraftDescription] = useState("");

  const beginDescribe = () => {
    setDraftDescription(location.description);
    setDescribing(true);
  };

  const beginEdit = () => {
    setDraftName(location.name);
    setDraftTemplate(location.templateId ?? "doorway");
    setEditing(true);
  };

  return (
    <section className="border-t border-line py-5">
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-[168px] shrink-0">
          {editing ? (
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (onRename(draftName, draftTemplate)) setEditing(false);
              }}
            >
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditing(false);
                }}
                autoFocus
                aria-label="地点名字"
                className="w-full rounded-token border border-line-2 bg-surface px-2 py-1.5 text-[13px] text-text focus:border-pick focus:outline-none"
              />
              <select
                value={draftTemplate}
                onChange={(event) => setDraftTemplate(event.target.value)}
                aria-label="地点模板"
                className="w-full rounded-token border border-line bg-surface px-2 py-1.5 text-[11.5px] text-muted focus:border-pick focus:outline-none"
              >
                {LOCATION_TEMPLATES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
              <div className="flex gap-1.5">
                <button
                  type="submit"
                  className="rounded-token border border-line-2 px-2 py-0.5 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-token border border-line px-2 py-0.5 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  取消
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-2.5">
                <h2 className="text-[17px] leading-none text-text">{location.name}</h2>
                <StatusChip
                  status={location.status}
                  missingText={location.required ? "缺 主镜" : "未挂场次"}
                />
                {!readOnly && (
                  <button
                    type="button"
                    onClick={beginEdit}
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
                  >
                    改名
                  </button>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoveTarget(otherLocations[0]?.id ?? "");
                      setDeleting(true);
                    }}
                    disabled={location.required && otherLocations.length === 0}
                    title={
                      location.required && otherLocations.length === 0
                        ? "还有场次在这个地点，又没有别的地点可搬：先新建一个地点"
                        : location.required
                          ? "还有场次在这个地点：把它们搬到别处，再删"
                          : "删掉这个地点：日志里留一条记录，已经出的主镜图不删"
                    }
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:text-pick disabled:cursor-default disabled:opacity-40"
                  >
                    删
                  </button>
                )}
              </div>
              {deleting ? (
                <form
                  className="mt-2 flex flex-col gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (onRemove(location.required ? moveTarget : undefined)) setDeleting(false);
                  }}
                >
                  {location.required && (
                    <label className="flex flex-col gap-1 text-[9px] text-muted-2">
                      这一地点还有场次，先搬到哪里
                      <select
                        value={moveTarget}
                        onChange={(event) => setMoveTarget(event.target.value)}
                        autoFocus
                        aria-label="搬到哪个地点"
                        className="w-full rounded-token border border-line bg-surface px-1.5 py-1 text-[10.5px] text-text focus:border-pick focus:outline-none"
                      >
                        {otherLocations.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="flex gap-1.5">
                    <button
                      type="submit"
                      className="rounded-token border border-pick/70 px-2 py-0.5 text-[10.5px] text-pick transition-colors duration-[var(--dur)] hover:bg-pick hover:text-bg"
                    >
                      {location.required ? "搬过去再删" : "确认删"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleting(false)}
                      className="rounded-token border border-line px-2 py-0.5 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                    >
                      取消
                    </button>
                  </div>
                </form>
              ) : (
                <p className="tnum mt-2 text-[10px] text-muted-2">
                  {location.required ? "主镜 · 全场共用" : "主镜 · 还没挂场次"}
                </p>
              )}
            </>
          )}
        </div>

        <figure className="w-[120px]">
          <div className="relative aspect-[9/16] overflow-hidden rounded-[1px] border border-line bg-[#0f1013]">
            {location.masterUri ? (
              <img
                src={location.masterUri}
                alt={`${location.name} · 主镜`}
                className="h-full w-full object-cover"
              />
            ) : location.masterAssetId ? (
              <Scene kind={location.art} className="h-full w-full" />
            ) : (
              <span className="absolute inset-0 grid place-items-center text-[9px] text-muted-2">
                待生成
              </span>
            )}
            {generating && (
              <span className="absolute inset-0 grid place-items-center bg-bg/75 text-[9px] text-text">
                生成中…
              </span>
            )}
          </div>
          <figcaption className="tnum mt-1.5 text-[9px] text-muted-2">master</figcaption>
        </figure>

        <div className="flex max-w-[38ch] flex-col gap-1.5 self-center">
          {describing ? (
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (onDescribe(draftDescription)) setDescribing(false);
              }}
            >
              <textarea
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setDescribing(false);
                }}
                autoFocus
                rows={3}
                aria-label="场景描述"
                placeholder="老楼走廊，声控灯，墙皮起了卷"
                className="w-full resize-none rounded-token border border-line-2 bg-surface px-2 py-1.5 text-[11.5px] leading-[1.6] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
              />
              <p className="text-[9px] leading-[1.5] text-muted-2">
                整句进主镜提示词：空间、陈设、光线，200 字以内。
              </p>
              <div className="flex gap-1.5">
                <button
                  type="submit"
                  className="rounded-token border border-line-2 px-2 py-0.5 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => setDescribing(false)}
                  className="rounded-token border border-line px-2 py-0.5 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  取消
                </button>
              </div>
            </form>
          ) : (
            <>
              {readOnly ? (
                <p className="text-[11.5px] leading-[1.6] text-text">
                  {location.description || "这个地点还没写场景描述。"}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={beginDescribe}
                  title="写一句这地方长什么样：会整句进主镜提示词"
                  className="text-left transition-colors duration-[var(--dur)]"
                >
                  {location.description ? (
                    <span className="text-[11.5px] leading-[1.6] text-text">{location.description}</span>
                  ) : (
                    <span className="text-[11px] leading-[1.6] text-muted-2">＋ 写一句这地方长什么样</span>
                  )}
                </button>
              )}
              <p className="text-[9px] leading-[1.6] text-muted-2">
                同一场的所有镜头都带这张图进生成，房间不许每镜重新想象。
              </p>
            </>
          )}
        </div>

        <div className="ml-auto flex w-[120px] shrink-0 flex-col items-end gap-2">
          {location.status === "locked" ? (
            <>
              <span className="tnum text-[9px] text-muted-2">{clock(location.lockedAt)} 锁</span>
              <button
                type="button"
                onClick={onUnlock}
                className="rounded-token border border-line px-3 py-1.5 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
              >
                解锁
              </button>
            </>
          ) : (
            <>
              {generating ? (
                <span className="tnum text-[9px] text-muted">生成中…</span>
              ) : (
                <button
                  type="button"
                  onClick={onGenerate}
                  className="rounded-token border border-line px-3 py-1.5 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  生成主镜
                  {quoteCny !== undefined && (
                    <span className="tnum mt-0.5 block text-[9.5px] text-muted-2">¥{quoteCny.toFixed(2)}</span>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={onLock}
                disabled={location.status === "incomplete"}
                title={location.status === "incomplete" ? "还没有主镜" : "锁定后下游只能引用，不能替换"}
                className="rounded-token bg-text px-3 py-1.5 text-[11.5px] text-bg transition-opacity duration-[var(--dur)] hover:opacity-85 disabled:pointer-events-none disabled:opacity-30"
              >
                锁定主镜
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function PropRow({
  prop,
  readOnly,
  generating,
  quoteCny,
  onGenerate,
  onLock,
  onUnlock,
  onEdit,
}: {
  prop: CastPropView;
  readOnly: boolean;
  /** 参考图正在生成 */
  generating: boolean;
  /** 这一次生成要花多少（元）；价目不知道就不给 */
  quoteCny?: number;
  onGenerate: () => void;
  onLock: () => void;
  onUnlock: () => void;
  /** 改名字 / 描述：成功返回 true，表单据此收起（ADR-0072） */
  onEdit: (name: string, description: string) => boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");

  const beginEdit = () => {
    setDraftName(prop.name);
    setDraftDescription(prop.description);
    setEditing(true);
  };

  return (
    <section className="border-t border-line py-5">
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-[168px] shrink-0">
          {editing ? (
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (onEdit(draftName, draftDescription)) setEditing(false);
              }}
            >
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditing(false);
                }}
                autoFocus
                aria-label="道具名字"
                className="w-full rounded-token border border-line-2 bg-surface px-2 py-1.5 text-[13px] text-text focus:border-pick focus:outline-none"
              />
              <textarea
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditing(false);
                }}
                rows={3}
                aria-label="道具描述"
                placeholder="长什么样：白底蓝边搪瓷缸，杯沿有一道旧磕痕"
                className="w-full resize-none rounded-token border border-line bg-surface px-2 py-1.5 text-[11px] leading-[1.6] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
              />
              <p className="text-[9px] leading-[1.5] text-muted-2">
                描述整句进提示词，200 字以内；参考图不跟着变。
              </p>
              <div className="flex gap-1.5">
                <button
                  type="submit"
                  className="rounded-token border border-line-2 px-2 py-0.5 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-token border border-line px-2 py-0.5 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  取消
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-2.5">
                <h2 className="text-[17px] leading-none text-text">{prop.name}</h2>
                <StatusChip status={prop.status} missingText="缺参考图" />
                {!readOnly && (
                  <button
                    type="button"
                    onClick={beginEdit}
                    title="改名字或描述"
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text"
                  >
                    改
                  </button>
                )}
              </div>
              <p className="mt-2 text-[11px] leading-[1.5] text-muted">
                {prop.description || "还没写道具描述。"}
              </p>
            </>
          )}
        </div>

        <figure className="w-[120px]">
          <div className="relative aspect-[9/16] overflow-hidden rounded-[1px] border border-line bg-[#0f1013]">
            {prop.referenceUri ? (
              <img
                src={prop.referenceUri}
                alt={`${prop.name} · 参考图`}
                className="h-full w-full object-cover"
              />
            ) : prop.referenceAssetId ? (
              <PropObject kind={prop.art} className="h-full w-full" />
            ) : (
              <span className="absolute inset-0 grid place-items-center text-[9px] text-muted-2">
                待生成
              </span>
            )}
            {generating && (
              <span className="absolute inset-0 grid place-items-center bg-bg/75 text-[9px] text-text">
                生成中…
              </span>
            )}
          </div>
          <figcaption className="tnum mt-1.5 text-[9px] text-muted-2">ref 1</figcaption>
        </figure>

        <div className="max-w-[38ch] self-center">
          <p className="text-[11px] leading-[1.6] text-muted-2">
            在镜头里出现，就要有一张参考图。锁住后，带它的镜头都引这一张。
          </p>
        </div>

        <div className="ml-auto flex w-[120px] shrink-0 flex-col items-end gap-2">
          {prop.status === "locked" ? (
            <>
              <span className="tnum text-[9px] text-muted-2">{clock(prop.lockedAt)} 锁</span>
              <button
                type="button"
                onClick={onUnlock}
                className="rounded-token border border-line px-3 py-1.5 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
              >
                解锁
              </button>
            </>
          ) : (
            <>
              {generating ? (
                <span className="tnum text-[9px] text-muted">生成中…</span>
              ) : (
                <button
                  type="button"
                  onClick={onGenerate}
                  className="rounded-token border border-line px-3 py-1.5 text-[11.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  生成参考图
                  {quoteCny !== undefined && (
                    <span className="tnum mt-0.5 block text-[9.5px] text-muted-2">¥{quoteCny.toFixed(2)}</span>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={onLock}
                disabled={prop.status === "incomplete"}
                title={prop.status === "incomplete" ? "还没有参考图" : "锁定后下游只能引用，不能替换"}
                className="rounded-token bg-text px-3 py-1.5 text-[11.5px] text-bg transition-opacity duration-[var(--dur)] hover:opacity-85 disabled:pointer-events-none disabled:opacity-30"
              >
                锁定道具
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export function CastScreen() {
  const project = useWorkbench((state) => state.project);
  const lockCast = useWorkbench((state) => state.lockCast);
  const unlockCast = useWorkbench((state) => state.unlockCast);
  const generateSheet = useWorkbench((state) => state.generateSheet);
  const generateMaster = useWorkbench((state) => state.generateMaster);
  const generateProp = useWorkbench((state) => state.generateProp);
  const jobs = useWorkbench((state) => state.jobs);
  const castError = useWorkbench((state) => state.castError);
  const hydrate = useWorkbench((state) => state.hydrate);
  const storageError = useWorkbench((state) => state.storageError);
  const readOnly = useWorkbench((state) => state.readOnly);
  const imageCny = useWorkbench((state) => state.imageCny);
  const setImagePrice = useWorkbench((state) => state.setImagePrice);
  const setBudget = useWorkbench((state) => state.setBudget);
  const addLocation = useWorkbench((state) => state.addLocation);
  const editLocation = useWorkbench((state) => state.editLocation);
  const removeLocation = useWorkbench((state) => state.removeLocation);
  const addCharacter = useWorkbench((state) => state.addCharacter);
  const editCharacter = useWorkbench((state) => state.editCharacter);
  const addProp = useWorkbench((state) => state.addProp);
  const editProp = useWorkbench((state) => state.editProp);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTemplate, setNewTemplate] = useState<string>("doorway");
  const [newDescription, setNewDescription] = useState("");
  const [creatingCharacter, setCreatingCharacter] = useState(false);
  const [newCharacterName, setNewCharacterName] = useState("");
  const [newCharacterAppearance, setNewCharacterAppearance] = useState("");
  const [creatingProp, setCreatingProp] = useState(false);
  const [newPropName, setNewPropName] = useState("");
  const [newPropDescription, setNewPropDescription] = useState("");

  const closeCreateCharacter = () => {
    setCreatingCharacter(false);
    setNewCharacterName("");
    setNewCharacterAppearance("");
  };

  const closeCreateProp = () => {
    setCreatingProp(false);
    setNewPropName("");
    setNewPropDescription("");
  };

  const closeCreate = () => {
    setCreating(false);
    setNewName("");
    setNewTemplate("doorway");
    setNewDescription("");
  };

  useEffect(() => {
    void hydrate();
    // 单价在服务端：进页面问一次，用来显示"这一格多少钱"并在提交前拦超预算
    void fetchImagePrice().then((price) => {
      if (price) setImagePrice(price);
    });
  }, [hydrate, setImagePrice]);

  const cast = useMemo(() => toCastView(project), [project]);
  const done = cast.lockedCount === cast.totalRequired;
  const progress = cast.totalRequired === 0 ? 0 : (cast.lockedCount / cast.totalRequired) * 100;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
      <TopBar
        title={project.title}
        version={project.version}
        stage="定妆"
        spentCny={cast.spend.spent}
        budgetCny={project.budgetCny}
        unpriced={cast.spend.unpriced}
        spendBreakdown={cast.spend}
        storageError={storageError}
        readOnly={readOnly}
        onBudgetChange={setBudget}
      />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1080px] px-5 pb-10 pt-7 sm:px-8">
          <header>
            <h1 className="text-[20px] leading-none tracking-[.02em] text-text">定妆</h1>
            <p className="mt-2.5 max-w-[52ch] text-[12.5px] leading-[1.6] text-muted">
              先把脸和空间钉住，再谈镜头。锁定的资产下游只能引用，换人要重新解锁并留痕。
            </p>

            <div className="mt-5 flex items-center gap-3">
              <span className="tnum text-[10px] text-muted">
                {cast.lockedCount} / {cast.totalRequired} 已锁定
              </span>
              <span className="h-px flex-1 bg-line">
                <span
                  className="block h-px bg-text transition-[width] duration-[var(--dur)]"
                  style={{ width: `${progress}%` }}
                />
              </span>
            </div>

            {castError && (
              <p className="mt-3 max-w-[60ch] text-[10.5px] leading-[1.6] text-pick">
                {castError}
              </p>
            )}
          </header>

          <section className="mt-7">
            <div className="flex items-center justify-between gap-3">
              <h2 className="tnum text-[9px] tracking-[.14em] text-muted-2">人物 · 三视图</h2>
              {!readOnly && !creatingCharacter && (
                <button
                  type="button"
                  onClick={() => setCreatingCharacter(true)}
                  className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  新建人物
                </button>
              )}
            </div>

            {creatingCharacter && (
              <form
                className="mt-3 flex flex-wrap items-center gap-2 rounded-token border border-dashed border-line-2 px-3 py-2.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (addCharacter(newCharacterName, newCharacterAppearance)) closeCreateCharacter();
                }}
              >
                <input
                  type="text"
                  value={newCharacterName}
                  onChange={(event) => setNewCharacterName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") closeCreateCharacter();
                  }}
                  autoFocus
                  aria-label="新人物名字"
                  placeholder="人物名字：林 · 周 · 阿棠"
                  className="min-w-[220px] flex-1 bg-transparent text-[12.5px] text-text placeholder:text-muted-2 focus:outline-none"
                />
                <button
                  type="submit"
                  className="rounded-token border border-line-2 px-2.5 py-1 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                >
                  创建
                </button>
                <button
                  type="button"
                  onClick={closeCreateCharacter}
                  className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  取消
                </button>
                <textarea
                  value={newCharacterAppearance}
                  onChange={(event) => setNewCharacterAppearance(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") closeCreateCharacter();
                  }}
                  rows={2}
                  aria-label="新人物外形"
                  placeholder="外形：短发、深色外套、左眼下一颗痣（选填，会进提示词）"
                  className="w-full resize-none rounded-token border border-line bg-surface px-2 py-1.5 text-[11.5px] leading-[1.6] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
                />
                <span className="w-full text-[10px] text-muted-2">
                  三视图随后一张张生成；外形描述 200 字以内。
                </span>
              </form>
            )}

            {cast.characters.map((character) => {
              const job = jobs[character.id];
              return (
                <CharacterRow
                  key={character.id}
                  character={character}
                  readOnly={readOnly ?? false}
                  generating={job?.kind === "sheet" ? job.angle : undefined}
                  quoteCny={
                    imageCny === undefined
                      ? undefined
                      : imageCny * character.panels.filter((panel) => panel.assetId).length
                  }
                  onGenerate={() => void generateSheet(character.id)}
                  onLock={() => lockCast("character", character.id)}
                  onUnlock={() => unlockCast("character", character.id)}
                  onEdit={(name, appearance) =>
                    editCharacter(character.id, { name, appearance })
                  }
                />
              );
            })}
          </section>

          <section className="mt-8">
            <div className="flex items-center justify-between gap-3">
              <h2 className="tnum text-[9px] tracking-[.14em] text-muted-2">场景 · 主镜</h2>
              {!readOnly && !creating && (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  新建地点
                </button>
              )}
            </div>

            {creating && (
              <form
                className="mt-3 flex flex-wrap items-center gap-2 rounded-token border border-dashed border-line-2 px-3 py-2.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (addLocation(newName, newTemplate, newDescription)) closeCreate();
                }}
              >
                <input
                  type="text"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") closeCreate();
                  }}
                  autoFocus
                  aria-label="新地点名字"
                  placeholder="地点名字：阳台 · 楼梯间 · 便利店门口"
                  className="min-w-[220px] flex-1 bg-transparent text-[12.5px] text-text placeholder:text-muted-2 focus:outline-none"
                />
                <select
                  value={newTemplate}
                  onChange={(event) => setNewTemplate(event.target.value)}
                  aria-label="新地点模板"
                  className="rounded-token border border-line bg-surface px-2 py-1 text-[11px] text-muted focus:border-pick focus:outline-none"
                >
                  {LOCATION_TEMPLATES.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="rounded-token border border-line-2 px-2.5 py-1 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                >
                  创建
                </button>
                <button
                  type="button"
                  onClick={closeCreate}
                  className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                >
                  取消
                </button>
                <textarea
                  value={newDescription}
                  onChange={(event) => setNewDescription(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") closeCreate();
                  }}
                  rows={2}
                  aria-label="新地点描述"
                  placeholder="这地方长什么样：空间、陈设、光线（选填，会进主镜提示词）"
                  className="w-full resize-none rounded-token border border-line bg-surface px-2 py-1.5 text-[11.5px] leading-[1.6] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
                />
                <span className="w-full text-[10px] text-muted-2">
                  建好后到剧本页把它挂到场上，场次才有地方发生。
                </span>
              </form>
            )}

            {cast.locations.map((location) => (
              <LocationRow
                key={location.id}
                location={location}
                generating={jobs[location.id]?.kind === "master"}
                quoteCny={imageCny}
                readOnly={readOnly ?? false}
                onGenerate={() => void generateMaster(location.id)}
                onLock={() => lockCast("location", location.id)}
                onUnlock={() => unlockCast("location", location.id)}
                onRename={(name, templateId) => editLocation(location.id, { name, templateId })}
                onDescribe={(description) => editLocation(location.id, { description })}
                onRemove={(moveToId) => removeLocation(location.id, moveToId)}
                otherLocations={cast.locations
                  .filter((item) => item.id !== location.id)
                  .map((item) => ({ id: item.id, name: item.name }))}
              />
            ))}
          </section>

          {cast.props.length > 0 && (
            <section className="mt-8">
              <div className="flex items-center justify-between gap-3">
                <h2 className="tnum text-[9px] tracking-[.14em] text-muted-2">道具 · 参考</h2>
                {!readOnly && !creatingProp && (
                  <button
                    type="button"
                    onClick={() => setCreatingProp(true)}
                    className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                  >
                    新建道具
                  </button>
                )}
              </div>

              {creatingProp && (
                <form
                  className="mt-3 flex flex-wrap items-center gap-2 rounded-token border border-dashed border-line-2 px-3 py-2.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (addProp(newPropName, newPropDescription)) closeCreateProp();
                  }}
                >
                  <input
                    type="text"
                    value={newPropName}
                    onChange={(event) => setNewPropName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") closeCreateProp();
                    }}
                    autoFocus
                    aria-label="新道具名字"
                    placeholder="道具名字：搪瓷杯 · 台灯 · 旧钥匙"
                    className="min-w-[220px] flex-1 bg-transparent text-[12.5px] text-text placeholder:text-muted-2 focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="rounded-token border border-line-2 px-2.5 py-1 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick"
                  >
                    创建
                  </button>
                  <button
                    type="button"
                    onClick={closeCreateProp}
                    className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
                  >
                    取消
                  </button>
                  <textarea
                    value={newPropDescription}
                    onChange={(event) => setNewPropDescription(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") closeCreateProp();
                    }}
                    rows={2}
                    aria-label="新道具描述"
                    placeholder="长什么样：白底蓝边搪瓷缸，杯沿有一道旧磕痕（选填，会进提示词）"
                    className="w-full resize-none rounded-token border border-line bg-surface px-2 py-1.5 text-[11.5px] leading-[1.6] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
                  />
                  <span className="w-full text-[10px] text-muted-2">
                    参考图随后生成；描述 200 字以内。
                  </span>
                </form>
              )}

              {cast.props.length === 0 && (
                <p className="mt-3 rounded-token border border-dashed border-line px-3 py-5 text-center text-[10.5px] leading-[1.8] text-muted-2">
                  还没有道具。上面新建一件，再到分镜页把它点进出场。
                </p>
              )}

              {cast.props.map((prop) => (
                <PropRow
                  key={prop.id}
                  prop={prop}
                  readOnly={readOnly ?? false}
                  generating={jobs[prop.id]?.kind === "prop"}
                  quoteCny={imageCny}
                  onGenerate={() => void generateProp(prop.id)}
                  onLock={() => lockCast("prop", prop.id)}
                  onUnlock={() => unlockCast("prop", prop.id)}
                  onEdit={(name, description) => editProp(prop.id, { name, description })}
                />
              ))}
            </section>
          )}
        </div>
      </main>

      <footer className="flex shrink-0 items-center gap-4 border-t border-line px-4 py-3">
        <span className="tnum text-[10px] text-muted">
          {cast.lockedCount} / {cast.totalRequired}
        </span>
        <span className="text-[11.5px] text-muted-2">
          {done ? "锚点锁住了，可以进分镜" : "定妆没锁完，分镜不开"}
        </span>

        <span className="ml-auto">
          {done ? (
            <Link
              href="/"
              className="flex items-center gap-1.5 rounded-token bg-text px-3 py-2 text-[12px] text-bg transition-opacity duration-[var(--dur)] hover:opacity-85"
            >
              进分镜
              <span aria-hidden="true">→</span>
            </Link>
          ) : (
            <span className="flex items-center gap-1.5 rounded-token border border-line px-3 py-2 text-[12px] text-muted-2">
              进分镜
              <span aria-hidden="true">→</span>
            </span>
          )}
        </span>
      </footer>
    </div>
  );
}
