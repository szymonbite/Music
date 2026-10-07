import { useState, type CSSProperties } from 'react';
import { hueFor, initials } from '../lib/format.ts';

export function Avatar({ id, name, url, size = 36 }: { id: string; name: string; url: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <img
        className="avatar"
        src={url}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className="avatar avatar--initials"
      style={{ '--hue': hueFor(id), width: size, height: size, fontSize: Math.round(size * 0.4) } as CSSProperties}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
