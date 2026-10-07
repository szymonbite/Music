import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeedItem, ReactionValue } from '../../shared/types.ts';
import { api } from '../api.ts';
import { FeedPlayer, hookStart, usePlayerValue, type PlayerSnapshot } from '../lib/feedPlayer.ts';
import { errorMessage, prefersReducedMotion } from '../lib/format.ts';
import { useSession } from '../session.tsx';
import { useToast } from '../toast.tsx';
import { CommentsSheet } from './CommentsSheet.tsx';
import { Icon } from './Icon.tsx';
import { Logo } from './Logo.tsx';
import { ShareSheet } from './ShareSheet.tsx';
import { SongCard } from './SongCard.tsx';

const selectStatus = (s: PlayerSnapshot) => s.status;
const selectMuted = (s: PlayerSnapshot) => s.muted;
const selectNeedsGesture = (s: PlayerSnapshot) => s.needsGesture;

const PAGE_SIZE = 8;

type SheetState = { kind: 'comments' | 'share'; item: FeedItem } | null;

/**
 * The vertical, snap-scrolling "For you" feed. Each card is one song; the
 * single shared YouTube player sits on whichever card is in view.
 */
export function Feed({ startWith }: { startWith: string | null }) {
  const { me } = useSession();
  const toast = useToast();
  const [player] = useState(() => new FeedPlayer());
  const [items, setItems] = useState<FeedItem[]>([]);
  const [active, setActive] = useState(0);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [exhausted, setExhausted] = useState(false);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [sheet, setSheet] = useState<SheetState>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const fetching = useRef(false);
  const itemsRef = useRef(items);
  const activeRef = useRef(active);
  const sheetOpenRef = useRef(false);
  useEffect(() => {
    itemsRef.current = items;
    activeRef.current = active;
    sheetOpenRef.current = sheet !== null;
  });

  const status = usePlayerValue(player, selectStatus);
  const muted = usePlayerValue(player, selectMuted);
  const needsGesture = usePlayerValue(player, selectNeedsGesture);

  const current = items[active];
  const currentId = current?.id ?? null;
  const currentDuration = current?.durationSec ?? null;
  const { skipIntro, autoAdvance } = me.settings;

  // One YouTube player for the whole feed.
  useEffect(() => {
    const host = hostRef.current;
    return host ? player.mount(host) : undefined;
  }, [player]);

  const fetchMore = useCallback(
    async (initial: boolean) => {
      if (fetching.current) return;
      fetching.current = true;
      try {
        const { items: next } = await api.feed({
          limit: PAGE_SIZE,
          exclude: itemsRef.current.map((i) => i.id),
          startWith: initial ? (startWith ?? undefined) : undefined,
        });
        setItems((prev) => {
          const known = new Set(prev.map((i) => i.id));
          return [...prev, ...next.filter((i) => !known.has(i.id))];
        });
        setExhausted(next.length === 0);
        setPhase('ready');
      } catch (err) {
        if (initial) setPhase('error');
        else toast(errorMessage(err), 'error');
      } finally {
        fetching.current = false;
      }
    },
    [startWith, toast],
  );

  useEffect(() => {
    void fetchMore(true);
  }, [fetchMore]);

  // Keep a few songs ready below the one playing.
  useEffect(() => {
    if (phase === 'ready' && !exhausted && items.length > 0 && active >= items.length - 3) void fetchMore(false);
  }, [active, items.length, phase, exhausted, fetchMore]);

  // When the song changes: tell the server how long the previous one played (listen vs. skip)...
  const reportedRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = reportedRef.current;
    if (previous && previous !== currentId) api.seen(previous, player.takeWatchedSeconds());
    reportedRef.current = currentId;
  }, [currentId, player]);

  // ...then start the new one, near its hook if the listener wants that.
  useEffect(() => {
    if (!currentId) return;
    const known = currentDuration !== null && currentDuration > 0;
    player.load(currentId, {
      startSeconds: skipIntro && known ? hookStart(currentDuration) : 0,
      seekToHook: skipIntro && !known,
    });
  }, [currentId, currentDuration, skipIntro, player]);

  // Report the last song when leaving the feed or closing the tab.
  useEffect(() => {
    const flush = () => {
      const id = reportedRef.current;
      if (id) api.seen(id, player.takeWatchedSeconds());
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [player]);

  // Which card is in view? Settle once scrolling stops (scroll-snap does the rest).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      const index = Math.round(el.scrollTop / (el.clientHeight || 1));
      setActive(Math.max(0, Math.min(index, itemsRef.current.length - 1)));
    };
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(settle, 90);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  const goTo = useCallback((index: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const target = Math.max(0, Math.min(index, itemsRef.current.length - 1));
    el.scrollTo({ top: target * el.clientHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, []);

  const patchItem = useCallback((id: string, patch: (item: FeedItem) => FeedItem) => {
    setItems((prev) => prev.map((i) => (i.id === id ? patch(i) : i)));
  }, []);

  useEffect(() => {
    player.setHandlers({
      onEnded: () => {
        if (autoAdvance) {
          goTo(activeRef.current + 1);
        } else {
          player.seek(0);
          player.play();
        }
      },
      onError: (videoId, code) => {
        api.unavailable(videoId, code);
        setFailed((prev) => new Set(prev).add(videoId));
        toast('This one can’t be played here, skipping');
        window.setTimeout(() => {
          if (itemsRef.current[activeRef.current]?.id === videoId) goTo(activeRef.current + 1);
        }, 1200);
      },
    });
  }, [player, autoAdvance, goTo, toast]);

  const react = useCallback(
    async (item: FeedItem, value: ReactionValue) => {
      const previous = item.me.reaction;
      if (previous === value) return;
      const likesDelta = (value === 1 ? 1 : 0) - (previous === 1 ? 1 : 0);
      patchItem(item.id, (i) => ({
        ...i,
        me: { ...i.me, reaction: value },
        stats: { ...i.stats, likes: Math.max(0, i.stats.likes + likesDelta) },
      }));
      if (value === -1 && itemsRef.current[activeRef.current]?.id === item.id) {
        toast('Got it, fewer songs like this');
        window.setTimeout(() => {
          if (itemsRef.current[activeRef.current]?.id === item.id) goTo(activeRef.current + 1);
        }, 500);
      }
      try {
        const res = await api.react(item.id, value);
        patchItem(item.id, (i) => ({ ...i, me: { ...i.me, reaction: res.reaction }, stats: res.stats }));
        if (res.youtube === 'error') toast('Couldn’t sync that to YouTube Music', 'error');
      } catch (err) {
        patchItem(item.id, (i) => ({
          ...i,
          me: { ...i.me, reaction: previous },
          stats: { ...i.stats, likes: Math.max(0, i.stats.likes - likesDelta) },
        }));
        toast(errorMessage(err), 'error');
      }
    },
    [goTo, patchItem, toast],
  );

  const toggleSave = useCallback(
    async (item: FeedItem) => {
      const saved = !item.me.saved;
      const delta = saved ? 1 : -1;
      patchItem(item.id, (i) => ({
        ...i,
        me: { ...i.me, saved },
        stats: { ...i.stats, saves: Math.max(0, i.stats.saves + delta) },
      }));
      try {
        const res = await api.save(item.id, saved);
        patchItem(item.id, (i) => ({ ...i, me: { ...i.me, saved: res.saved }, stats: res.stats }));
        if (res.youtube === 'error') toast('Saved here, but couldn’t sync to YouTube Music', 'error');
        else if (saved) toast(res.youtube === 'ok' ? 'Saved, and added to your YouTube Music playlist' : 'Saved to your library', 'success');
      } catch (err) {
        patchItem(item.id, (i) => ({
          ...i,
          me: { ...i.me, saved: !saved },
          stats: { ...i.stats, saves: Math.max(0, i.stats.saves - delta) },
        }));
        toast(errorMessage(err), 'error');
      }
    },
    [patchItem, toast],
  );

  const likeOnDoubleTap = useCallback(
    (item: FeedItem) => {
      if (item.me.reaction !== 1) void react(item, 1);
    },
    [react],
  );
  const togglePlay = useCallback(() => player.toggle(), [player]);
  const openComments = useCallback((item: FeedItem) => setSheet({ kind: 'comments', item }), []);
  const openShare = useCallback((item: FeedItem) => setSheet({ kind: 'share', item }), []);
  const closeSheet = useCallback(() => setSheet(null), []);
  const onReact = useCallback((item: FeedItem, value: ReactionValue) => void react(item, value), [react]);
  const onSave = useCallback((item: FeedItem) => void toggleSave(item), [toggleSave]);

  // Keyboard shortcuts for desktop.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (sheetOpenRef.current || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="slider"]')) return;
      const item = itemsRef.current[activeRef.current];
      switch (e.key) {
        case 'ArrowDown':
        case 'j':
          e.preventDefault();
          goTo(activeRef.current + 1);
          break;
        case 'ArrowUp':
        case 'k':
          e.preventDefault();
          goTo(activeRef.current - 1);
          break;
        case ' ':
          e.preventDefault();
          player.toggle();
          break;
        case 'l':
          if (item) void react(item, item.me.reaction === 1 ? 0 : 1);
          break;
        case 'd':
          if (item) void react(item, item.me.reaction === -1 ? 0 : -1);
          break;
        case 's':
          if (item) void toggleSave(item);
          break;
        case 'c':
          if (item) setSheet({ kind: 'comments', item });
          break;
        case 'm':
          player.setMuted(!player.getSnapshot().muted);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goTo, player, react, toggleSave]);

  const playerVisible = currentId !== null && !failed.has(currentId) && (status === 'playing' || status === 'paused');

  return (
    <div className="feed-wrap">
      <div className="feed" ref={scrollRef} aria-label="Songs for you" aria-busy={phase === 'loading'}>
        {items.map((item, index) => (
          <SongCard
            key={item.id}
            item={item}
            active={index === active}
            render={Math.abs(index - active) <= 2}
            player={player}
            failed={failed.has(item.id)}
            onTogglePlay={togglePlay}
            onDoubleTap={likeOnDoubleTap}
            onReact={onReact}
            onComments={openComments}
            onSave={onSave}
            onShare={openShare}
          />
        ))}
        <div className="player-layer" style={{ transform: `translateY(${active * 100}%)` }} aria-hidden="true">
          <div className="media-slot">
            <div ref={hostRef} className="player-host" data-visible={playerVisible} />
          </div>
        </div>
      </div>

      <header className="feed-top">
        <Logo size={26} withName />
        <button
          type="button"
          className="icon-btn icon-btn--glass"
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
          onClick={() => player.setMuted(!muted)}
        >
          <Icon name={muted ? 'volumeOff' : 'volume'} />
        </button>
      </header>

      {needsGesture && (
        <button type="button" className="unmute-pill" onClick={togglePlay}>
          <Icon name="volumeOff" size={18} /> Tap to unmute
        </button>
      )}

      {phase === 'loading' && (
        <div className="feed-status">
          <span className="spinner" aria-label="Loading songs" />
        </div>
      )}
      {phase === 'error' && (
        <div className="feed-status">
          <p>Couldn’t load your feed.</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              setPhase('loading');
              void fetchMore(true);
            }}
          >
            <Icon name="refresh" size={18} /> Try again
          </button>
        </div>
      )}
      {phase === 'ready' && items.length === 0 && (
        <div className="feed-status">
          <p>No songs to show right now. Add a few favourites to get started.</p>
        </div>
      )}

      <p className="feed-hints" aria-hidden="true">
        <kbd>↑</kbd>
        <kbd>↓</kbd> scroll · <kbd>Space</kbd> play · <kbd>L</kbd> like · <kbd>D</kbd> dislike · <kbd>S</kbd> save · <kbd>C</kbd> comments
      </p>

      {sheet?.kind === 'comments' && (
        <CommentsSheet
          song={sheet.item}
          onClose={closeSheet}
          onCountChange={(delta) =>
            patchItem(sheet.item.id, (i) => ({ ...i, stats: { ...i.stats, comments: Math.max(0, i.stats.comments + delta) } }))
          }
        />
      )}
      {sheet?.kind === 'share' && <ShareSheet song={sheet.item} onClose={closeSheet} />}
    </div>
  );
}
