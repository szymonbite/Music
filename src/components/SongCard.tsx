import { memo, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { FeedItem } from '../../shared/types.ts';
import { formatGenre, youtubeMusicUrl } from '../../shared/youtube.ts';
import { usePlayerValue, type FeedPlayer, type PlayerSnapshot } from '../lib/feedPlayer.ts';
import { ActionRail, type ActionHandlers } from './ActionRail.tsx';
import { Icon } from './Icon.tsx';
import { ProgressBar } from './ProgressBar.tsx';
import { Thumb } from './Thumb.tsx';

const selectStatus = (s: PlayerSnapshot) => s.status;
const selectApiFailed = (s: PlayerSnapshot) => s.apiFailed;

interface SongCardProps extends ActionHandlers {
  item: FeedItem;
  active: boolean;
  /** Render full content (only cards near the active one, to keep the DOM light). */
  render: boolean;
  player: FeedPlayer;
  failed: boolean;
  onTogglePlay: () => void;
  onDoubleTap: (item: FeedItem) => void;
}

/** CSS url() value for an artwork URL we got from our own API. */
function cssUrl(url: string): string {
  return /^https:\/\//.test(url) ? `url("${url.replace(/["\\\n\r]/g, '')}")` : 'none';
}

/** Status shown over the active card: paused icon, buffering spinner, or a player problem. */
function PlaybackOverlay({ player, item, failed }: { player: FeedPlayer; item: FeedItem; failed: boolean }) {
  const status = usePlayerValue(player, selectStatus);
  const apiFailed = usePlayerValue(player, selectApiFailed);

  if (apiFailed || failed) {
    return (
      <div className="card__notice">
        <p>{failed ? 'This video can’t be played here.' : 'The YouTube player couldn’t load.'}</p>
        <a className="btn btn--small" href={youtubeMusicUrl(item.id)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          Open in YouTube Music <Icon name="external" size={16} />
        </a>
      </div>
    );
  }
  if (status === 'paused') {
    return (
      <span className="card__paused" aria-hidden="true">
        <Icon name="play" size={64} />
      </span>
    );
  }
  if (status === 'buffering') return <span className="spinner card__spinner" aria-hidden="true" />;
  return null;
}

function SongCardInner(props: SongCardProps) {
  const { item, active, render, player, failed, onTogglePlay, onDoubleTap, ...handlers } = props;
  const [hearts, setHearts] = useState<{ id: number; x: number; y: number }[]>([]);
  const lastTap = useRef(0);
  const singleTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (singleTapTimer.current) clearTimeout(singleTapTimer.current);
    },
    [],
  );

  if (!render) return <section className="card card--placeholder" aria-hidden="true" />;

  // Single tap toggles playback; double tap likes (with a heart burst), like TikTok.
  const onTap = (e: MouseEvent<HTMLButtonElement>) => {
    if (e.detail === 0) {
      // Keyboard activation: no double-tap detection needed.
      if (active) onTogglePlay();
      return;
    }
    const now = Date.now();
    if (now - lastTap.current < 300) {
      if (singleTapTimer.current) clearTimeout(singleTapTimer.current);
      singleTapTimer.current = null;
      lastTap.current = 0;
      const rect = e.currentTarget.getBoundingClientRect();
      const heart = { id: now, x: e.clientX - rect.left, y: e.clientY - rect.top };
      setHearts((current) => [...current, heart]);
      window.setTimeout(() => setHearts((current) => current.filter((h) => h.id !== heart.id)), 900);
      onDoubleTap(item);
      return;
    }
    lastTap.current = now;
    singleTapTimer.current = setTimeout(() => {
      singleTapTimer.current = null;
      if (active) onTogglePlay();
    }, 280);
  };

  return (
    <section
      className={`card${active ? ' card--active' : ''}`}
      aria-label={`${item.title} by ${item.artist}`}
      data-song-id={item.id}
      data-active={active || undefined}
    >
      <div className="card__bg" style={{ backgroundImage: cssUrl(item.thumbnailUrl) }} aria-hidden="true" />
      <div className="card__shade" aria-hidden="true" />
      <div className="media-slot card__media" aria-hidden="true">
        <Thumb song={item} className="card__thumb" />
      </div>

      <div className="card__ui">
        <button type="button" className="card__tap" aria-label={active ? 'Play or pause' : `Play ${item.title}`} onClick={onTap} />
        {hearts.map((h) => (
          <span key={h.id} className="burst" style={{ left: h.x, top: h.y }} aria-hidden="true">
            <Icon name="heart" size={96} filled />
          </span>
        ))}
        {active && <PlaybackOverlay player={player} item={item} failed={failed} />}

        <div className="card__info">
          {item.reason && (
            <p className="card__reason">
              <Icon name="sparkle" size={14} /> {item.reason}
            </p>
          )}
          <h2 className="card__title">{item.title}</h2>
          <p className="card__artist">
            {item.artist}
            {item.year ? <span className="card__year"> · {item.year}</span> : null}
          </p>
          {item.genres.length > 0 && (
            <ul className="card__chips" aria-label="Genres">
              {item.genres.slice(0, 3).map((g) => (
                <li key={g} className="chip chip--glass">
                  #{formatGenre(g)}
                </li>
              ))}
            </ul>
          )}
        </div>

        <ActionRail item={item} {...handlers} />
        {active && <ProgressBar player={player} />}
      </div>
    </section>
  );
}

export const SongCard = memo(SongCardInner);
