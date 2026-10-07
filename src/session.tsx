import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Features, Me, MePatch, MeResponse } from '../shared/types.ts';
import { api } from './api.ts';
import { Logo } from './components/Logo.tsx';
import { errorMessage } from './lib/format.ts';

interface SessionValue {
  me: Me;
  features: Features;
  /** Saves a profile change and updates the session. */
  update: (patch: MePatch) => Promise<void>;
  /** Replaces the session with a fresh server response. */
  replace: (response: MeResponse) => void;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: MeResponse };

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      setState({ status: 'ready', data: await api.me() });
    } catch (err) {
      // A failed background refresh keeps the current session; only a failed first load shows the error screen.
      setState((prev) => (prev.status === 'ready' ? prev : { status: 'error', message: errorMessage(err) }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = useCallback(async (patch: MePatch) => {
    const data = await api.updateMe(patch);
    setState({ status: 'ready', data });
  }, []);

  const replace = useCallback((data: MeResponse) => setState({ status: 'ready', data }), []);

  if (state.status === 'loading') {
    return (
      <div className="splash" aria-busy="true">
        <Logo size={64} />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="splash">
        <Logo size={64} />
        <p className="splash__message">{state.message}</p>
        <button
          className="btn btn--primary"
          onClick={() => {
            setState({ status: 'loading' });
            void refresh();
          }}
        >
          Try again
        </button>
      </div>
    );
  }
  return (
    <SessionContext value={{ me: state.data.me, features: state.data.features, update, replace, refresh }}>
      {children}
    </SessionContext>
  );
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
