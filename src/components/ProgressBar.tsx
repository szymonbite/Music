import { useRef, useState, type PointerEvent } from 'react';
import { usePlayerValue, type FeedPlayer, type PlayerSnapshot } from '../lib/feedPlayer.ts';
import { formatTime } from '../lib/format.ts';
import { Icon } from './Icon.tsx';

const selectTime = (s: PlayerSnapshot) => s.currentTime;
const selectDuration = (s: PlayerSnapshot) => s.duration;
const selectPreviewStart = (s: PlayerSnapshot) => s.preview?.start ?? -1;
const selectPreviewEnd = (s: PlayerSnapshot) => s.preview?.end ?? -1;

/**
 * Song progress along the bottom of the active card. Drag or use arrow keys to
 * seek. In preview mode the highlight being played is marked on the track,
 * with a button to keep listening to the full song.
 */
export function ProgressBar({ player }: { player: FeedPlayer }) {
  const current = usePlayerValue(player, selectTime);
  const duration = usePlayerValue(player, selectDuration);
  const previewStart = usePlayerValue(player, selectPreviewStart);
  const previewEnd = usePlayerValue(player, selectPreviewEnd);
  const [scrub, setScrub] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const shown = scrub ?? current;
  const percent = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;
  const previewing = previewStart >= 0 && previewEnd > previewStart;
  const windowLeft = duration > 0 && previewing ? Math.min(100, (previewStart / duration) * 100) : 0;
  const windowWidth = duration > 0 && previewing ? Math.min(100 - windowLeft, ((previewEnd - previewStart) / duration) * 100) : 0;
  const previewLeft = previewing ? Math.max(0, Math.ceil(previewEnd - current)) : 0;

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
    player.seek(timeAt(e.clientX), { manual: true });
    setScrub(null);
  };

  return (
    <div className={`progress${scrub !== null ? ' progress--scrubbing' : ''}`} onClick={(e) => e.stopPropagation()}>
      <div className="progress__row">
        <span className="progress__time" aria-hidden="true">
          {formatTime(shown)} / {formatTime(duration)}
          {previewing && duration > 0 && <span className="progress__preview"> · preview {previewLeft}s</span>}
        </span>
        {previewing && (
          <button type="button" className="full-song" onClick={() => player.playFull()}>
            <Icon name="play" size={12} /> Full song
          </button>
        )}
      </div>
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
          player.seek(current + (e.key === 'ArrowRight' ? 5 : -5), { manual: true });
        }}
      >
        {previewing && <div className="progress__window" style={{ left: `${windowLeft}%`, width: `${windowWidth}%` }} />}
        <div className="progress__fill" style={{ width: `${percent}%` }} />
        <div className="progress__knob" style={{ left: `${percent}%` }} />
      </div>
    </div>
  );
}
