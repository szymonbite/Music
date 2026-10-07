import { useCallback, useSyncExternalStore } from 'react';
import { loadYouTubeApi, PlayerState, type YTPlayer } from './youtubeApi.ts';

export type PlayerStatus = 'idle' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerSnapshot {
  /** The YouTube player script couldn't be loaded (offline, blocked...). */
  apiFailed: boolean;
  videoId: string | null;
  status: PlayerStatus;
  /** The listener's mute preference. */
  muted: boolean;
  /** The browser blocked autoplay with sound; a tap is needed to unmute / start. */
  needsGesture: boolean;
  currentTime: number;
  duration: number;
  /** The highlight being played in preview mode, or null when playing the full song. */
  preview: { start: number; end: number } | null;
}

interface Handlers {
  onEnded?: () => void;
  onPreviewEnd?: () => void;
  onError?: (videoId: string, code: number) => void;
}

interface LoadRequest {
  videoId: string;
  startSeconds: number;
  /** Jump to the hook once the duration is known (when it wasn't known up front). */
  seekToHook: boolean;
  /** Play only this many seconds from the start point (hook preview), or null for the full song. */
  previewSeconds: number | null;
}

/** What to tell the server when a song scrolls away. */
export interface PlaybackReport {
  watchedSec: number;
  /** Where the listener jumped to and then kept listening: a vote for the hook. */
  hookSec?: number;
}

/** Listening this long after jumping somewhere counts as a vote that the hook is there. */
const HOOK_VOTE_LISTEN_SEC = 15;

const MUTED_KEY = 'earworm:muted';

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
  } catch {
    // storage unavailable (private mode etc.)
  }
}

/** Where to start a song so the listener hears the good part sooner: a quarter in, at most 45s. */
export function hookStart(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec < 90) return 0;
  return Math.round(Math.min(45, durationSec * 0.25));
}

/**
 * One YouTube player shared by the whole feed. Re-using a single iframe makes
 * swiping fast and lets autoplay keep working after the first tap on mobile.
 */
export class FeedPlayer {
  private player: YTPlayer | null = null;
  private ready = false;
  private pending: LoadRequest | null = null;
  private current: LoadRequest | null = null;
  private handlers: Handlers = {};
  private listeners = new Set<() => void>();
  private snapshot: PlayerSnapshot;
  private poll: ReturnType<typeof setInterval> | null = null;
  private blockedTimer: ReturnType<typeof setTimeout> | null = null;
  private watched = 0;
  private lastTick = 0;
  private previewEnded = false;
  private seekTarget: number | null = null;
  private listenedSinceSeek = 0;

  constructor() {
    this.snapshot = {
      apiFailed: false,
      videoId: null,
      status: 'idle',
      muted: readMuted(),
      needsGesture: false,
      currentTime: 0,
      duration: 0,
      preview: null,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PlayerSnapshot => this.snapshot;

  setHandlers(handlers: Handlers): void {
    this.handlers = handlers;
  }

  private update(patch: Partial<PlayerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Creates the YouTube iframe inside host. Returns a cleanup function. */
  mount(host: HTMLElement): () => void {
    let disposed = false;
    loadYouTubeApi()
      .then((YT) => {
        if (disposed) return;
        const element = document.createElement('div');
        host.appendChild(element);
        const player: YTPlayer = new YT.Player(element, {
          width: '100%',
          height: '100%',
          playerVars: {
            playsinline: 1,
            controls: 0,
            disablekb: 1,
            fs: 0,
            iv_load_policy: 3,
            rel: 0,
            enablejsapi: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              if (disposed) return;
              this.player = player;
              this.ready = true;
              if (this.snapshot.muted) player.mute();
              const pending = this.pending;
              this.pending = null;
              if (pending) this.start(pending);
            },
            onStateChange: (e) => this.onStateChange(e.data ?? PlayerState.UNSTARTED),
            onError: (e) => this.onError(e.data ?? 0),
            onAutoplayBlocked: () => this.onAutoplayBlocked(),
          },
        });
      })
      .catch(() => {
        if (!disposed) this.update({ apiFailed: true });
      });

    return () => {
      disposed = true;
      this.stopPolling();
      this.clearBlockedCheck();
      this.ready = false;
      try {
        this.player?.destroy();
      } catch {
        // already gone
      }
      this.player = null;
      host.replaceChildren();
    };
  }

  load(videoId: string, opts: { startSeconds?: number; seekToHook?: boolean; previewSeconds?: number | null } = {}): void {
    const request: LoadRequest = {
      videoId,
      startSeconds: opts.startSeconds ?? 0,
      seekToHook: opts.seekToHook ?? false,
      previewSeconds: opts.previewSeconds ?? null,
    };
    this.watched = 0;
    this.previewEnded = false;
    this.seekTarget = null;
    this.listenedSinceSeek = 0;
    this.stopPolling();
    // With a known start point the preview window is known now; otherwise once we've jumped to the hook.
    const preview =
      request.previewSeconds && !request.seekToHook
        ? { start: request.startSeconds, end: request.startSeconds + request.previewSeconds }
        : null;
    this.update({ videoId, status: 'buffering', currentTime: request.startSeconds, duration: 0, preview });
    if (!this.ready || !this.player) {
      this.pending = request;
      return;
    }
    this.start(request);
  }

  private start(request: LoadRequest): void {
    this.current = request;
    this.player?.loadVideoById({ videoId: request.videoId, startSeconds: request.startSeconds });
    this.armBlockedCheck();
  }

  /**
   * Some browsers (notably iOS Safari) silently refuse to autoplay with sound.
   * If nothing has started after a moment, play muted and ask for a tap.
   */
  private armBlockedCheck(): void {
    this.clearBlockedCheck();
    this.blockedTimer = setTimeout(() => {
      const state = this.player?.getPlayerState();
      if (state === PlayerState.UNSTARTED || state === PlayerState.CUED) this.onAutoplayBlocked();
    }, 2500);
  }

  private clearBlockedCheck(): void {
    if (this.blockedTimer) clearTimeout(this.blockedTimer);
    this.blockedTimer = null;
  }

  private onAutoplayBlocked(): void {
    if (!this.player) return;
    this.player.mute();
    this.player.playVideo();
    this.update({ needsGesture: true });
  }

  private onStateChange(state: number): void {
    switch (state) {
      case PlayerState.PLAYING: {
        this.clearBlockedCheck();
        const duration = this.player?.getDuration() ?? 0;
        const request = this.current;
        let preview = this.snapshot.preview;
        if (request?.seekToHook && duration > 0) {
          request.seekToHook = false;
          const hook = hookStart(duration);
          if (hook > 0 && (this.player?.getCurrentTime() ?? 0) < 3) this.player?.seekTo(hook, true);
          if (request.previewSeconds) preview = { start: hook, end: hook + request.previewSeconds };
        }
        this.update({ status: 'playing', duration, preview });
        this.startPolling();
        break;
      }
      case PlayerState.PAUSED:
        this.tick();
        this.stopPolling();
        this.update({ status: 'paused' });
        break;
      case PlayerState.BUFFERING:
        this.update({ status: 'buffering' });
        break;
      case PlayerState.ENDED:
        this.tick();
        this.stopPolling();
        this.update({ status: 'ended' });
        this.handlers.onEnded?.();
        break;
      case PlayerState.CUED:
        this.update({ status: 'paused' });
        break;
      default:
        break;
    }
  }

  private onError(code: number): void {
    this.clearBlockedCheck();
    this.stopPolling();
    this.update({ status: 'error' });
    if (this.snapshot.videoId) this.handlers.onError?.(this.snapshot.videoId, code);
  }

  private startPolling(): void {
    if (this.poll) return;
    this.lastTick = performance.now();
    this.poll = setInterval(() => this.tick(), 250);
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private tick(): void {
    const now = performance.now();
    if (this.snapshot.status === 'playing') {
      const elapsed = (now - this.lastTick) / 1000;
      this.watched += elapsed;
      if (this.seekTarget !== null) this.listenedSinceSeek += elapsed;
    }
    this.lastTick = now;
    if (!this.player) return;
    const currentTime = this.player.getCurrentTime();
    const duration = this.player.getDuration();
    if (currentTime !== this.snapshot.currentTime || duration !== this.snapshot.duration) {
      this.update({ currentTime, duration });
    }
    const preview = this.snapshot.preview;
    if (preview && !this.previewEnded && this.snapshot.status === 'playing' && currentTime >= preview.end) {
      this.previewEnded = true;
      this.handlers.onPreviewEnd?.();
    }
  }

  play(): void {
    this.player?.playVideo();
  }

  pause(): void {
    this.player?.pauseVideo();
  }

  /** Tap on the video: unmute if autoplay was blocked, otherwise play / pause. */
  toggle(): void {
    if (this.snapshot.needsGesture) {
      if (!this.snapshot.muted) this.player?.unMute();
      this.player?.playVideo();
      this.update({ needsGesture: false });
      return;
    }
    if (this.snapshot.status === 'playing' || this.snapshot.status === 'buffering') this.pause();
    else this.play();
  }

  /**
   * Jumps to a position. A manual jump (the listener dragging the progress bar)
   * moves the preview window there and may become a vote for the song's hook.
   */
  seek(seconds: number, opts: { manual?: boolean } = {}): void {
    const target = Math.max(0, seconds);
    this.player?.seekTo(target, true);
    let preview = this.snapshot.preview;
    if (opts.manual) {
      this.seekTarget = target;
      this.listenedSinceSeek = 0;
      if (preview) preview = { start: target, end: target + (preview.end - preview.start) };
    }
    this.previewEnded = false;
    this.update({ currentTime: target, preview });
  }

  /** Keep playing past the highlight: the whole song from here. */
  playFull(): void {
    if (this.snapshot.preview) this.update({ preview: null });
  }

  setMuted(muted: boolean): void {
    writeMuted(muted);
    if (muted) {
      this.player?.mute();
    } else {
      this.player?.unMute();
      if (this.snapshot.needsGesture) this.player?.playVideo();
    }
    this.update({ muted, needsGesture: false });
  }

  /** How long the current song actually played, and any hook vote. Resets the counters. */
  takeReport(): PlaybackReport {
    this.tick();
    const report: PlaybackReport = { watchedSec: this.watched };
    if (this.seekTarget !== null && this.seekTarget >= 5 && this.listenedSinceSeek >= HOOK_VOTE_LISTEN_SEC) {
      report.hookSec = Math.round(this.seekTarget);
    }
    this.watched = 0;
    this.seekTarget = null;
    this.listenedSinceSeek = 0;
    return report;
  }
}

/** Subscribes to one primitive field of the player's state. */
export function usePlayerValue<T extends string | number | boolean | null>(
  player: FeedPlayer,
  select: (snapshot: PlayerSnapshot) => T,
): T {
  const getValue = useCallback(() => select(player.getSnapshot()), [player, select]);
  return useSyncExternalStore(player.subscribe, getValue, getValue);
}
