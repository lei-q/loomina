"use client";

import { useState } from "react";
import { useWorkbench } from "@/lib/workbench-store";
import { assetHref } from "@/lib/asset-uri";
import { loadWorkspaceProjects } from "@/lib/workspace-assets";
import {
  sharedEntitiesOf,
  sharedEntityKindLabel,
  sharedEntitySummary,
  type SharedEntity,
  type SharedEntityKind,
} from "@/lib/shared-entities";

/**
 * 从别的空间搬一个演员 / 场景 / 道具（C1 / ADR-0190）。
 *
 * 打开面板时才回放各空间的日志；取用只登记资产记录与实体，不复制字节，
 * 也不重新生成——这正是「跨集复用不再花钱」的入口。
 */
export function SharedEntityPicker({
  kind,
  onPick,
}: {
  kind: SharedEntityKind;
  onPick: (shared: SharedEntity) => boolean;
}) {
  const workspaceId = useWorkbench((state) => state.workspaceId);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<SharedEntity[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const label = sharedEntityKindLabel(kind);

  const openPicker = async () => {
    setOpen(true);
    if (list) return;
    setBusy(true);
    setError(undefined);
    try {
      const spaces = await loadWorkspaceProjects();
      setList(
        sharedEntitiesOf(
          spaces.filter((space) => space.id !== workspaceId),
          kind,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读不到别的空间。");
    } finally {
      setBusy(false);
    }
  };

  const take = (shared: SharedEntity) => {
    if (onPick(shared)) {
      setOpen(false);
      return;
    }
    setError("这个没取过来：看页头的提示。");
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void openPicker()}
        title={`从本机其它工作空间搬一个${label}过来：定妆 / 主镜 / 参考图一起带过来，不重新生成、不花钱`}
        className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
      >
        从别的空间取
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-bg/80 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-label={`从别的空间取${label}`}
            className="max-h-[82vh] w-[720px] max-w-[94vw] overflow-y-auto border border-line bg-bg px-4 py-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[11px] tracking-[.06em] text-text">
                从别的空间取一个{label}
              </h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
              >
                关闭
              </button>
            </div>
            <p className="mt-1 text-[9px] leading-[1.7] text-muted-2">
              只列本机其它工作空间里的{label}。取用会把定妆 / 主镜 / 参考图一起带过来，
              资产只登记地址：不复制文件、不重新生成、不花钱。名字撞了自动加「（复用）」。
            </p>

            {busy && <p className="mt-3 text-[10px] text-muted-2">正在读别的空间…</p>}
            {error && <p className="mt-2 text-[9.5px] text-pick">{error}</p>}

            {!busy && list && (
              <div className="mt-3 space-y-1.5">
                {list.map((entity) => (
                  <button
                    key={entity.key}
                    type="button"
                    onClick={() => take(entity)}
                    className="flex w-full items-center gap-3 border border-line px-2.5 py-2 text-left transition-colors duration-[var(--dur)] hover:border-line-2 hover:bg-surface/60"
                  >
                    <span className="grid h-[48px] w-[48px] shrink-0 place-items-center overflow-hidden rounded-[1px] border border-line bg-[#0f1013] text-[11px] text-muted-2">
                      {entity.thumbnail ? (
                        <img
                          src={assetHref(entity.thumbnail)}
                          alt={entity.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        entity.name.slice(0, 1)
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[11px] text-text">{entity.name}</span>
                        <span className="tnum text-[9px] text-muted-2">
                          {sharedEntitySummary(entity)}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-[9.5px] text-muted">
                        {entity.detail || "没有描述"}
                      </span>
                      <span className="mt-0.5 block text-[8.5px] text-muted-2">
                        {entity.workspaceName}
                      </span>
                    </span>
                  </button>
                ))}
                {list.length === 0 && (
                  <p className="text-[10px] text-muted-2">
                    别的空间里还没有{label}：先在另一个工作空间做好，再过来取。
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
