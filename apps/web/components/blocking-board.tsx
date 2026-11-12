"use client";

import { useRef, useState } from "react";
import type { CameraPlacement, LocationSpace, Vec3 } from "@loomina/ir";
import { cn } from "@/lib/utils";

/**
 * 俯视走位图（B13.1 / ADR-0126 §5）。
 *
 * 这是平面图，不是预演：只有房间外框、锚点、人物与朝向、轴线、机位视锥。
 * 没有相机高度、没有遮挡，所以界面上要写清「不是最终画面」。
 *
 * 坐标就是 IR 的场地坐标：X 向右、Z 向下（俯视看，Y 朝观察者）。
 */

/** 图边留白：锚点标签会伸到房间外，留够就不被裁 */
const PAD = 0.9;

export type BoardActor = { characterId: string; name: string; position: Vec3; facingRad: number };
export type BoardCamera = { shotId: string; label: string; placement: CameraPlacement; focalMm: number };

/**
 * 焦段 → 水平视角。
 *
 * 焦段是 35 mm 全画幅**等效**值：竖幅时画面宽对应全画幅短边 24 mm，
 * 所以 `2·atan(24/2/f)`。35 mm 约 37.8°、24 mm 约 53.1°、50 mm 约 27.0°。
 *
 * 第一版写的是 9.6 mm（手机传感器的物理宽度），35 mm 算出 15.6°——
 * 那是一个长焦视场，俯视图里的扇形窄得不像话。B13.3 落地时发现并改正，
 * 与结构参考图共用同一个口径。
 */
export function fovRad(focalMm: number): number {
  return 2 * Math.atan(24 / 2 / Math.max(8, focalMm));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type BlockingBoardProps = {
  space: LocationSpace;
  actors: BoardActor[];
  cameras?: BoardCamera[];
  /** 轴线两端的人物 id；给了才画虚线 */
  axis?: { aId: string; bId: string } | null;
  /** 只读：不给 onMoveActor 就拖不动 */
  onMoveActor?: (characterId: string, position: Vec3) => void;
  onMoveCamera?: (shotId: string, position: Vec3) => void;
  /** 高亮哪一镜的机位 */
  activeShotId?: string;
  className?: string;
  /** 图上额外的一句话，比如「建议」或「当前走位」 */
  caption?: string;
};

export function BlockingBoard({
  space,
  actors,
  cameras = [],
  axis,
  onMoveActor,
  onMoveCamera,
  activeShotId,
  className,
  caption,
}: BlockingBoardProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragging, setDragging] = useState<
    { kind: "actor"; id: string } | { kind: "camera"; id: string } | null
  >(null);

  const [width, depth] = space.dimensions;
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const view = {
    x: -halfWidth - PAD,
    y: -halfDepth - PAD,
    width: width + PAD * 2,
    height: depth + PAD * 2,
  };

  /**
   * 屏幕坐标 → 场地坐标。
   *
   * 俯视图只决定 X / Z；Y 是高度，图上看不出来，所以由调用方给一个保留值：
   * 拖人物保留 0（地面），拖机位保留原来的高度（不然机位会被压到地上）。
   */
  const toPoint = (event: React.PointerEvent, keepY: number): Vec3 | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    // 保持比例（preserveAspectRatio 默认 xMidYMid meet）：取较小的一边换算
    const scale = Math.min(rect.width / view.width, rect.height / view.height);
    const offsetX = (rect.width - view.width * scale) / 2;
    const offsetY = (rect.height - view.height * scale) / 2;
    const x = view.x + (event.clientX - rect.left - offsetX) / scale;
    const z = view.y + (event.clientY - rect.top - offsetY) / scale;
    return [
      clamp(x, -halfWidth + 0.1, halfWidth - 0.1),
      keepY,
      clamp(z, -halfDepth + 0.1, halfDepth - 0.1),
    ];
  };

  const handleMove = (event: React.PointerEvent) => {
    if (!dragging) return;
    const keepY =
      dragging.kind === "camera"
        ? (cameras.find((camera) => camera.shotId === dragging.id)?.placement.position[1] ?? 1.5)
        : (actors.find((actor) => actor.characterId === dragging.id)?.position[1] ?? 0);
    const point = toPoint(event, keepY);
    if (!point) return;
    if (dragging.kind === "actor") onMoveActor?.(dragging.id, point);
    else onMoveCamera?.(dragging.id, point);
  };

  const actorById = new Map(actors.map((actor) => [actor.characterId, actor]));
  const axisA = axis ? actorById.get(axis.aId) : undefined;
  const axisB = axis ? actorById.get(axis.bId) : undefined;

  return (
    <figure className={cn("min-w-0", className)}>
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
        role="img"
        aria-label={`俯视走位图：${width}×${depth} 米`}
        className={cn(
          "block w-full touch-none select-none rounded-token border border-line bg-[#0f1013]",
          dragging && "cursor-grabbing",
        )}
        onPointerMove={handleMove}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
        onPointerCancel={() => setDragging(null)}
      >
        {/* 房间外框 */}
        <rect
          x={-halfWidth}
          y={-halfDepth}
          width={width}
          height={depth}
          fill="none"
          stroke="var(--line-2, #3a3d44)"
          strokeWidth={0.05}
        />
        {/* 米格：每米一格，淡一点，给距离感 */}
        {Array.from({ length: Math.max(1, Math.round(width)) - 1 }, (_, index) => (
          <line
            key={`gx-${index}`}
            x1={-halfWidth + index + 1}
            y1={-halfDepth}
            x2={-halfWidth + index + 1}
            y2={halfDepth}
            stroke="#1e2026"
            strokeWidth={0.02}
          />
        ))}
        {Array.from({ length: Math.max(1, Math.round(depth)) - 1 }, (_, index) => (
          <line
            key={`gz-${index}`}
            x1={-halfWidth}
            y1={-halfDepth + index + 1}
            x2={halfWidth}
            y2={-halfDepth + index + 1}
            stroke="#1e2026"
            strokeWidth={0.02}
          />
        ))}

        {/* 锚点：门 / 窗 / 家具 / 光 */}
        {space.anchors.map((anchor) => {
          const [x, , z] = anchor.position;
          const isOpening = anchor.kind === "door" || anchor.kind === "window";
          return (
            <g key={anchor.id}>
              {isOpening ? (
                <rect
                  x={x - 0.35}
                  y={z - 0.08}
                  width={0.7}
                  height={0.16}
                  fill={anchor.kind === "door" ? "#3c4048" : "#2c3a44"}
                  stroke={anchor.kind === "door" ? "#6a707c" : "#54788c"}
                  strokeWidth={0.02}
                  transform={`rotate(${(anchor.facingRad * 180) / Math.PI} ${x} ${z})`}
                />
              ) : (
                <rect
                  x={x - 0.22}
                  y={z - 0.22}
                  width={0.44}
                  height={0.44}
                  rx={0.05}
                  fill={anchor.kind === "light" ? "#2b2b1d" : "#1d1f24"}
                  stroke={anchor.kind === "light" ? "#8a8352" : "#454a54"}
                  strokeWidth={0.02}
                />
              )}
              {/* 顶灯 / 镜面在天花上，俯视图里只画位置、不标名字：否则和家具标签叠在一起 */}
              {anchor.label && anchor.kind !== "light" && anchor.kind !== "mirror" && (
                <text
                  x={x}
                  // 贴着下沿的锚点把标签放上面，免得掉出画框
                  y={z > halfDepth - 0.7 ? z - 0.42 : z + 0.55}
                  fontSize={0.16}
                  textAnchor={x > halfWidth - 0.9 ? "end" : x < -halfWidth + 0.9 ? "start" : "middle"}
                  fill="#6f7684"
                >
                  {/* 图上只写短名（"沙发"），完整名字在下面的说明里 */}
                  {anchor.label.replace(/（[^）]*）/g, "")}
                </text>
              )}
            </g>
          );
        })}

        {/* 轴线：最主要一对角色的连线 */}
        {axisA && axisB && (
          <line
            x1={axisA.position[0]}
            y1={axisA.position[2]}
            x2={axisB.position[0]}
            y2={axisB.position[2]}
            stroke="#7d8494"
            strokeWidth={0.03}
            strokeDasharray="0.18 0.12"
          />
        )}

        {/* 机位视锥 */}
        {cameras.map((camera) => {
          const [px, , pz] = camera.placement.position;
          const [tx, , tz] = camera.placement.target;
          const dx = tx - px;
          const dz = tz - pz;
          const length = Math.hypot(dx, dz) || 0.001;
          const base = Math.atan2(dz, dx);
          const half = fovRad(camera.focalMm) / 2;
          const reach = Math.min(length * 1.15, Math.max(width, depth));
          const leftX = px + Math.cos(base - half) * reach;
          const leftZ = pz + Math.sin(base - half) * reach;
          const rightX = px + Math.cos(base + half) * reach;
          const rightZ = pz + Math.sin(base + half) * reach;
          const active = !activeShotId || camera.shotId === activeShotId;
          return (
            <g key={camera.shotId} opacity={active ? 1 : 0.28}>
              <polygon
                points={`${px},${pz} ${leftX},${leftZ} ${rightX},${rightZ}`}
                fill={active ? "#c8b06a" : "#8a8158"}
                fillOpacity={0.12}
                stroke={active ? "#c8b06a" : "#6d6749"}
                strokeWidth={0.025}
                strokeOpacity={0.7}
              />
              <circle
                cx={px}
                cy={pz}
                r={0.16}
                fill="#c8b06a"
                stroke="#0f1013"
                strokeWidth={0.03}
                className={onMoveCamera ? "cursor-grab" : undefined}
                onPointerDown={(event) => {
                  if (!onMoveCamera) return;
                  event.stopPropagation();
                  // 不在这里 setPointerCapture：捕获之后 pointermove 只发给这个圆点，
                  // svg 上的拖动监听就收不到了
                  setDragging({ kind: "camera", id: camera.shotId });
                }}
              />
              <text
                x={px}
                y={pz - 0.26}
                fontSize={0.22}
                textAnchor="middle"
                fill={active ? "#d8cfae" : "#8a8158"}
              >
                {camera.label}
              </text>
            </g>
          );
        })}

        {/* 人物：圆点 + 朝向箭头 */}
        {actors.map((actor, index) => {
          const [x, , z] = actor.position;
          const ahead = 0.42;
          const ax = x + Math.sin(actor.facingRad) * ahead;
          const az = z + Math.cos(actor.facingRad) * ahead;
          const tone = ACTOR_TONES[index % ACTOR_TONES.length]!;
          return (
            <g key={actor.characterId}>
              <line
                x1={x}
                y1={z}
                x2={ax}
                y2={az}
                stroke={tone}
                strokeWidth={0.06}
                strokeLinecap="round"
              />
              <circle
                cx={x}
                cy={z}
                r={0.19}
                fill={tone}
                stroke="#0f1013"
                strokeWidth={0.04}
                className={onMoveActor ? "cursor-grab" : undefined}
                onPointerDown={(event) => {
                  if (!onMoveActor) return;
                  event.stopPropagation();
                  setDragging({ kind: "actor", id: actor.characterId });
                }}
              />
              <text
                x={x}
                y={z + 0.5}
                fontSize={0.24}
                textAnchor="middle"
                fill="#c9ccd2"
              >
                {actor.name}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1.5 flex items-baseline justify-between gap-2 text-[9px] leading-[1.5] text-muted-2">
        <span>{caption ?? "俯视走位图"}</span>
        <span className="tnum shrink-0">
          {width}×{depth} m
          {onMoveActor || onMoveCamera ? " · 可拖动" : ""}
        </span>
      </figcaption>
    </figure>
  );
}

const ACTOR_TONES = ["#8fb2d6", "#d69a8f", "#9fd6a8", "#c8a8d6"];
