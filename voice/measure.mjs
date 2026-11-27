// Read a rendered WAV back and say what is actually in it.
//
// Everything here works from the samples alone. It does not import the synthesizer, it does
// not know which phonemes were asked for, and it has no expected timeline. That is the
// point: a check that shares its assumptions with the code under test can only prove they
// agree. Three questions are answered, each from the signal:
//
//   voiced share  - how much of the file is periodic sound at all. A file of silence, or of
//                   clicks, scores near zero even if its header is perfect.
//   onsets        - syllable-like events: energy rising out of a quiet stretch. This is the
//                   count that separates speech from one long tone, and it is compared with
//                   the number of syllables the text should have.
//   vowels        - for frames the file itself marks as stable and periodic, where the formants
//                   sit, and therefore which vowel class they are. A filter sweep for its
//                   own sake produces many vowel frames but an implausible one-pole voice:
//                   the same formant pair every frame. Real speech visits the space.
//
// The vowel classifier uses F1/F2 in Hz against coarse regions rather than the exact table,
// so a systematic offset in the synthesizer's formants does not make every vowel wrong.

import { readFileSync } from "node:fs";
import { wavSamples } from "./wav.mjs";

const FRAME = 1024; // ~46 ms at 22.05 kHz: long enough to resolve 300 Hz formants.

// Goertzel power at one frequency: cheap, and exact enough for a band comparison.
function powerAt(data, start, n, freq, rate) {
  const k = 2 * Math.PI * freq / rate;
  const c = 2 * Math.cos(k);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s = data[start + i] + c * s1 - s2; s2 = s1; s1 = s; }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

const BANDS = {
  // Formant search ranges. F1 for a male voice lives in 250-850 Hz, F2 in 800-2600.
  f1: Array.from({ length: 25 }, (_, i) => 250 + i * 25),
  f2: Array.from({ length: 37 }, (_, i) => 800 + i * 50)
};

// Coarse vowel regions in (F1, F2): enough to tell a front from a back vowel, which is what
// a listener does when deciding whether two words sound different.
const REGIONS = [
  { name: "IY", f1: [250, 420], f2: [2000, 2800] },
  { name: "IH", f1: [350, 520], f2: [1700, 2200] },
  { name: "EH", f1: [480, 640], f2: [1600, 2000] },
  { name: "AE", f1: [600, 780], f2: [1500, 1900] },
  { name: "AA", f1: [680, 850], f2: [1000, 1300] },
  { name: "AO", f1: [520, 700], f2: [800, 1000] },
  { name: "UH", f1: [380, 520], f2: [950, 1200] },
  { name: "UW", f1: [250, 380], f2: [800, 1050] },
  { name: "AH", f1: [560, 740], f2: [1100, 1400] }
];

function classify(f1, f2) {
  let best = null, bestCost = Infinity;
  for (const r of REGIONS) {
    const d1 = f1 < r.f1[0] ? r.f1[0] - f1 : f1 > r.f1[1] ? f1 - r.f1[1] : 0;
    const d2 = f2 < r.f2[0] ? r.f2[0] - f2 : f2 > r.f2[1] ? f2 - r.f2[1] : 0;
    const cost = d1 + d2;
    if (cost < bestCost) { best = r.name; bestCost = cost; }
  }
  return best;
}

export function measure(file) {
  const { rate, samples } = wavSamples(readFileSync(file));
  const n = samples.length;
  if (!n) throw new Error(`${file} has no samples`);

  // Frame energies, on a 10 ms hop.
  const hop = Math.round(rate / 100), window = FRAME;
  const frames = [];
  let peak = 0, peakSample = 0;
  for (let i = 0; i < n; i++) { const v = Math.abs(samples[i]); if (v > peakSample) peakSample = v; }
  for (let start = 0; start + window <= n; start += hop) {
    let sum = 0;
    for (let i = 0; i < window; i++) { const v = samples[start + i]; sum += v * v; }
    const rms = Math.sqrt(sum / window);
    if (rms > peak) peak = rms;
    frames.push({ start, rms });
  }
  if (!frames.length) throw new Error(`${file} is shorter than one analysis frame`);
  const loud = frames.filter(f => f.rms > peak * 0.06);

  // Onsets: a syllable is a rise in the energy envelope after a dip. Requiring true
  // *silence* between syllables would be wrong for real speech - connected speech rarely
  // goes quiet between syllables - and it was wrong here too: it found 4 events in a
  // sentence of 14 words. So this tracks local minima instead: each frame is compared with
  // the quietest frame since the last onset, and a rise of 1.6x that minimum is an event.
  // The refractory window keeps a vibrato or a burst from counting twice.
  //
  // The threshold is not a taste: `test/voice.test.mjs` renders a pure tone, white noise and
  // a slow filter sweep and requires this function to find fewer than three onsets in each,
  // while a spoken sentence clears it. If the threshold loosened until a sweep passed, that
  // test would go red.
  const refractory = Math.round(0.07 * 1000 / 10);
  // The quietest a frame is allowed to count as, for the purpose of a rise. A frame of
  // digital silence must not become the floor, because then every later frame divides by
  // zero and the detector is dead for the rest of the file. That is not hypothetical: an
  // AAC round trip pads the start of a file with a few all-zero samples, and a film's own
  // soundtrack therefore measured 0 onsets while the identical WAV it was rendered from
  // measured 14 - the failure was in the measure, not in the audio. Silences are common
  // (the start and end, the gap between sentences), so the floor is clamped to a small
  // fraction of the peak instead. Anything quieter than that is *at* the floor, and a rise
  // out of it still has to clear the audible gate below.
  // The one thing that must not become the floor is *digital silence* - a run of samples
  // that are exactly zero, which is what an encoder's padding and a file's own start and end
  // are made of. Quiet-but-real audio does participate, or the floor would drop so far that
  // every inter-syllable dip counted as a rise. Three LSB of 16-bit is the line: below that
  // there is no sound to be quieter than.
  const silence = 3 / 32768;
  const onsets = [];
  let low = Infinity, lastOnsetAt = -Infinity;
  frames.forEach(f => {
    const t = f.start / rate;
    if (f.rms < low && f.rms > silence) low = f.rms;
    // The rise has to be audible in absolute terms as well, so a quiet passage's own noise
    // floor is not chopped into syllables.
    const floor = Number.isFinite(low) ? low : peak * 0.05;
    if (f.rms > peak * 0.05 && f.rms / floor >= 1.6 && t - lastOnsetAt >= 0.07) {
      onsets.push(t); lastOnsetAt = t; low = f.rms;
    }
  });

  // Periodicity and formants, from the loud frames only.
  let periodic = 0, analysed = 0;
  const vowelFrames = [];
  for (const f of loud) {
    const data = samples.subarray(f.start, f.start + window);
    // Normalized autocorrelation at the pitch lag: a vowel repeats at its pitch period, and
    // white noise does not. `r` is the correlation coefficient over the overlap, so its
    // value is comparable between a loud frame and a quiet one.
    //
    // The first version of this summed every second product but divided by the *full*
    // frame energy, which is not a correlation at all: white noise scored 0.40 and a pure
    // tone 0.45, so the check could not tell a machine hum from a vowel. A probe caught it.
    // Now a tone scores ~1.0 and noise ~0, which is the behaviour the word "periodic"
    // promises.
    let best = 0;
    for (let lag = Math.round(rate / 300); lag <= Math.round(rate / 70); lag++) {
      let ab = 0, aa = 0, bb = 0;
      for (let i = 0; i < window - lag; i++) { const x = data[i], y = data[i + lag]; ab += x * y; aa += x * x; bb += y * y; }
      const r = aa && bb ? ab / Math.sqrt(aa * bb) : 0;
      if (r > best) best = r;
    }
    const periodicity = best;
    analysed++;
    if (periodicity < 0.35) continue;
    periodic++;
    const p1 = BANDS.f1.map(hz => [hz, powerAt(data, 0, window, hz, rate)]);
    const p2 = BANDS.f2.map(hz => [hz, powerAt(data, 0, window, hz, rate)]);
    const f1 = p1.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    const f2 = p2.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    // A frame whose strongest low-frequency peak is at the very edge of the search range is
    // not evidence of a formant there.
    if (f1 <= 250 || f1 >= 850 || f2 <= 800 || f2 >= 2600) continue;
    vowelFrames.push({ f1, f2, vowel: classify(f1, f2) });
  }
  const vowels = {};
  for (const v of vowelFrames) vowels[v.vowel] = (vowels[v.vowel] || 0) + 1;

  return {
    file,
    rate,
    seconds: n / rate,
    // Reported on the same scale as `test/wav.mjs` (16-bit counts) so the two can be
    // compared without a mental conversion.
    peakSample: Math.round(peakSample * 32767),
    voicedShare: analysed ? periodic / analysed : 0,
    loudFrames: loud.length,
    totalFrames: frames.length,
    onsets: onsets.length,
    onsetTimes: onsets.slice(0, 200),
    vowelFrames: vowelFrames.length,
    vowelKinds: Object.keys(vowels).length,
    vowels
  };
}
