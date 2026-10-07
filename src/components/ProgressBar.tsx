import { useRef, useState, type PointerEvent } from 'react';
import { usePlayerValue, type FeedPlayer, type PlayerSnapshot } from '../lib/feedPlayer.ts';
import { formatTime } from '../lib/format.ts';

const selectTime = (s: PlayerSnapshot) => s.currentTime;
const selectDuration = (s: PlayerSnapshot) => s.duration;

/** Song progress along the bottom of the active card. Drag or use arrow keys to seek. */
export function ProgressBar({ player }: { player: FeedPlayer }) {
  const current = usePlayerValue(player, selectTime);
  const duration = usePlayerValue(player, selectDuration);
  const [scrub, setScrub] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const shown = scrub ?? current;
  const percent = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;

  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setScrub(timeAt(e.clientX));
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (scrub === null) return;
    player.seek(timeAt(e.clientX));
    setScrub(null);
  };

  return (
    <div className={`progress${scrub !== null ? ' progress--scrubbing' : ''}`} onClick={(e) => e.stopPropagation()}>
      <span className="progress__time" aria-hidden="true">
        {formatTime(shown)} / {formatTime(duration)}
      </span>
      <div
        ref={trackRef}
        className="progress__track"
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={`${formatTime(shown)} of ${formatTime(duration)}`}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => {
          if (scrub !== null) setScrub(timeAt(e.clientX));
        }}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setScrub(null)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          e.preventDefault();
          e.stopPropagation();
          player.seek(current + (e.key === 'ArrowRight' ? 5 : -5));
        }}
      >
        <div className="progress__fill" style={{ width: `${percent}%` }} />
        <div className="progress__knob" style={{ left: `${percent}%` }} />
      </div>
    </div>
  );
}
