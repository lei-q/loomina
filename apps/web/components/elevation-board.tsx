"use client";

import type { CameraPlacement, LocationSpace, Vec3 } from "@loomina/ir";
import type { Occlusion } from "@loomina/pipeline";
import { cn } from "@/lib/utils";

/**
 * 立面图（B13.2 / ADR-0126 §1）。
 *
 * 俯视图能说「谁在左谁在右」，说不出「谁挡住谁」「机位有多高」。
 * 这里把视线竖起来画：横轴是离机位的地面距离，纵轴是高度。
 *
 * 仍然不是渲染：人物是一根柱子、家具是一块矩形，高度取自模板的锚点坐标
 * （家具高度是估的）。图上写明这一点，免得被当成画面。
 *
 * SVG 的 y 轴朝下，所以高度一律过 `Y()` 换算；组件里不出现裸的 `y={height}`。
 */

export type ElevationActor = {
  characterId: string;
  name: string;
  position: Vec3;
  facingRad: number;
};

export type ElevationBoardProps = {
  space: LocationSpace;
  placement: CameraPlacement;
  actors: ElevationActor[];
  occlusions: Occlusion[];
  /** 视线在 XZ 上的水平距离 */
  spanM: number;
  /** 画面里画到多高（一般取房间层高） */
  heightM: number;
  className?: string;
};

const PAD = 0.45;

export function ElevationBoard({
  space,
  placement,
  actors,
  occlusions,
  spanM,
  heightM,
  className,
}: ElevationBoardProps) {
  const camera = placement.position;
  const target = placement.target;
  const groundSpan = Math.max(spanM, 0.8);
  const roomHeight = Math.max(heightM, 1.5);
  const viewHeight = roomHeight + PAD * 2;

  /** 高度（米）→ 图上的 y：0 米贴底，层高贴顶 */
  const Y = (height: number) => roomHeight - height;

  // 把世界坐标投到这条视线上：横向用离机位的水平距离
  const alongOf = (point: Vec3) => {
    const dx = target[0] - camera[0];
    const dz = target[2] - camera[2];
    const length = Math.hypot(dx, dz) || 1;
    return ((point[0] - camera[0]) * dx + (point[2] - camera[2]) * dz) / length;
  };

  const cameraX = 0;
  const targetX = groundSpan;
  const sightAt = (t: number) => camera[1] + (target[1] - camera[1]) * t;
  // 站在目标身后的人、以及贴边的人名都会超出视线长度：视野按最远的那个再放宽一点
  const alongs = actors.map((actor) => alongOf(actor.position));
  const viewSpan = Math.max(groundSpan, ...alongs, 0.8) + 0.6;

  return (
    <figure className={cn("min-w-0", className)}>
      <svg
        viewBox={`${-PAD} ${-PAD} ${viewSpan + PAD * 2} ${viewHeight}`}
        role="img"
        aria-label={`立面图：机位 ${camera[1].toFixed(2)} 米高，距目标 ${groundSpan.toFixed(1)} 米`}
        className="block w-full rounded-token border border-line bg-[#0f1013]"
      >
        {/* 地面实线、天花虚线 */}
        <line
          x1={-PAD}
          y1={Y(0)}
          x2={viewSpan + PAD}
          y2={Y(0)}
          stroke="var(--line-2, #3a3d44)"
          strokeWidth={0.03}
        />
        <line
          x1={-PAD}
          y1={Y(roomHeight)}
          x2={viewSpan + PAD}
          y2={Y(roomHeight)}
          stroke="#24262c"
          strokeWidth={0.02}
          strokeDasharray="0.12 0.1"
        />
        <text x={-PAD + 0.06} y={Y(roomHeight) + 0.2} fontSize={0.13} fill="#5c626e">
          天花 {roomHeight.toFixed(1)} m
        </text>

        {/* 米格：每米一根竖线 */}
        {Array.from({ length: Math.max(1, Math.floor(viewSpan)) }, (_, index) => (
          <line
            key={`g-${index}`}
            x1={index + 1}
            y1={Y(0)}
            x2={index + 1}
            y2={Y(roomHeight)}
            stroke="#1c1e24"
            strokeWidth={0.012}
          />
        ))}

        {/* 锚点：只画挡得住视线的那些，按真实高度 */}
        {space.anchors
          .filter((anchor) =>
            occlusions.some((item) => item.kind === "anchor" && item.id === anchor.id),
          )
          .map((anchor) => {
            const x = alongOf(anchor.position);
            const height = Math.max(0.05, anchor.position[1]);
            return (
              <rect
                key={`a-${anchor.id}`}
                x={x - 0.25}
                y={Y(height)}
                width={0.5}
                height={height}
                fill="#2a2d34"
                stroke="#565c68"
                strokeWidth={0.014}
              />
            );
          })}

        {/* 人物：一根柱子 + 头顶的名字；站同一条线上时名字左右错开 */}
        {actors.map((actor, index) => {
          const x = alongOf(actor.position);
          if (x < -0.4 || x > groundSpan + 0.4) return null;
          const tone = ACTOR_TONES[index % ACTOR_TONES.length]!;
          const body = 1.68;
          const crowded =
            actors.filter((other) => Math.abs(alongOf(other.position) - x) < 0.45).length > 1;
          const dx = crowded ? (index % 2 === 0 ? -0.4 : 0.4) : 0;
          return (
            <g key={`p-${actor.characterId}`}>
              <line
                x1={x}
                y1={Y(0)}
                x2={x}
                y2={Y(body)}
                stroke={tone}
                strokeWidth={0.1}
                strokeLinecap="round"
                opacity={0.85}
              />
              <circle cx={x} cy={Y(body + 0.09)} r={0.11} fill={tone} opacity={0.9} />
              <text
                x={x + dx}
                y={Y(body) - 0.22}
                fontSize={0.17}
                textAnchor="middle"
                fill="#9aa0ac"
              >
                {actor.name}
              </text>
            </g>
          );
        })}

        {/* 视线：机位 → 目标 */}
        <line
          x1={cameraX}
          y1={Y(camera[1])}
          x2={targetX}
          y2={Y(target[1])}
          stroke="#c8b06a"
          strokeWidth={0.022}
          strokeDasharray="0.16 0.1"
        />
        {/* 被挡住的那一段加粗：一眼能看出挡在哪 */}
        {occlusions.map((item, index) => {
          const startX = item.at * groundSpan;
          const endX = Math.min(groundSpan, startX + 0.18);
          return (
            <line
              key={`o-${item.kind}-${item.id}-${index}`}
              x1={startX}
              y1={Y(sightAt(item.at))}
              x2={endX}
              y2={Y(sightAt(Math.min(1, item.at + 0.18 / groundSpan)))}
              stroke="#d98b6a"
              strokeWidth={0.05}
              strokeLinecap="round"
            />
          );
        })}

        {/* 机位：一个小方框，标签压在它下方 */}
        <g>
          <rect
            x={cameraX - 0.16}
            y={Y(camera[1]) - 0.12}
            width={0.32}
            height={0.24}
            rx={0.04}
            fill="#c8b06a"
            stroke="#0f1013"
            strokeWidth={0.02}
          />
          <text
            x={cameraX}
            y={Y(camera[1]) + 0.42}
            fontSize={0.16}
            textAnchor="middle"
            fill="#d8cfae"
          >
            机位 {camera[1].toFixed(2)} m
          </text>
        </g>

        {/* 目标：一道竖标，标签在左上 */}
        <g>
          <line
            x1={targetX}
            y1={Y(target[1])}
            x2={targetX}
            y2={Y(target[1]) + 0.26}
            stroke="#8fb2d6"
            strokeWidth={0.03}
          />
          <text
            x={targetX - 0.12}
            y={Y(target[1]) + 0.34}
            fontSize={0.15}
            textAnchor="end"
            fill="#8fb2d6"
          >
            目标 {target[1].toFixed(2)} m
          </text>
        </g>
      </svg>
      <figcaption className="mt-1.5 flex items-baseline justify-between gap-2 text-[9px] leading-[1.5] text-muted-2">
        <span>立面 · 视线从机位竖起来画</span>
        <span className="tnum shrink-0">
          {groundSpan.toFixed(1)} m · {occlusions.length} 处遮挡
        </span>
      </figcaption>
    </figure>
  );
}

const ACTOR_TONES = ["#8fb2d6", "#d69a8f", "#9fd6a8", "#c8a8d6"];
