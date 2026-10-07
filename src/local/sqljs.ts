// Earworm's database inside the Android app: SQLite compiled to WebAssembly
// (sql.js), wrapped in the same small interface the server uses for Node's
// built-in SQLite, so all of the server's queries run unchanged.
//
// sql.js keeps the database in memory. The app saves a copy to IndexedDB
// shortly after every change (see persist.ts) and loads it on start.

import initSqlJs from 'sql.js';
import { migrate, type DB, type Statement } from '../../server/db.ts';

type SqlJsDatabase = initSqlJs.Database;
type SqlJsStatement = initSqlJs.Statement;

function isNamedParams(params: unknown[]): params is [Record<string, unknown>] {
  const [first] = params;
  return params.length === 1 && first !== null && typeof first === 'object' && !Array.isArray(first) && !(first instanceof Uint8Array);
}

function toSqlValue(value: unknown): initSqlJs.SqlValue {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value as initSqlJs.SqlValue;
}

/** A prepared statement that re-prepares itself after the database was exported (which frees statements). */
class SqlJsStatementAdapter implements Statement {
  private stmt: SqlJsStatement | null = null;
  private generation = -1;
  private readonly owner: SqlJsDb;
  private readonly sql: string;

  constructor(owner: SqlJsDb, sql: string) {
    this.owner = owner;
    this.sql = sql;
  }

  private bound(params: unknown[]): SqlJsStatement {
    if (!this.stmt || this.generation !== this.owner.generation) {
      this.stmt = this.owner.raw.prepare(this.sql);
      this.generation = this.owner.generation;
    }
    if (isNamedParams(params)) {
      // node:sqlite takes { id: 1 } for ":id"; sql.js wants the prefix in the key.
      const named: Record<string, initSqlJs.SqlValue> = {};
      for (const [key, value] of Object.entries(params[0])) named[/^[:@$]/.test(key) ? key : `:${key}`] = toSqlValue(value);
      this.stmt.bind(named);
    } else {
      this.stmt.bind(params.map(toSqlValue));
    }
    return this.stmt;
  }

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const stmt = this.bound(params);
    try {
      stmt.step();
    } finally {
      stmt.reset();
    }
    this.owner.changed();
    return { changes: this.owner.raw.getRowsModified(), lastInsertRowid: this.owner.lastInsertRowid() };
  }

  get(...params: unknown[]): unknown {
    const stmt = this.bound(params);
    try {
      return stmt.step() ? stmt.getAsObject() : undefined;
    } finally {
      stmt.reset();
    }
  }

  all(...params: unknown[]): unknown[] {
    const stmt = this.bound(params);
    const rows: unknown[] = [];
    try {
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.reset();
    }
    return rows;
  }
}

export class SqlJsDb implements DB {
  raw: SqlJsDatabase;
  /** Bumped whenever sql.js frees our prepared statements. */
  generation = 0;
  /** Called after anything that may have changed the data. */
  onChange: () => void = () => {};
  private rowidStmt: { stmt: SqlJsStatement; generation: number } | null = null;

  constructor(raw: SqlJsDatabase) {
    this.raw = raw;
    this.configure();
  }

  private configure(): void {
    this.raw.exec('PRAGMA foreign_keys = ON;');
  }

  changed(): void {
    this.onChange();
  }

  lastInsertRowid(): number {
    if (!this.rowidStmt || this.rowidStmt.generation !== this.generation) {
      this.rowidStmt = { stmt: this.raw.prepare('SELECT last_insert_rowid() AS id'), generation: this.generation };
    }
    const { stmt } = this.rowidStmt;
    try {
      stmt.step();
      return Number(stmt.getAsObject().id);
    } finally {
      stmt.reset();
    }
  }

  exec(sql: string): void {
    this.raw.exec(sql);
    this.changed();
  }

  prepare(sql: string): Statement {
    return new SqlJsStatementAdapter(this, sql);
  }

  /** The whole database file. Must not be called inside a transaction. */
  export(): Uint8Array {
    const bytes = this.raw.export();
    // export() closes and reopens the database: statements are freed and pragmas reset.
    this.generation++;
    this.configure();
    return bytes;
  }

  close(): void {
    this.raw.close();
  }
}

let sqlJs: Promise<initSqlJs.SqlJsStatic> | null = null;

/**
 * Opens a database from a saved copy (or a fresh one) and brings its schema up to date.
 * `wasmUrl` is where the browser finds sql.js' WebAssembly file; Node finds it on its own.
 */
export async function openSqlJsDb(saved: Uint8Array | null, wasmUrl?: string): Promise<SqlJsDb> {
  sqlJs ??= initSqlJs(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
  const SQL = await sqlJs;
  const db = new SqlJsDb(saved ? new SQL.Database(saved) : new SQL.Database());
  migrate(db);
  return db;
}
