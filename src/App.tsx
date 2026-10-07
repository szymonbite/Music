import { useEffect, useRef, type ReactNode } from 'react';
import { BottomNav } from './components/BottomNav.tsx';
import { FeedPage } from './pages/FeedPage.tsx';
import { LibraryPage } from './pages/LibraryPage.tsx';
import { PickPage } from './pages/PickPage.tsx';
import { ProfilePage } from './pages/ProfilePage.tsx';
import { WelcomePage } from './pages/WelcomePage.tsx';
import { Redirect, RouterProvider, useRouter } from './router.tsx';
import { SessionProvider, useSession } from './session.tsx';
import { ToastProvider, useToast } from './toast.tsx';

const OAUTH_ERRORS: Record<string, string> = {
  cancelled: 'Connecting YouTube Music was cancelled.',
  scope_missing: 'Earworm needs permission to manage your YouTube account to sync likes and saves. Please try again and allow it.',
  expired: 'That sign-in took too long. Please try again.',
  invalid_state: 'That sign-in link wasn’t valid. Please try again.',
  session_mismatch: 'Your session changed while signing in. Please try again.',
  google_error: 'Google sign-in didn’t work. Please try again.',
};

/** Shows the result of the YouTube Music connection flow, then tidies the URL. */
function useOAuthNotice() {
  const { path, search, navigate } = useRouter();
  const toast = useToast();
  const handled = useRef(false);
  const connected = search.get('youtube');
  const error = search.get('youtube_error');

  useEffect(() => {
    if ((!connected && !error) || handled.current) return;
    handled.current = true;
    if (connected === 'connected') toast('YouTube Music connected 🎉', 'success');
    if (error) toast(OAUTH_ERRORS[error] ?? OAUTH_ERRORS.google_error!, 'error');
    const params = new URLSearchParams(window.location.search);
    params.delete('youtube');
    params.delete('youtube_error');
    const rest = params.toString();
    navigate(`${path}${rest ? `?${rest}` : ''}`, { replace: true });
  }, [connected, error, path, navigate, toast]);
}

const ROUTES: Record<string, () => ReactNode> = {
  '/': () => <FeedPage />,
  '/welcome': () => <WelcomePage />,
  '/pick': () => <PickPage />,
  '/library': () => <LibraryPage />,
  '/me': () => <ProfilePage />,
};

const WITH_NAV = new Set(['/', '/library', '/me']);

function Shell() {
  const { me } = useSession();
  const { path, search } = useRouter();
  useOAuthNotice();

  const route = ROUTES[path];
  if (!route) return <Redirect to="/" />;
  // Shared song links play straight away, even before onboarding.
  const sharedSong = path === '/' && search.has('song');
  if (!me.onboarded && path !== '/welcome' && path !== '/pick' && !sharedSong) return <Redirect to="/welcome" />;
  if (me.onboarded && path === '/welcome') return <Redirect to="/" />;

  return (
    <div className="app">
      <div className="app__main">{route()}</div>
      {WITH_NAV.has(path) && (me.onboarded || sharedSong) && <BottomNav />}
    </div>
  );
}

export function App() {
  return (
    <RouterProvider>
      <ToastProvider>
        <SessionProvider>
          <Shell />
        </SessionProvider>
      </ToastProvider>
    </RouterProvider>
  );
}
