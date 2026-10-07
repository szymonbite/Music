import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { GenreCount, SearchResponse, Song, YouTubeLibrary, YouTubePlaylist } from '../../shared/types.ts';
import { formatGenre, parseYouTubeRef } from '../../shared/youtube.ts';
import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { SongTile } from '../components/SongTile.tsx';
import { Thumb } from '../components/Thumb.tsx';
import { errorMessage } from '../lib/format.ts';
import { Link, useRouter } from '../router.tsx';
import { useSession } from '../session.tsx';
import { useToast } from '../toast.tsx';

const MIN_FAVORITES = 3;
const LIKED_PREVIEW = 24;

type PlaylistState = { id: string; title: string; songs: Song[] | null };

function TileGrid({ songs, selected, onToggle }: { songs: Song[]; selected: Map<string, Song>; onToggle: (song: Song) => void }) {
  return (
    <div className="tile-grid">
      {songs.map((song) => (
        <SongTile key={song.id} song={song} selected={selected.has(song.id)} onToggle={onToggle} />
      ))}
    </div>
  );
}

function TileSkeletons() {
  return (
    <div className="tile-grid" aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className="tile tile--skeleton" />
      ))}
    </div>
  );
}

/** Choose favourite songs: from YouTube Music, search, pasted links, or popular picks by genre. */
export function PickPage() {
  const { me, features, update } = useSession();
  const { navigate } = useRouter();
  const toast = useToast();

  const [selected, setSelected] = useState<Map<string, Song>>(() => new Map());
  const [genres, setGenres] = useState<GenreCount[]>([]);
  const [genre, setGenre] = useState<string | null>(null);
  const [starter, setStarter] = useState<Song[] | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [remoteSearching, setRemoteSearching] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [ytLibrary, setYtLibrary] = useState<YouTubeLibrary | null>(null);
  const [ytError, setYtError] = useState<string | null>(null);
  const [showAllLiked, setShowAllLiked] = useState(false);
  const [playlist, setPlaylist] = useState<PlaylistState | null>(null);
  const [saving, setSaving] = useState(false);

  const ytConnected = me.youtube !== null;
  const canSearchYouTube = features.youtubeSearch || ytConnected;

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.favorites(), api.genres()])
      .then(([favorites, genreList]) => {
        if (cancelled) return;
        setSelected(new Map(favorites.songs.map((s) => [s.id, s])));
        setGenres(genreList.genres.slice(0, 16));
      })
      .catch((err: unknown) => {
        if (!cancelled) toast(errorMessage(err), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    api
      .starter(genre)
      .then((r) => {
        if (!cancelled) setStarter(r.songs);
      })
      .catch((err: unknown) => {
        if (!cancelled) toast(errorMessage(err), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [genre, toast]);

  useEffect(() => {
    if (!ytConnected) return;
    let cancelled = false;
    api
      .youtubeLibrary()
      .then((library) => {
        if (!cancelled) setYtLibrary(library);
      })
      .catch((err: unknown) => {
        if (!cancelled) setYtError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [ytConnected]);

  // Search songs we already know as you type.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || parseYouTubeRef(q)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .search(q, false)
        .then((r) => {
          if (!cancelled) setResults(r);
        })
        .catch(() => {});
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const toggle = useCallback((song: Song) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(song.id)) next.delete(song.id);
      else next.set(song.id, song);
      return next;
    });
  }, []);

  const addSongs = (songs: Song[]) => {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const song of songs) next.set(song.id, song);
      return next;
    });
  };

  const searchYouTube = async () => {
    const q = query.trim();
    if (!q) return;
    setRemoteSearching(true);
    try {
      const r = await api.search(q, true);
      setResults(r);
      if (r.remoteError) toast(r.remoteError, 'error');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setRemoteSearching(false);
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    const ref = parseYouTubeRef(q);
    if (!ref) {
      if (canSearchYouTube) await searchYouTube();
      return;
    }
    setResolving(true);
    try {
      const res = await api.resolve(q);
      if (ref.type === 'video') {
        addSongs(res.songs);
        if (res.songs[0]) toast(`Added “${res.songs[0].title}”`, 'success');
      } else {
        setPlaylist({ id: ref.id, title: res.playlistTitle ?? 'Playlist', songs: res.songs });
        toast(`Loaded ${res.songs.length} songs. Tap the ones you love.`);
      }
      setQuery('');
      setResults(null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setResolving(false);
    }
  };

  const openPlaylist = async (p: YouTubePlaylist) => {
    setPlaylist({ id: p.id, title: p.title, songs: null });
    try {
      const r = await api.youtubePlaylist(p.id);
      setPlaylist((current) => (current?.id === p.id ? { ...current, songs: r.songs } : current));
    } catch (err) {
      toast(errorMessage(err), 'error');
      setPlaylist(null);
    }
  };

  const finish = async () => {
    setSaving(true);
    try {
      await api.setFavorites([...selected.keys()]);
      if (!me.onboarded) await update({ onboarded: true });
      if (me.onboarded) toast('Favourites saved', 'success');
      navigate(me.onboarded ? '/me' : '/');
    } catch (err) {
      toast(errorMessage(err), 'error');
      setSaving(false);
    }
  };

  const skip = async () => {
    try {
      await update({ onboarded: true });
      navigate('/');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const minimum = me.onboarded ? 0 : MIN_FAVORITES;
  const remaining = Math.max(0, minimum - selected.size);
  const selectedList = [...selected.values()];
  const liked = ytLibrary?.liked ?? [];

  return (
    <main className="pick">
      <header className="pick__header">
        {me.onboarded && (
          <Link to="/me" className="icon-btn" aria-label="Back">
            <Icon name="arrowLeft" />
          </Link>
        )}
        <div className="pick__heading">
          <h1>{me.onboarded ? 'Your favourite songs' : 'Pick songs you love'}</h1>
          <p className="muted">
            {me.onboarded ? 'Your feed is built around these. Tap to add or remove.' : 'Choose at least 3 and we’ll find more like them.'}
          </p>
        </div>
        {!me.onboarded && (
          <button type="button" className="btn btn--ghost btn--small" onClick={() => void skip()}>
            Skip
          </button>
        )}
      </header>

      <form className="searchbar" role="search" onSubmit={(e) => void onSubmit(e)}>
        <Icon name="search" size={20} />
        <input
          type="search"
          className="searchbar__input"
          placeholder="Search songs or paste a YouTube Music link"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value.trim()) setResults(null);
          }}
          aria-label="Search songs or paste a link"
          enterKeyHint="search"
        />
        {(resolving || remoteSearching) && <span className="spinner spinner--small" aria-label="Searching" />}
      </form>

      {results && query.trim() && (
        <section className="pick__section" aria-label="Search results">
          <h2>Results</h2>
          {results.local.length > 0 ? (
            <TileGrid songs={results.local} selected={selected} onToggle={toggle} />
          ) : (
            <p className="muted">No matches among the songs Earworm knows yet.</p>
          )}
          {results.remote.length > 0 && (
            <>
              <h3>From YouTube</h3>
              <TileGrid songs={results.remote} selected={selected} onToggle={toggle} />
            </>
          )}
          {canSearchYouTube && results.remote.length === 0 && (
            <button type="button" className="btn btn--small" disabled={remoteSearching} onClick={() => void searchYouTube()}>
              <Icon name="search" size={16} /> Search YouTube for “{query.trim()}”
            </button>
          )}
          {!canSearchYouTube && <p className="fineprint">Can’t find it? Paste a YouTube or YouTube Music link to add any song.</p>}
        </section>
      )}

      {me.onboarded && selectedList.length > 0 && (
        <section className="pick__section">
          <h2>Your picks</h2>
          <TileGrid songs={selectedList} selected={selected} onToggle={toggle} />
        </section>
      )}

      {playlist && (
        <section className="pick__section">
          <div className="pick__section-head">
            <h2>{playlist.title}</h2>
            {playlist.songs && playlist.songs.length > 0 && (
              <button type="button" className="btn btn--small btn--ghost" onClick={() => addSongs(playlist.songs ?? [])}>
                Select all
              </button>
            )}
            <button type="button" className="icon-btn" aria-label="Close playlist" onClick={() => setPlaylist(null)}>
              <Icon name="close" size={20} />
            </button>
          </div>
          {playlist.songs === null ? (
            <TileSkeletons />
          ) : playlist.songs.length > 0 ? (
            <TileGrid songs={playlist.songs} selected={selected} onToggle={toggle} />
          ) : (
            <p className="muted">No playable songs in this playlist.</p>
          )}
        </section>
      )}

      {ytConnected && (
        <section className="pick__section">
          <h2>From your YouTube Music</h2>
          {ytError && <p className="notice notice--error">{ytError}</p>}
          {!ytLibrary && !ytError && <TileSkeletons />}
          {ytLibrary && (
            <>
              {ytLibrary.playlists.length > 0 && (
                <div className="chips-row" role="group" aria-label="Your playlists">
                  {ytLibrary.playlists.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`chip${playlist?.id === p.id ? ' chip--active' : ''}`}
                      onClick={() => void openPlaylist(p)}
                    >
                      {p.title} <span className="chip__count">{p.itemCount}</span>
                    </button>
                  ))}
                </div>
              )}
              <h3>Liked songs</h3>
              {liked.length > 0 ? (
                <>
                  <TileGrid songs={showAllLiked ? liked : liked.slice(0, LIKED_PREVIEW)} selected={selected} onToggle={toggle} />
                  {liked.length > LIKED_PREVIEW && !showAllLiked && (
                    <button type="button" className="btn btn--small btn--ghost" onClick={() => setShowAllLiked(true)}>
                      Show all {liked.length} liked songs
                    </button>
                  )}
                </>
              ) : (
                <p className="muted">No liked songs yet. Songs you like in YouTube Music show up here.</p>
              )}
            </>
          )}
        </section>
      )}

      <section className="pick__section">
        <h2>{ytConnected ? 'Or start from popular songs' : 'Popular songs'}</h2>
        <div className="chips-row" role="group" aria-label="Filter by genre">
          <button
            type="button"
            className={`chip${genre === null ? ' chip--active' : ''}`}
            aria-pressed={genre === null}
            onClick={() => {
              setGenre(null);
              setStarter(null);
            }}
          >
            All
          </button>
          {genres.map((g) => (
            <button
              key={g.genre}
              type="button"
              className={`chip${genre === g.genre ? ' chip--active' : ''}`}
              aria-pressed={genre === g.genre}
              onClick={() => {
                setGenre(g.genre);
                setStarter(null);
              }}
            >
              {formatGenre(g.genre)}
            </button>
          ))}
        </div>
        {starter ? <TileGrid songs={starter} selected={selected} onToggle={toggle} /> : <TileSkeletons />}
      </section>

      <footer className="pick__bar">
        <div className="pick__selected" aria-live="polite">
          <span className="pick__minis" aria-hidden="true">
            {selectedList.slice(-4).map((s) => (
              <Thumb key={s.id} song={s} className="pick__mini" square />
            ))}
          </span>
          <span>
            <strong>{selected.size}</strong> selected
            {remaining > 0 && <span className="muted"> · {remaining} more to go</span>}
          </span>
        </div>
        <button type="button" className="btn btn--primary" disabled={saving || remaining > 0} onClick={() => void finish()}>
          {me.onboarded ? 'Save' : 'Start scrolling'}
        </button>
      </footer>
    </main>
  );
}
