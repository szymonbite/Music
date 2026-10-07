import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { setApiTransport } from './api.ts';
import './styles.css';

// Checked inline (not via platform.ts) so web builds drop the app's backend entirely.
if (import.meta.env.MODE === 'app') {
  // The Android app answers API calls itself (src/local/), so it works without a server.
  const backend = import('./local/start.ts').then((m) => m.startLocalBackend());
  setApiTransport(async (url, init) => {
    try {
      return (await backend).fetch(url, init);
    } catch (err) {
      console.error(err);
      const message = `Earworm couldn’t open its data (${err instanceof Error ? err.message : String(err)}).`;
      return Response.json({ error: 'startup', message }, { status: 500 });
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
