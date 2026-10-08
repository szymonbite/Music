interface ImportMetaEnv {
  /** Optional YouTube Data API key baked into the Android app, so search works before connecting an account. */
  readonly VITE_YOUTUBE_API_KEY?: string;
  /** Optional Last.fm key baked into the Android app, for better similar artists. */
  readonly VITE_LASTFM_API_KEY?: string;
  /** Android app: where CI publishes the latest APK and its version.json (enables in-app updates). */
  readonly VITE_UPDATE_URL?: string;
}
