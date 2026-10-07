import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';

export type DB = DatabaseSync;

/**
 * Loads Node's built-in SQLite module, hiding the one-off "experimental
 * feature" warning it prints. Loaded lazily so the filter is in place first.
 */
function loadSqlite(): typeof import('node:sqlite') {
  const require = createRequire(import.meta.url);
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message;
    if (message.includes('SQLite is an experimental feature')) return;
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}
export type Params = SQLInputValue[] | Record<string, SQLInputValue>;

/** Schema migrations, applied in order. Never edit a shipped migration; append a new one. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    onboarded_at INTEGER,
    settings TEXT NOT NULL DEFAULT '{}',
    google_sub TEXT UNIQUE,
    google_email TEXT,
    google_name TEXT,
    google_picture TEXT,
    yt_access_token TEXT,
    yt_refresh_token TEXT,
    yt_token_expires_at INTEGER,
    yt_playlist_id TEXT,
    yt_discovered_at INTEGER
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_verifier TEXT NOT NULL,
    return_to TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE songs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    channel_id TEXT,
    channel_title TEXT,
    duration_sec INTEGER,
    year INTEGER,
    genres TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    thumbnail_url TEXT,
    source TEXT NOT NULL,
    popularity REAL NOT NULL DEFAULT 0.5,
    trending_at INTEGER,
    unavailable INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE favorites (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL REFERENCES songs(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, song_id)
  );

  CREATE TABLE reactions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL REFERENCES songs(id),
    value INTEGER NOT NULL CHECK (value IN (-1, 1)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, song_id)
  );
  CREATE INDEX reactions_song ON reactions(song_id, value);

  CREATE TABLE saves (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL REFERENCES songs(id),
    created_at INTEGER NOT NULL,
    yt_item_id TEXT,
    PRIMARY KEY (user_id, song_id)
  );
  CREATE INDEX saves_song ON saves(song_id);

  CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id TEXT NOT NULL REFERENCES songs(id),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX comments_song ON comments(song_id, id);
  CREATE INDEX comments_user ON comments(user_id);

  CREATE TABLE views (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL REFERENCES songs(id),
    seen_count INTEGER NOT NULL DEFAULT 0,
    watched_sec INTEGER NOT NULL DEFAULT 0,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, song_id)
  );

  CREATE TABLE library (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL REFERENCES songs(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, song_id)
  );

  CREATE TABLE playback_failures (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL REFERENCES songs(id),
    code INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, song_id)
  );

  CREATE TABLE fetch_log (
    key TEXT PRIMARY KEY,
    fetched_at INTEGER NOT NULL
  );
  `,
];

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new (loadSqlite().DatabaseSync)(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const { user_version: version } = get<{ user_version: number }>(db, 'PRAGMA user_version')!;
  for (let i = version; i < MIGRATIONS.length; i++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}

const statements = new WeakMap<DB, Map<string, StatementSync>>();

function prepare(db: DB, sql: string): StatementSync {
  let byDb = statements.get(db);
  if (!byDb) {
    byDb = new Map();
    statements.set(db, byDb);
  }
  let stmt = byDb.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    byDb.set(sql, stmt);
  }
  return stmt;
}

export function run(db: DB, sql: string, params: Params = []): { changes: number; lastInsertRowid: number } {
  const stmt = prepare(db, sql);
  const result = Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}

export function get<T>(db: DB, sql: string, params: Params = []): T | undefined {
  const stmt = prepare(db, sql);
  return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) as T | undefined;
}

export function all<T>(db: DB, sql: string, params: Params = []): T[] {
  const stmt = prepare(db, sql);
  return (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as T[];
}

const depth = new WeakMap<DB, number>();

/** Runs fn in a transaction (or a savepoint when nested). */
export function transaction<T>(db: DB, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const savepoint = `sp_${level}`;
  db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  depth.set(db, level + 1);
  try {
    const result = fn();
    db.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    throw err;
  } finally {
    depth.set(db, level);
  }
}

/** Builds "?, ?, ?" for an IN (...) clause. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
