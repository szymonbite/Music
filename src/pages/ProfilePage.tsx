import { useEffect, useState, type FormEvent } from 'react';
import type { UserSettings } from '../../shared/types.ts';
import { api, connectYouTubeUrl } from '../api.ts';
import { Avatar } from '../components/Avatar.tsx';
import { Icon } from '../components/Icon.tsx';
import { Switch } from '../components/Switch.tsx';
import { errorMessage } from '../lib/format.ts';
import { Link } from '../router.tsx';
import { useSession } from '../session.tsx';
import { useToast } from '../toast.tsx';

const REGIONS: [string, string][] = [
  ['AR', 'Argentina'], ['AU', 'Australia'], ['BR', 'Brazil'], ['CA', 'Canada'], ['CL', 'Chile'], ['CO', 'Colombia'],
  ['CZ', 'Czechia'], ['DK', 'Denmark'], ['FI', 'Finland'], ['FR', 'France'], ['DE', 'Germany'], ['IN', 'India'],
  ['ID', 'Indonesia'], ['IE', 'Ireland'], ['IT', 'Italy'], ['JP', 'Japan'], ['MX', 'Mexico'], ['NL', 'Netherlands'],
  ['NZ', 'New Zealand'], ['NG', 'Nigeria'], ['NO', 'Norway'], ['PH', 'Philippines'], ['PL', 'Poland'], ['PT', 'Portugal'],
  ['ZA', 'South Africa'], ['KR', 'South Korea'], ['ES', 'Spain'], ['SE', 'Sweden'], ['TR', 'Turkey'], ['UA', 'Ukraine'],
  ['GB', 'United Kingdom'], ['US', 'United States'],
];

const SHORTCUTS: [string, string][] = [
  ['↑ / ↓', 'Previous / next song'],
  ['Space', 'Play or pause'],
  ['L', 'Like'],
  ['D', 'Dislike'],
  ['S', 'Save'],
  ['C', 'Comments'],
  ['M', 'Mute'],
];

export function ProfilePage() {
  const { me, features, update, replace, refresh } = useSession();
  const toast = useToast();
  const [name, setName] = useState(me.displayName);
  const [busy, setBusy] = useState(false);

  // Pick up fresh counts (likes, saves...) whenever the profile opens.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveName = async (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === me.displayName) {
      setName(me.displayName);
      return;
    }
    try {
      await update({ displayName: trimmed });
      toast('Name updated', 'success');
    } catch (err) {
      setName(me.displayName);
      toast(errorMessage(err), 'error');
    }
  };

  const setSetting = async (patch: Partial<UserSettings>) => {
    try {
      await update({ settings: patch });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect YouTube Music? Your likes, saves and comments in Earworm stay.')) return;
    setBusy(true);
    try {
      replace(await api.disconnectYouTube());
      toast('YouTube Music disconnected');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    const message = me.youtube
      ? 'Sign out? Connect the same YouTube Music account to get back in.'
      : 'Start over? You haven’t connected an account, so your likes, saves and comments can’t be recovered.';
    if (!window.confirm(message)) return;
    try {
      await api.logout();
      window.location.assign('/');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const regions = REGIONS.some(([code]) => code === me.settings.region)
    ? REGIONS
    : [...REGIONS, [me.settings.region, me.settings.region] as [string, string]];

  return (
    <main className="page profile">
      <section className="profile__header">
        <Avatar id={me.id} name={me.displayName} url={me.avatarUrl} size={84} />
        <form onSubmit={(e) => void saveName(e)}>
          <label className="visually-hidden" htmlFor="display-name">
            Display name
          </label>
          <input
            id="display-name"
            className="profile__name"
            value={name}
            maxLength={30}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveName()}
          />
        </form>
        <dl className="stats">
          <div>
            <dt>Followers</dt>
            <dd>{me.counts.followers}</dd>
          </div>
          <div>
            <dt>Following</dt>
            <dd>{me.counts.following}</dd>
          </div>
          <div>
            <dt>Likes</dt>
            <dd>{me.counts.likes}</dd>
          </div>
          <div>
            <dt>Saves</dt>
            <dd>{me.counts.saves}</dd>
          </div>
          <div>
            <dt>Favourites</dt>
            <dd>{me.counts.favorites}</dd>
          </div>
          <div>
            <dt>Comments</dt>
            <dd>{me.counts.comments}</dd>
          </div>
        </dl>
        <div className="profile__actions">
          <Link to="/people" className="btn btn--small btn--primary">
            <Icon name="user" size={16} /> Find people
          </Link>
          <Link to="/pick" className="btn btn--small">
            <Icon name="heart" size={16} /> Edit favourite songs
          </Link>
        </div>
      </section>

      <section className="card-section" aria-labelledby="yt-heading">
        <h2 id="yt-heading">YouTube Music</h2>
        {me.youtube ? (
          <>
            <div className="yt-account">
              <Avatar id={`${me.id}-yt`} name={me.youtube.name ?? me.displayName} url={me.youtube.pictureUrl} size={40} />
              <div>
                <strong>{me.youtube.name ?? 'Connected'}</strong>
                {me.youtube.email && <span className="muted">{me.youtube.email}</span>}
              </div>
            </div>
            <Switch
              label="Sync likes & dislikes"
              description="Rate songs on YouTube Music when you like or dislike them here."
              checked={me.settings.syncReactions}
              onChange={(v) => void setSetting({ syncReactions: v })}
            />
            <Switch
              label="Save to a YouTube Music playlist"
              description="Saved songs are added to a private “Earworm saves” playlist."
              checked={me.settings.syncSaves}
              onChange={(v) => void setSetting({ syncSaves: v })}
            />
            {me.youtube.playlistUrl && (
              <a className="link" href={me.youtube.playlistUrl} target="_blank" rel="noreferrer">
                Open “Earworm saves” <Icon name="external" size={14} />
              </a>
            )}
            <button type="button" className="btn btn--ghost btn--small" disabled={busy} onClick={() => void disconnect()}>
              Disconnect YouTube Music
            </button>
          </>
        ) : features.youtubeLogin ? (
          <>
            {me.youtubeExpired ? (
              <p className="notice notice--error">
                Your YouTube Music connection expired, so likes and saves aren’t syncing. Reconnect to pick up where you left off.
              </p>
            ) : (
              <p className="muted">Import your liked songs and playlists, and keep likes and saves in sync with YouTube Music.</p>
            )}
            <a className="btn btn--youtube" href={connectYouTubeUrl('/me')}>
              <Icon name="music" size={20} /> {me.youtubeExpired ? 'Reconnect YouTube Music' : 'Connect YouTube Music'}
            </a>
          </>
        ) : (
          <p className="muted">
            Not set up on this server yet. Whoever runs Earworm needs to add Google OAuth credentials (see the README).
          </p>
        )}
      </section>

      <section className="card-section" aria-labelledby="playback-heading">
        <h2 id="playback-heading">Playback</h2>
        <Switch
          label="Hook previews"
          description="Play a 30 second highlight of each song. Tap “Full song” to keep listening."
          checked={me.settings.previewMode}
          onChange={(v) => void setSetting({ previewMode: v })}
        />
        <Switch
          label="Skip intros"
          description="Start songs about a quarter of the way in, closer to the hook."
          checked={me.settings.skipIntro}
          onChange={(v) => void setSetting({ skipIntro: v })}
        />
        <Switch
          label="Autoplay next song"
          description="Scroll to the next song when one ends. Off: songs loop."
          checked={me.settings.autoAdvance}
          onChange={(v) => void setSetting({ autoAdvance: v })}
        />
        {(features.youtubeSearch || me.youtube) && (
          <label className="field field--inline">
            <span className="field__label">Trending charts from</span>
            <select className="input" value={me.settings.region} onChange={(e) => void setSetting({ region: e.target.value })}>
              {regions.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      <section className="card-section" aria-labelledby="privacy-heading">
        <h2 id="privacy-heading">Privacy</h2>
        <Switch
          label="Show my likes & saves to followers"
          description="They appear on your profile and in your followers’ Friends feed."
          checked={me.settings.shareActivity}
          onChange={(v) => void setSetting({ shareActivity: v })}
        />
      </section>

      <section className="card-section shortcuts-section" aria-labelledby="keys-heading">
        <h2 id="keys-heading">Keyboard shortcuts</h2>
        <dl className="shortcuts">
          {SHORTCUTS.map(([keys, action]) => (
            <div key={keys} className="shortcuts__row">
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="profile__footer">
        <button type="button" className="btn btn--ghost btn--block btn--danger" onClick={() => void signOut()}>
          <Icon name="logout" size={18} /> {me.youtube ? 'Sign out' : 'Start over'}
        </button>
        <p className="fineprint">Songs play through the official YouTube player. Earworm isn’t affiliated with YouTube or Google.</p>
      </section>
    </main>
  );
}
