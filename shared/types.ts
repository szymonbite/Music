// Types shared by the API server and the web client.

/** 1 = like, -1 = dislike, 0 = no reaction. */
export type ReactionValue = -1 | 0 | 1;

export type SongSource = 'catalog' | 'youtube' | 'link';

export interface Song {
  /** YouTube video id. */
  id: string;
  title: string;
  artist: string;
  year: number | null;
  durationSec: number | null;
  genres: string[];
  tags: string[];
  thumbnailUrl: string;
  source: SongSource;
  /** Where the hook is, learned from where listeners jump to. Null until enough people have voted. */
  hookSec: number | null;
}

export interface SongStats {
  likes: number;
  comments: number;
  saves: number;
}

export interface MySongState {
  reaction: ReactionValue;
  saved: boolean;
  favorite: boolean;
}

export interface FeedItem extends Song {
  stats: SongStats;
  me: MySongState;
  /** Short human explanation of why this song is in the feed. */
  reason: string;
}

/** "forYou" is the personalised feed; "friends" shows what people you follow liked and saved. */
export type FeedMode = 'forYou' | 'friends';

export interface FeedRequest {
  mode?: FeedMode;
  limit?: number;
  /** Song ids the client already has, so the server doesn't send them again. */
  exclude?: string[];
  /** Put this song first (used by shared links). */
  startWith?: string;
}

export interface FeedResponse {
  items: FeedItem[];
}

export interface UserSettings {
  /** Start songs a little way in, closer to the hook. */
  skipIntro: boolean;
  /** Scroll to the next song when the current one ends. */
  autoAdvance: boolean;
  /** Mirror likes and dislikes to YouTube Music. */
  syncReactions: boolean;
  /** Add saved songs to a playlist on YouTube Music. */
  syncSaves: boolean;
  /** ISO 3166-1 alpha-2 region used for trending charts. */
  region: string;
  /** Play a ~30 second highlight of each song instead of the whole thing. */
  previewMode: boolean;
  /** Let people who follow you see your recent likes and saves. */
  shareActivity: boolean;
}

export interface YouTubeConnection {
  email: string | null;
  name: string | null;
  pictureUrl: string | null;
  /** The playlist saved songs are added to, once it exists. */
  playlistUrl: string | null;
}

export interface Me {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  onboarded: boolean;
  settings: UserSettings;
  youtube: YouTubeConnection | null;
  /** The YouTube Music connection stopped working (e.g. Google expired it) and needs reconnecting. */
  youtubeExpired: boolean;
  counts: {
    favorites: number;
    likes: number;
    saves: number;
    comments: number;
    followers: number;
    following: number;
  };
}

export interface Features {
  /** Google OAuth is configured, so users can connect YouTube Music. */
  youtubeLogin: boolean;
  /** A YouTube Data API key is configured, so search works for everyone. */
  youtubeSearch: boolean;
}

export interface MeResponse {
  me: Me;
  features: Features;
}

export interface MePatch {
  displayName?: string;
  onboarded?: boolean;
  settings?: Partial<UserSettings>;
}

export interface CommentAuthor {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface Comment {
  id: number;
  songId: string;
  /** The top-level comment this replies to, or null for top-level comments. */
  parentId: number | null;
  body: string;
  createdAt: number;
  author: CommentAuthor;
  mine: boolean;
  likes: number;
  liked: boolean;
  replyCount: number;
}

export interface CommentLikeResponse {
  liked: boolean;
  likes: number;
}

export interface RepliesResponse {
  replies: Comment[];
}

export interface SeenRequest {
  /** Seconds the song actually played. */
  watchedSec: number;
  /** Where the listener jumped to and then kept listening: a vote for the song's hook. */
  hookSec?: number;
}

export interface PublicUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  followers: number;
  following: number;
  isFollowing: boolean;
  isMe: boolean;
}

export interface UserProfile {
  user: PublicUser;
  /** Recent likes and saves, or null when the listener keeps them private. */
  activity: { saved: Song[]; liked: Song[] } | null;
}

export interface PeopleResponse {
  people: PublicUser[];
}

export interface FollowResponse {
  following: boolean;
  followers: number;
}

export interface CommentsPage {
  comments: Comment[];
  nextCursor: number | null;
  total: number;
}

/** Outcome of mirroring an action to YouTube Music. */
export type SyncStatus = 'ok' | 'error' | 'off';

export interface ReactionResponse {
  reaction: ReactionValue;
  stats: SongStats;
  youtube: SyncStatus;
}

export interface SaveResponse {
  saved: boolean;
  stats: SongStats;
  youtube: SyncStatus;
}

export interface SearchResponse {
  local: Song[];
  remote: Song[];
  remoteAvailable: boolean;
  remoteError?: string;
}

export interface ResolveResponse {
  songs: Song[];
  playlistTitle?: string;
}

export interface GenreCount {
  genre: string;
  count: number;
}

export interface YouTubePlaylist {
  id: string;
  title: string;
  itemCount: number;
  thumbnailUrl: string | null;
}

export interface YouTubeLibrary {
  liked: Song[];
  playlists: YouTubePlaylist[];
}

export type LibraryKind = 'saved' | 'liked' | 'favorites' | 'disliked';

export interface LibraryItem extends Song {
  addedAt: number;
}

export interface LibraryResponse {
  kind: LibraryKind;
  items: LibraryItem[];
}

export interface ApiErrorBody {
  error: string;
  message: string;
}
