import { Link, useRouter } from '../router.tsx';
import { Icon, type IconName } from './Icon.tsx';

const TABS: { to: string; label: string; icon: IconName }[] = [
  { to: '/', label: 'For you', icon: 'home' },
  { to: '/library', label: 'Library', icon: 'library' },
  { to: '/me', label: 'Me', icon: 'user' },
];

export function BottomNav() {
  const { path } = useRouter();
  return (
    <nav className="bottom-nav" aria-label="Main">
      {TABS.map((tab) => (
        <Link key={tab.to} to={tab.to} className="bottom-nav__item" aria-current={path === tab.to ? 'page' : undefined}>
          <Icon name={tab.icon} size={24} />
          <span>{tab.label}</span>
        </Link>
      ))}
    </nav>
  );
}
