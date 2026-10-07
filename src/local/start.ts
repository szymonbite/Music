// Starts the Android app's built-in backend: opens the saved database, keeps
// it saved, and connects the server code to Android's HTTP and Google sign-in.

import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { regionFromAcceptLanguage } from '../../server/users.ts';
import { handleBackButton } from './backButton.ts';
import { googleAuthPlugin, nativeFetch } from './native.ts';
import { AutoSaver, indexedDbStorage } from './persist.ts';
import { createLocalServer, type LocalServer } from './server.ts';
import { openSqlJsDb } from './sqljs.ts';

export async function startLocalBackend(): Promise<LocalServer> {
  handleBackButton();
  const storage = indexedDbStorage();
  const db = await openSqlJsDb(await storage.load(), wasmUrl);
  const saver = new AutoSaver(db, storage);
  // Save straight away when the app goes to the background; Android may close it from there.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void saver.flush();
  });
  window.addEventListener('pagehide', () => void saver.flush());

  return createLocalServer({
    db,
    fetch: nativeFetch,
    googleAuth: googleAuthPlugin(),
    youtubeApiKey: import.meta.env.VITE_YOUTUBE_API_KEY || null,
    lastfmApiKey: import.meta.env.VITE_LASTFM_API_KEY || null,
    region: regionFromAcceptLanguage(navigator.languages.join(',')),
    persist: () => saver.flush(),
  });
}
