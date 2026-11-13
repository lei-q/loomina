"use client";

import { useState } from "react";
import { useWorkbench } from "@/lib/workbench-store";
import { assetHref } from "@/lib/asset-uri";
import { loadWorkspaceProjects, sharedAssetsOf, type SharedAsset } from "@/lib/workspace-assets";

/**
 * 从别的空间拿一条视频当这一镜的一拍（C1 / C14 / ADR-0194）。
 *
 * 视频是最贵的一项；同一段走廊、同一个动作在第二集还要用，就该拿原件，
 * 而不是重新生成。取用只登记资产记录：地址不变、不复制字节、不花钱。
 */
export function SharedVideoPicker({
  usedUris,
  onPick,
}: {
  usedUris: string[];
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
          ["video"],
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
    setError("这条没挂上：可能已经在这一镜里，或地址不可用。");
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void openPicker()}
        title="从本机其它工作空间拿一条已经出好的视频当这一拍：不重新生成、不花钱"
        className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
      >
        从素材库取一拍
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
            aria-label="从素材库取一拍视频"
            className="max-h-[82vh] w-[760px] max-w-[94vw] overflow-y-auto border border-line bg-bg px-4 py-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[11px] tracking-[.06em] text-text">从素材库取一拍</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
              >
                关闭
              </button>
            </div>
            <p className="mt-1 text-[9px] leading-[1.7] text-muted-2">
              只列本机其它工作空间里的视频。取用只登记地址，不复制文件、不重新生成、
              不花钱；挂上后就是这一镜新的一拍，原来的拍不受影响。
            </p>

            {busy && <p className="mt-3 text-[10px] text-muted-2">正在读别的空间…</p>}
            {error && <p className="mt-2 text-[9.5px] text-pick">{error}</p>}

            {!busy && list && (
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {list.slice(0, 60).map((asset) => {
                  const used = usedUris.includes(asset.uri);
                  return (
                    <button
                      key={asset.uri}
                      type="button"
                      disabled={used}
                      onClick={() => take(asset)}
                      title={
                        used
                          ? "这一镜已经挂了这条视频"
                          : `${asset.workspaceName} · ${asset.usedBy.join(" · ") || "没标用处"}`
                      }
                      className="flex flex-col gap-1 border border-line p-1 text-left transition-colors duration-[var(--dur)] enabled:hover:border-line-2 disabled:opacity-40"
                    >
                      <span className="block aspect-[9/16] w-full overflow-hidden rounded-[1px] border border-line bg-[#0f1013]">
                        <video
                          src={assetHref(asset.uri)}
                          muted
                          playsInline
                          preload="metadata"
                          className="h-full w-full object-cover"
                        />
                      </span>
                      <span className="flex items-baseline justify-between gap-1 text-[8.5px] text-muted-2">
                        <span className="truncate">{asset.workspaceName}</span>
                        <span className="shrink-0">{used ? "已在这一镜" : "取来"}</span>
                      </span>
                      <span className="block truncate text-[8px] text-muted-2">
                        {asset.usedBy.slice(0, 2).join(" · ") || "没标用处"}
                      </span>
                    </button>
                  );
                })}
                {list.length === 0 && (
                  <p className="col-span-full text-[10px] text-muted-2">
                    别的空间里还没有视频：先在另一个工作空间出一拍，再过来取。
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
