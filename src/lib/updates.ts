// Updates for the Android app: is there a newer build, and installing it.
// The checking and installing are Android-only (src/local/updater.ts registers
// them); this is the state the screens show, so the web build stays free of them.

import { useSyncExternalStore } from 'react';

export interface UpdateInfo {
  versionCode: number;
  versionName: string;
  apkUrl: string;
  sha256: string;
  size: number;
}

export interface Updater {
  /** The installed version, e.g. "1.0.42". */
  currentVersion: string;
  /** The newer build, or null when this one is the latest. */
  check(): Promise<UpdateInfo | null>;
  /** Downloads the build and opens Android's installer. */
  install(update: UpdateInfo): Promise<void>;
}

export type UpdateState =
  | { status: 'unsupported' }
  | { status: 'idle' | 'checking' | 'current'; current: string }
  | { status: 'available' | 'downloading'; current: string; update: UpdateInfo }
  | { status: 'error'; current: string; message: string; update: UpdateInfo | null };

let updater: Updater | null = null;
let state: UpdateState = { status: 'unsupported' };
const listeners = new Set<() => void>();

function setState(next: UpdateState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** What CI publishes next to each APK (see .github/workflows/android.yml). */
export function parseVersionFile(data: unknown, installedCode: number, baseUrl: string): UpdateInfo | null {
  const v = (data ?? {}) as Record<string, unknown>;
  const fileName = typeof v.apk === 'string' && /^[\w.-]+\.apk$/.test(v.apk) ? v.apk : null;
  if (
    typeof v.versionCode !== 'number' ||
    typeof v.versionName !== 'string' ||
    typeof v.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(v.sha256) ||
    typeof v.size !== 'number' ||
    !fileName
  ) {
    throw new Error('The update information looks broken');
  }
  if (v.versionCode <= installedCode) return null;
  return { versionCode: v.versionCode, versionName: v.versionName, apkUrl: `${baseUrl}/${fileName}`, sha256: v.sha256, size: v.size };
}

export function registerUpdater(next: Updater): void {
  updater = next;
  setState({ status: 'idle', current: next.currentVersion });
}

/** Looks for a newer build. `quiet` (the check at start-up) doesn't report errors. */
export async function checkForUpdate(opts: { quiet?: boolean } = {}): Promise<void> {
  if (!updater || state.status === 'checking' || state.status === 'downloading') return;
  const current = updater.currentVersion;
  setState({ status: 'checking', current });
  try {
    const update = await updater.check();
    setState(update ? { status: 'available', current, update } : { status: 'current', current });
  } catch (err) {
    setState(
      opts.quiet
        ? { status: 'idle', current }
        : { status: 'error', current, update: null, message: err instanceof Error ? err.message : String(err) },
    );
  }
}

/** Downloads the newer build and opens Android's installer. */
export async function installUpdate(): Promise<void> {
  if (!updater || state.status !== 'available') return;
  const { current, update } = state;
  setState({ status: 'downloading', current, update });
  try {
    await updater.install(update);
    // The installer is open now; if you back out of it, you can tap Update again.
    setState({ status: 'available', current, update });
  } catch (err) {
    setState({ status: 'error', current, update, message: err instanceof Error ? err.message : String(err) });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUpdate(): UpdateState {
  return useSyncExternalStore(subscribe, () => state);
}
