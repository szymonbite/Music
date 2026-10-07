import { isVideoId } from '../../shared/youtube.ts';
import { Feed } from '../components/Feed.tsx';
import { useRouter } from '../router.tsx';

export function FeedPage() {
  const { search } = useRouter();
  const song = search.get('song');
  const startWith = isVideoId(song) ? song : null;
  // A new shared song starts a fresh feed.
  return <Feed key={startWith ?? 'feed'} startWith={startWith} />;
}
