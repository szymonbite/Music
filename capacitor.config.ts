import type { CapacitorConfig } from '@capacitor/cli';

// The Android app. Build it with `npm run android:sync`, then Gradle (see docs/ANDROID.md).
const APP_ID = 'io.github.szymonbite.earworm';

const config: CapacitorConfig = {
  appId: APP_ID,
  appName: 'Earworm',
  webDir: 'dist-app',
  backgroundColor: '#0b0b10',
  server: {
    // The app is served from https://<APP_ID>/. YouTube's player only plays inside apps that
    // identify themselves this way (otherwise it shows "error 153").
    hostname: APP_ID,
    androidScheme: 'https',
  },
  plugins: {
    SystemBars: {
      insetsHandling: 'native',
      initialViewportFitValueHint: 'cover',
      // Light status bar icons on Earworm's dark background.
      style: 'DARK',
    },
  },
};

export default config;
