import { useEffect, useState, type ChangeEvent } from 'react';
import type { GoogleClientInfo } from '../../shared/types.ts';
import { api } from '../api.ts';
import { errorMessage } from '../lib/format.ts';
import { useSession } from '../session.tsx';
import { useToast } from '../toast.tsx';

interface ClientFile {
  installed?: { client_id?: unknown; client_secret?: unknown };
  web?: unknown;
}

/**
 * Android app only. Android's own Google sign-in always uses your main YouTube
 * profile; to pick another one (a Brand Account), the app signs in through the
 * browser instead, which needs a "Desktop app" OAuth client from Google Cloud.
 */
export function YouTubeProfileSetup({ onSwitch, busy }: { onSwitch: () => void; busy: boolean }) {
  const { me } = useSession();
  const toast = useToast();
  const [info, setInfo] = useState<GoogleClientInfo | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .googleClient()
      .then(setInfo)
      .catch(() => setInfo({ clientId: null }));
  }, []);

  const save = async (id: string, secret: string) => {
    setSaving(true);
    setError(null);
    try {
      setInfo(await api.setGoogleClient(id, secret));
      toast(me.youtube ? 'Saved. Tap “Switch YouTube profile” to pick one.' : 'Saved. Now connect YouTube Music and pick your profile.', 'success');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const loadFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let parsed: ClientFile;
    try {
      parsed = JSON.parse(await file.text()) as ClientFile;
    } catch {
      setError('That isn’t the file Google Cloud downloads for an OAuth client (it’s called client_secret_….json).');
      return;
    }
    if (parsed.web) {
      setError('That file is for a “Web application” client. Create a “Desktop app” client instead and download its file.');
      return;
    }
    const id = typeof parsed.installed?.client_id === 'string' ? parsed.installed.client_id : '';
    const secret = typeof parsed.installed?.client_secret === 'string' ? parsed.installed.client_secret : '';
    if (!id || !secret) {
      setError('That file doesn’t include a client ID and secret. Download it again right after creating the client.');
      return;
    }
    setClientId(id);
    setClientSecret(secret);
    await save(id, secret);
  };

  const remove = async () => {
    try {
      await api.removeGoogleClient();
      setInfo({ clientId: null });
      toast('Browser sign-in removed');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  if (!info) return null;

  if (info.clientId) {
    return (
      <div className="profile-setup">
        <p className="muted">✓ Connecting asks which YouTube profile to use (it signs in through your browser).</p>
        <div className="profile-setup__actions">
          {me.youtube && (
            <button type="button" className="btn btn--small" disabled={busy} onClick={onSwitch}>
              Switch YouTube profile
            </button>
          )}
          <button type="button" className="btn btn--ghost btn--small" onClick={() => void remove()}>
            Stop using browser sign-in
          </button>
        </div>
      </div>
    );
  }

  return (
    <details className="profile-setup">
      <summary>Use a different YouTube profile</summary>
      <p className="muted">
        Android’s own Google sign-in always connects your main YouTube profile. To pick another one (a Brand Account), Earworm can sign in
        through your browser instead. One-time setup in Google Cloud:
      </p>
      <ol className="profile-setup__steps">
        <li>
          Open <strong>Google Auth Platform → Clients → Create client</strong>.
        </li>
        <li>
          Choose <strong>Desktop app</strong>, give it any name, and tap <strong>Create</strong>.
        </li>
        <li>
          Tap <strong>Download JSON</strong> straight away. Google only shows the secret once.
        </li>
        <li>Load that file here.</li>
      </ol>
      <label className="btn btn--primary btn--small profile-setup__file">
        Load the downloaded file
        <input type="file" accept=".json,application/json" onChange={(e) => void loadFile(e)} disabled={saving} />
      </label>
      <p className="muted">Or paste both values:</p>
      <label className="field">
        <span className="field__label">Client ID</span>
        <input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <label className="field">
        <span className="field__label">Client secret</span>
        <input className="input" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn btn--small" disabled={saving} onClick={() => void save(clientId, clientSecret)}>
        Save
      </button>
    </details>
  );
}
