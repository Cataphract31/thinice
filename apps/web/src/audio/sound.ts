import { riskScale } from "../game/risk";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let reverbBus: GainNode | null = null;
let muted = false;

const STORAGE_KEY = "zinc.muted";
const VOLUME_KEY = "zinc.volume";
let volume = 0.7;

const SAMPLE_PEAK = 0.34;

const SAMPLE_NAMES = [
  "tick",
  "shatter",
  "shatter_many",
  "extract",
  "died",
  "seal",
  "join",
] as const;
type SampleName = (typeof SAMPLE_NAMES)[number];

const samples = new Map<SampleName, AudioBuffer>();
const sampleGain = new Map<SampleName, number>();

function peakOf(buf: AudioBuffer): number {
  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < data.length; i += 4) {
      const v = data[i]! < 0 ? -data[i]! : data[i]!;
      if (v > peak) peak = v;
    }
  }
  return peak;
}

async function loadSamplePack(ac: AudioContext): Promise<void> {
  const base = import.meta.env.BASE_URL || "/";
  await Promise.all(
    SAMPLE_NAMES.map(async (name) => {
      for (const ext of ["mp3", "wav", "ogg"]) {
        try {
          const res = await fetch(`${base}sfx/${name}.${ext}`);
          if (!res.ok) continue;
          const bytes = await res.arrayBuffer();
          if (bytes.byteLength < 512) continue;
          const buf = await ac.decodeAudioData(bytes);
          const peak = peakOf(buf);
          samples.set(name, buf);
          sampleGain.set(name, peak > 0.001 ? SAMPLE_PEAK / peak : 1);
          return;
        } catch {
        }
      }
    }),
  );
}

function sample(name: SampleName, gain = 1, wet = 0.25, rate = 1): boolean {
  const buf = samples.get(name);
  if (!buf || !ctx || !master || muted) return false;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = gain * (sampleGain.get(name) ?? 1);
  src.connect(g);
  connectVoice(g, wet);
  src.start();
  return true;
}

function buildImpulse(ac: AudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ac.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ac.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const n = Math.random() * 2 - 1;
      lp += (n - lp) * 0.28;
      data[i] = lp * Math.pow(1 - t, decay);
    }
  }
  return buf;
}

export function initAudio(): void {
  if (ctx) {
    if (ctx.state === "suspended") void ctx.resume();
    return;
  }
  try {
    const Ctor =
      window.AudioContext ??
      (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ac = new Ctor();

    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 26;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.006;
    comp.release.value = 0.22;

    const out = ac.createGain();
    out.gain.value = muted ? 0 : volume;
    out.connect(comp);
    comp.connect(ac.destination);

    const conv = ac.createConvolver();
    conv.buffer = buildImpulse(ac, 2.6, 2.4);
    const send = ac.createGain();
    send.gain.value = 1;
    const damp = ac.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 4200;
    send.connect(damp);
    damp.connect(conv);
    conv.connect(out);

    ctx = ac;
    master = out;
    reverbBus = send;

    void loadSamplePack(ac);
  } catch {
    ctx = null;
  }
}

export function loadMutePreference(): boolean {
  try {
    muted = localStorage.getItem(STORAGE_KEY) === "1";
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw !== null) {
      const v = Number(raw);
      if (Number.isFinite(v) && v >= 0 && v <= 1) volume = v;
    }
  } catch {
    muted = false;
  }
  return muted;
}

function applyLevel(): void {
  if (master && ctx) {
    master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.03);
  }
}

export function setMuted(next: boolean): void {
  muted = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
  }
  applyLevel();
}

export function isMuted(): boolean {
  return muted;
}

export function getVolume(): number {
  return volume;
}

export function setVolume(next: number): void {
  volume = Math.max(0, Math.min(1, next));
  if (volume > 0 && muted) {
    muted = false;
    try {
      localStorage.setItem(STORAGE_KEY, "0");
    } catch {
    }
  }
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
  }
  applyLevel();
}

function connectVoice(node: AudioNode, wet: number): void {
  if (!ctx || !master || !reverbBus) return;
  node.connect(master);
  if (wet > 0) {
    const w = ctx.createGain();
    w.gain.value = wet;
    node.connect(w);
    w.connect(reverbBus);
  }
}

interface SubOpts {
  freq: number;
  dur: number;
  gain: number;
  attack?: number;
  wet?: number;
  delay?: number;
  glideTo?: number;
}

function sub({
  freq,
  dur,
  gain,
  attack = 0.008,
  wet = 0.2,
  delay = 0,
  glideTo,
}: SubOpts): void {
  if (!ctx || !master || muted) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t0);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(18, glideTo), t0 + dur);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(g);
  connectVoice(g, wet);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

interface TextureOpts {
  dur: number;
  gain: number;
  freq: number;
  q?: number;
  type?: BiquadFilterType;
  sweepTo?: number;
  attack?: number;
  wet?: number;
  delay?: number;
}

let noiseBed: AudioBuffer | null = null;
const NOISE_SECONDS = 2;

function noiseBuffer(ac: AudioContext): AudioBuffer {
  if (noiseBed) return noiseBed;
  const frames = Math.floor(ac.sampleRate * NOISE_SECONDS);
  const buf = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buf.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < frames; i++) {
    const n = Math.random() * 2 - 1;
    lp += (n - lp) * 0.45;
    data[i] = lp;
  }
  noiseBed = buf;
  return buf;
}

function texture({
  dur,
  gain,
  freq,
  q = 1.2,
  type = "bandpass",
  sweepTo,
  attack = 0.004,
  wet = 0.3,
  delay = 0,
}: TextureOpts): void {
  if (!ctx || !master || muted) return;
  const t0 = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);

  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t0);
  if (sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), t0 + dur);
  filter.Q.value = q;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  src.connect(filter);
  filter.connect(g);
  connectVoice(g, wet);
  const offset = Math.random() * Math.max(0, NOISE_SECONDS - dur - 0.05);
  src.start(t0, offset, dur + 0.02);
}

function knock(freq: number, gain: number, wet = 0.18, delay = 0): void {
  texture({ dur: 0.045, gain, freq, q: 2.4, wet, delay });
  sub({ freq, glideTo: freq * 0.55, dur: 0.1, gain: gain * 0.8, attack: 0.002, wet, delay });
}

const TICK_LEVEL = 0.58;

export function sfxTick(hazard: number): void {
  const t = riskScale(hazard);

  if (sample("tick", (0.22 + t * 0.95) * TICK_LEVEL, 0.06 + t * 0.5, 0.86 + t * 0.3))
    return;

  const lead = Math.pow(t, 0.75);

  const wet = 0.05 + lead * 0.4;
  const dur = 0.045 + lead * 0.215;

  const beat = (delay: number, level: number): void => {
    texture({
      dur,
      gain: (0.016 + lead * 0.082) * level * TICK_LEVEL,
      freq: 240 + lead * 1160,
      q: t < 0.24 ? 0.8 : 1.3 + lead * 3.4,
      type: t < 0.24 ? "lowpass" : "bandpass",
      sweepTo: 170 + lead * 300,
      attack: 0.004 - lead * 0.0025,
      wet,
      delay,
    });
    sub({
      freq: 68 + lead * 82,
      glideTo: 52 + lead * 30,
      dur: dur * 1.5,
      gain: (0.022 + lead * 0.062) * level * TICK_LEVEL,
      attack: 0.002,
      wet: wet * 0.7,
      delay,
    });
    if (t > 0.29) {
      const w = (t - 0.29) / 0.71;
      sub({
        freq: 60,
        glideTo: 36,
        dur: 0.15 + w * 0.28,
        gain: 0.055 * w * level * TICK_LEVEL,
        attack: 0.006,
        wet: 0.2 + w * 0.2,
        delay,
      });
    }
    if (t > 0.53) {
      const b = (t - 0.53) / 0.47;
      texture({
        dur: 0.016,
        gain: 0.016 * b * level * TICK_LEVEL,
        freq: 2400 + b * 1200,
        q: 1.1,
        attack: 0.001,
        wet: 0.15,
        delay,
      });
    }
  };

  beat(0, 1);

  if (t > 0.58) {
    const h = (t - 0.58) / 0.42;
    sub({
      freq: 58,
      glideTo: 38,
      dur: 0.13 + h * 0.09,
      gain: (0.028 + h * 0.022) * TICK_LEVEL,
      attack: 0.008,
      wet: 0.22,
      delay: 0.16 - h * 0.045,
    });
  }
}

export function sfxShatter(count: number): void {
  const n = Math.max(1, Math.min(7, Math.round(Math.sqrt(count) * 1.6)));
  if (sample(count > 3 ? "shatter_many" : "shatter", 0.85, 0.3)) return;

  for (let i = 0; i < n; i++) {
    const delay = i === 0 ? 0 : 0.012 + Math.random() * 0.1;
    const f = 900 + Math.random() * 1500;
    texture({
      dur: 0.035 + Math.random() * 0.05,
      gain: (0.075 / (1 + i * 0.45)) * (0.8 + Math.random() * 0.4),
      freq: f,
      q: 2.2,
      sweepTo: f * 0.45,
      wet: 0.25 + i * 0.06,
      delay,
    });
  }

  const heft = Math.min(1, count / 10);
  texture({
    dur: 0.2 + heft * 0.22,
    gain: 0.07 + heft * 0.045,
    freq: 420,
    sweepTo: 150,
    q: 0.9,
    wet: 0.32 + heft * 0.2,
    delay: 0.01,
  });
  sub({
    freq: 68,
    glideTo: 40,
    dur: 0.3 + heft * 0.22,
    gain: 0.13 + heft * 0.07,
    attack: 0.01,
    wet: 0.18,
  });
}

export function sfxExtract(): void {
  if (sample("extract", 0.9, 0.4)) return;
  texture({
    dur: 0.34,
    gain: 0.075,
    freq: 2600,
    sweepTo: 620,
    q: 0.7,
    type: "lowpass",
    attack: 0.012,
    wet: 0.45,
  });
  sub({ freq: 116, glideTo: 88, dur: 0.5, gain: 0.16, attack: 0.02, wet: 0.35 });
  knock(300, 0.05, 0.3, 0.03);
}

export function sfxYouDied(): void {
  if (sample("died", 1, 0.5)) return;
  sub({ freq: 92, glideTo: 26, dur: 1.25, gain: 0.3, attack: 0.005, wet: 0.45 });
  texture({ dur: 0.5, gain: 0.15, freq: 1500, sweepTo: 160, q: 1.1, wet: 0.55 });
  texture({
    dur: 0.9,
    gain: 0.06,
    freq: 300,
    sweepTo: 90,
    q: 0.6,
    type: "lowpass",
    attack: 0.05,
    wet: 0.7,
    delay: 0.08,
  });
}

export function sfxSeal(): void {
  if (sample("seal", 0.9, 0.4)) return;
  sub({ freq: 128, glideTo: 54, dur: 0.5, gain: 0.19, attack: 0.01, wet: 0.4 });
  texture({ dur: 0.19, gain: 0.07, freq: 520, sweepTo: 170, q: 1.1, wet: 0.35 });
}

export function sfxJoin(): void {
  if (sample("join", 1.9, 0.3)) return;
  knock(210, 0.09, 0.28);
  sub({ freq: 140, dur: 0.22, gain: 0.07, attack: 0.014, wet: 0.3 });
}

export function sfxStatic(amount: number): void {
  const a = Math.max(0, Math.min(1, amount));
  if (a <= 0.01) return;
  const grains = 1 + Math.round(a * 2);
  for (let i = 0; i < grains; i++) {
    texture({
      dur: 0.018 + Math.random() * 0.05,
      gain: 0.013 + a * 0.02,
      freq: 2600 + Math.random() * 2800,
      q: 0.8,
      attack: 0.001,
      wet: 0.05,
      delay: i === 0 ? 0 : Math.random() * 0.1,
    });
  }
  if (a > 0.6) {
    texture({
      dur: 0.16,
      gain: 0.045,
      freq: 680,
      sweepTo: 210,
      q: 0.7,
      type: "lowpass",
      attack: 0.004,
      wet: 0.1,
    });
  }
}

export function sfxTvOff(): void {
  texture({ dur: 0.018, gain: 0.05, freq: 3400, q: 1.4, attack: 0.001, wet: 0.04 });
  if (ctx && master && !muted) {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(3100, t0);
    osc.frequency.exponentialRampToValueAtTime(120, t0 + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.026, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    osc.connect(g);
    connectVoice(g, 0.08);
    osc.start(t0);
    osc.stop(t0 + 0.24);
  }
  sub({ freq: 88, glideTo: 30, dur: 0.3, gain: 0.13, attack: 0.004, wet: 0.15, delay: 0.05 });
}

export function sfxTvOn(): void {
  texture({ dur: 0.28, gain: 0.055, freq: 90, q: 3.2, attack: 0.02, wet: 0.18 });
  sub({ freq: 44, glideTo: 58, dur: 0.26, gain: 0.085, attack: 0.02, wet: 0.15 });
  texture({ dur: 0.05, gain: 0.028, freq: 3600, q: 0.9, attack: 0.001, wet: 0.06, delay: 0.1 });
}
