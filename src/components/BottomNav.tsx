import { useUpdate } from '../lib/updates.ts';
import { Link, useRouter } from '../router.tsx';
import { Icon, type IconName } from './Icon.tsx';

const TABS: { to: string; label: string; icon: IconName }[] = [
  { to: '/', label: 'For you', icon: 'home' },
  { to: '/library', label: 'Library', icon: 'library' },
  { to: '/me', label: 'Me', icon: 'user' },
];

export function BottomNav() {
  const { path } = useRouter();
  // The Android app marks "Me" when a new version is ready to install there.
  const updateReady = useUpdate().status === 'available';
  return (
    <nav className="bottom-nav" aria-label="Main">
      {TABS.map((tab) => {
        const dot = tab.to === '/me' && updateReady;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            className="bottom-nav__item"
            aria-current={path === tab.to ? 'page' : undefined}
            aria-label={dot ? `${tab.label}, update available` : undefined}
          >
            <span className="bottom-nav__icon">
              <Icon name={tab.icon} size={24} />
              {dot && <span className="bottom-nav__dot" />}
            </span>
            <span>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
