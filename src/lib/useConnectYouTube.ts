import { useCallback, useState } from 'react';
import { api, connectYouTubeUrl } from '../api.ts';
import { APP_MODE } from '../platform.ts';
import { useRouter } from '../router.tsx';
import { useSession } from '../session.tsx';
import { useToast } from '../toast.tsx';
import { errorMessage } from './format.ts';

/**
 * "Connect YouTube Music", continuing at `returnTo` afterwards. On the web
 * that's a trip to Google's sign-in page and back, so `connect` never settles
 * (the page is leaving). In the Android app, Google's account picker opens over
 * the app; if that fails, `error` explains why (it stays on screen, because the
 * fix is usually a setting in Google Cloud).
 */
export function useConnectYouTube(): { connect: (returnTo: string) => Promise<void>; error: string | null } {
  const { replace } = useSession();
  const { path, navigate } = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(
    async (returnTo: string) => {
      if (!APP_MODE) {
        window.location.assign(connectYouTubeUrl(returnTo));
        return new Promise<void>(() => {});
      }
      setError(null);
      try {
        replace(await api.connectYouTubeNative());
        toast('YouTube Music connected 🎉', 'success');
        if (returnTo !== path) navigate(returnTo);
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [replace, path, navigate, toast],
  );

  return { connect, error };
}
