import fs from 'node:fs';
import { isVideoId } from '../shared/youtube.ts';
import { transaction, type DB } from './db.ts';
import { decadeTag } from './music.ts';
import { upsertSong } from './songs.ts';

export interface CatalogEntry {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  genres: string[];
  tags: string[];
}

const CATALOG_FILE = new URL('./data/catalog.json', import.meta.url);

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Reads and validates the built-in song catalogue. Invalid entries are skipped. */
export function loadCatalog(file: URL | string = CATALOG_FILE): CatalogEntry[] {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('catalog.json must contain an array');
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    const { id, title, artist, year, genres, tags } = item;
    if (!isVideoId(id) || seen.has(id) || typeof title !== 'string' || typeof artist !== 'string') continue;
    seen.add(id);
    entries.push({
      id,
      title,
      artist,
      year: typeof year === 'number' ? year : null,
      genres: isStringList(genres) ? genres : [],
      tags: isStringList(tags) ? tags : [],
    });
  }
  return entries;
}

/** Makes sure every catalogue song exists in the database with up-to-date curated metadata. */
export function seedCatalog(db: DB, entries: CatalogEntry[], now: number): void {
  transaction(db, () => {
    for (const entry of entries) {
      const decade = decadeTag(entry.year);
      upsertSong(
        db,
        {
          id: entry.id,
          title: entry.title,
          artist: entry.artist,
          year: entry.year,
          genres: entry.genres,
          tags: decade ? [...entry.tags, decade] : entry.tags,
          source: 'catalog',
        },
        now,
      );
    }
  });
}
