import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { createApp } from './app.ts';
import { loadCatalog, seedCatalog } from './catalog.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { DeezerProvider, LastFmProvider, SimilarArtists } from './similar.ts';
import { YouTubeClient } from './youtube/client.ts';
import { YouTubeService } from './youtube/service.ts';

function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const now = () => Date.now();

  const db = openDb(config.databasePath);
  seedCatalog(db, loadCatalog(), now());

  const youtube = new YouTubeService({
    db,
    now,
    discoverySearch: config.youtube.discoverySearch,
    dailySearchBudget: config.youtube.dailySearchBudget,
    client: new YouTubeClient({
      apiKey: config.youtube.apiKey,
      clientId: config.youtube.clientId,
      clientSecret: config.youtube.clientSecret,
    }),
  });

  const { provider: similarProvider, lastfmApiKey } = config.similarArtists;
  const similar = new SimilarArtists({
    db,
    now,
    provider:
      similarProvider === 'lastfm' && lastfmApiKey
        ? new LastFmProvider(lastfmApiKey)
        : similarProvider === 'deezer'
          ? new DeezerProvider()
          : null,
  });

  const app = createApp({ db, config, youtube, similar, now, random: Math.random });
  const server = http.createServer(app);
  let closeVite: () => Promise<void> = async () => {};

  if (config.isProduction) {
    const dist = path.resolve('dist');
    if (!fs.existsSync(path.join(dist, 'index.html'))) {
      console.error('No built client found in ./dist. Run `npm run build` first.');
      process.exit(1);
    }
    app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(dist, { index: false }));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    // Development: serve the React app through Vite on the same port as the API,
    // with hot reload riding on the same HTTP server (no extra WebSocket port).
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
    app.use(vite.middlewares);
    closeVite = () => vite.close();
  }

  server.listen(config.port, () => {
    const url = config.appUrl ?? `http://localhost:${config.port}`;
    console.log(`\n  🎧 Earworm is running at ${url} (${config.isProduction ? 'production' : 'development'})`);
    console.log(`     YouTube Music login: ${youtube.loginEnabled ? 'on' : 'off (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)'}`);
    console.log(`     YouTube search:      ${youtube.searchEnabled ? 'on' : 'off (set YOUTUBE_API_KEY)'}`);
    console.log(`     Similar artists:     ${similar.providerName ?? 'off'}\n`);
  });

  if (youtube.searchEnabled) {
    youtube.hydrateCatalog().catch((err: unknown) => {
      console.warn('Could not refresh catalogue songs from YouTube:', err instanceof Error ? err.message : err);
    });
  }

  const shutdown = () => {
    void closeVite();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
