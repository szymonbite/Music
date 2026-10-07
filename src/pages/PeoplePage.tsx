import { useEffect, useState } from 'react';
import type { PublicUser } from '../../shared/types.ts';
import { api } from '../api.ts';
import { Avatar } from '../components/Avatar.tsx';
import { FollowButton } from '../components/FollowButton.tsx';
import { Icon } from '../components/Icon.tsx';
import { UserSheet } from '../components/UserSheet.tsx';
import { errorMessage } from '../lib/format.ts';
import { Link, useRouter } from '../router.tsx';

/** Find people on Earworm and follow them. */
export function PeoplePage() {
  const { navigate } = useRouter();
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<PublicUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openUser, setOpenUser] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .people(query.trim())
        .then((r) => {
          if (!cancelled) {
            setPeople(r.people);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(errorMessage(err));
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const updatePerson = (id: string, isFollowing: boolean, followers: number) =>
    setPeople((list) => list?.map((p) => (p.id === id ? { ...p, isFollowing, followers } : p)) ?? null);

  return (
    <main className="page people">
      <header className="people__header">
        <Link to="/me" className="icon-btn" aria-label="Back">
          <Icon name="arrowLeft" />
        </Link>
        <h1 className="page__title">People</h1>
      </header>
      <form className="searchbar" role="search" onSubmit={(e) => e.preventDefault()}>
        <Icon name="search" size={20} />
        <input
          type="search"
          className="searchbar__input"
          placeholder="Search by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search people"
        />
      </form>
      <p className="fineprint people__hint">Follow friends to see what they like and save in your Friends feed.</p>

      {error && <p className="notice notice--error">{error}</p>}
      {!people && !error && <span className="spinner comments__spinner" aria-label="Loading people" />}
      {people && people.length === 0 && (
        <div className="empty">
          <Icon name="user" size={40} />
          <p>{query.trim() ? 'Nobody by that name yet.' : 'You’re the first one here. Share the app with friends!'}</p>
        </div>
      )}
      {people && people.length > 0 && (
        <ul className="person-list">
          {people.map((person) => (
            <li key={person.id} className="person">
              <button type="button" className="person__main" onClick={() => setOpenUser(person.id)}>
                <Avatar id={person.id} name={person.displayName} url={person.avatarUrl} size={44} />
                <span className="person__text">
                  <span className="person__name">{person.displayName}</span>
                  <span className="person__meta">
                    {person.followers} {person.followers === 1 ? 'follower' : 'followers'}
                  </span>
                </span>
              </button>
              <FollowButton user={person} onChange={(following, followers) => updatePerson(person.id, following, followers)} />
            </li>
          ))}
        </ul>
      )}

      {openUser && (
        <UserSheet
          userId={openUser}
          onClose={() => setOpenUser(null)}
          onPlay={(songId) => navigate(`/?song=${encodeURIComponent(songId)}`)}
        />
      )}
    </main>
  );
}
