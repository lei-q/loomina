"use client";

import { useState } from "react";
import { useWorkbench } from "@/lib/workbench-store";
import { assetHref } from "@/lib/asset-uri";
import { loadWorkspaceProjects, sharedAssetsOf, type SharedAsset } from "@/lib/workspace-assets";

/**
 * 从别的空间拿一版配音（C1 / ADR-0195）。
 *
 * 配音按字计费，同一句在第二集重录一次就是再花一次钱。取用只登记地址，
 * 不复制字节、不重新生成；挂上就是这句台词当前采用的音轨。
 */
export function SharedAudioPicker({
  usedUri,
  onPick,
}: {
  usedUri?: string;
  onPick: (uri: string) => boolean;
}) {
  const workspaceId = useWorkbench((state) => state.workspaceId);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<SharedAsset[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const openPicker = async () => {
    setOpen(true);
    if (list) return;
    setBusy(true);
    setError(undefined);
    try {
      const spaces = await loadWorkspaceProjects();
      setList(
        sharedAssetsOf(
          spaces.filter((space) => space.id !== workspaceId),
          ["audio"],
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读不到别的空间。");
    } finally {
      setBusy(false);
    }
  };

  const take = (asset: SharedAsset) => {
    if (onPick(asset.uri)) {
      setOpen(false);
      return;
    }
    setError("这一版没用上：可能地址不可用，或这句台词锁在已锁定的镜头里。");
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void openPicker()}
        title="从本机其它工作空间拿一版已经录好的配音：不重新生成、不花钱"
        className="rounded-token border border-line px-1.5 py-px text-[8.5px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
      >
        从别的空间取一版
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
            aria-label="从别的空间取一版配音"
            className="max-h-[82vh] w-[680px] max-w-[94vw] overflow-y-auto border border-line bg-bg px-4 py-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[11px] tracking-[.06em] text-text">从别的空间取一版配音</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
              >
                关闭
              </button>
            </div>
            <p className="mt-1 text-[9px] leading-[1.7] text-muted-2">
              只列本机其它工作空间里的音频。取用只登记地址，不复制文件、不重新生成、
              不花钱；挂上后就是这句台词当前采用的音轨，原来的音轨记录仍留在日志里。
            </p>

            {busy && <p className="mt-3 text-[10px] text-muted-2">正在读别的空间…</p>}
            {error && <p className="mt-2 text-[9.5px] text-pick">{error}</p>}

            {!busy && list && (
              <div className="mt-3 space-y-1.5">
                {list.slice(0, 60).map((asset) => {
                  const used = usedUri === asset.uri;
                  return (
                    <div
                      key={asset.uri}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 border border-line px-2 py-1.5"
                    >
                      <audio
                        src={assetHref(asset.uri)}
                        controls
                        preload="metadata"
                        className="h-7 w-[210px] shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[9.5px] text-muted">
                          {asset.usedBy.slice(0, 2).join(" · ") || "没标用处"}
                        </span>
                        <span className="block text-[8.5px] text-muted-2">
                          {asset.workspaceName}
                        </span>
                      </span>
                      <button
                        type="button"
                        disabled={used}
                        onClick={() => take(asset)}
                        className="rounded-token border border-line px-2 py-px text-[9px] text-muted transition-colors duration-[var(--dur)] enabled:hover:border-pick enabled:hover:text-pick disabled:opacity-40"
                      >
                        {used ? "已采用" : "取这一版"}
                      </button>
                    </div>
                  );
                })}
                {list.length === 0 && (
                  <p className="text-[10px] text-muted-2">
                    别的空间里还没有音频：先在另一个工作空间配一句，或贴一条音轨，再过来取。
                  </p>
                )}
              </div>
            )}
            {list && list.length > 60 && (
              <p className="mt-2 text-[9px] text-muted-2">
                只列了最新 60 条：先在别的空间整理一下不用的素材。
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
