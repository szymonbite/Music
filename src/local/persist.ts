// Keeps the app's database on the phone: a copy is saved to IndexedDB shortly
// after every change, and loaded again when the app starts.

import type { SqlJsDb } from './sqljs.ts';

export interface DbStorage {
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
}

const IDB_NAME = 'earworm';
const STORE = 'files';
const KEY = 'earworm.db';

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Couldn’t open storage'));
  });
}

/** Stores the database file in IndexedDB. */
export function indexedDbStorage(): DbStorage {
  let idb: Promise<IDBDatabase> | null = null;
  const store = async (mode: IDBTransactionMode) => {
    idb ??= openIdb();
    return (await idb).transaction(STORE, mode).objectStore(STORE);
  };
  return {
    async load() {
      const os = await store('readonly');
      return new Promise((resolve, reject) => {
        const request = os.get(KEY);
        request.onsuccess = () => resolve(request.result instanceof Uint8Array ? request.result : null);
        request.onerror = () => reject(request.error ?? new Error('Couldn’t read storage'));
      });
    },
    async save(bytes) {
      const os = await store('readwrite');
      return new Promise((resolve, reject) => {
        const request = os.put(bytes, KEY);
        request.transaction!.oncomplete = () => resolve();
        request.transaction!.onerror = () => reject(request.error ?? new Error('Couldn’t write storage'));
      });
    },
  };
}

/** In-memory storage, for tests. */
export function memoryStorage(): DbStorage & { saves: number } {
  let saved: Uint8Array | null = null;
  return {
    saves: 0,
    async load() {
      return saved;
    },
    async save(bytes) {
      saved = bytes;
      this.saves++;
    },
  };
}

/**
 * Saves the database a moment after it changes: after `delayMs` of quiet, or
 * at most `maxDelayMs` after the first unsaved change, so a busy stretch of
 * scrolling still gets saved regularly.
 */
export class AutoSaver {
  private readonly db: SqlJsDb;
  private readonly storage: DbStorage;
  private readonly delayMs: number;
  private readonly maxDelayMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstChangeAt: number | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(db: SqlJsDb, storage: DbStorage, opts: { delayMs?: number; maxDelayMs?: number } = {}) {
    this.db = db;
    this.storage = storage;
    this.delayMs = opts.delayMs ?? 1000;
    this.maxDelayMs = opts.maxDelayMs ?? 4000;
    db.onChange = () => this.schedule();
  }

  private schedule(): void {
    const now = Date.now();
    this.firstChangeAt ??= now;
    clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.delayMs, this.firstChangeAt + this.maxDelayMs - now));
    this.timer = setTimeout(() => void this.flush(), wait);
  }

  /** Saves now if anything changed. Resolves once every save so far has been written. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.firstChangeAt === null) return this.saving;
    this.firstChangeAt = null;
    // Snapshot synchronously, so the copy is consistent; write in order.
    const bytes = this.db.export();
    this.saving = this.saving
      .then(() => this.storage.save(bytes))
      .catch((err: unknown) => console.error('Saving Earworm’s data failed:', err));
    return this.saving;
  }
}
