// The acoustic half of the offline voice: phonemes to 16-bit PCM.
//
// This is a small formant synthesizer, the technique eSpeak is built on. A voiced sound is
// a buzz at the pitch of the voice passed through three resonators whose frequencies pick
// the vowel; an unvoiced sound is shaped noise. That is enough for English to be
// recognisable, it sounds like a machine rather than a person (the docs say so), and it
// needs nothing installed - which is the whole point: there is no speech model on this
// machine, in any form.
//
// What separates "words" from "beeps" is not the vowel table, it is timing:
//
//   * coarticulation - the resonators travel towards the next sound while the current one
//     is still sounding, the way a mouth does, instead of stepping at phoneme boundaries;
//   * a stop is a real silence and then a burst, which is what makes `cat` two events;
//   * unstressed syllables are shorter and quieter than stressed ones, and vowels are
//     longer at the end of a word.
//
// `voice/measure.mjs` reads the rendered file back and classifies each vowel from its
// spectrum without consulting this file, so "it sounds like words" is a number rather than
// an opinion.

import { tokenize, checkReadings, CURRENT_READINGS } from "./lexicon.mjs";

export const RATE = 22050; // Speech energy is under 8 kHz; 44.1 kHz would double the file
                          // for nothing. The WAV this writes is still ordinary 16-bit PCM.

// First three formant frequencies for each vowel, in Hz. These are the standard values for
// an adult male voice; they are what makes `ee` and `oo` different sounds rather than
// different pitches.
export const VOWEL_TARGETS = {
  IY: [270, 2290, 3010], IH: [390, 1990, 2550], EH: [530, 1840, 2480], AE: [660, 1720, 2410],
  AA: [730, 1090, 2440], AO: [570, 840, 2410], OW: [540, 900, 2400], UH: [440, 1020, 2240],
  UW: [300, 870, 2240], AH: [640, 1190, 2390], ER: [490, 1350, 1690],
  // A diphthong's entry lists its *offglide*; the nucleus comes from NUCLEUS.
  AY: [440, 1800, 2500], OY: [500, 900, 2300], AW: [600, 900, 2300], EY: [400, 2100, 2600]
};
const NUCLEUS = { AY: "AA", OY: "AO", AW: "AA", EY: "EH" };

// kind, duration ms, voiced?, noise band centre Hz.
export const CONSONANTS = {
  B: ["stop", 70, 1, 300], D: ["stop", 65, 1, 400], G: ["stop", 70, 1, 500],
  P: ["stop", 80, 0, 300], T: ["stop", 80, 0, 400], K: ["stop", 85, 0, 500],
  M: ["nasal", 75, 1, 260], N: ["nasal", 70, 1, 280], NG: ["nasal", 75, 1, 300],
  F: ["fric", 90, 0, 4000], TH: ["fric", 85, 0, 3500], S: ["fric", 100, 0, 6500],
  SH: ["fric", 105, 0, 3000], V: ["fric", 75, 1, 3500], DH: ["fric", 70, 1, 3200],
  Z: ["fric", 90, 1, 6000], ZH: ["fric", 95, 1, 2900], HH: ["fric", 60, 0, 1800],
  CH: ["affricate", 110, 0, 3000], JH: ["affricate", 100, 1, 2900],
  L: ["liquid", 85, 1, 360], R: ["liquid", 85, 1, 420], W: ["glide", 75, 1, 300], Y: ["glide", 70, 1, 2200]
};
const VOWELS = new Set(Object.keys(VOWEL_TARGETS));

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const frames = ms => Math.max(1, Math.round(ms * RATE / 1000));

// One two-pole resonator. Three in series turn a buzz into a vowel.
function makeResonator(freq) {
  const r = 0.965, theta = 2 * Math.PI * clamp(freq, 90, RATE / 2 - 400) / RATE;
  const a1 = 2 * r * Math.cos(theta), a2 = -r * r;
  let y1 = 0, y2 = 0;
  return x => { const y = x + a1 * y1 + a2 * y2; y2 = y1; y1 = y; return y; };
}

// Deterministic noise, so the same text renders to the same bytes and a check that compares
// audio against its own record is not a coin flip.
function noiseSource(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return (s / 0x7fffffff) - 1; };
}
function hashOf(text) {
  let h = 2166136261;
  for (const ch of text) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// A vowel plus the consonants around it: the unit that carries stress and length.
function syllables(phonemes) {
  const units = [];
  let onset = [];
  for (const p of phonemes) {
    if (VOWELS.has(p)) { units.push({ onset, vowel: p, coda: [] }); onset = []; }
    else if (units.length) units.at(-1).coda.push(p);
    else onset.push(p);
  }
  if (onset.length) {
    if (units.length) units.at(-1).coda.push(...onset);
    else units.push({ onset, vowel: null, coda: [] });
  }
  return units;
}

// Speak `tokens` (from lexicon.tokenize) and return an array of floats in -1..1.
// options.rate scales every duration (1.0 measured, 1.3 brisker, 0.8 deliberate);
// options.pitch is the base pitch in Hz.
export function synthesize(tokens, options = {}) {
  const rate = clamp(Number(options.rate) || 1, 0.5, 2.5);
  const pitch = clamp(Number(options.pitch) || 112, 70, 240);
  const rand = noiseSource(hashOf(tokens.map(t => t.word).join(" ")) ^ 0x9e37);
  const out = [];
  let phase = 0, voiced = 0, breath = 0;
  let formants = [500, 1500, 2500], target = [500, 1500, 2500];
  let res = formants.map(makeResonator), built = formants.slice(), sinceBuild = 0;
  const total = tokens.length || 1;

  // One stretch of sound at a fixed excitation and a travelling spectral target. `spectral`
  // false means the target is not a vowel: a consonant keeps the previous formant shape and
  // only changes its source, which is what stops a plosive from clicking.
  //
  // `envelope(i, n)` is an amplitude shape over the stretch. It exists because syllables
  // need an edge: with a flat envelope a sentence is one continuous buzz whose formants
  // wander, which measures as speech-like and is very hard to follow. Real speech dips 20-40
  // per cent between syllables, and that dip is what a listener hears as a word boundary.
  const emit = (ms, spectral, gain, place, pitchScale = 1, envelope = null) => {
    const n = frames(ms * rate);
    // Rebuild the filter every ~2 ms rather than every sample: formants move gradually, and
    // per-sample rebuilding costs more than it can buy at this resolution.
    const step = Math.max(1, Math.round(RATE * 0.002));
    const glide = Math.exp(-1 / (RATE * 0.010)); // 10 ms time constant on formant travel
    for (let i = 0; i < n; i++) {
      if (spectral) for (let k = 0; k < 3; k++) formants[k] = target[k] + (formants[k] - target[k]) * glide;
      if (++sinceBuild >= step) {
        sinceBuild = 0;
        if (built.some((f, k) => Math.abs(f - formants[k]) > 8)) { res = formants.map(makeResonator); built = formants.slice(); }
      }
      phase += (pitch * pitchScale) / RATE;
      if (phase >= 1) phase -= 1;
      // A pulse-ish source: the buzz carries the harmonics the formants shape.
      const buzz = 2 * phase - 1;
      let x = voiced * buzz + breath * rand() * (place / 4000);
      for (const r of res) x = r(x);
      // No clipping here. Three chained resonators have a large combined gain, and the first
      // version clamped every sample at 0.98 to keep the file in range - which turned 75% of
      // the output into a square wave. A square wave is periodic and formant-shaped enough to
      // look like speech to a check that counts frames, and it flattened every syllable
      // envelope into one continuous buzz, so a listener heard a rasp instead of words and the
      // onset count was measuring the clamp rather than the voice. The whole buffer is scaled
      // once, at the end, so the shape of the envelope survives.
      out.push(x * gain * (envelope ? envelope(i, n) : 1));
    }
  };

  tokens.forEach((token, index) => {
    const units = syllables(token.phonemes);
    const declination = 1.05 - 0.15 * (index / total);
    units.forEach((unit, u) => {
      const stressed = u === 0 && units.length > 1;
      for (const c of unit.onset) {
        const [kind, ms, isVoiced, place] = CONSONANTS[c] || ["fric", 70, 0, 3000];
        if (kind === "stop") {
          // Closure, then burst. The silence is the whole cue for a stop.
          voiced = 0; breath = 0; emit(ms * 0.55, false, 0.6, place);
          breath = 0.55; emit(ms * 0.45, false, 0.85, place);
        } else {
          voiced = isVoiced ? (kind === "nasal" || kind === "liquid" ? 0.32 : 0.22) : 0;
          breath = kind === "fric" || kind === "affricate" ? 0.5 : 0;
          emit(ms, false, kind === "nasal" ? 0.45 : 0.75, place);
        }
      }
      if (unit.vowel) {
        const v = unit.vowel, dip = v in NUCLEUS;
        target = (dip ? VOWEL_TARGETS[NUCLEUS[v]] : VOWEL_TARGETS[v]).slice();
        voiced = 0.42; breath = 0;
        const base = (dip ? 150 : 115) * (stressed ? 1.2 : 1) * (u === units.length - 1 ? 1.15 : 1);
        // Every syllable ends lower than it starts, and an unstressed one starts lower too.
        // This is the amplitude half of stress; the length half is in `base`.
        const top = stressed ? 1 : 0.72;
        const shape = (i, n) => top * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, i / n)));
        emit(base, true, 1, 0, declination * (stressed ? 1.05 : 1), shape);
        if (dip) { target = VOWEL_TARGETS[v].slice(); emit(base * 0.6, true, 1, 0, declination, shape); }
      }
      for (const c of unit.coda) {
        const [kind, ms, isVoiced, place] = CONSONANTS[c] || ["fric", 70, 0, 3000];
        if (kind === "stop") {
          voiced = isVoiced ? 0.2 : 0; breath = 0; emit(ms * 0.5, false, 0.5, place);
          voiced = 0; breath = 0.4; emit(ms * 0.35, false, 0.7, place);
        } else {
          voiced = isVoiced ? (kind === "nasal" ? 0.3 : 0.25) : 0;
          breath = kind === "fric" || kind === "affricate" ? 0.45 : 0;
          emit(ms, false, kind === "nasal" ? 0.4 : 0.65, place);
        }
      }
    });
    // Between words: a real silence, sized by punctuation. Twenty milliseconds is enough for
    // a listener to hear two words; without it `the sea` is one long `thuhsee`.
    voiced = 0; breath = 0;
    const gap = token.punctuation === "sentence" ? 220 : token.punctuation === "clause" ? 110 : 45;
    emit(gap, false, 0, 0);
  });

  // The very last vowel of the file is shaped by the same stress envelope and would end
  // abruptly; a 8 ms fade at each end plus 30 ms of silence keeps the edge clean.
  // True silence at both ends, and an 8 ms fade so the file does not begin with a click.
  const pad = new Array(frames(30)).fill(0);
  const all = [...pad, ...out, ...pad];
  // One gain for the whole file, setting the loudest sample to 0.9 of full scale. Rescaling
  // here rather than clipping per sample is what keeps the syllable envelope intact: the
  // relative shape of every dip and peak is a fact about the words, and a per-sample clamp
  // destroys exactly that.
  let loudest = 0;
  for (const v of all) { const a = Math.abs(v); if (a > loudest) loudest = a; }
  if (loudest > 0) { const scale = 0.9 / loudest; for (let i = 0; i < all.length; i++) all[i] *= scale; }
  const fade = frames(8);
  for (let i = 0; i < fade; i++) { all[i] *= i / fade; all[all.length - 1 - i] *= i / fade; }
  return all;
}

// The entry point the voice actually uses: one line of text per phrase, spoken in order.
// `segments` says where each phrase begins in the file, which is what lets the server check
// an agent's timeline against the WAV that was published rather than against its story.
// `readings` belongs here for the same reason rate and pitch do: it changes the bytes. A take
// recorded as "rate 1, pitch 112" but rendered by the rule engine cannot be reproduced by a
// build that reads words from the dictionary, and without this field the record could not say
// which one made the audio. It is validated where it is used, so a typo is a refusal and not a
// silent fallback to whatever this build happens to default to.
export function effectiveVoice(options = {}) {
  return {
    rate: clamp(Number(options.rate) || 1, 0.5, 2.5),
    pitch: clamp(Number(options.pitch) || 112, 70, 240),
    // Refused rather than defaulted. `options.readings` unset means "whatever this build
    // reads with"; a *named* table this build does not have is a typo or a newer build's
    // audio, and quietly substituting today's would make the one field that explains the
    // bytes into a field nothing enforces. `pronounce` raises the same error.
    readings: options.readings == null ? CURRENT_READINGS : checkReadings(options.readings)
  };
}

export function renderParagraph(phrases, options = {}) {
  const parts = [], segments = [];
  let cursor = 0;
  for (const phrase of phrases) {
    const { tokens, unreadable } = tokenize(phrase.text, effectiveVoice(options).readings);
    if (unreadable.length) throw new Error(`the offline voice cannot say ${unreadable.map(w => `"${w}"`).join(", ")}`);
    if (!tokens.length) continue;
    const pcm = synthesize(tokens, options);
    segments.push({ text: phrase.text, start: cursor / RATE, duration: pcm.length / RATE, words: tokens.length });
    parts.push(pcm);
    cursor += pcm.length;
  }
  // The settings these bytes were actually made with, after synthesis has clamped them. A
  // caller that records the numbers it *asked* for - or worse, rounds them - writes a record
  // that cannot reproduce its own audio, and a checker that trusts the record then refuses
  // an honest take. Measured: `--rate 1.23456` recorded as 1.235 re-rendered to a signal that
  // drifted far enough to fail two of five phrases.
  return { samples: parts.flat(), rate: RATE, segments, voice: effectiveVoice(options) };
}

// 16-bit little-endian mono RIFF/WAVE, header included: the same shape `synth` asks an
// agent for, so the file endpoint and the canvas player need to know nothing new.
export function toWav(samples, rate = RATE) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(clamp(samples[i], -1, 1) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii"); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii"); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
