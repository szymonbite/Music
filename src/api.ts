import type {
  Comment,
  CommentLikeResponse,
  CommentsPage,
  FeedItem,
  FeedRequest,
  FeedResponse,
  FollowResponse,
  GenreCount,
  LibraryKind,
  LibraryResponse,
  MePatch,
  MeResponse,
  PeopleResponse,
  ReactionResponse,
  ReactionValue,
  RepliesResponse,
  ResolveResponse,
  SaveResponse,
  SearchResponse,
  SeenRequest,
  Song,
  UserProfile,
  YouTubeLibrary,
} from '../shared/types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Transport = (url: string, init: RequestInit) => Promise<Response>;

let transport: Transport = (url, init) => fetch(url, init);

/** Sends API calls somewhere other than the network: the Android app's built-in backend. */
export function setApiTransport(next: Transport): void {
  transport = next;
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await transport(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    });
  } catch {
    throw new ApiError(0, 'network', 'You seem to be offline. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, err.error ?? 'error', err.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  me: () => request<MeResponse>('GET', '/me'),
  updateMe: (patch: MePatch) => request<MeResponse>('PATCH', '/me', patch),
  logout: () => request<void>('POST', '/auth/logout'),
  disconnectYouTube: () => request<MeResponse>('POST', '/auth/google/disconnect'),
  /** Android app only: connects YouTube Music through Google's account picker. */
  connectYouTubeNative: () => request<MeResponse>('POST', '/auth/native'),

  feed: (req: FeedRequest) => request<FeedResponse>('POST', '/feed', req),
  song: (id: string) => request<FeedItem>('GET', `/songs/${enc(id)}`),
  react: (id: string, value: ReactionValue) => request<ReactionResponse>('PUT', `/songs/${enc(id)}/reaction`, { value }),
  save: (id: string, saved: boolean) => request<SaveResponse>('PUT', `/songs/${enc(id)}/save`, { saved }),
  /** Fire-and-forget: survives the page being closed. */
  seen: (id: string, report: SeenRequest) =>
    request<void>('POST', `/songs/${enc(id)}/seen`, { ...report, watchedSec: Math.round(report.watchedSec) }, { keepalive: true }).catch(
      () => {},
    ),
  unavailable: (id: string, code: number) =>
    request<void>('POST', `/songs/${enc(id)}/unavailable`, { code }).catch(() => {}),

  comments: (id: string, cursor?: number | null) =>
    request<CommentsPage>('GET', `/songs/${enc(id)}/comments${cursor ? `?cursor=${cursor}` : ''}`),
  postComment: (id: string, body: string, parentId?: number) =>
    request<Comment>('POST', `/songs/${enc(id)}/comments`, parentId ? { body, parentId } : { body }),
  deleteComment: (commentId: number) => request<void>('DELETE', `/comments/${commentId}`),
  replies: (commentId: number) => request<RepliesResponse>('GET', `/comments/${commentId}/replies`),
  likeComment: (commentId: number, liked: boolean) =>
    request<CommentLikeResponse>('PUT', `/comments/${commentId}/like`, { liked }),

  people: (q = '') => request<PeopleResponse>('GET', `/users${q ? `?q=${enc(q)}` : ''}`),
  user: (id: string) => request<UserProfile>('GET', `/users/${enc(id)}`),
  follow: (id: string, following: boolean) => request<FollowResponse>('PUT', `/users/${enc(id)}/follow`, { following }),

  genres: () => request<{ genres: GenreCount[] }>('GET', '/genres'),
  starter: (genre?: string | null) =>
    request<{ songs: Song[] }>('GET', `/songs/starter${genre ? `?genre=${enc(genre)}` : ''}`),
  search: (q: string, remote: boolean) =>
    request<SearchResponse>('GET', `/songs/search?q=${enc(q)}${remote ? '&remote=1' : ''}`),
  resolve: (url: string) => request<ResolveResponse>('POST', '/songs/resolve', { url }),

  favorites: () => request<{ songs: Song[] }>('GET', '/favorites'),
  setFavorites: (songIds: string[]) => request<{ songs: Song[] }>('PUT', '/favorites', { songIds }),
  setFavorite: (id: string, favorite: boolean) =>
    request<{ favorite: boolean }>('PUT', `/favorites/${enc(id)}`, { favorite }),
  library: (kind: LibraryKind) => request<LibraryResponse>('GET', `/library/${kind}`),

  youtubeLibrary: () => request<YouTubeLibrary>('GET', '/youtube/library'),
  youtubePlaylist: (id: string) => request<ResolveResponse>('GET', `/youtube/playlists/${enc(id)}`),
};

/** Where to send the browser to connect YouTube Music. */
export function connectYouTubeUrl(returnTo: string): string {
  return `/api/auth/google?returnTo=${enc(returnTo)}`;
}
