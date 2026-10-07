// Small YouTube helpers used by both the server and the client.

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{2,64}$/;

export function isVideoId(value: unknown): value is string {
  return typeof value === 'string' && VIDEO_ID_RE.test(value);
}

export type YouTubeRef = { type: 'video'; id: string } | { type: 'playlist'; id: string };

/**
 * Understands YouTube and YouTube Music links (watch, youtu.be, shorts, embed,
 * playlist) as well as bare 11-character video ids.
 */
export function parseYouTubeRef(input: string): YouTubeRef | null {
  const text = input.trim();
  if (VIDEO_ID_RE.test(text)) return { type: 'video', id: text };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');

  if (host === 'youtu.be') {
    const id = url.pathname.split('/')[1];
    return isVideoId(id) ? { type: 'video', id } : null;
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;

  const v = url.searchParams.get('v');
  if (isVideoId(v)) return { type: 'video', id: v };

  const pathMatch = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/);
  if (pathMatch?.[1]) return { type: 'video', id: pathMatch[1] };

  const list = url.searchParams.get('list');
  if (list && PLAYLIST_ID_RE.test(list)) return { type: 'playlist', id: list };

  return null;
}

export function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export function youtubeMusicUrl(videoId: string): string {
  return `https://music.youtube.com/watch?v=${videoId}`;
}

export function youtubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function youtubePlaylistUrl(playlistId: string): string {
  return `https://music.youtube.com/playlist?list=${playlistId}`;
}

const GENRE_LABELS: Record<string, string> = {
  'r&b': 'R&B',
  'hip-hop': 'Hip-Hop',
  'k-pop': 'K-Pop',
  'j-pop': 'J-Pop',
  edm: 'EDM',
};

export function formatGenre(genre: string): string {
  return (
    GENRE_LABELS[genre] ??
    genre
      .split(/[-\s]+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  );
}
