import type { Song } from '../../shared/types.ts';
import { youtubeMusicUrl, youtubeUrl } from '../../shared/youtube.ts';
import { useToast } from '../toast.tsx';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';
import { Thumb } from './Thumb.tsx';

export function songLink(songId: string): string {
  return `${window.location.origin}/?song=${encodeURIComponent(songId)}`;
}

export function ShareSheet({ song, onClose }: { song: Song; onClose: () => void }) {
  const toast = useToast();
  const link = songLink(song.id);
  const canShare = typeof navigator.share === 'function';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copied', 'success');
      onClose();
    } catch {
      toast('Couldn’t copy. Select the link and copy it manually.', 'error');
    }
  };

  const share = async () => {
    try {
      await navigator.share({ title: `${song.title} by ${song.artist}`, text: `Listen to ${song.title} by ${song.artist}`, url: link });
      onClose();
    } catch {
      // cancelled
    }
  };

  return (
    <Sheet title="Share" onClose={onClose}>
      <div className="share">
        <div className="share__song">
          <Thumb song={song} className="share__thumb" square />
          <div>
            <strong>{song.title}</strong>
            <span>{song.artist}</span>
          </div>
        </div>
        <input className="input share__link" readOnly value={link} aria-label="Link to this song" onFocus={(e) => e.currentTarget.select()} />
        <div className="share__actions">
          <button type="button" className="btn" onClick={() => void copy()}>
            <Icon name="link" size={20} /> Copy link
          </button>
          {canShare && (
            <button type="button" className="btn" onClick={() => void share()}>
              <Icon name="share" size={20} /> Share…
            </button>
          )}
          <a className="btn" href={youtubeMusicUrl(song.id)} target="_blank" rel="noreferrer">
            <Icon name="music" size={20} /> Open in YouTube Music
          </a>
          <a className="btn" href={youtubeUrl(song.id)} target="_blank" rel="noreferrer">
            <Icon name="external" size={20} /> Watch on YouTube
          </a>
        </div>
      </div>
    </Sheet>
  );
}
