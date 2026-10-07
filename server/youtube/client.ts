// Thin wrapper around Google OAuth and the YouTube Data API v3.
// Everything goes through an injectable fetch so tests can fake Google.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Manage the YouTube account: read likes/playlists, rate videos, edit playlists. */
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';
const SCOPES = ['openid', 'email', 'profile', YOUTUBE_SCOPE];

export interface YouTubeClientOptions {
  apiKey: string | null;
  clientId: string | null;
  clientSecret: string | null;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** How a request is authorised: the server's API key, or a user's OAuth access token. */
export type Credentials = { kind: 'key' } | { kind: 'token'; accessToken: string };

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export interface GoogleUserInfo {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

export interface YtThumbnail {
  url: string;
  width?: number;
  height?: number;
}

export interface YtVideo {
  id: string;
  snippet?: {
    title: string;
    channelId?: string;
    channelTitle?: string;
    categoryId?: string;
    publishedAt?: string;
    liveBroadcastContent?: string;
    thumbnails?: Record<string, YtThumbnail | undefined>;
  };
  contentDetails?: { duration?: string };
  status?: { embeddable?: boolean; privacyStatus?: string };
  statistics?: { viewCount?: string };
  topicDetails?: { topicCategories?: string[] };
}

export interface YtPlaylist {
  id: string;
  snippet?: { title: string; thumbnails?: Record<string, YtThumbnail | undefined> };
  contentDetails?: { itemCount?: number };
}

export interface YtPlaylistItem {
  id: string;
  snippet?: { title?: string; resourceId?: { videoId?: string } };
  contentDetails?: { videoId?: string };
}

export interface Page<T> {
  items: T[];
  nextPageToken: string | null;
}

export class YouTubeApiError extends Error {
  readonly status: number;
  readonly reason: string | null;

  constructor(status: number, message: string, reason: string | null) {
    super(message);
    this.status = status;
    this.reason = reason;
  }

  get isQuota(): boolean {
    return this.reason === 'quotaExceeded' || this.reason === 'dailyLimitExceeded' || this.reason === 'rateLimitExceeded';
  }
}

const API = 'https://www.googleapis.com/youtube/v3';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const OEMBED_URL = 'https://www.youtube.com/oembed';

const VIDEO_PARTS = 'snippet,contentDetails,status,statistics,topicDetails';

type Params = Record<string, string | number | boolean | undefined>;

export class YouTubeClient {
  private readonly apiKey: string | null;
  private readonly clientId: string | null;
  private readonly clientSecret: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: YouTubeClientOptions) {
    this.apiKey = opts.apiKey;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  get oauthEnabled(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  get apiKeyEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  // --- OAuth ---------------------------------------------------------------

  authUrl(opts: { redirectUri: string; state: string; codeChallenge: string; loginHint?: string }): string {
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.clientId ?? '',
      redirect_uri: opts.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      state: opts.state,
      code_challenge: opts.codeChallenge,
      code_challenge_method: 'S256',
      ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
    }).toString();
    return url.toString();
  }

  exchangeCode(opts: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenResponse> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code: opts.code,
      code_verifier: opts.codeVerifier,
      redirect_uri: opts.redirectUri,
    });
  }

  refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async revoke(token: string): Promise<void> {
    await this.fetchImpl(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  async userInfo(accessToken: string): Promise<GoogleUserInfo> {
    const res = await this.fetchImpl(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as GoogleUserInfo;
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId ?? '',
        client_secret: this.clientSecret ?? '',
        ...params,
      }).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as TokenResponse;
  }

  // --- Data API ------------------------------------------------------------

  private async request<T>(method: string, path: string, params: Params, creds: Credentials, body?: unknown): Promise<T> {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (creds.kind === 'key') {
      if (!this.apiKey) throw new YouTubeApiError(401, 'No YouTube API key configured', 'noApiKey');
      url.searchParams.set('key', this.apiKey);
    } else {
      headers.Authorization = `Bearer ${creds.accessToken}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await toApiError(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Full details for up to any number of videos (batched 50 at a time). Missing videos are omitted. */
  async videos(ids: string[], creds: Credentials): Promise<YtVideo[]> {
    const out: YtVideo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const data = await this.request<{ items?: YtVideo[] }>(
        'GET',
        '/videos',
        { part: VIDEO_PARTS, id: chunk.join(','), maxResults: 50 },
        creds,
      );
      out.push(...(data.items ?? []));
    }
    return out;
  }

  async likedVideos(creds: Credentials, pageToken?: string): Promise<Page<YtVideo>> {
    const data = await this.request<{ items?: YtVideo[]; nextPageToken?: string }>(
      'GET',
      '/videos',
      { part: VIDEO_PARTS, myRating: 'like', maxResults: 50, pageToken },
      creds,
    );
    return { items: data.items ?? [], nextPageToken: data.nextPageToken ?? null };
  }

  async myPlaylists(creds: Credentials, pageToken?: string): Promise<Page<YtPlaylist>> {
    const data = await this.request<{ items?: YtPlaylist[]; nextPageToken?: string }>(
      'GET',
      '/playlists',
      { part: 'snippet,contentDetails', mine: true, maxResults: 50, pageToken },
      creds,
    );
    return { items: data.items ?? [], nextPageToken: data.nextPageToken ?? null };
  }

  async playlistInfo(playlistId: string, creds: Credentials): Promise<YtPlaylist | null> {
    const data = await this.request<{ items?: YtPlaylist[] }>(
      'GET',
      '/playlists',
      { part: 'snippet,contentDetails', id: playlistId, maxResults: 1 },
      creds,
    );
    return data.items?.[0] ?? null;
  }

  async playlistItems(playlistId: string, creds: Credentials, pageToken?: string, maxResults = 50): Promise<Page<YtPlaylistItem>> {
    const data = await this.request<{ items?: YtPlaylistItem[]; nextPageToken?: string }>(
      'GET',
      '/playlistItems',
      { part: 'snippet,contentDetails', playlistId, maxResults, pageToken },
      creds,
    );
    return { items: data.items ?? [], nextPageToken: data.nextPageToken ?? null };
  }

  /** Video ids of music search results. Costs 100 quota units. */
  async search(query: string, creds: Credentials, maxResults = 15): Promise<string[]> {
    const data = await this.request<{ items?: { id?: { videoId?: string } }[] }>(
      'GET',
      '/search',
      { part: 'snippet', q: query, type: 'video', videoCategoryId: 10, videoEmbeddable: true, maxResults },
      creds,
    );
    return (data.items ?? []).map((i) => i.id?.videoId).filter((id): id is string => Boolean(id));
  }

  /** The most popular music videos in a region right now. */
  async musicChart(regionCode: string, creds: Credentials, maxResults = 50): Promise<YtVideo[]> {
    const data = await this.request<{ items?: YtVideo[] }>(
      'GET',
      '/videos',
      { part: VIDEO_PARTS, chart: 'mostPopular', videoCategoryId: 10, regionCode, maxResults },
      creds,
    );
    return data.items ?? [];
  }

  rate(videoId: string, rating: 'like' | 'dislike' | 'none', creds: Credentials): Promise<void> {
    return this.request('POST', '/videos/rate', { id: videoId, rating }, creds);
  }

  async createPlaylist(title: string, description: string, creds: Credentials): Promise<string> {
    const data = await this.request<{ id: string }>(
      'POST',
      '/playlists',
      { part: 'snippet,status' },
      creds,
      { snippet: { title, description }, status: { privacyStatus: 'private' } },
    );
    return data.id;
  }

  async addToPlaylist(playlistId: string, videoId: string, creds: Credentials): Promise<string> {
    const data = await this.request<{ id: string }>(
      'POST',
      '/playlistItems',
      { part: 'snippet' },
      creds,
      { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
    );
    return data.id;
  }

  deletePlaylistItem(itemId: string, creds: Credentials): Promise<void> {
    return this.request('DELETE', '/playlistItems', { id: itemId }, creds);
  }

  /** Title and channel for a public video, without needing an API key. */
  async oembed(videoId: string): Promise<{ title: string; author_name: string } | null> {
    const url = `${OEMBED_URL}?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) return null;
      const data = (await res.json()) as { title?: unknown; author_name?: unknown };
      if (typeof data.title !== 'string') return null;
      return { title: data.title, author_name: typeof data.author_name === 'string' ? data.author_name : '' };
    } catch {
      return null;
    }
  }
}

async function toApiError(res: Response): Promise<YouTubeApiError> {
  let message = `${res.status} ${res.statusText}`;
  let reason: string | null = null;
  try {
    const body = (await res.json()) as {
      error?: string | { message?: string; errors?: { reason?: string }[]; status?: string };
      error_description?: string;
    };
    if (typeof body.error === 'string') {
      // OAuth endpoints: { error: "invalid_grant", error_description: "..." }
      reason = body.error;
      message = body.error_description ?? body.error;
    } else if (body.error) {
      message = body.error.message ?? message;
      reason = body.error.errors?.[0]?.reason ?? body.error.status ?? null;
    }
  } catch {
    // not JSON
  }
  return new YouTubeApiError(res.status, message, reason);
}
