// Helpers for turning messy YouTube metadata into tidy song data.

const ARTIST_SEPARATORS = /\s*(?:,|&|\+)\s*|\s+(?:x|feat\.?|ft\.?|featuring|with|vs\.?)\s+/i;

/** "Mark Ronson feat. Bruno Mars" -> ["Mark Ronson", "Bruno Mars"] */
export function splitArtists(artist: string): string[] {
  return artist
    .split(ARTIST_SEPARATORS)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** The headline artist, without featured guests: "Mark Ronson feat. Bruno Mars" -> "Mark Ronson". */
export function primaryArtist(artist: string): string {
  return artist.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0]!.trim();
}

/** Lowercase, accent-free, punctuation-free key used to match artists across sources. */
export function normalizeArtistName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function artistKeys(artist: string): string[] {
  const keys = splitArtists(artist).map(normalizeArtistName).filter(Boolean);
  return [...new Set(keys)];
}

const NOISE = /\b(official|video|audio|lyrics?|visuali[sz]er|remaster(?:ed)?|hd|hq|4k|mv|m\/v|clip|videoclip|oficial|officiel|explicit|color coded)\b/i;

/** Drops "(Official Video)", "[4K Remaster]", "| Official Audio" and similar noise. */
export function cleanTitle(title: string): string {
  let cleaned = title.replace(/\s*[([]([^)\]]*)[)\]]/g, (whole, inner: string) => (NOISE.test(inner) ? '' : whole));
  cleaned = cleaned.replace(/\s*[|｜].*$/, (segment) => (NOISE.test(segment) ? '' : segment));
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned || title.trim();
}

function cleanChannelTitle(channel: string): string {
  let name = channel
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\s*(?:official(?: channel)?|music)$/i, '')
    .trim();
  if (!/\s/.test(name)) name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  return name;
}

/**
 * Splits a YouTube title such as "Artist - Song (Official Video) ft. Guest"
 * into artist and song title, falling back to the channel name.
 */
export function parseVideoTitle(rawTitle: string, channelTitle = ''): { title: string; artist: string } {
  let title = cleanTitle(rawTitle);
  let artist: string;

  const topic = channelTitle.match(/^(.*?)\s*-\s*Topic$/i);
  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (topic?.[1]) {
    artist = topic[1].trim();
  } else if (dash?.[1] && dash[2]) {
    artist = dash[1].trim();
    title = dash[2].trim();
  } else {
    artist = cleanChannelTitle(channelTitle) || 'Unknown artist';
  }

  const feat = title.match(/\s*[([]?\b(?:feat\.?|ft\.?|featuring)\s+([^)\]]+?)[)\]]?\s*$/i);
  if (feat?.[1] && feat.index !== undefined && feat.index > 0) {
    title = title.slice(0, feat.index).trim();
    if (!/\b(?:feat\.?|ft\.?|featuring)\s/i.test(artist)) artist = `${artist} feat. ${feat[1].trim()}`;
  }
  return { title: title.replace(/^["“]|["”]$/g, ''), artist };
}

/** "PT3M33S" -> 213 */
export function parseIsoDuration(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, d = '0', h = '0', min = '0', s = '0'] = m;
  return Number(d) * 86_400 + Number(h) * 3600 + Number(min) * 60 + Number(s);
}

const TOPIC_GENRES: Record<string, string> = {
  Pop_music: 'pop',
  Rock_music: 'rock',
  Hip_hop_music: 'hip-hop',
  Electronic_music: 'electronic',
  Rhythm_and_blues: 'r&b',
  Soul_music: 'soul',
  Country_music: 'country',
  Jazz: 'jazz',
  Classical_music: 'classical',
  Reggae: 'reggae',
  Reggaeton: 'reggaeton',
  Music_of_Latin_America: 'latin',
  Independent_music: 'indie',
  Christian_music: 'christian',
  Music_of_Asia: 'asian',
  Music_of_Bollywood: 'bollywood',
  Heavy_metal_music: 'metal',
  Punk_rock: 'punk',
  Alternative_rock: 'alternative',
  Folk_music: 'folk',
  Blues: 'blues',
  Electronic_dance_music: 'dance',
  House_music: 'house',
  Techno: 'electronic',
  Funk: 'funk',
  Disco: 'disco',
  Video_game_music: 'soundtrack',
  Soundtrack: 'soundtrack',
};

/** Maps YouTube topicDetails (Wikipedia URLs) to our genre slugs. */
export function topicsToGenres(topicUrls: string[] | undefined): string[] {
  const genres = new Set<string>();
  for (const url of topicUrls ?? []) {
    let slug: string;
    try {
      slug = decodeURIComponent(url.split('/').pop() ?? '');
    } catch {
      continue;
    }
    const mapped = TOPIC_GENRES[slug] ?? (/_music$/i.test(slug) ? slug.replace(/_music$/i, '').replace(/_/g, ' ').toLowerCase() : null);
    if (mapped && mapped.length <= 24) genres.add(mapped);
  }
  return [...genres].slice(0, 4);
}

export function decadeTag(year: number | null | undefined): string | null {
  if (!year || year < 1900) return null;
  return `${Math.floor(year / 10) * 10}s`;
}

/** Turns a view count into a 0..1 prior (1M views ~ 0.6, 1B views ~ 0.9). */
export function popularityFromViews(views: number | null | undefined): number {
  if (!views || views < 0) return 0.3;
  return Math.min(1, Math.log10(views + 1) / 10);
}
