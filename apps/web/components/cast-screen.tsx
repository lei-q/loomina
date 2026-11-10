"use client";

import Link from "next/link";
import { useMemo } from "react";
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
  onLock,
  onUnlock,
}: {
  character: CastCharacterView;
  onLock: () => void;
  onUnlock: () => void;
}) {
  const missing = character.panels.filter((panel) => !panel.assetId).length;

  return (
    <section className="border-t border-line py-5">
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-[168px] shrink-0">
          <div className="flex items-baseline gap-2.5">
            <h2 className="text-[17px] leading-none text-text">{character.name}</h2>
            <StatusChip status={character.status} missing={missing} />
          </div>
          <p className="mt-2 text-[11.5px] leading-[1.5] text-muted">{character.appearance}</p>
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
                {panel.assetId ? (
                  <Bust view={panel.angle} className="h-full w-full" />
                ) : (
                  <span className="absolute inset-0 grid place-items-center text-[9px] text-muted-2">
                    待生成
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
          )}
        </div>
      </div>
    </section>
  );
}

function LocationRow({
  location,
  onLock,
  onUnlock,
}: {
  location: CastLocationView;
  onLock: () => void;
  onUnlock: () => void;
}) {
  return (
    <section className="border-t border-line py-5">
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-[168px] shrink-0">
          <div className="flex items-baseline gap-2.5">
            <h2 className="text-[17px] leading-none text-text">{location.name}</h2>
            <StatusChip status={location.status} />
          </div>
          <p className="tnum mt-2 text-[10px] text-muted-2">主镜 · 全场共用</p>
        </div>

        <figure className="w-[120px]">
          <div className="relative aspect-[9/16] overflow-hidden rounded-[1px] border border-line bg-[#0f1013]">
            {location.masterAssetId ? (
              <Scene kind={location.art} className="h-full w-full" />
            ) : (
              <span className="absolute inset-0 grid place-items-center text-[9px] text-muted-2">
                待生成
              </span>
            )}
          </div>
          <figcaption className="tnum mt-1.5 text-[9px] text-muted-2">master</figcaption>
        </figure>

        <div className="max-w-[38ch] self-center">
          <p className="text-[11px] leading-[1.6] text-muted-2">
            同一场的所有镜头都带这张图进生成，房间不许每镜重新想象。
          </p>
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
            <button
              type="button"
              onClick={onLock}
              disabled={location.status === "incomplete"}
              title={location.status === "incomplete" ? "还没有主镜" : "锁定后下游只能引用，不能替换"}
              className="rounded-token bg-text px-3 py-1.5 text-[11.5px] text-bg transition-opacity duration-[var(--dur)] hover:opacity-85 disabled:pointer-events-none disabled:opacity-30"
            >
              锁定主镜
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function PropRow({
  prop,
  onLock,
  onUnlock,
}: {
  prop: CastPropView;
  onLock: () => void;
  onUnlock: () => void;
}) {
  return (
    <section className="border-t border-line py-5">
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-[168px] shrink-0">
          <div className="flex items-baseline gap-2.5">
            <h2 className="text-[17px] leading-none text-text">{prop.name}</h2>
            <StatusChip status={prop.status} missingText="缺参考图" />
          </div>
          <p className="mt-2 text-[11px] leading-[1.5] text-muted">{prop.description}</p>
        </div>

        <figure className="w-[120px]">
          <div className="relative aspect-[9/16] overflow-hidden rounded-[1px] border border-line bg-[#0f1013]">
            {prop.referenceAssetId ? (
              <PropObject kind={prop.art} className="h-full w-full" />
            ) : (
              <span className="absolute inset-0 grid place-items-center text-[9px] text-muted-2">
                待生成
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
            <button
              type="button"
              onClick={onLock}
              disabled={prop.status === "incomplete"}
              title={prop.status === "incomplete" ? "还没有参考图" : "锁定后下游只能引用，不能替换"}
              className="rounded-token bg-text px-3 py-1.5 text-[11.5px] text-bg transition-opacity duration-[var(--dur)] hover:opacity-85 disabled:pointer-events-none disabled:opacity-30"
            >
              锁定道具
            </button>
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

  const cast = useMemo(() => toCastView(project), [project]);
  const done = cast.lockedCount === cast.totalRequired;
  const progress = cast.totalRequired === 0 ? 0 : (cast.lockedCount / cast.totalRequired) * 100;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
      <TopBar title={project.title} version={project.version} stage="定妆" />

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
          </header>

          <section className="mt-7">
            <h2 className="tnum text-[9px] tracking-[.14em] text-muted-2">人物 · 三视图</h2>
            {cast.characters.map((character) => (
              <CharacterRow
                key={character.id}
                character={character}
                onLock={() => lockCast("character", character.id)}
                onUnlock={() => unlockCast("character", character.id)}
              />
            ))}
          </section>

          <section className="mt-8">
            <h2 className="tnum text-[9px] tracking-[.14em] text-muted-2">场景 · 主镜</h2>
            {cast.locations.map((location) => (
              <LocationRow
                key={location.id}
                location={location}
                onLock={() => lockCast("location", location.id)}
                onUnlock={() => unlockCast("location", location.id)}
              />
            ))}
          </section>

          {cast.props.length > 0 && (
            <section className="mt-8">
              <h2 className="tnum text-[9px] tracking-[.14em] text-muted-2">道具 · 参考</h2>
              {cast.props.map((prop) => (
                <PropRow
                  key={prop.id}
                  prop={prop}
                  onLock={() => lockCast("prop", prop.id)}
                  onUnlock={() => unlockCast("prop", prop.id)}
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
