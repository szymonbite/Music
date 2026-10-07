import type { Song } from '../../shared/types.ts';
import { Icon } from './Icon.tsx';
import { Thumb } from './Thumb.tsx';

interface SongTileProps {
  song: Song;
  selected: boolean;
  onToggle: (song: Song) => void;
}

/** A selectable song card for the favourites picker. */
export function SongTile({ song, selected, onToggle }: SongTileProps) {
  return (
    <button
      type="button"
      className="tile"
      aria-pressed={selected}
      aria-label={`${song.title} by ${song.artist}`}
      onClick={() => onToggle(song)}
    >
      <span className="tile__art">
        <Thumb song={song} square />
        <span className="tile__check" aria-hidden="true">
          <Icon name="check" size={18} strokeWidth={3} />
        </span>
      </span>
      <span className="tile__title">{song.title}</span>
      <span className="tile__artist">{song.artist}</span>
    </button>
  );
}
