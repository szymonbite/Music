import type { AppConfig } from './config.ts';
import type { DB } from './db.ts';
import type { SimilarArtists } from './similar.ts';
import type { YouTubeService } from './youtube/service.ts';

/** Everything route handlers need. Injected so tests can control time, randomness and YouTube. */
export interface AppContext {
  db: DB;
  config: AppConfig;
  youtube: YouTubeService;
  similar: SimilarArtists;
  now: () => number;
  random: () => number;
}
