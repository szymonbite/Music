// A stand-in for https://www.youtube.com/iframe_api used by the end-to-end tests
// (the sandbox can't reach YouTube). It mimics the bits of YT.Player that
// Earworm uses and records every call in window.__ytCalls.
(() => {
  const calls = (window.__ytCalls = []);
  const State = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

  class Player {
    constructor(element, options) {
      const target = typeof element === 'string' ? document.getElementById(element) : element;
      this.frame = document.createElement('div');
      this.frame.setAttribute('data-testid', 'fake-youtube');
      this.frame.style.cssText =
        'display:grid;place-items:center;background:linear-gradient(135deg,#222,#000);color:#fff;font:600 13px system-ui';
      target.replaceWith(this.frame);
      this.events = options.events || {};
      this.state = State.UNSTARTED;
      this.time = 0;
      this.duration = 0;
      this.muted = false;
      this.videoId = null;
      this.timer = null;
      window.__ytPlayer = this;
      setTimeout(() => this.events.onReady && this.events.onReady({ target: this }), 20);
    }

    emit(state) {
      this.state = state;
      if (this.events.onStateChange) this.events.onStateChange({ target: this, data: state });
    }

    loadVideoById(arg) {
      const { videoId, startSeconds = 0 } = typeof arg === 'string' ? { videoId: arg } : arg;
      calls.push({ type: 'load', videoId, startSeconds });
      this.videoId = videoId;
      this.time = startSeconds;
      this.duration = window.__ytDuration || 200;
      this.frame.textContent = `▶ ${videoId}`;
      clearInterval(this.timer);
      this.emit(State.BUFFERING);
      setTimeout(() => {
        if (this.videoId !== videoId) return;
        if ((window.__ytUnavailable || []).includes(videoId)) {
          if (this.events.onError) this.events.onError({ target: this, data: 150 });
          return;
        }
        this.startClock();
      }, 60);
    }

    cueVideoById(arg) {
      const { videoId, startSeconds = 0 } = typeof arg === 'string' ? { videoId: arg } : arg;
      calls.push({ type: 'cue', videoId, startSeconds });
      this.videoId = videoId;
      this.time = startSeconds;
      this.emit(State.CUED);
    }

    startClock() {
      clearInterval(this.timer);
      this.emit(State.PLAYING);
      this.timer = setInterval(() => {
        this.time += 0.25 * (window.__ytSpeed || 1);
        if (this.time >= this.duration) {
          clearInterval(this.timer);
          this.time = this.duration;
          this.emit(State.ENDED);
        }
      }, 250);
    }

    playVideo() {
      calls.push({ type: 'play' });
      this.startClock();
    }

    pauseVideo() {
      calls.push({ type: 'pause' });
      clearInterval(this.timer);
      this.emit(State.PAUSED);
    }

    seekTo(seconds) {
      calls.push({ type: 'seek', seconds });
      this.time = seconds;
    }

    mute() {
      calls.push({ type: 'mute' });
      this.muted = true;
    }

    unMute() {
      calls.push({ type: 'unmute' });
      this.muted = false;
    }

    isMuted() {
      return this.muted;
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
      clearInterval(this.timer);
      this.frame.remove();
    }
  }

  window.YT = { Player, PlayerState: State };
  setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 0);
})();
