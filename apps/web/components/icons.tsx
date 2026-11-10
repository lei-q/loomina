type IconProps = { className?: string };

/** 经线：片格里三根经线，中间一根是光。 */
export function Logomark({ className }: IconProps) {
  return (
    <svg viewBox="0 0 40 40" fill="none" className={className} aria-hidden="true">
      <rect x="7" y="3" width="26" height="34" rx="1" stroke="currentColor" strokeWidth="1.4" opacity=".5" />
      <path d="M14 3v34M26 3v34" stroke="currentColor" strokeWidth="1.4" opacity=".7" />
      <path d="M20 3v34" stroke="currentColor" strokeWidth="3" />
    </svg>
  );
}

const iconClass = "h-4 w-4";

export function RedoIcon({ className = iconClass }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4.5V11h-6.5" />
    </svg>
  );
}

export function CheckIcon({ className = iconClass }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4.5 12.5l4.8 4.8L19.5 7" />
    </svg>
  );
}

export function CrossIcon({ className = iconClass }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" className={className} aria-hidden="true">
      <path d="M7 7l10 10M17 7L7 17" />
    </svg>
  );
}

export function LockIcon({ className = iconClass }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="5" y="10.5" width="14" height="9.5" rx="1" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </svg>
  );
}

export function UnlockIcon({ className = iconClass }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="5" y="10.5" width="14" height="9.5" rx="1" />
      <path d="M8 10.5V8a4 4 0 0 1 7.5-2" />
    </svg>
  );
}

export function ExportIcon({ className = iconClass }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 4v11M8 8l4-4 4 4M5 15v4h14v-4" />
    </svg>
  );
}

export function PlayIcon({ className = iconClass }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8 5.5v13l10-6.5z" />
    </svg>
  );
}
