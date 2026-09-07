export type LockStateCallbacks = { onPause: (reason: 'lock' | 'suspend') => void; onResume: (reason: 'unlock' | 'resume') => void };
export type LockStateClock = { setTimeout: (callback: () => void, delay: number) => unknown; clearTimeout: (timer: unknown) => void };

export class LockCaptureState {
  private timer: unknown = null;
  private paused = false;

  constructor(private readonly graceMs: number, private readonly callbacks: LockStateCallbacks, private readonly clock: LockStateClock = {
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: timer => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
  }) {}

  lock() {
    if (this.paused || this.timer) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.paused) return;
      this.paused = true;
      this.callbacks.onPause('lock');
    }, this.graceMs);
  }

  unlock() {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (!this.paused) return;
    this.paused = false;
    this.callbacks.onResume('unlock');
  }

  suspend() {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.paused) return;
    this.paused = true;
    this.callbacks.onPause('suspend');
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.callbacks.onResume('resume');
  }

  isPaused() { return this.paused; }
}
