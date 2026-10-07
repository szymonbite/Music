/**
 * True in the Android app build (`vite build --mode app`), where Earworm's
 * backend runs inside the app (src/local/) instead of on a server.
 */
export const APP_MODE = import.meta.env.MODE === 'app';
