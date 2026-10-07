import { useEffect, useState } from 'react';
import type { LibraryItem, LibraryKind } from '../../shared/types.ts';
import { youtubeMusicUrl } from '../../shared/youtube.ts';
import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { Thumb } from '../components/Thumb.tsx';
import { errorMessage, timeAgo } from '../lib/format.ts';
import { Link } from '../router.tsx';
import { useSession } from '../session.tsx';
import { useToast } from '../toast.tsx';

const TABS: { kind: LibraryKind; label: string; empty: string; remove: string }[] = [
  { kind: 'saved', label: 'Saved', empty: 'Tap the bookmark on a song to save it here.', remove: 'Unsave' },
  { kind: 'liked', label: 'Liked', empty: 'Songs you like show up here.', remove: 'Remove like' },
  { kind: 'favorites', label: 'Favourites', empty: 'Your favourite songs shape your feed. Pick a few!', remove: 'Remove from favourites' },
  {
    kind: 'disliked',
    label: 'Disliked',
    empty: 'Songs you dislike are hidden from your feed. Changed your mind? They’ll be here.',
    remove: 'Remove dislike',
  },
];

export function LibraryPage() {
  const { me } = useSession();
  const toast = useToast();
  const [kind, setKind] = useState<LibraryKind>('saved');
  const [lists, setLists] = useState<Partial<Record<LibraryKind, LibraryItem[]>>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .library(kind)
      .then((r) => {
        if (!cancelled) setLists((current) => ({ ...current, [kind]: r.items }));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  const remove = async (item: LibraryItem) => {
    const before = lists[kind];
    setLists((current) => ({ ...current, [kind]: current[kind]?.filter((i) => i.id !== item.id) }));
    try {
      if (kind === 'saved') await api.save(item.id, false);
      else if (kind === 'favorites') await api.setFavorite(item.id, false);
      else await api.react(item.id, 0);
    } catch (err) {
      setLists((current) => ({ ...current, [kind]: before }));
      toast(errorMessage(err), 'error');
    }
  };

  const tab = TABS.find((t) => t.kind === kind)!;
  const items = lists[kind];

  return (
    <main className="page library">
      <h1 className="page__title">Library</h1>
      <div className="segmented" role="tablist" aria-label="Library sections">
        {TABS.map((t) => (
          <button
            key={t.kind}
            type="button"
            role="tab"
            id={`tab-${t.kind}`}
            aria-selected={kind === t.kind}
            aria-controls="library-panel"
            className="segmented__item"
            onClick={() => {
              setKind(t.kind);
              setError(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id="library-panel" role="tabpanel" aria-labelledby={`tab-${kind}`}>
        {kind === 'saved' && me.youtube?.playlistUrl && (
          <a className="notice library__playlist" href={me.youtube.playlistUrl} target="_blank" rel="noreferrer">
            <Icon name="music" size={18} /> Also in your “Earworm saves” playlist on YouTube Music <Icon name="external" size={14} />
          </a>
        )}
        {error ? (
          <p className="notice notice--error">{error}</p>
        ) : !items ? (
          <div className="song-list" aria-busy="true">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="song-row song-row--skeleton" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="empty">
            <Icon name={kind === 'disliked' ? 'thumbDown' : kind === 'liked' ? 'heart' : 'bookmark'} size={40} />
            <p>{tab.empty}</p>
            {kind === 'favorites' ? (
              <Link to="/pick" className="btn btn--primary">
                Pick favourites
              </Link>
            ) : (
              <Link to="/" className="btn">
                Start scrolling
              </Link>
            )}
          </div>
        ) : (
          <ul className="song-list">
            {items.map((item) => (
              <li key={item.id} className="song-row">
                <Link to={`/?song=${item.id}`} className="song-row__main" aria-label={`Play ${item.title} by ${item.artist}`}>
                  <Thumb song={item} className="song-row__thumb" square />
                  <span className="song-row__text">
                    <span className="song-row__title">{item.title}</span>
                    <span className="song-row__artist">
                      {item.artist} · {timeAgo(item.addedAt)}
                    </span>
                  </span>
                </Link>
                <a className="icon-btn" href={youtubeMusicUrl(item.id)} target="_blank" rel="noreferrer" aria-label={`Open ${item.title} in YouTube Music`}>
                  <Icon name="external" size={20} />
                </a>
                <button type="button" className="icon-btn" aria-label={`${tab.remove}: ${item.title}`} onClick={() => void remove(item)}>
                  <Icon name="close" size={20} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {kind === 'favorites' && items && items.length > 0 && (
          <Link to="/pick" className="btn btn--block library__edit">
            Edit favourites
          </Link>
        )}
      </div>
    </main>
  );
}
