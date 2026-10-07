import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { migrate, type DB } from './db.ts';

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

/** Opens (or creates) the server's SQLite database and brings its schema up to date. */
export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new (loadSqlite().DatabaseSync)(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}
