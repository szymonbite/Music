import { useEffect, useState } from 'react';
import type { Song, UserProfile } from '../../shared/types.ts';
import { api } from '../api.ts';
import { errorMessage } from '../lib/format.ts';
import { Avatar } from './Avatar.tsx';
import { FollowButton } from './FollowButton.tsx';
import { Sheet } from './Sheet.tsx';
import { Thumb } from './Thumb.tsx';

function SongList({ title, songs, onPlay }: { title: string; songs: Song[]; onPlay: (songId: string) => void }) {
  if (!songs.length) return null;
  return (
    <section className="user-sheet__section">
      <h3>{title}</h3>
      <ul className="mini-songs">
        {songs.map((song) => (
          <li key={song.id}>
            <button type="button" className="mini-song" onClick={() => onPlay(song.id)} aria-label={`Play ${song.title} by ${song.artist}`}>
              <Thumb song={song} className="mini-song__thumb" square />
              <span className="mini-song__text">
                <span className="mini-song__title">{song.title}</span>
                <span className="mini-song__artist">{song.artist}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Another listener's profile: follow them and see what they've been liking and saving. */
export function UserSheet({ userId, onClose, onPlay }: { userId: string; onClose: () => void; onPlay: (songId: string) => void }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .user(userId)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const user = profile?.user;
  return (
    <Sheet title={user?.displayName ?? 'Profile'} onClose={onClose} className="user-sheet">
      <div className="user-sheet__body">
        {error && <p className="notice notice--error">{error}</p>}
        {!profile && !error && <span className="spinner comments__spinner" aria-label="Loading profile" />}
        {user && profile && (
          <>
            <div className="user-sheet__header">
              <Avatar id={user.id} name={user.displayName} url={user.avatarUrl} size={64} />
              <div className="user-sheet__who">
                <strong>{user.displayName}</strong>
                <span className="muted">
                  {user.followers} {user.followers === 1 ? 'follower' : 'followers'} · {user.following} following
                </span>
              </div>
              <FollowButton
                user={user}
                onChange={(isFollowing, followers) => setProfile((p) => (p ? { ...p, user: { ...p.user, isFollowing, followers } } : p))}
              />
            </div>
            {profile.activity ? (
              profile.activity.saved.length || profile.activity.liked.length ? (
                <>
                  <SongList title="Recently saved" songs={profile.activity.saved} onPlay={onPlay} />
                  <SongList title="Recently liked" songs={profile.activity.liked} onPlay={onPlay} />
                </>
              ) : (
                <p className="muted user-sheet__empty">Nothing liked or saved yet.</p>
              )
            ) : (
              <p className="muted user-sheet__empty">{user.displayName} keeps their likes and saves private.</p>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
