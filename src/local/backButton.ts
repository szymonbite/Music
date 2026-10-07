import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

/**
 * Android's back button: closes an open sheet first, then goes back a
 * screen, and from the first screen sends the app to the background (like
 * the home button, so the music app is still there when you come back).
 */
export function handleBackButton(): void {
  if (!Capacitor.isNativePlatform()) return;
  void App.addListener('backButton', ({ canGoBack }) => {
    if (document.querySelector('[role="dialog"]')) {
      // Sheets close on Escape.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    } else if (canGoBack) {
      window.history.back();
    } else {
      void App.minimizeApp();
    }
  });
}
