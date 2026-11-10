import type { SheetView } from "@loomina/ir";

/**
 * 三视图占位剪影。
 *
 * 示例项目没有真图（图片接口还没通），但格子的语义是真的：
 * 正面 / 3-4 / 侧面 / 背面各是一张独立的图，锁定的是这四张图的 id。
 * 画法与分镜剪影同一套墨色：一束顶光、一个实心人形、一条地平线。
 */
export function Bust({ view, className }: { view: SheetView; className?: string }) {
  const ink = "#06070a";
  const edge = "#3a424b";
  const gradientId = `cast-light-${view}`;

  return (
    <svg viewBox="0 0 90 160" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b3138" stopOpacity=".85" />
          <stop offset=".75" stopColor="#14171b" stopOpacity=".25" />
          <stop offset="1" stopColor="#0f1013" stopOpacity="0" />
        </linearGradient>
      </defs>

      <rect width="90" height="160" fill={`url(#${gradientId})`} />
      <path d="M0 132H90" stroke="#232830" strokeWidth="0.8" />

      {view === "front" && (
        <>
          <circle cx="45" cy="40" r="17" fill={ink} stroke={edge} strokeWidth="0.9" />
          <rect x="39" y="52" width="12" height="12" fill={ink} />
          <path d="M15 132V92C15 74 28 62 45 62C62 62 75 74 75 92V132Z" fill={ink} stroke={edge} strokeWidth="0.9" />
        </>
      )}

      {view === "threeQuarter" && (
        <>
          <circle cx="42" cy="40" r="17" fill={ink} stroke={edge} strokeWidth="0.9" />
          <path d="M59 34C63 38 65 44 64 50C62 44 60 40 57 37Z" fill={ink} />
          <rect x="37" y="52" width="12" height="12" fill={ink} />
          <path d="M18 132V94C18 76 29 63 44 62C62 61 76 74 76 94V132Z" fill={ink} stroke={edge} strokeWidth="0.9" />
        </>
      )}

      {view === "side" && (
        <>
          <circle cx="46" cy="40" r="16" fill={ink} stroke={edge} strokeWidth="0.9" />
          <path d="M60 38H64V45H60Z" fill={ink} />
          <rect x="40" y="52" width="12" height="12" fill={ink} />
          <path d="M22 132V95C22 78 33 66 46 65C59 64 70 74 70 92V132Z" fill={ink} stroke={edge} strokeWidth="0.9" />
        </>
      )}

      {view === "back" && (
        <>
          <circle cx="45" cy="40" r="18" fill={ink} stroke={edge} strokeWidth="0.9" />
          <path d="M27 46C27 26 34 18 45 18C56 18 63 26 63 46Z" fill={ink} />
          <rect x="39" y="52" width="12" height="12" fill={ink} />
          <path d="M14 132V91C14 73 28 61 45 61C62 61 76 73 76 91V132Z" fill={ink} stroke={edge} strokeWidth="0.9" />
        </>
      )}
    </svg>
  );
}
