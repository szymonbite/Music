import type { FetchLike, YtPlaylist, YtVideo } from '../youtube/client.ts';

export interface RecordedCall {
  method: string;
  url: URL;
  body: string | null;
  authorization: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function apiError(status: number, reason: string): Response {
  return json({ error: { code: status, message: reason, errors: [{ reason }] } }, status);
}

export function fakeVideo(
  id: string,
  title: string,
  channelTitle: string,
  opts: { categoryId?: string; duration?: string; views?: number; topics?: string[]; embeddable?: boolean; channelId?: string } = {},
): YtVideo {
  return {
    id,
    snippet: {
      title,
      channelTitle,
      channelId: opts.channelId ?? `UC${id}chan`,
      categoryId: opts.categoryId ?? '10',
      publishedAt: '2021-06-01T00:00:00Z',
      liveBroadcastContent: 'none',
      thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } },
    },
    contentDetails: { duration: opts.duration ?? 'PT3M30S' },
    status: { embeddable: opts.embeddable ?? true, privacyStatus: 'public' },
    statistics: { viewCount: String(opts.views ?? 1_000_000) },
    topicDetails: { topicCategories: opts.topics ?? ['https://en.wikipedia.org/wiki/Pop_music'] },
  };
}

/**
 * An in-memory stand-in for Google OAuth, the YouTube Data API and oEmbed.
 * Every request is recorded in `calls`.
 */
export class FakeGoogle {
  calls: RecordedCall[] = [];
  videos = new Map<string, YtVideo>();
  liked: string[] = [];
  playlists: YtPlaylist[] = [];
  playlistItems = new Map<string, string[]>();
  chart: string[] = [];
  searchResults: string[] = [];
  profile = { sub: 'google-user-1', email: 'listener@example.com', name: 'Test Listener', picture: 'https://example.com/me.png' };
  validCode = 'good-code';
  accessToken = 'access-1';
  refreshToken = 'refresh-1';
  failRefresh = false;
  grantedScope = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/youtube';
  createdPlaylists: string[] = [];
  private itemCounter = 0;

  addVideos(...videos: YtVideo[]): void {
    for (const v of videos) this.videos.set(v.id, v);
  }

  callsTo(path: string, method?: string): RecordedCall[] {
    return this.calls.filter((c) => `${c.url.origin}${c.url.pathname}`.endsWith(path) && (!method || c.method === method));
  }

  fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : null;
    const headers = new Headers(init?.headers);
    this.calls.push({ method, url, body, authorization: headers.get('Authorization') });

    if (url.href.startsWith('https://oauth2.googleapis.com/token')) return this.token(new URLSearchParams(body ?? ''));
    if (url.href.startsWith('https://oauth2.googleapis.com/revoke')) return new Response('', { status: 200 });
    if (url.href.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
      return headers.get('Authorization') === `Bearer ${this.accessToken}` ? json(this.profile) : json({ error: 'invalid_token' }, 401);
    }
    if (url.href.startsWith('https://www.youtube.com/oembed')) {
      const id = new URL(url.searchParams.get('url') ?? '').searchParams.get('v') ?? '';
      const video = this.videos.get(id);
      return video ? json({ title: video.snippet?.title, author_name: video.snippet?.channelTitle }) : new Response('Not Found', { status: 404 });
    }
    if (url.href.startsWith('https://www.googleapis.com/youtube/v3/')) {
      const authorized = url.searchParams.has('key') || headers.get('Authorization') === `Bearer ${this.accessToken}`;
      if (!authorized) return apiError(401, 'authError');
      return this.youtube(method, url.pathname.replace('/youtube/v3', ''), url.searchParams, body);
    }
    return new Response('Not Found', { status: 404 });
  };

  private token(params: URLSearchParams): Response {
    if (params.get('grant_type') === 'authorization_code') {
      if (params.get('code') !== this.validCode || !params.get('code_verifier')) {
        return json({ error: 'invalid_grant', error_description: 'Bad code' }, 400);
      }
      return json({
        access_token: this.accessToken,
        refresh_token: this.refreshToken,
        expires_in: 3600,
        scope: this.grantedScope,
        token_type: 'Bearer',
      });
    }
    if (params.get('grant_type') === 'refresh_token') {
      if (this.failRefresh || params.get('refresh_token') !== this.refreshToken) {
        return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
      }
      this.accessToken = `access-${Number(this.accessToken.split('-')[1]) + 1}`;
      return json({ access_token: this.accessToken, expires_in: 3600, token_type: 'Bearer' });
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  }

  private youtube(method: string, path: string, q: URLSearchParams, body: string | null): Response {
    const items = (ids: string[]) => ids.map((id) => this.videos.get(id)).filter(Boolean);
    if (method === 'GET' && path === '/videos') {
      if (q.get('myRating') === 'like') return json({ items: items(this.liked) });
      if (q.get('chart') === 'mostPopular') return json({ items: items(this.chart) });
      return json({ items: items((q.get('id') ?? '').split(',')) });
    }
    if (method === 'GET' && path === '/playlists') {
      if (q.get('mine') === 'true') return json({ items: this.playlists });
      return json({ items: this.playlists.filter((p) => p.id === q.get('id')) });
    }
    if (method === 'GET' && path === '/playlistItems') {
      const ids = this.playlistItems.get(q.get('playlistId') ?? '');
      if (!ids) return apiError(404, 'playlistNotFound');
      return json({ items: ids.map((videoId, i) => ({ id: `pi-${i}`, contentDetails: { videoId } })) });
    }
    if (method === 'GET' && path === '/search') {
      return json({ items: this.searchResults.map((videoId) => ({ id: { kind: 'youtube#video', videoId } })) });
    }
    if (method === 'POST' && path === '/videos/rate') return new Response(null, { status: 204 });
    if (method === 'POST' && path === '/playlists') {
      const id = `PLearworm${this.createdPlaylists.length + 1}`;
      this.createdPlaylists.push(id);
      this.playlistItems.set(id, []);
      return json({ id });
    }
    if (method === 'POST' && path === '/playlistItems') {
      const snippet = (JSON.parse(body ?? '{}') as { snippet: { playlistId: string; resourceId: { videoId: string } } }).snippet;
      const list = this.playlistItems.get(snippet.playlistId);
      if (!list) return apiError(404, 'playlistNotFound');
      list.push(snippet.resourceId.videoId);
      return json({ id: `item-${++this.itemCounter}` });
    }
    if (method === 'DELETE' && path === '/playlistItems') return new Response(null, { status: 204 });
    return apiError(404, 'notFound');
  }
}
