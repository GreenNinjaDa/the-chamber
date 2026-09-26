/*
 * Procedural sound: everything is synthesised with WebAudio (oscillators, filtered noise, little
 * note sequences), so there are no audio assets to license. The context starts on the first
 * click (browsers insist); until then, and when muted, every call quietly does nothing.
 * Mute with `?mute` in the URL or the lever in the lobby (settings.sound).
 */

import { settings } from '../game/settings';

type Wave = OscillatorType;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
const muted = new URLSearchParams(location.search).has('mute');

/** Call from a user gesture (the first click): creates / resumes the audio context. */
export function unlockAudio() {
  if (muted) return;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') void ctx.resume();
}

function ready(): AudioContext | null {
  if (!ctx || !master || !settings.sound || ctx.state !== 'running') return null;
  return ctx;
}

/** One tone: `freq` (Hz) sliding to `to` over `dur` seconds, with a quick attack and a decay. */
export function tone(freq: number, dur: number, opts: { to?: number; wave?: Wave; vol?: number; at?: number; attack?: number } = {}) {
  const c = ready();
  if (!c) return;
  const t0 = c.currentTime + (opts.at ?? 0);
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = opts.wave ?? 'square';
  osc.frequency.setValueAtTime(freq, t0);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), t0 + dur);
  const vol = opts.vol ?? 0.3;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + (opts.attack ?? 0.01));
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(master!);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

/** A burst of filtered noise (bangs, whooshes, pops, crashes). */
export function noise(dur: number, opts: { freq?: number; to?: number; q?: number; vol?: number; at?: number; type?: BiquadFilterType } = {}) {
  const c = ready();
  if (!c || !noiseBuffer) return;
  const t0 = c.currentTime + (opts.at ?? 0);
  const src = c.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const filter = c.createBiquadFilter();
  filter.type = opts.type ?? 'lowpass';
  filter.frequency.setValueAtTime(opts.freq ?? 1200, t0);
  if (opts.to) filter.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), t0 + dur);
  filter.Q.value = opts.q ?? 0.7;
  const gain = c.createGain();
  const vol = opts.vol ?? 0.4;
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(gain).connect(master!);
  src.start(t0, Math.random() * 0.5);
  src.stop(t0 + dur + 0.05);
}

/** Note name (e.g. 'E5', 'C#4') to frequency. */
export function note(name: string): number {
  const m = name.match(/^([A-G])(#|b)?(\d)$/);
  if (!m) return 440;
  const base = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1] as 'C'] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return 440 * Math.pow(2, (base + (Number(m[3]) - 4) * 12) / 12);
}

const tunes = new Set<{ stop(): void }>();

/** Stops every tune (a level starting, or the pause menu). Levels start theirs again from update(). */
export function stopTunes() {
  for (const t of tunes) t.stop();
}

/**
 * A looping tune: a list of [note | null for a rest, beats] played at `bpm`. `start()` is safe
 * to call every frame. Scheduling runs ahead in small chunks from a timer, so it keeps time while
 * the tab is busy.
 */
export class Tune {
  private timer: number | null = null;
  private nextAt = 0;
  private index = 0;

  constructor(private notes: [string | null, number][], public bpm: number, private opts: { wave?: Wave; vol?: number; bass?: boolean } = {}) {}

  get playing() {
    return this.timer !== null;
  }

  start() {
    const c = ready();
    if (!c || this.timer !== null) return;
    this.nextAt = c.currentTime + 0.05;
    this.index = 0;
    this.timer = window.setInterval(() => this.schedule(), 50);
    tunes.add(this);
    this.schedule();
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    tunes.delete(this);
  }

  private schedule() {
    const c = ready();
    if (!c) return this.stop();
    const beat = 60 / this.bpm;
    // Fell behind (a long frame, a hidden tab): skip ahead rather than play every missed note at once.
    if (this.nextAt < c.currentTime) this.nextAt = c.currentTime + 0.02;
    while (this.nextAt < c.currentTime + 0.25) {
      const [n, beats] = this.notes[this.index];
      const dur = beats * beat;
      if (n) {
        const f = note(n);
        tone(f, dur * 0.9, { wave: this.opts.wave ?? 'square', vol: this.opts.vol ?? 0.12, at: this.nextAt - c.currentTime });
        if (this.opts.bass && this.index % 2 === 0) tone(f / 4, dur * 0.8, { wave: 'triangle', vol: 0.12, at: this.nextAt - c.currentTime });
      }
      this.nextAt += dur;
      this.index = (this.index + 1) % this.notes.length;
    }
  }
}

/** A steady tone (a hum, a buzz) until `stop()`. `start()` is safe to call every frame. */
export class Drone {
  private osc: OscillatorNode | null = null;
  private gain: GainNode | null = null;

  constructor(private freq: number, private opts: { wave?: Wave; vol?: number; wobble?: number } = {}) {}

  start() {
    const c = ready();
    if (!c || this.osc) return;
    this.osc = c.createOscillator();
    this.osc.type = this.opts.wave ?? 'sawtooth';
    this.osc.frequency.value = this.freq;
    this.gain = c.createGain();
    this.gain.gain.setValueAtTime(0.0001, c.currentTime);
    this.gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, this.opts.vol ?? 0.05), c.currentTime + 0.3);
    const filter = c.createBiquadFilter();
    filter.frequency.value = this.freq * 6;
    this.osc.connect(filter).connect(this.gain).connect(master!);
    if (this.opts.wobble) {
      // A slow wobble in pitch, like a motor.
      const lfo = c.createOscillator(), depth = c.createGain();
      lfo.frequency.value = this.opts.wobble;
      depth.gain.value = this.freq * 0.03;
      lfo.connect(depth).connect(this.osc.frequency);
      lfo.start();
      this.osc.addEventListener('ended', () => lfo.stop());
    }
    this.osc.start();
    tunes.add(this);
  }

  /** Changes the loudness (glides there). */
  setVolume(vol: number) {
    if (vol === this.opts.vol) return;
    this.opts.vol = vol;
    if (this.gain && ctx) this.gain.gain.setTargetAtTime(Math.max(0.0001, vol), ctx.currentTime, 0.1);
  }

  /** Changes the pitch (glides there). */
  setFreq(freq: number) {
    if (freq === this.freq) return;
    this.freq = freq;
    if (this.osc && ctx) this.osc.frequency.setTargetAtTime(freq, ctx.currentTime, 0.1);
  }

  stop() {
    tunes.delete(this);
    if (!this.osc || !this.gain || !ctx) return;
    this.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
    this.osc.stop(ctx.currentTime + 0.3);
    this.osc = this.gain = null;
  }
}

// --- A few ready-made sounds --------------------------------------------------------------------

export const sfx = {
  /** Something going through a portal. */
  portal() {
    tone(220, 0.5, { to: 880, wave: 'sine', vol: 0.2 });
    noise(0.5, { freq: 400, to: 3000, type: 'bandpass', q: 3, vol: 0.2 });
  },
  /** A liquid portal blooping open. */
  portalOpen() {
    tone(90, 0.45, { to: 240, wave: 'sine', vol: 0.3, attack: 0.08 });
    tone(180, 0.3, { to: 520, wave: 'triangle', vol: 0.08, at: 0.05 });
  },
  /** A wall panel sliding. */
  slide() {
    noise(0.6, { freq: 700, to: 300, type: 'bandpass', q: 2, vol: 0.25 });
    tone(60, 0.5, { wave: 'sawtooth', vol: 0.05 });
  },
  button() {
    tone(900, 0.05, { wave: 'square', vol: 0.08 });
    tone(1300, 0.08, { wave: 'square', vol: 0.06, at: 0.05 });
  },
  /** Getting hit: a thump and a little grunt (0-1). */
  oof(strength = 1) {
    if (strength < 0.15) return;
    noise(0.15, { freq: 500, to: 120, vol: 0.35 * strength });
    tone(170 + Math.random() * 40, 0.16, { to: 95, wave: 'sawtooth', vol: 0.09 * strength, attack: 0.02 });
  },
  splat() {
    noise(0.4, { freq: 1500, to: 150, q: 1.5, vol: 0.45 });
    noise(0.25, { freq: 3000, to: 800, type: 'bandpass', q: 2, vol: 0.2, at: 0.05 });
  },
  /** The sad trombone for a death screen. */
  fail(delay = 0) {
    ['G3', 'F#3', 'F3', 'E3'].forEach((n, i) =>
      tone(note(n), i === 3 ? 0.9 : 0.34, { wave: 'sawtooth', vol: 0.1, at: delay + i * 0.34, to: i === 3 ? note('D#3') : undefined, attack: 0.04 }),
    );
  },
  /** A little fanfare for getting out. */
  win() {
    ['C5', 'E5', 'G5', 'C6'].forEach((n, i) => tone(note(n), 0.18, { wave: 'square', vol: 0.12, at: i * 0.09 }));
  },
  explosion(vol = 0.6) {
    noise(1.2, { freq: 900, to: 60, vol });
    tone(80, 0.6, { to: 30, wave: 'sine', vol: vol * 0.8 });
  },
  pop() {
    noise(0.08, { freq: 2500, to: 600, vol: 0.35 });
  },
  thud(vol = 0.4) {
    tone(110, 0.2, { to: 45, wave: 'sine', vol });
    noise(0.12, { freq: 400, to: 100, vol: vol * 0.6 });
  },
  click() {
    tone(1800, 0.03, { wave: 'square', vol: 0.08 });
  },
  ding() {
    tone(note('E6'), 1.4, { wave: 'sine', vol: 0.3 });
    tone(note('E7'), 0.8, { wave: 'sine', vol: 0.08 });
  },
  scratch() {
    noise(0.35, { freq: 3000, to: 300, type: 'bandpass', q: 4, vol: 0.5 });
    tone(600, 0.3, { to: 120, wave: 'sawtooth', vol: 0.15 });
  },
  zap() {
    for (let i = 0; i < 4; i++) noise(0.05, { freq: 5000, type: 'highpass', vol: 0.3, at: i * 0.04 });
  },
  shot() {
    noise(0.35, { freq: 2500, to: 200, vol: 0.7 });
    tone(150, 0.2, { to: 40, wave: 'square', vol: 0.3 });
  },
  laugh(delay = 0) {
    for (let i = 0; i < 4; i++) tone(i % 2 ? 330 : 390, 0.12, { to: i % 2 ? 260 : 300, wave: 'sawtooth', vol: 0.12, at: delay + i * 0.16 });
  },
};

/** For play-testing: whether sound is actually running. */
export function audioState() {
  return ctx ? ctx.state : 'not started';
}
