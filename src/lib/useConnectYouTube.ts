import { useCallback } from 'react';
import { api, connectYouTubeUrl } from '../api.ts';
import { APP_MODE } from '../platform.ts';
import { useRouter } from '../router.tsx';
import { useSession } from '../session.tsx';
import { useToast } from '../toast.tsx';
import { errorMessage } from './format.ts';

/**
 * Starts "Connect YouTube Music", then continues at `returnTo`. On the web
 * that's a trip to Google's sign-in page and back, so the promise never
 * settles (the page is leaving). In the Android app, Google's account picker
 * opens over the app and the promise resolves once it's done.
 */
export function useConnectYouTube(): (returnTo: string) => Promise<void> {
  const { replace } = useSession();
  const { path, navigate } = useRouter();
  const toast = useToast();

  return useCallback(
    async (returnTo: string) => {
      if (!APP_MODE) {
        window.location.assign(connectYouTubeUrl(returnTo));
        return new Promise<void>(() => {});
      }
      try {
        replace(await api.connectYouTubeNative());
        toast('YouTube Music connected 🎉', 'success');
        if (returnTo !== path) navigate(returnTo);
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    },
    [replace, path, navigate, toast],
  );
}
