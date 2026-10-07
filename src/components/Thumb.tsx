import { useState, type CSSProperties } from 'react';
import type { Song } from '../../shared/types.ts';
import { hueFor } from '../lib/format.ts';
import { Icon } from './Icon.tsx';

type ThumbSong = Pick<Song, 'id' | 'artist' | 'thumbnailUrl'>;

interface ThumbProps {
  song: ThumbSong;
  className?: string;
  /** Square crop. YouTube thumbnails are 4:3 with letterbox bars, so they get zoomed past the bars. */
  square?: boolean;
}

/** Song artwork, falling back to a colourful placeholder when the image can't load. */
export function Thumb({ song, className = '', square = false }: ThumbProps) {
  const [failed, setFailed] = useState(false);
  const classes = `thumb${square ? ' thumb--square' : ''} ${className}`;
  if (failed || !song.thumbnailUrl) {
    return (
      <span className={`${classes} thumb--fallback`} style={{ '--hue': hueFor(song.artist || song.id) } as CSSProperties} aria-hidden="true">
        <Icon name="music" />
      </span>
    );
  }
  return (
    <span className={classes}>
      <img src={song.thumbnailUrl} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </span>
  );
}
