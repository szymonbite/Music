import path from 'node:path';

export interface AppConfig {
  port: number;
  isProduction: boolean;
  /** Public base URL without a trailing slash, or null to derive it from each request. */
  appUrl: string | null;
  databasePath: string;
  cookieSecure: boolean;
  /** Value for Express' "trust proxy" setting. */
  trustProxy: boolean | number | string;
  youtube: {
    apiKey: string | null;
    clientId: string | null;
    clientSecret: string | null;
    /** Spend search quota (100 units/call) on genre-based discovery. */
    discoverySearch: boolean;
  };
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  const v = nonEmpty(value);
  if (!v) return false;
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  return v;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): AppConfig {
  const isProduction = argv.includes('--prod') || env.NODE_ENV === 'production';
  const appUrl = nonEmpty(env.APP_URL)?.replace(/\/+$/, '') ?? null;
  const databasePath = nonEmpty(env.DATABASE_PATH) ?? path.resolve('data', 'earworm.db');
  return {
    port: Number(env.PORT) || 3000,
    isProduction,
    appUrl,
    databasePath,
    cookieSecure: bool(env.COOKIE_SECURE, appUrl?.startsWith('https://') ?? false),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    youtube: {
      apiKey: nonEmpty(env.YOUTUBE_API_KEY),
      clientId: nonEmpty(env.GOOGLE_CLIENT_ID),
      clientSecret: nonEmpty(env.GOOGLE_CLIENT_SECRET),
      discoverySearch: bool(env.YOUTUBE_DISCOVERY_SEARCH, false),
    },
  };
}
