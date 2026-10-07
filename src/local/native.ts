// The bits of the Android app that live on the native side.

import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import type { FetchLike } from '../../server/youtube/client.ts';

export interface GoogleAuthResult {
  accessToken: string;
  grantedScopes: string[];
}

/** What Google Cloud needs to know to recognise the app (its Android OAuth client). */
export interface AppIdentity {
  packageName: string;
  /** Fingerprint of the certificate the installed app is signed with, e.g. "B2:B8:…". */
  sha1: string;
}

/**
 * "Connect YouTube Music" on Android, through Google Play services' account
 * picker (android/app/src/main/java/.../GoogleAuthPlugin.java). Google blocks
 * its sign-in pages inside app web views, so this can't be done in JavaScript.
 */
export interface GoogleAuthPlugin {
  /**
   * Asks for access to the listener's YouTube account. With `interactive`, shows
   * the account picker and consent screen when needed; without it, fails with
   * code "consent_required" instead. Other failures have code "cancelled" or
   * "google_error", and Google's status code in `data.status` (10: Google doesn't
   * recognise the app). Note that Google also reports some refusals as "cancelled".
   */
  authorize(options: { interactive: boolean }): Promise<GoogleAuthResult>;
  appIdentity?(): Promise<AppIdentity>;
}

declare global {
  interface Window {
    /** Lets browser tests stand in for the Android plugin. */
    __earwormGoogleAuth?: GoogleAuthPlugin;
  }
}

/** The Google sign-in plugin, or null when it isn't available (e.g. a desktop browser). */
export function googleAuthPlugin(): GoogleAuthPlugin | null {
  if (window.__earwormGoogleAuth) return window.__earwormGoogleAuth;
  return Capacitor.isNativePlatform() ? registerPlugin<GoogleAuthPlugin>('GoogleAuth') : null;
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * fetch() for Google, YouTube, Deezer and Last.fm. On Android it goes through
 * the native HTTP stack, because several of these APIs don't allow requests
 * from web pages (CORS). Elsewhere it's the normal fetch().
 */
export const nativeFetch: FetchLike = async (input, init = {}) => {
  if (!Capacitor.isNativePlatform()) return fetch(input, init);
  const res = await CapacitorHttp.request({
    url: input,
    method: init.method ?? 'GET',
    headers: headerRecord(init.headers),
    data: typeof init.body === 'string' ? init.body : undefined,
    responseType: 'text',
    connectTimeout: 10_000,
    readTimeout: 15_000,
  });
  // JSON responses arrive already parsed; turn everything back into a body.
  const text = res.data === undefined || res.data === null ? '' : typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  const noBody = res.status === 204 || res.status === 205 || res.status === 304;
  return new Response(noBody ? null : text, { status: res.status, headers: res.headers });
};
