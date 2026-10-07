import crypto from 'node:crypto';
import type { Me, UserSettings } from '../shared/types.ts';
import { youtubePlaylistUrl } from '../shared/youtube.ts';
import { get, run, transaction, type DB } from './db.ts';

export interface UserRow {
  id: string;
  display_name: string;
  created_at: number;
  onboarded_at: number | null;
  settings: string;
  google_sub: string | null;
  google_email: string | null;
  google_name: string | null;
  google_picture: string | null;
  yt_access_token: string | null;
  yt_refresh_token: string | null;
  yt_token_expires_at: number | null;
  yt_playlist_id: string | null;
  yt_discovered_at: number | null;
}

export const DEFAULT_SETTINGS: UserSettings = {
  skipIntro: true,
  autoAdvance: true,
  syncReactions: true,
  syncSaves: true,
  region: 'US',
};

const BOOLEAN_SETTINGS = ['skipIntro', 'autoAdvance', 'syncReactions', 'syncSaves'] as const;

/** Validates a (partial) settings object, dropping anything unknown or malformed. */
export function sanitizeSettings(input: unknown): Partial<UserSettings> {
  if (!input || typeof input !== 'object') return {};
  const source = input as Record<string, unknown>;
  const out: Partial<UserSettings> = {};
  for (const key of BOOLEAN_SETTINGS) {
    if (typeof source[key] === 'boolean') out[key] = source[key];
  }
  if (typeof source.region === 'string' && /^[A-Za-z]{2}$/.test(source.region)) {
    out.region = source.region.toUpperCase();
  }
  return out;
}

export function parseSettings(json: string): UserSettings {
  let stored: unknown = {};
  try {
    stored = JSON.parse(json);
  } catch {
    // fall back to defaults
  }
  return { ...DEFAULT_SETTINGS, ...sanitizeSettings(stored) };
}

export function randomDisplayName(): string {
  return `Listener ${crypto.randomInt(1000, 10000)}`;
}

/** Picks a region for trending charts from an Accept-Language header ("pl-PL,pl;q=0.9" -> "PL"). */
export function regionFromAcceptLanguage(header: string | undefined): string {
  const match = header?.match(/[a-z]{2,3}-([A-Z]{2})\b/i);
  return match?.[1] ? match[1].toUpperCase() : DEFAULT_SETTINGS.region;
}

export function getUser(db: DB, id: string): UserRow | undefined {
  return get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', [id]);
}

export function createUser(db: DB, opts: { displayName?: string; region?: string }, now: number): UserRow {
  const id = crypto.randomUUID();
  const settings: UserSettings = { ...DEFAULT_SETTINGS, region: opts.region ?? DEFAULT_SETTINGS.region };
  run(db, 'INSERT INTO users (id, display_name, created_at, settings) VALUES (?, ?, ?, ?)', [
    id,
    opts.displayName ?? randomDisplayName(),
    now,
    JSON.stringify(settings),
  ]);
  return getUser(db, id)!;
}

export function isYouTubeConnected(user: UserRow): boolean {
  return Boolean(user.google_sub && (user.yt_refresh_token || user.yt_access_token));
}

/** Control and bidi-override characters, which can garble or spoof text. */
export const UNSAFE_CHARS = /[\p{Cc}‪-‮⁦-⁩]/gu;

/** Keeps display names readable: no control characters, collapsed whitespace, 1-30 chars. */
export function cleanDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 1 || cleaned.length > 30) return null;
  return cleaned;
}

export function toMe(db: DB, user: UserRow): Me {
  const counts = get<Me['counts']>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM favorites WHERE user_id = :id) AS favorites,
       (SELECT COUNT(*) FROM reactions WHERE user_id = :id AND value = 1) AS likes,
       (SELECT COUNT(*) FROM saves WHERE user_id = :id) AS saves,
       (SELECT COUNT(*) FROM comments WHERE user_id = :id) AS comments`,
    { id: user.id },
  )!;
  const connected = isYouTubeConnected(user);
  return {
    id: user.id,
    displayName: user.display_name,
    avatarUrl: connected ? user.google_picture : null,
    onboarded: user.onboarded_at !== null,
    settings: parseSettings(user.settings),
    youtube: connected
      ? {
          email: user.google_email,
          name: user.google_name,
          pictureUrl: user.google_picture,
          playlistUrl: user.yt_playlist_id ? youtubePlaylistUrl(user.yt_playlist_id) : null,
        }
      : null,
    counts: { ...counts },
  };
}

// --- Sessions -------------------------------------------------------------

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Creates a session and returns the raw token for the cookie. Only its hash is stored. */
export function createSession(db: DB, userId: string, now: number): string {
  const token = crypto.randomBytes(32).toString('base64url');
  run(db, 'INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)', [
    hashToken(token),
    userId,
    now,
    now,
  ]);
  return token;
}

const SESSION_TOUCH_INTERVAL = 60 * 60 * 1000;

export function userForSession(db: DB, token: string, now: number): UserRow | undefined {
  const hash = hashToken(token);
  const session = get<{ user_id: string; last_seen_at: number }>(
    db,
    'SELECT user_id, last_seen_at FROM sessions WHERE token_hash = ?',
    [hash],
  );
  if (!session) return undefined;
  if (now - session.last_seen_at > SESSION_TOUCH_INTERVAL) {
    run(db, 'UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', [now, hash]);
  }
  return getUser(db, session.user_id);
}

export function deleteSession(db: DB, token: string): void {
  run(db, 'DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
}

/**
 * Moves everything a guest did into another account (used when a guest
 * connects a Google account that already belongs to an existing user), then
 * deletes the guest.
 */
export function mergeUsers(db: DB, fromId: string, intoId: string): void {
  if (fromId === intoId) return;
  const params = { from: fromId, into: intoId };
  transaction(db, () => {
    run(db, `INSERT OR IGNORE INTO favorites (user_id, song_id, created_at)
             SELECT :into, song_id, created_at FROM favorites WHERE user_id = :from`, params);
    run(db, `INSERT OR IGNORE INTO reactions (user_id, song_id, value, created_at)
             SELECT :into, song_id, value, created_at FROM reactions WHERE user_id = :from`, params);
    run(db, `INSERT OR IGNORE INTO saves (user_id, song_id, created_at, yt_item_id)
             SELECT :into, song_id, created_at, NULL FROM saves WHERE user_id = :from`, params);
    run(db, `INSERT OR IGNORE INTO views (user_id, song_id, seen_count, watched_sec, last_seen_at)
             SELECT :into, song_id, seen_count, watched_sec, last_seen_at FROM views WHERE user_id = :from`, params);
    run(db, `INSERT OR IGNORE INTO library (user_id, song_id, created_at)
             SELECT :into, song_id, created_at FROM library WHERE user_id = :from`, params);
    run(db, `INSERT OR IGNORE INTO playback_failures (user_id, song_id, code, created_at)
             SELECT :into, song_id, code, created_at FROM playback_failures WHERE user_id = :from`, params);
    run(db, 'UPDATE comments SET user_id = :into WHERE user_id = :from', params);
    run(db, 'UPDATE sessions SET user_id = :into WHERE user_id = :from', params);
    run(db, `UPDATE users SET onboarded_at = COALESCE(onboarded_at, (SELECT onboarded_at FROM users WHERE id = :from))
             WHERE id = :into`, params);
    // node:sqlite rejects named parameters a statement doesn't use, so pass only :from here.
    run(db, 'DELETE FROM users WHERE id = :from', { from: fromId });
  });
}
