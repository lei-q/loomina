"use client";

import { useEffect, useMemo, useState } from "react";
import type { Brand } from "@loomina/ir";
import type { EditView } from "@/lib/edit";
import { brandArtOf, cardImage, textColorsOf } from "@/lib/card-image";
import { frameSize } from "@/lib/render-manifest";
import { cn } from "@/lib/utils";

export type BrandPatch = {
  name?: string;
  handle?: string;
  color?: string;
  intro?: {
    enabled?: boolean;
    title?: string;
    subtitle?: string;
    durationMs?: number;
  };
  outro?: {
    enabled?: boolean;
    title?: string;
    subtitle?: string;
    durationMs?: number;
  };
};

export type BrandPanelProps = {
  view: EditView;
  /** 写一条 `brand.updated`；返回是否真的写进去了 */
  onSave: (patch: BrandPatch) => boolean;
  readOnly?: boolean;
  onClose: () => void;
};

type CardDraft = { title: string; subtitle: string; seconds: string };

const PREVIEW_WIDTH = 236;

function secondsOf(ms: number): string {
  return (Math.round(ms / 100) / 10).toFixed(1);
}

/**
 * 品牌包与头尾卡（E9 / ADR-0174）。
 *
 * 这里只做静态卡：底色 + 标题 + 副标题 + 落款。卡片是成片最前 / 最后的一张
 * 静帧，时长会进 IR，成片、预览、SRT 与 OTIO 的时间都按它整体后移。
 *
 * 预览用的就是导出那条路 —— 同一个画法、同一张图；所以这里看到什么，
 * 导出就是什么，不会「界面上好看、导出里错位」。
 */
export function BrandPanel({ view, onSave, readOnly, onClose }: BrandPanelProps) {
  const brand = view.brand;
  const [name, setName] = useState(brand.name);
  const [handle, setHandle] = useState(brand.handle);
  const [color, setColor] = useState(brand.color);
  const [intro, setIntro] = useState<CardDraft>({
    title: brand.intro.title,
    subtitle: brand.intro.subtitle,
    seconds: secondsOf(brand.intro.durationMs),
  });
  const [outro, setOutro] = useState<CardDraft>({
    title: brand.outro.title,
    subtitle: brand.outro.subtitle,
    seconds: secondsOf(brand.outro.durationMs),
  });
  const [notice, setNotice] = useState("");

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const size = frameSize("final", view.frame.aspect);
  const previewHeight = Math.round((PREVIEW_WIDTH * size.height) / size.width);
  const colors = textColorsOf(color);

  const draftBrand: Brand = useMemo(
    () => ({
      ...brand,
      name,
      handle,
      color,
      intro: {
        ...brand.intro,
        title: intro.title,
        subtitle: intro.subtitle,
        durationMs: Math.round(Number(intro.seconds || "0") * 1000) || brand.intro.durationMs,
      },
      outro: {
        ...brand.outro,
        title: outro.title,
        subtitle: outro.subtitle,
        durationMs: Math.round(Number(outro.seconds || "0") * 1000) || brand.outro.durationMs,
      },
    }),
    [brand, name, handle, color, intro, outro],
  );

  const preview = (role: "intro" | "outro", draft: CardDraft) => {
    const uri = cardImage(
      brandArtOf(draftBrand, role, draft),
      { width: PREVIEW_WIDTH, height: previewHeight },
    );
    if (uri) {
      return (
        <img
          src={uri}
          alt={role === "intro" ? "片头卡预览" : "片尾卡预览"}
          width={PREVIEW_WIDTH}
          height={previewHeight}
          className="rounded-token border border-line"
        />
      );
    }
    // 没有画布时退回纯 CSS 的大致样子：形状与文字位置一致，字距不会完全一样
    return (
      <div
        className="flex flex-col items-center justify-center rounded-token border border-line px-4 text-center"
        style={{
          width: PREVIEW_WIDTH,
          height: previewHeight,
          background: color,
          color: colors.text,
        }}
      >
        <p className="text-[15px] font-semibold leading-tight">{draft.title || "（没有标题）"}</p>
        {draft.subtitle && (
          <p className="mt-2 text-[11px]" style={{ color: colors.muted }}>
            {draft.subtitle}
          </p>
        )}
      </div>
    );
  };

  const saveIdentity = () => {
    if (readOnly) return;
    const ok = onSave({ name, handle, color });
    setNotice(ok ? "品牌信息已写进项目：头尾卡都用这个落款与底色。" : "和项目里的一样，没有要写的。");
  };

  const saveCard = (
    role: "intro" | "outro",
    draft: CardDraft,
    setDraft: (next: CardDraft) => void,
  ) => {
    if (readOnly) return;
    const seconds = Number(draft.seconds);
    if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 10) {
      setNotice("卡片时长要在 0.5–10 秒之间。");
      return;
    }
    const durationMs = Math.round(seconds * 1000);
    const ok = onSave(
      role === "intro"
        ? { intro: { title: draft.title, subtitle: draft.subtitle, durationMs } }
        : { outro: { title: draft.title, subtitle: draft.subtitle, durationMs } },
    );
    if (ok) {
      setDraft({ ...draft, seconds: secondsOf(durationMs) });
      const label = role === "intro" ? "片头卡" : "片尾卡";
      setNotice(`${label}已保存：成片、预览、SRT 与 OTIO 的时间都按 ${secondsOf(durationMs)} 秒后移。`);
    } else {
      setNotice("和项目里的一样，没有要写的。");
    }
  };

  const toggle = (role: "intro" | "outro", enabled: boolean) => {
    if (readOnly) return;
    const ok = onSave(role === "intro" ? { intro: { enabled } } : { outro: { enabled } });
    if (ok) {
      const label = role === "intro" ? "片头卡" : "片尾卡";
      setNotice(
        enabled
          ? `${label}已打开：${label === "片头卡" ? "成片最前面" : "成片最后面"}多出一张卡，字都留着。`
          : `${label}已关掉：成片回到只有镜头，卡上的字还留着。`,
      );
    }
  };

  const cardSection = (
    role: "intro" | "outro",
    draft: CardDraft,
    setDraft: (next: CardDraft) => void,
  ) => {
    const card = brand[role];
    const label = role === "intro" ? "片头卡" : "片尾卡";
    const placeholders =
      role === "intro"
        ? { title: "夜班", subtitle: "第一集" }
        : { title: "下一集 20:00", subtitle: "关注不迷路" };
    return (
      <section className="mt-4 border-t border-line pt-3">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[10.5px] text-text">{label}</h3>
            <span className="tnum text-[9px] text-muted-2">
              {card.enabled ? `开 · ${secondsOf(card.durationMs)} 秒` : "关"}
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={card.enabled}
            disabled={readOnly}
            onClick={() => toggle(role, !card.enabled)}
            className={cn(
              "rounded-token border px-2.5 py-1 text-[10px] transition-colors duration-[var(--dur)] disabled:opacity-40",
              card.enabled
                ? "border-pick bg-pick/15 text-text"
                : "border-line text-muted hover:border-line-2 hover:text-text",
            )}
          >
            {card.enabled ? "出片：开" : "出片：关"}
          </button>
        </div>

        <div className="mt-2 flex gap-3">
          <div className="shrink-0">{preview(role, draft)}</div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <label className="text-[9px] text-muted-2">
              标题
              <input
                value={draft.title}
                disabled={readOnly}
                maxLength={60}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveCard(role, draft, setDraft);
                }}
                placeholder={placeholders.title}
                className="mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text placeholder:text-muted-2/70 focus:border-line-2 focus:outline-none disabled:opacity-40"
              />
            </label>
            <label className="text-[9px] text-muted-2">
              副标题
              <input
                value={draft.subtitle}
                disabled={readOnly}
                maxLength={60}
                onChange={(event) => setDraft({ ...draft, subtitle: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveCard(role, draft, setDraft);
                }}
                placeholder={placeholders.subtitle}
                className="mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text placeholder:text-muted-2/70 focus:border-line-2 focus:outline-none disabled:opacity-40"
              />
            </label>
            <label className="text-[9px] text-muted-2">
              时长（秒）
              <input
                value={draft.seconds}
                disabled={readOnly}
                inputMode="decimal"
                onChange={(event) => setDraft({ ...draft, seconds: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveCard(role, draft, setDraft);
                }}
                className="tnum mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none disabled:opacity-40"
              />
            </label>
            <button
              type="button"
              disabled={readOnly}
              onClick={() => saveCard(role, draft, setDraft)}
              className="mt-0.5 self-start rounded-token border border-line-2 bg-text/10 px-2 py-0.5 text-[9.5px] text-text transition-colors duration-[var(--dur)] hover:bg-text/20 disabled:opacity-40"
            >
              保存这张卡
            </button>
          </div>
        </div>
      </section>
    );
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label="品牌包与头尾卡"
        className="flex h-full w-[470px] max-w-[94vw] flex-col border-l border-line bg-bg"
      >
        <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12px] tracking-[.06em] text-text">品牌包与头尾卡</h2>
            <span className="tnum text-[9px] text-muted-2">
              {view.cards.length} 张出片 · 成片 {view.totalSec.toFixed(1)} 秒
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
          <section>
            <h3 className="text-[10.5px] text-text">品牌</h3>
            <div className="mt-2 flex flex-col gap-1.5">
              <label className="text-[9px] text-muted-2">
                落款名
                <input
                  value={name}
                  disabled={readOnly}
                  maxLength={40}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="织光机"
                  className="mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text placeholder:text-muted-2/70 focus:border-line-2 focus:outline-none disabled:opacity-40"
                />
              </label>
              <label className="text-[9px] text-muted-2">
                账号 / 期数说明
                <input
                  value={handle}
                  disabled={readOnly}
                  maxLength={60}
                  onChange={(event) => setHandle(event.target.value)}
                  placeholder="@织光机 · 第 03 集"
                  className="mt-0.5 w-full rounded-token border border-line bg-transparent px-1.5 py-1 text-[10px] text-text placeholder:text-muted-2/70 focus:border-line-2 focus:outline-none disabled:opacity-40"
                />
              </label>
              <div className="flex items-center gap-2 text-[9px] text-muted-2">
                卡片底色
                <input
                  type="color"
                  aria-label="卡片底色"
                  value={color}
                  disabled={readOnly}
                  onChange={(event) => setColor(event.target.value.toUpperCase())}
                  className="h-6 w-10 rounded-token border border-line bg-transparent"
                />
                <span className="tnum text-muted">{color}</span>
                <span className="text-muted-2">
                  字色自动换成{colors.text === "#F4F4F5" ? "浅" : "深"}色
                </span>
              </div>
              <button
                type="button"
                disabled={readOnly}
                onClick={saveIdentity}
                className="mt-0.5 self-start rounded-token border border-line-2 bg-text/10 px-2 py-0.5 text-[9.5px] text-text transition-colors duration-[var(--dur)] hover:bg-text/20 disabled:opacity-40"
              >
                保存品牌
              </button>
            </div>
          </section>

          {notice && (
            <p className="mt-3 rounded-token border border-line bg-surface/60 px-2 py-1.5 text-[9.5px] leading-[1.6] text-muted">
              {notice}
            </p>
          )}

          {cardSection("intro", intro, setIntro)}
          {cardSection("outro", outro, setOutro)}

          <p className="mt-4 border-t border-line pt-3 text-[9px] leading-[1.7] text-muted-2">
            卡片是成片最前 / 最后的一张静帧，不是时间线里的镜头：时间线本身不动，
            导出时整体后移。片头卡是静音的，配乐从第一镜进来。这一版只做静态卡——
            动态 logo、贴片广告与模板市场都没做。
          </p>
        </div>
      </aside>
    </div>
  );
}
