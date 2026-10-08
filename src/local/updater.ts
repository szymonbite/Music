// Checks the "android-latest" GitHub release for a newer build, and installs it
// through AppUpdaterPlugin.java. CI bakes the release's address into release
// builds (VITE_UPDATE_URL); builds without it don't offer updates.

import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { parseVersionFile, type Updater } from '../lib/updates.ts';
import { nativeFetch } from './native.ts';

interface AppUpdaterPlugin {
  /** Downloads the APK, checks its SHA-256, then opens Android's installer. */
  install(options: { url: string; sha256: string }): Promise<void>;
}

declare global {
  interface Window {
    /** Let browser tests stand in for the installed app and its installer. */
    __earwormAppInfo?: { version: string; build: string };
    __earwormAppUpdater?: AppUpdaterPlugin;
  }
}

export async function createUpdater(): Promise<Updater | null> {
  const baseUrl = import.meta.env.VITE_UPDATE_URL?.replace(/\/+$/, '');
  if (!baseUrl) return null;
  const info = window.__earwormAppInfo ?? (Capacitor.isNativePlatform() ? await App.getInfo() : null);
  if (!info) return null;
  const installedCode = Number(info.build) || 0;
  const plugin = window.__earwormAppUpdater ?? registerPlugin<AppUpdaterPlugin>('AppUpdater');

  return {
    currentVersion: info.version,
    async check() {
      const res = await nativeFetch(`${baseUrl}/version.json`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Couldn’t check for updates (${res.status})`);
      return parseVersionFile(await res.json(), installedCode, baseUrl);
    },
    install: (update) => plugin.install({ url: update.apkUrl, sha256: update.sha256 }),
  };
}
