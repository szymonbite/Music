import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';

interface SheetProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

/** A bottom sheet dialog, TikTok style. Closes on backdrop tap or Escape. */
export function Sheet({ title, onClose, children, className = '' }: SheetProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div className="sheet-backdrop" onClick={() => onCloseRef.current()}>
      <div
        ref={panelRef}
        className={`sheet ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet__handle" aria-hidden="true" />
        <header className="sheet__header">
          <h2 id={titleId} className="sheet__title">
            {title}
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => onCloseRef.current()}>
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet__body">{children}</div>
      </div>
    </div>
  );
}
