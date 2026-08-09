/**
 * Audio.
 *
 * Two rules came out of playtesting, and they drive everything here.
 *
 * 1. NO TONES. Bells, chimes and pitched "blings" are what made the last pass
 *    feel like a toy. Nothing in this file plays a melody or a chord you could
 *    hum, with the single exception of the jackpot, which earns it. Everything
 *    else is material: noise driven through resonant filters, plus sub. That
 *    is how real impact design works — you are meant to hear an object, not a
 *    synthesiser.
 *
 * 2. A MASS SHATTER IS MANY THINGS, NOT ONE BIG THING. Making a wipe louder
 *    sounded like a machine gun; making it deeper sounded like a bad movie
 *    trailer. Twenty plates going at once is a rockfall — a spread of small
 *    cracks, staggered by a few milliseconds each, over one shared low body.
 *    So `sfxShatter` scales in *density*, holding pitch and level roughly
 *    fixed.
 *
 * Everything runs through a convolution reverb built from a generated impulse
 * response, so sounds sit in a room instead of firing dry at the listener.
 *
 * ── Using real recorded samples instead ──────────────────────────────────
 * Synthesis is the fallback, not the ceiling. Drop audio files into
 * `apps/web/public/sfx/` and they are used automatically in place of the
 * synthesised voice, no code change:
 *
 *     tick.mp3  shatter.mp3  shatter_many.mp3  extract.mp3
 *     died.mp3  seal.mp3     join.mp3          bonanza.mp3
 *
 * (.mp3, .wav or .ogg — the loader tries each.) Anything missing keeps its
 * synthesised version, so the pack can be filled in one sound at a time.
 * Sources that are free for commercial use: freesound.org filtered to CC0,
 * or a paid pack from Soundly / A Sound Effect / Krotos.
 */

import { riskScale } from "../game/risk";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let reverbBus: GainNode | null = null;
let muted = false;

const STORAGE_KEY = "zinc.muted";
const VOLUME_KEY = "zinc.volume";
/** 0–1, persisted. Mute is just this held at zero without forgetting the setting. */
let volume = 0.7;

/**
 * Peak every pack sample is normalised to.
 *
 * Generated and library SFX arrive mastered near full scale, which is roughly
 * three times hotter than anything synthesised here — so dropping one in made
 * it jump out of the mix. Rather than guess a trim per file, every sample is
 * scanned on load and scaled to this peak, which is where the synth voices
 * sit. Re-generating a file at a different level then changes nothing.
 */
const SAMPLE_PEAK = 0.34;

/* ── Optional sample pack ───────────────────────────────────────────────── */

const SAMPLE_NAMES = [
  "tick",
  "shatter",
  "shatter_many",
  "extract",
  "died",
  "seal",
  "join",
  "bonanza",
] as const;
type SampleName = (typeof SAMPLE_NAMES)[number];

const samples = new Map<SampleName, AudioBuffer>();
/** Per-sample scaling that brings each file to SAMPLE_PEAK. */
const sampleGain = new Map<SampleName, number>();

/** Highest absolute sample value across every channel. */
function peakOf(buf: AudioBuffer): number {
  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    // Stepping is plenty for a peak estimate on a one-shot and keeps a 5s
    // stereo file from blocking the main thread on load.
    for (let i = 0; i < data.length; i += 4) {
      const v = data[i]! < 0 ? -data[i]! : data[i]!;
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/**
 * Tries each container for each name. A miss is completely normal — the file
 * simply isn't in the pack — so failures are silent and leave the synthesised
 * voice in place.
 */
async function loadSamplePack(ac: AudioContext): Promise<void> {
  const base = import.meta.env.BASE_URL || "/";
  await Promise.all(
    SAMPLE_NAMES.map(async (name) => {
      for (const ext of ["mp3", "wav", "ogg"]) {
        try {
          const res = await fetch(`${base}sfx/${name}.${ext}`);
          if (!res.ok) continue;
          const bytes = await res.arrayBuffer();
          // A static host that falls back to index.html will hand us HTML with
          // a 200, so decoding is the real test of whether a sample exists.
          if (bytes.byteLength < 512) continue;
          const buf = await ac.decodeAudioData(bytes);
          const peak = peakOf(buf);
          samples.set(name, buf);
          sampleGain.set(name, peak > 0.001 ? SAMPLE_PEAK / peak : 1);
          return;
        } catch {
          /* next extension */
        }
      }
    }),
  );
}

/** Plays a pack sample if one was found. Returns false to fall through to synthesis. */
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

/* ── Engine ─────────────────────────────────────────────────────────────── */

/**
 * Impulse response: exponentially decaying noise, slightly different per
 * channel for width, one-pole lowpassed so the tail is dark rather than hissy.
 */
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

    // Glue compression, then a ceiling so a mass shatter can never clip.
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
    // Zero is a legal saved level. Guarding with `v > 0` silently discarded a
    // slider parked at 0, so the game came back at the 70% default — the one
    // preference where getting it wrong is loudest. A missing key reads as
    // null, and Number(null) is 0, so existence is checked first.
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

/** Applies mute and level together — mute is level zero without losing the setting. */
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
    /* preference simply won't persist */
  }
  applyLevel();
}

export function isMuted(): boolean {
  return muted;
}

export function getVolume(): number {
  return volume;
}

/**
 * Master level, 0-1. Touching the slider also unmutes: a player dragging the
 * volume up while muted plainly wants to hear something.
 */
export function setVolume(next: number): void {
  volume = Math.max(0, Math.min(1, next));
  if (volume > 0 && muted) {
    muted = false;
    try {
      localStorage.setItem(STORAGE_KEY, "0");
    } catch {
      /* ignore */
    }
  }
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    /* ignore */
  }
  applyLevel();
}

/** Routes a voice to the dry output and, optionally, the reverb send. */
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

/**
 * Sub-bass weight. Sine only, and kept below ~200Hz — the moment this reaches
 * into the midrange it stops being felt and starts being a note.
 */
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

/**
 * One shared noise bed, generated once. Every texture voice used to fill a
 * fresh AudioBuffer with a per-sample RNG loop on the main thread — with the
 * tick firing twice a second and shatters spawning up to eight voices, a hot
 * round churned tens of thousands of `Math.random()` calls per second. A
 * random read offset into one long buffer is indistinguishable to the ear.
 */
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

/** Resonant filtered noise. The material itself — never raw white noise. */
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
  // Random offset into the shared bed, clamped so the read never runs off the end.
  const offset = Math.random() * Math.max(0, NOISE_SECONDS - dur - 0.05);
  src.start(t0, offset, dur + 0.02);
}

/** One dry, woody knock. Short enough to read as an impact, not a pitch. */
function knock(freq: number, gain: number, wet = 0.18, delay = 0): void {
  texture({ dur: 0.045, gain, freq, q: 2.4, wet, delay });
  sub({ freq, glideTo: freq * 0.55, dur: 0.1, gain: gain * 0.8, attack: 0.002, wet, delay });
}

/* ── Cues ───────────────────────────────────────────────────────────────── */

/**
 * The metronome — the only cue that carries continuous information.
 *
 * It fires twice a second for the whole round, so it is the one sound a player
 * hears enough times to read *without looking*. That makes it far too valuable
 * to be a constant click.
 *
 * ── Calibration ──────────────────────────────────────────────────────────
 * The scale is set by where the hazard actually spends its time. Play a round
 * and it opens near 7%, collapses within a few ticks, then lives between
 * roughly 0.5% and 3.5% for almost the entire round. The endgame creep pulls
 * over half of rounds back above 5% and a few percent past 7.5%; nothing
 * measured has ever exceeded ~17%. The shared scale has a knee at 7.5%: full
 * resolution below it, the top 15% reserved for the rare blowout.
 *
 * The mapping is logarithmic for the same reason hearing is: what registers is
 * the ratio between two values, not their difference. 1% to 2% is a doubling
 * of your chance of dying and sounds like a real change; 6% to 7% is a sixth
 * more and barely should.
 *
 *     hazard   0.4%    1%     2%     3%     5%    7.5%   10%    17%
 *     scale    0.00   0.27   0.47   0.58   0.73   0.85   0.88   0.92
 *
 * ── What moves ───────────────────────────────────────────────────────────
 * Seven things at once, because level alone reads as "same sound, louder"
 * rather than as danger:
 *
 *   level      near-silent when safe, seven times louder at the top
 *   pitch      the pulse rises more than an octave
 *   timbre     a dull lowpassed pff becomes a focused resonant knock
 *   brightness the filter opens almost six-fold
 *   length     the decay stretches from a blip to a thud
 *   weight     sub-bass fades in through the upper half
 *   space      the reverb send opens, which is what reads as dread
 *
 * Past ~3% a soft sub-only ghost beat follows each tick, tightening as risk
 * climbs. See the note on it below: at a 500ms tick a full doubled beat is
 * roughly 240bpm and reads as an alarm rather than as tension.
 */

/**
 * Overall level of the tick, independent of every other cue.
 *
 * It fires ~120 times a minute, so it sits at a completely different fatigue
 * budget from sounds you hear once a round. One knob for the whole voice keeps
 * the risk dynamics intact while scaling the lot — nudge this alone rather
 * than the individual gains below.
 */
const TICK_LEVEL = 0.58;

export function sfxTick(hazard: number): void {
  // Shared with the risk meter. These were two independent hardcoded curves
  // that had already drifted apart once.
  const t = riskScale(hazard);

  if (sample("tick", (0.22 + t * 0.95) * TICK_LEVEL, 0.06 + t * 0.5, 0.86 + t * 0.3))
    return;

  // Shaped curves so the middle of the range keeps moving rather than
  // saturating: brightness and length lead, weight lags.
  const lead = Math.pow(t, 0.75);

  const wet = 0.05 + lead * 0.4;
  const dur = 0.045 + lead * 0.215;

  const beat = (delay: number, level: number): void => {
    // Body. Timbre class changes, not just the filter frequency — a dull
    // lowpassed breath at the bottom, a focused resonant knock at the top.
    // Switching type is far more noticeable than any amount of tweening.
    // Threshold constants sit on the knee scale so each character change
    // lands at the same real-world hazard it always did.
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
    // Pitched pulse — over an octave of travel, which is most of the tension.
    sub({
      freq: 68 + lead * 82,
      glideTo: 52 + lead * 30,
      dur: dur * 1.5,
      gain: (0.022 + lead * 0.062) * level * TICK_LEVEL,
      attack: 0.002,
      wet: wet * 0.7,
      delay,
    });
    // Weight. Fades in through the upper half; this is what pulls the tick
    // toward the character of the lattice sealing.
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
    // Bite. A short transient on top once it is genuinely dangerous — an
    // attack character that simply is not present lower down. Kept well below
    // the presence peak around 3-4kHz, which is where the ear is most easily
    // fatigued and where this turned shrill.
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

  /*
   * The heartbeat.
   *
   * This is the cue the whole tick is built around, but it needs restraint at
   * this tempo. Ticks land every 500ms, so a full second beat means four
   * impacts a second — around 240bpm, which stops reading as tension and
   * starts reading as an alarm. The reference (a shooter's low-health
   * heartbeat) works because it is slow and alone in the mix; here it is
   * riding on top of an already-fast metronome.
   *
   * So the second beat is a ghost, not a repeat: sub only, no body, no bite,
   * darker and much quieter than the first, sitting under it rather than
   * beside it. You feel the doubling more than you hear it. It also holds off
   * until ~3% now, so it marks a genuinely hot shaft instead of being the
   * normal state of affairs.
   */
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

/**
 * Plates shattering — a rockfall, not an explosion.
 *
 * The count changes how *many* cracks you hear and how far they smear across
 * time, not how loud or how low the whole thing is. Pitch and level are held
 * near constant on purpose: one plate and fifteen plates should sound like the
 * same material, in the same room, at different scales of event.
 */
export function sfxShatter(count: number): void {
  const n = Math.max(1, Math.min(7, Math.round(Math.sqrt(count) * 1.6)));
  if (sample(count > 3 ? "shatter_many" : "shatter", 0.85, 0.3)) return;

  // The grains. Each is a separate small fracture, jittered so they never line
  // up into a single machine-gun transient.
  for (let i = 0; i < n; i++) {
    const delay = i === 0 ? 0 : 0.012 + Math.random() * 0.1;
    const f = 900 + Math.random() * 1500;
    texture({
      dur: 0.035 + Math.random() * 0.05,
      // Later grains sit further back, so the cascade has depth.
      gain: (0.075 / (1 + i * 0.45)) * (0.8 + Math.random() * 0.4),
      freq: f,
      q: 2.2,
      sweepTo: f * 0.45,
      wet: 0.25 + i * 0.06,
      delay,
    });
  }

  // One shared body under the whole cascade. Grows sub-linearly, and never
  // drops in pitch with size — mass reads as spread, not as depth.
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

/**
 * You got out. A pressure release, not a reward jingle — air escaping a seal,
 * settling onto a soft floor. Relief reads better than congratulation, and it
 * does not get grating on the two-hundredth time.
 */
export function sfxExtract(): void {
  if (sample("extract", 0.9, 0.4)) return;
  // Air venting.
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
  // The floor it lands on.
  sub({ freq: 116, glideTo: 88, dur: 0.5, gain: 0.16, attack: 0.02, wet: 0.35 });
  knock(300, 0.05, 0.3, 0.03);
}

/** Your plate went. Dark, close, final. */
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

/** The lattice sealing. Low, solid, a door closing. */
export function sfxSeal(): void {
  if (sample("seal", 0.9, 0.4)) return;
  sub({ freq: 128, glideTo: 54, dur: 0.5, gain: 0.19, attack: 0.01, wet: 0.4 });
  texture({ dur: 0.19, gain: 0.07, freq: 520, sweepTo: 170, q: 1.1, wet: 0.35 });
}

/**
 * You bonded in. A single low confirmation.
 *
 * The sample rides considerably louder than the synthesised version it
 * replaces. That voice was written as the quietest thing in the game — a
 * deliberate near-nothing — and the pack file inherited its level, which left
 * a real recording sitting under everything around it. Loudness normalisation
 * does not catch this: it equalises the *files*, and this was the cue's own
 * trim being wrong.
 */
export function sfxJoin(): void {
  if (sample("join", 1.9, 0.3)) return;
  knock(210, 0.09, 0.28);
  sub({ freq: 140, dur: 0.22, gain: 0.07, attack: 0.014, wet: 0.3 });
}

/* ── Broadcast layer ────────────────────────────────────────────────────────
 *
 * CRT mode's hardware sounds — the FEED failing, not the ice. The world's
 * audio above sits in a room, on the reverb bus; these sit on the glass:
 * dry, close, quiet. Callers gate on CRT being enabled — the audio engine
 * has no business knowing about a render flag.
 */

/**
 * Tape damage. The renderer fires this on the exact frame a band tear or
 * tracking fault hits the picture, so the crackle is what the tear sounds
 * like rather than a sound that happens to play near it.
 *
 * `amount` is the fault's energy, 0-1: an idle tracking stray at the bottom,
 * a full signal break at the top. More energy means more grains, denser and
 * slightly brighter — never simply louder, same law as the shatter.
 */
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
  // A hard break also drags the low end for a beat — the picture physically
  // losing its lock, not just the surface crackling.
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

/**
 * The set powers down between rounds: relay click, the scan collapsing to a
 * line, the tube letting go. The falling whistle is a sine, which flirts with
 * the no-tones rule — but at 200ms top-to-bottom it reads as machinery dying,
 * not as a note, and nothing about it can be hummed.
 */
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

/**
 * Power back on for the next round: a degauss shudder — low buzzy noise, the
 * coil not a chord — and a small static pop as the picture snaps back.
 */
export function sfxTvOn(): void {
  texture({ dur: 0.28, gain: 0.055, freq: 90, q: 3.2, attack: 0.02, wet: 0.18 });
  sub({ freq: 44, glideTo: 58, dur: 0.26, gain: 0.085, attack: 0.02, wet: 0.15 });
  texture({ dur: 0.05, gain: 0.028, freq: 3600, q: 0.9, attack: 0.001, wet: 0.06, delay: 0.1 });
}

/**
 * The jackpot — the one moment allowed to be musical.
 *
 * Structure is the standard three-part celebration cue: a riser that builds
 * anticipation, an impact that lands it, then a warm sustained pad that hangs
 * in the reverb while the overlay plays. The pad is a filtered saw stack, not
 * bells: an open fifth with the octave above it, lowpassed so it stays warm
 * and never turns into a sparkle.
 */
export function sfxBonanza(): void {
  if (sample("bonanza", 1, 0.5)) return;
  if (!ctx || !master || muted) return;
  const t0 = ctx.currentTime;

  // Riser: 1.1s of noise sweeping up into the hit.
  texture({
    dur: 1.1,
    gain: 0.09,
    freq: 260,
    sweepTo: 5200,
    q: 1.4,
    attack: 0.5,
    wet: 0.5,
  });

  // Impact.
  const hit = 1.1;
  sub({ freq: 78, glideTo: 40, dur: 1.5, gain: 0.32, attack: 0.006, wet: 0.35, delay: hit });
  texture({ dur: 0.5, gain: 0.13, freq: 1500, sweepTo: 200, q: 0.9, wet: 0.6, delay: hit });

  // The pad: C2 / G2 / C3 / G3. Slow attack, long release, well behind the hit.
  for (const [freq, level] of [
    [65.4, 0.075],
    [98.0, 0.06],
    [130.8, 0.05],
    [196.0, 0.032],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    osc.detune.value = (Math.random() - 0.5) * 9;

    // Filter opens as the chord blooms, which is what makes a pad breathe.
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(240, t0 + hit);
    lp.frequency.linearRampToValueAtTime(1500, t0 + hit + 1.2);
    lp.frequency.linearRampToValueAtTime(500, t0 + hit + 3.4);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0 + hit);
    g.gain.linearRampToValueAtTime(level, t0 + hit + 0.35);
    g.gain.setValueAtTime(level, t0 + hit + 1.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + hit + 3.6);

    osc.connect(lp);
    lp.connect(g);
    connectVoice(g, 0.55);
    osc.start(t0 + hit);
    osc.stop(t0 + hit + 3.7);
  }
}
