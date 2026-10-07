import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export type ToastTone = 'default' | 'success' | 'error';
type ShowToast = (message: string, tone?: ToastTone) => void;

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

const ToastContext = createContext<ShowToast>(() => {});
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = useCallback<ShowToast>((message, tone = 'default') => {
    const id = nextId++;
    setToasts((current) => [...current.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 2800);
  }, []);

  return (
    <ToastContext value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext>
  );
}

export function useToast(): ShowToast {
  return useContext(ToastContext);
}
