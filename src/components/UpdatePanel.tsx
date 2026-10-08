import { checkForUpdate, installUpdate, useUpdate } from '../lib/updates.ts';

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Android app: the installed version, and updating it in place. */
export function UpdatePanel() {
  const update = useUpdate();
  if (update.status === 'unsupported') return null;

  return (
    <section className="card-section" aria-labelledby="app-heading">
      <h2 id="app-heading">Earworm app</h2>
      {update.status === 'available' || update.status === 'downloading' ? (
        <>
          <p className="update__ready">
            Version {update.update.versionName} is ready ({megabytes(update.update.size)}). You have {update.current}.
          </p>
          <button
            type="button"
            className="btn btn--primary"
            disabled={update.status === 'downloading'}
            onClick={() => void installUpdate()}
          >
            {update.status === 'downloading' ? 'Downloading…' : 'Update now'}
          </button>
          <p className="fineprint">
            Android then asks you to install it. The first time, it asks you to allow Earworm to install apps: allow it, go back,
            and tap Install. Your likes, saves and settings stay.
          </p>
        </>
      ) : (
        <>
          <p className="muted">
            Version {update.current}
            {update.status === 'current' && ' · You’re up to date'}
          </p>
          {update.status === 'error' && (
            <p className="notice notice--error" role="alert">
              {update.message}
            </p>
          )}
          <button
            type="button"
            className="btn btn--small"
            disabled={update.status === 'checking'}
            onClick={() => void checkForUpdate()}
          >
            {update.status === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        </>
      )}
    </section>
  );
}
