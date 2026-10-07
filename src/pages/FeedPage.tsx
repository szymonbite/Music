import { isVideoId } from '../../shared/youtube.ts';
import { Feed } from '../components/Feed.tsx';
import { useRouter } from '../router.tsx';
import { useSession } from '../session.tsx';

export function FeedPage() {
  const { search } = useRouter();
  const { features } = useSession();
  const song = search.get('song');
  const startWith = isVideoId(song) ? song : null;
  const mode = features.social && search.get('tab') === 'friends' && !startWith ? 'friends' : 'forYou';
  // A new shared song or a different tab starts a fresh feed.
  return <Feed key={`${mode}:${startWith ?? ''}`} startWith={startWith} mode={mode} />;
}
