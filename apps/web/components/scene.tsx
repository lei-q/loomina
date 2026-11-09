import type { SceneKind } from "@/lib/demo";
import { cn } from "@/lib/utils";

/**
 * 分镜剪影：平面色块，不用渐变假装画面。
 * 这里的墨色是插图自己的颜色，不属于主题令牌——分镜稿不该跟着皮肤变。
 */
const ink = {
  bg: "#0f1013",
  lit: "#39404a",
  body: "#050506",
  edge: "#232830",
} as const;

/** 一个人形：头、颈、肩、躯干。原点在头部中心。 */
function Figure({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} fill={ink.body}>
      <circle cx="0" cy="0" r="18" />
      <rect x="-6" y="12" width="12" height="24" />
      <path d="M-30 170V44C-30 30-22 20-10 16C-3 14 3 14 10 16C22 20 30 30 30 44V170Z" />
    </g>
  );
}

function Doorway() {
  return (
    <>
      <rect width="180" height="320" fill={ink.bg} />
      <rect x="54" width="72" height="320" fill={ink.lit} />
      <Figure x={90} y={150} />
      <path d="M0 270h180" stroke={ink.edge} strokeWidth="1" />
    </>
  );
}

function TwoFigures() {
  return (
    <>
      <rect width="180" height="320" fill={ink.bg} />
      <rect x="84" width="12" height="320" fill={ink.lit} opacity=".45" />
      <Figure x={54} y={150} />
      <Figure x={126} y={150} />
      <path d="M0 268h180" stroke={ink.edge} strokeWidth="1" />
    </>
  );
}

function Table() {
  return (
    <>
      <rect width="180" height="320" fill={ink.bg} />
      <rect x="0" y="252" width="180" height="68" fill="#1b1f24" />
      <rect x="28" y="146" width="7" height="106" fill={ink.lit} opacity=".35" />
      <Figure x={96} y={150} />
      <rect x="120" y="238" width="16" height="10" fill={ink.lit} opacity=".5" />
    </>
  );
}

function Corridor() {
  return (
    <>
      <rect width="180" height="320" fill={ink.bg} />
      <polygon points="62,0 118,0 134,320 46,320" fill={ink.lit} opacity=".5" />
      <Figure x={90} y={192} scale={0.75} />
      <path d="M0 282h180" stroke={ink.edge} strokeWidth="1" />
    </>
  );
}

const scenes: Record<SceneKind, () => React.JSX.Element> = {
  door: Doorway,
  two: TwoFigures,
  table: Table,
  corridor: Corridor,
};

export function Scene({ kind, className }: { kind: SceneKind; className?: string }) {
  const Body = scenes[kind];
  return (
    <svg viewBox="0 0 180 320" preserveAspectRatio="xMidYMid slice" className={cn("block", className)} aria-hidden="true">
      <Body />
    </svg>
  );
}
