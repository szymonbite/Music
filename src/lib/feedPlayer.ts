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
}

interface Handlers {
  onEnded?: () => void;
  onError?: (videoId: string, code: number) => void;
}

interface LoadRequest {
  videoId: string;
  startSeconds: number;
  /** Jump to the hook once the duration is known (when it wasn't known up front). */
  seekToHook: boolean;
}

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

  constructor() {
    this.snapshot = {
      apiFailed: false,
      videoId: null,
      status: 'idle',
      muted: readMuted(),
      needsGesture: false,
      currentTime: 0,
      duration: 0,
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

  load(videoId: string, opts: { startSeconds?: number; seekToHook?: boolean } = {}): void {
    const request: LoadRequest = { videoId, startSeconds: opts.startSeconds ?? 0, seekToHook: opts.seekToHook ?? false };
    this.watched = 0;
    this.stopPolling();
    this.update({ videoId, status: 'buffering', currentTime: request.startSeconds, duration: 0 });
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
        if (request?.seekToHook && duration > 0) {
          request.seekToHook = false;
          const hook = hookStart(duration);
          if (hook > 0 && (this.player?.getCurrentTime() ?? 0) < 3) this.player?.seekTo(hook, true);
        }
        this.update({ status: 'playing', duration });
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
    if (this.snapshot.status === 'playing') this.watched += (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (!this.player) return;
    const currentTime = this.player.getCurrentTime();
    const duration = this.player.getDuration();
    if (currentTime !== this.snapshot.currentTime || duration !== this.snapshot.duration) {
      this.update({ currentTime, duration });
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

  seek(seconds: number): void {
    this.player?.seekTo(Math.max(0, seconds), true);
    this.update({ currentTime: Math.max(0, seconds) });
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

  /** Seconds the current song has actually been playing since it was loaded. Resets the counter. */
  takeWatchedSeconds(): number {
    this.tick();
    const watched = this.watched;
    this.watched = 0;
    return watched;
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
