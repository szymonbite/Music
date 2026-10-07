const PATHS = {
  heart: 'M12 20s-7-4.35-9-9.1C1.7 7.6 3.9 4 7.4 4c2 0 3.6 1.1 4.6 2.6C13 5.1 14.6 4 16.6 4c3.5 0 5.7 3.6 4.4 6.9C19 15.65 12 20 12 20z',
  thumbDown:
    'M16 4H7.3a2 2 0 0 0-1.96 1.6l-1.3 6.5A2 2 0 0 0 6 14.5h4.5l-.7 3.8a2 2 0 0 0 .6 1.8l.6.6L16 15V4zM16 4h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3',
  comment: 'M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12z',
  bookmark: 'M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.5L5 21V4.5a1 1 0 0 1 1-1z',
  share: 'M14 5l7 7-7 7M21 12H10a6 6 0 0 0-6 6v1',
  volume: 'M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  volumeOff: 'M4 9h4l5-4v14l-5-4H4zM17 9.5l5 5M22 9.5l-5 5',
  play: 'M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z',
  pause: 'M7 5h3v14H7zM14 5h3v14h-3z',
  home: 'M3 11l9-7 9 7M5 9.5V20h5v-6h4v6h5V9.5',
  library: 'M5 3.5h9a1 1 0 0 1 1 1V21l-5.5-3.5L4 21V4.5a1 1 0 0 1 1-1zM19 6.5V21',
  user: 'M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM3.5 21a8.5 8.5 0 0 1 17 0',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.5-4.5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6L6 18',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  logout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3',
  plus: 'M12 5v14M5 12h14',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  arrowLeft: 'M19 12H5M12 19l-7-7 7-7',
  arrowDown: 'M12 5v14M19 12l-7 7-7-7',
  refresh: 'M20 11a8 8 0 0 0-14.9-3.9M4 4v4h4M4 13a8 8 0 0 0 14.9 3.9M20 20v-4h-4',
  send: 'M4 12l16-8-6 16-3-7z',
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps {
  name: IconName;
  size?: number;
  filled?: boolean;
  className?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 24, filled = false, className, strokeWidth = 2 }: IconProps) {
  const solid = filled || name === 'play' || name === 'pause' || name === 'sparkle';
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
      fill={solid ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={solid && name !== 'heart' && name !== 'bookmark' && name !== 'thumbDown' ? 0 : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
