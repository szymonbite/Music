import { useId } from 'react';

export function Logo({ size = 28, withName = false }: { size?: number; withName?: boolean }) {
  const gradientId = useId();
  return (
    <span className="logo">
      <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff3d71" />
            <stop offset="1" stopColor="#7c5cff" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="16" fill={`url(#${gradientId})`} />
        <path d="M12 36c4-10 8-10 12 0s8 10 12 0 8-10 12 0" fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" />
        <circle cx="50" cy="22" r="4" fill="#fff" />
      </svg>
      {withName && <span className="logo__name">Earworm</span>}
    </span>
  );
}
