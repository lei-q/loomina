"use client";

import { useEffect, useRef, useState } from "react";
import type { CameraPlacement, LocationSpace, Vec3 } from "@loomina/ir";
import { drawStructure, structureOf, type StructureFrame } from "@loomina/pipeline";
import { cn } from "@/lib/utils";

/**
 * 结构参考图（B13.3 / ADR-0129 §2）。
 *
 * 把这一镜的坐标投成一张 9:16 的图：地面网格、房间线框、家具矮盒、
 * 人物柱子（按深度着色，近暖远冷）。用来判断「人在画面的哪个位置、
 * 离机头多远、前后景怎么叠」。
 *
 * **不是渲染**：没有逐像素深度、没有材质与光。图下方固定写明这一点，
 * 免得被当成 previs 画面（ADR-0126 的同一口径）。
 */

export type StructureActorInput = {
  characterId: string;
  name: string;
  position: Vec3;
};

export type StructureBoardProps = {
  space: LocationSpace;
  placement: CameraPlacement;
  actors: StructureActorInput[];
  focalMm?: number;
  className?: string;
};

export function StructureBoard({
  space,
  placement,
  actors,
  focalMm,
  className,
}: StructureBoardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [frame, setFrame] = useState<StructureFrame | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const next = structureOf({ space, placement, actors, ...(focalMm ? { focalMm } : {}) });
    setFrame(next);
    const context = canvas.getContext("2d");
    if (!context) return;
    drawStructure(context, next);
  }, [space, placement, actors, focalMm]);

  /** 存成 PNG：作者可以把它当关键帧的构图参考 */
  const download = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `结构参考图-${placement.position.map((value) => value.toFixed(1)).join("_")}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  return (
    <figure className={cn("min-w-0", className)}>
      <canvas
        ref={canvasRef}
        width={360}
        height={640}
        role="img"
        aria-label="结构参考图：房间线框、家具与人物按机位投影，颜色由近到远从暖到冷"
        className="block w-full rounded-token border border-line bg-[#0f1013]"
      />
      <figcaption className="mt-1.5 flex items-baseline justify-between gap-2 text-[9px] leading-[1.5] text-muted-2">
        <span>
          结构参考图 · 近暖远冷，不是渲染
          {frame && frame.outside > 0 ? ` · ${frame.outside} 人画面外` : ""}
          {frame && frame.culled > 0 ? ` · ${frame.culled} 件机位背后` : ""}
        </span>
        <button
          type="button"
          onClick={download}
          className="shrink-0 rounded-token border border-line px-1.5 py-px text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          title="存成 PNG，可以贴给图像模型当构图参考"
        >
          存成 PNG
        </button>
      </figcaption>
    </figure>
  );
}
