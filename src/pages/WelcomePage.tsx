import { useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon.tsx';
import { Logo } from '../components/Logo.tsx';
import { errorMessage } from '../lib/format.ts';
import { useConnectYouTube } from '../lib/useConnectYouTube.ts';
import { APP_MODE } from '../platform.ts';
import { useRouter } from '../router.tsx';
import { useSession } from '../session.tsx';
import { useToast } from '../toast.tsx';

export function WelcomePage() {
  const { me, features, update } = useSession();
  const { navigate } = useRouter();
  const toast = useToast();
  const connectYouTube = useConnectYouTube();
  const [name, setName] = useState(me.displayName);
  const [busy, setBusy] = useState(false);

  const saveName = async (): Promise<boolean> => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast('Pick a name first (you can change it later)', 'error');
      return false;
    }
    if (trimmed === me.displayName) return true;
    try {
      await update({ displayName: trimmed });
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    }
  };

  const continueToPicker = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    if (await saveName()) navigate('/pick');
    setBusy(false);
  };

  const connect = async () => {
    setBusy(true);
    if (await saveName()) await connectYouTube('/pick');
    setBusy(false);
  };

  return (
    <main className="welcome">
      <div className="welcome__hero">
        <div className="welcome__orbs" aria-hidden="true" />
        <Logo size={72} />
        <h1 className="welcome__title">Find your next earworm</h1>
        <p className="welcome__lead">
          Scroll through songs like TikTok. <strong>Like</strong>, <strong>dislike</strong>, <strong>comment</strong> and{' '}
          <strong>save</strong> the ones that stick. The more you react, the better it gets.
        </p>
      </div>

      <form className="welcome__form" onSubmit={(e) => void continueToPicker(e)}>
        <label className="field">
          <span className="field__label">What should we call you?</span>
          <input className="input" value={name} maxLength={30} onChange={(e) => setName(e.target.value)} autoComplete="nickname" />
          <span className="field__hint">{features.social ? 'Shown next to your comments.' : 'You can change it later.'}</span>
        </label>

        {me.youtube ? (
          <div className="notice notice--success">
            <Icon name="check" size={18} /> Connected to YouTube Music as {me.youtube.email ?? me.youtube.name}
          </div>
        ) : features.youtubeLogin ? (
          <>
            <button type="button" className="btn btn--youtube btn--block" disabled={busy} onClick={() => void connect()}>
              <Icon name="music" size={20} /> Connect YouTube Music
            </button>
            <p className="fineprint">
              We’ll import your liked songs and playlists so you can pick favourites fast, and mirror your likes, dislikes and saves
              back to YouTube Music. You can turn syncing off anytime.
            </p>
          </>
        ) : (
          <p className="notice">
            {APP_MODE
              ? 'Connecting YouTube Music needs the Android app, so pick your favourites by hand.'
              : 'Connecting a YouTube Music account isn’t set up on this server yet, so pick your favourites by hand. (Running it yourself? See “Connect YouTube Music” in the README.)'}
          </p>
        )}

        <button type="submit" className={`btn btn--block ${features.youtubeLogin && !me.youtube ? 'btn--ghost' : 'btn--primary'}`} disabled={busy}>
          {features.youtubeLogin && !me.youtube ? 'Skip, I’ll pick songs myself' : 'Pick my favourite songs'}
        </button>
      </form>
    </main>
  );
}
