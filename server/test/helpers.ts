import request from 'supertest';
import { createApp } from '../app.ts';
import { loadCatalog, seedCatalog, type CatalogEntry } from '../catalog.ts';
import { loadConfig, type AppConfig } from '../config.ts';
import type { AppContext } from '../context.ts';
import { openDb } from '../db.ts';
import { YouTubeClient, type FetchLike } from '../youtube/client.ts';
import { YouTubeService } from '../youtube/service.ts';

/** Deterministic pseudo-random numbers. */
export function seeded(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const offline: FetchLike = async (input) => {
  throw new Error(`Unexpected network request in a test: ${input}`);
};

export interface TestOptions {
  fetch?: FetchLike;
  apiKey?: string;
  oauth?: boolean;
  catalog?: CatalogEntry[];
  config?: Partial<AppConfig>;
  discoverySearch?: boolean;
}

/** A fully wired app on an in-memory database with a controllable clock. */
export function createTestApp(opts: TestOptions = {}) {
  let now = Date.UTC(2026, 9, 7, 12, 0, 0);
  const clock = () => now;
  const db = openDb(':memory:');
  seedCatalog(db, opts.catalog ?? loadCatalog(), clock());
  const config: AppConfig = { ...loadConfig({}, []), appUrl: 'http://localhost:3000', ...opts.config };
  const youtube = new YouTubeService({
    db,
    now: clock,
    discoverySearch: opts.discoverySearch ?? false,
    client: new YouTubeClient({
      apiKey: opts.apiKey ?? null,
      clientId: opts.oauth ? 'test-client-id' : null,
      clientSecret: opts.oauth ? 'test-client-secret' : null,
      fetch: opts.fetch ?? offline,
    }),
  });
  const ctx: AppContext = { db, config, youtube, now: clock, random: seeded() };
  const app = createApp(ctx);
  return {
    app,
    db,
    ctx,
    advance(ms: number) {
      now += ms;
    },
    /** A browser-like client with its own cookie jar, already holding a guest session. */
    async listener(headers: Record<string, string> = {}) {
      const agent = request.agent(app);
      const res = await agent.get('/api/me').set(headers).expect(200);
      return { agent, me: res.body.me as { id: string } };
    },
  };
}

export function entry(id: string, artist: string, title: string, genres: string[], year = 2015): CatalogEntry {
  return { id, artist, title, genres, tags: [], year };
}
