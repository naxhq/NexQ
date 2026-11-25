/**
 * Scroll controller: pure (injected clock, no DOM). Turns a note position into a
 * smooth scroll offset that keeps the spoken line on the focus line, critically
 * damped (no overshoot) and velocity limited. Also drives the non-voice mode
 * (words per minute auto-scroll) and yields to any manual scroll for 4 s.
 */
import type { FollowState } from "./follower";

/** How long a manual scroll takes control away from voice and auto-scroll. */
export const MANUAL_YIELD_MS = 4000;

/** One rendered line of the note, as measured by the UI. Sorted by token range. */
export interface LineMetric {
  /** First token index on this line. */
  startToken: number;
  /** One past the last token on this line. */
  endToken: number;
  /** Top of the line in content pixels. */
  top: number;
  height: number;
}

export interface ScrollMetrics {
  lines: LineMetric[];
  contentHeight: number;
  viewportHeight: number;
}

export interface ScrollOptions {
  clock?: () => number;
  /** Where the spoken line sits in the viewport, 0 (top) .. 1 (bottom). Default 0.35. */
  focusRatio?: number;
  /** Time to settle, seconds (critical damping). Default 0.45. */
  smoothTime?: number;
  /** Max scroll speed, px/s. Default 900. */
  maxSpeed?: number;
  /** Snap instead of animating. */
  reducedMotion?: boolean;
  wpm?: number;
}

export type ScrollMode = "voice" | "wpm" | "off";

/** Yield bookkeeping, usable on its own (manual scroll => follower held for 4 s). */
export class ManualYield {
  private until = -Infinity;
  constructor(private clock: () => number = () => Date.now(), private ms = MANUAL_YIELD_MS) {}
  touch(): void {
    this.until = this.clock() + this.ms;
  }
  active(): boolean {
    return this.clock() < this.until;
  }
  remaining(): number {
    return Math.max(0, this.until - this.clock());
  }
}

export class ScrollController {
  private clock: () => number;
  private focus: number;
  private smoothTime: number;
  private maxSpeed: number;
  private reduced: boolean;
  private metrics: ScrollMetrics = { lines: [], contentHeight: 0, viewportHeight: 0 };
  private cur = 0;
  private vel = 0;
  private target = 0;
  private lastTick: number | null = null;
  private mode: ScrollMode = "voice";
  private playing = false;
  private wpm: number;
  private wpmPos = 0;
  private voicePos: number | null = null;
  private yielder: ManualYield;

  constructor(opts: ScrollOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.focus = opts.focusRatio ?? 0.35;
    this.smoothTime = opts.smoothTime ?? 0.45;
    this.maxSpeed = opts.maxSpeed ?? 900;
    this.reduced = opts.reducedMotion ?? false;
    this.wpm = opts.wpm ?? 140;
    this.yielder = new ManualYield(this.clock);
  }

  /** Called whenever something that can move the note changes, so a sleeping frame loop can start again. */
  onWake?: () => void;

  setMetrics(m: ScrollMetrics): void {
    this.metrics = m;
    this.onWake?.();
    this.target = this.clampScroll(this.target);
    if (this.cur > this.maxScroll()) this.cur = this.maxScroll();
  }

  setMode(mode: ScrollMode): void {
    this.mode = mode;
    this.lastTick = null;
    this.onWake?.();
  }
  getMode(): ScrollMode {
    return this.mode;
  }

  // -- voice mode ---------------------------------------------------------

  /** Feed the follower's output. Holds still unless following (unsure, lost and paused keep the last target). */
  setVoice(position: number, state: FollowState): void {
    if (state !== "following") return;
    this.voicePos = position;
    this.onWake?.();
  }

  // -- wpm mode -----------------------------------------------------------

  play(): void {
    this.playing = true;
    this.lastTick = null;
    this.onWake?.();
  }
  pause(): void {
    this.playing = false;
  }
  isPlaying(): boolean {
    return this.playing;
  }
  setWpm(wpm: number): void {
    this.wpm = Math.max(20, Math.min(400, wpm));
    this.onWake?.();
  }
  getWpm(): number {
    return this.wpm;
  }
  /** Set the auto-scroll position (token index), e.g. on restart. */
  setWpmPosition(token: number): void {
    this.wpmPos = Math.max(0, token);
    this.onWake?.();
  }

  // -- manual scroll ------------------------------------------------------

  /** Call from the scroll event when the user (not us) moved the content. */
  onUserScroll(scrollTop: number): void {
    this.yielder.touch();
    this.cur = scrollTop;
    this.target = scrollTop;
    this.vel = 0;
    this.wpmPos = this.tokenAtScroll(scrollTop);
    this.onWake?.();
  }
  isYielding(): boolean {
    return this.yielder.active();
  }
  yieldRemainingMs(): number {
    return this.yielder.remaining();
  }
  /** Token at the focus line for a scroll offset: pass to VoiceFollower.seek() after a manual scroll. */
  tokenAtScroll(scrollTop: number): number {
    return this.tokenAtY(scrollTop + this.metrics.viewportHeight * this.focus);
  }

  // -- metrics helpers ----------------------------------------------------

  private maxScroll(): number {
    return Math.max(0, this.metrics.contentHeight - this.metrics.viewportHeight);
  }
  private clampScroll(v: number): number {
    return Math.max(0, Math.min(this.maxScroll(), v));
  }
  private centre(i: number): number {
    const l = this.metrics.lines[i];
    return l.top + l.height / 2;
  }

  /** Content y for a fractional token position: line centres, interpolated by token across the line. */
  yForToken(token: number): number {
    const lines = this.metrics.lines;
    if (lines.length === 0) return 0;
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid].startToken <= token) lo = mid;
      else hi = mid - 1;
    }
    const l = lines[lo];
    const next = lines[lo + 1];
    if (!next) return this.centre(lo);
    const frac = Math.max(0, Math.min(1, (token - l.startToken) / Math.max(1, l.endToken - l.startToken)));
    return this.centre(lo) + frac * (this.centre(lo + 1) - this.centre(lo));
  }

  /** Inverse of yForToken. */
  tokenAtY(y: number): number {
    const lines = this.metrics.lines;
    if (lines.length === 0) return 0;
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.centre(mid) <= y) lo = mid;
      else hi = mid - 1;
    }
    const l = lines[lo];
    const next = lines[lo + 1];
    if (!next || y <= this.centre(lo)) return l.startToken;
    const frac = Math.max(0, Math.min(1, (y - this.centre(lo)) / Math.max(1, this.centre(lo + 1) - this.centre(lo))));
    return l.startToken + frac * (l.endToken - l.startToken);
  }

  /** Scroll offset that puts the spoken position on the focus line. */
  scrollForToken(token: number): number {
    return this.clampScroll(this.yForToken(token) - this.metrics.viewportHeight * this.focus);
  }

  // -- tick ---------------------------------------------------------------

  /** Advance one frame; returns the scroll offset to apply. */
  update(): number {
    const now = this.clock();
    const dt = this.lastTick === null ? 0 : Math.min(0.1, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    if (this.isYielding()) return this.cur;
    if (this.mode === "off") return this.cur;
    if (this.mode === "wpm") {
      if (this.playing && dt > 0) {
        const lines = this.metrics.lines;
        const total = lines.length ? lines[lines.length - 1].endToken : 0;
        this.wpmPos = Math.min(total, this.wpmPos + (this.wpm / 60) * dt);
      }
      this.target = this.scrollForToken(this.wpmPos);
    } else if (this.voicePos !== null) {
      this.target = this.scrollForToken(this.voicePos);
    }
    if (this.reduced) {
      this.cur = this.target;
      this.vel = 0;
      return this.cur;
    }
    if (dt === 0) return this.cur;
    if (Math.abs(this.target - this.cur) < 0.5 && Math.abs(this.vel) < 1) {
      this.cur = this.target;
      this.vel = 0;
      return this.cur;
    }
    this.smoothDamp(dt);
    this.cur = this.clampScroll(this.cur);
    return this.cur;
  }

  /** Critically damped spring (no overshoot), speed limited. */
  private smoothDamp(dt: number): void {
    const st = Math.max(0.0001, this.smoothTime);
    const omega = 2 / st;
    const x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const orig = this.target;
    const maxChange = this.maxSpeed * st;
    const change = Math.max(-maxChange, Math.min(maxChange, this.cur - this.target));
    const tgt = this.cur - change;
    const temp = (this.vel + omega * change) * dt;
    this.vel = (this.vel - omega * temp) * exp;
    let out = tgt + (change + temp) * exp;
    if (orig - this.cur > 0 === out > orig) {
      out = orig;
      this.vel = (out - orig) / dt;
    }
    this.cur = out;
  }

  get scrollTop(): number {
    return this.cur;
  }
  get targetTop(): number {
    return this.target;
  }
}
