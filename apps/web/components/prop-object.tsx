import type { PropKind } from "@/lib/read-model";

/**
 * 道具参考的占位剪影。
 *
 * 和 Bust / Scene 同一套墨色：一束顶光、一个实心物件、一条地平线。
 * 示例项目没有真图，但格子语义是真的——一个道具一张参考图，锁的是这张。
 */
export function PropObject({ kind, className }: { kind: PropKind; className?: string }) {
  const ink = "#06070a";
  const edge = "#3a424b";
  const gradientId = `prop-light-${kind}`;

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

      {kind === "cup" && (
        <>
          <path d="M32 84H58L55 120H35Z" fill={ink} stroke={edge} strokeWidth="0.9" />
          <ellipse cx="45" cy="84" rx="13" ry="4" fill={ink} stroke={edge} strokeWidth="0.9" />
          <path d="M58 92C67 92 67 108 56 108" stroke={edge} strokeWidth="2" />
        </>
      )}

      {kind === "lamp" && (
        <>
          <path d="M24 132L66 132L56 96L34 96Z" fill="#e8e4d9" fillOpacity=".05" />
          <ellipse cx="45" cy="122" rx="18" ry="5" fill={ink} stroke={edge} strokeWidth="0.9" />
          <rect x="43" y="98" width="4" height="24" fill={ink} stroke={edge} strokeWidth="0.7" />
          <path d="M34 68H56L62 96H28Z" fill={ink} stroke={edge} strokeWidth="0.9" />
        </>
      )}

      {kind === "generic" && (
        <>
          <rect x="28" y="82" width="34" height="38" fill={ink} stroke={edge} strokeWidth="0.9" />
          <path d="M28 94H62" stroke={edge} strokeWidth="0.8" />
        </>
      )}
    </svg>
  );
}
