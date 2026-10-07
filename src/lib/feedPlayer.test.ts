import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedPlayer, hookStart } from './feedPlayer.ts';
import type { YTPlayerOptions } from './youtubeApi.ts';

type Handler = (e: { data?: number; target: unknown }) => void;

/** Just enough of YT.Player to drive FeedPlayer. */
class FakeYTPlayer {
  static instance: FakeYTPlayer | null = null;
  calls: [string, unknown?][] = [];
  state = -1;
  time = 0;
  duration = 240;
  private readonly events: Record<string, Handler | undefined>;

  constructor(_element: HTMLElement, options: YTPlayerOptions) {
    this.events = (options.events ?? {}) as Record<string, Handler | undefined>;
    FakeYTPlayer.instance = this;
  }

  emit(name: 'onReady' | 'onStateChange' | 'onError' | 'onAutoplayBlocked', data?: number) {
    if (name === 'onStateChange' && data !== undefined) this.state = data;
    this.events[name]?.({ data, target: this });
  }

  loadVideoById(opts: { videoId: string; startSeconds?: number }) {
    this.calls.push(['load', opts]);
  }
  cueVideoById(opts: unknown) {
    this.calls.push(['cue', opts]);
  }
  playVideo() {
    this.calls.push(['play']);
  }
  pauseVideo() {
    this.calls.push(['pause']);
  }
  seekTo(seconds: number) {
    this.calls.push(['seek', seconds]);
    this.time = seconds;
  }
  mute() {
    this.calls.push(['mute']);
  }
  unMute() {
    this.calls.push(['unmute']);
  }
  isMuted() {
    return false;
  }
  getCurrentTime() {
    return this.time;
  }
  getDuration() {
    return this.duration;
  }
  getPlayerState() {
    return this.state;
  }
  destroy() {
    this.calls.push(['destroy']);
  }
}

async function mountedPlayer() {
  const player = new FeedPlayer();
  const host = document.createElement('div');
  const unmount = player.mount(host);
  await Promise.resolve();
  await Promise.resolve();
  const yt = FakeYTPlayer.instance!;
  return { player, yt, unmount };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  window.YT = { Player: FakeYTPlayer as never };
  FakeYTPlayer.instance = null;
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  delete window.YT;
});

describe('hookStart', () => {
  it('starts longer songs a quarter in, at most 45 seconds', () => {
    expect(hookStart(30)).toBe(0);
    expect(hookStart(89)).toBe(0);
    expect(hookStart(120)).toBe(30);
    expect(hookStart(400)).toBe(45);
  });
});

describe('FeedPlayer', () => {
  it('queues a song until the player is ready, then plays it', async () => {
    const player = new FeedPlayer();
    player.load('song1111111', { startSeconds: 30 });
    expect(player.getSnapshot()).toMatchObject({ videoId: 'song1111111', status: 'buffering' });

    player.mount(document.createElement('div'));
    await Promise.resolve();
    await Promise.resolve();
    const yt = FakeYTPlayer.instance!;
    expect(yt.calls).toEqual([]);
    yt.emit('onReady');
    expect(yt.calls).toContainEqual(['load', { videoId: 'song1111111', startSeconds: 30 }]);
  });

  it('tracks playback state and tells the feed when a song ends', async () => {
    const { player, yt } = await mountedPlayer();
    const onEnded = vi.fn();
    player.setHandlers({ onEnded });
    yt.emit('onReady');
    player.load('song1111111');

    yt.emit('onStateChange', 1);
    expect(player.getSnapshot()).toMatchObject({ status: 'playing', duration: 240 });
    yt.emit('onStateChange', 2);
    expect(player.getSnapshot().status).toBe('paused');
    yt.emit('onStateChange', 0);
    expect(player.getSnapshot().status).toBe('ended');
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it('jumps to the hook once the duration is known', async () => {
    const { player, yt } = await mountedPlayer();
    yt.emit('onReady');
    player.load('song1111111', { seekToHook: true });
    yt.emit('onStateChange', 1);
    expect(yt.calls).toContainEqual(['seek', 45]);
    // Only once per song.
    yt.emit('onStateChange', 2);
    yt.emit('onStateChange', 1);
    expect(yt.calls.filter(([name]) => name === 'seek')).toHaveLength(1);
  });

  it('reports videos that cannot be played', async () => {
    const { player, yt } = await mountedPlayer();
    const onError = vi.fn();
    player.setHandlers({ onError });
    yt.emit('onReady');
    player.load('blocked1111');
    yt.emit('onError', 150);
    expect(onError).toHaveBeenCalledWith('blocked1111', 150);
    expect(player.getSnapshot().status).toBe('error');
  });

  it('falls back to muted playback when the browser blocks autoplay, and unmutes on tap', async () => {
    const { player, yt } = await mountedPlayer();
    yt.emit('onReady');
    player.load('song1111111');
    vi.advanceTimersByTime(2600);
    expect(yt.calls).toContainEqual(['mute']);
    expect(player.getSnapshot().needsGesture).toBe(true);

    player.toggle();
    expect(yt.calls.slice(-2)).toEqual([['unmute'], ['play']]);
    expect(player.getSnapshot().needsGesture).toBe(false);
  });

  it('toggles play and pause on tap', async () => {
    const { player, yt } = await mountedPlayer();
    yt.emit('onReady');
    player.load('song1111111');
    yt.emit('onStateChange', 1);
    player.toggle();
    expect(yt.calls.at(-1)).toEqual(['pause']);
    yt.emit('onStateChange', 2);
    player.toggle();
    expect(yt.calls.at(-1)).toEqual(['play']);
  });

  it('remembers the mute preference', async () => {
    const { player, yt } = await mountedPlayer();
    yt.emit('onReady');
    player.setMuted(true);
    expect(yt.calls).toContainEqual(['mute']);
    expect(localStorage.getItem('earworm:muted')).toBe('1');
    expect(new FeedPlayer().getSnapshot().muted).toBe(true);
  });

  it('measures how long a song actually played', async () => {
    const { player, yt } = await mountedPlayer();
    yt.emit('onReady');
    player.load('song1111111');
    yt.emit('onStateChange', 1);
    vi.advanceTimersByTime(3000);
    yt.emit('onStateChange', 2);
    vi.advanceTimersByTime(5000);
    expect(player.takeReport().watchedSec).toBeCloseTo(3, 0);
    expect(player.takeReport().watchedSec).toBe(0);
  });

  it('plays a 30 second highlight in preview mode, then hands over', async () => {
    const { player, yt } = await mountedPlayer();
    const onPreviewEnd = vi.fn();
    player.setHandlers({ onPreviewEnd });
    yt.emit('onReady');
    player.load('song1111111', { startSeconds: 50, previewSeconds: 30 });
    expect(player.getSnapshot().preview).toEqual({ start: 50, end: 80 });

    yt.time = 50;
    yt.emit('onStateChange', 1);
    yt.time = 79;
    vi.advanceTimersByTime(250);
    expect(onPreviewEnd).not.toHaveBeenCalled();
    yt.time = 80.1;
    vi.advanceTimersByTime(250);
    expect(onPreviewEnd).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(onPreviewEnd).toHaveBeenCalledOnce();
  });

  it('sets the preview window at the estimated hook when the length was unknown', async () => {
    const { player, yt } = await mountedPlayer();
    yt.emit('onReady');
    player.load('song1111111', { seekToHook: true, previewSeconds: 30 });
    expect(player.getSnapshot().preview).toBeNull();
    yt.emit('onStateChange', 1);
    expect(player.getSnapshot().preview).toEqual({ start: 45, end: 75 });
  });

  it('switches to the full song on request', async () => {
    const { player, yt } = await mountedPlayer();
    const onPreviewEnd = vi.fn();
    player.setHandlers({ onPreviewEnd });
    yt.emit('onReady');
    player.load('song1111111', { startSeconds: 50, previewSeconds: 30 });
    yt.emit('onStateChange', 1);
    player.playFull();
    expect(player.getSnapshot().preview).toBeNull();
    yt.time = 120;
    vi.advanceTimersByTime(500);
    expect(onPreviewEnd).not.toHaveBeenCalled();
  });

  it('turns "jumped there and kept listening" into a hook vote', async () => {
    const { player, yt } = await mountedPlayer();
    yt.emit('onReady');
    player.load('song1111111', { startSeconds: 50, previewSeconds: 30 });
    yt.emit('onStateChange', 1);
    player.seek(92, { manual: true });
    expect(player.getSnapshot().preview).toEqual({ start: 92, end: 122 });
    vi.advanceTimersByTime(10_000);
    expect(player.takeReport().hookSec).toBeUndefined();

    player.seek(92, { manual: true });
    vi.advanceTimersByTime(16_000);
    expect(player.takeReport()).toMatchObject({ hookSec: 92 });
  });

  it('destroys the iframe on unmount', async () => {
    const { yt, unmount } = await mountedPlayer();
    yt.emit('onReady');
    unmount();
    expect(yt.calls.at(-1)).toEqual(['destroy']);
  });
});
