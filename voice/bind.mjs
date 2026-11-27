// Does this WAV say the words its timeline claims?
//
// A reviewer found the hole this closes, on the shipped build: take A's audio and take B's
// `timeline.json` were accepted together, and the card reported B's sentence over A's sound.
// Nothing in the old check was wrong, it was merely insufficient - it compared the timeline
// with the *duration* of the file, so any two takes with the same number of syllables
// matched. A person reopening the card then saw one sentence written down and heard another,
// which is worse than no record at all.
//
// The first fix used the property that makes this voice checkable at all: rendering is
// deterministic, so the server re-rendered the timeline's phrases and correlated the result
// with the published samples. Same words scored 1.000, a one-word edit 0.515, two swapped
// clauses 0.166 - and one correlation over the whole file looked like a clean answer.
//
// It was not, and the same reviewer showed why twice:
//
//   * with a 32-second take of twelve sentences that differ only in the last two clauses,
//     the file-level correlation of the mixed take was 0.896 - above the threshold,
//     accepted - because eleven and a half seconds of the two scripts are identical;
//   * so the unit had to become the phrase. But one correlation per phrase is *the same
//     mistake one level down*: a phrase whose shared opening is long enough also averages
//     its own edit away. Measured, a phrase reworded only at the end scored 0.940.
//
// So the unit is smaller again: this compares each phrase against its own render **frame by
// frame** and answers with the worst frame that carries sound. A shared prefix cannot hide a
// difference, at any length, because there is nowhere left for agreement to be averaged into.
// Measured on this voice, 25 ms frames over the frames the render
// gives energy to. All of these numbers are printed by `node voice/audit-binding.mjs`, so the
// claim can be rechecked on any build rather than taken from this comment:
//
//   the same phrase ..................... worst frame  1.000
//   one word changed ................... worst frame -0.344
//   a phrase reworded at the end ....... worst frame -0.218
//   the ending clause swapped .......... worst frame -0.297
//
// The threshold of 0.5 sits far from both ends, and the sign makes it starker than that: an
// honest take's worst frame is 1.000 and a changed one's is negative, because the two signals
// disagree about which way the pressure is going at that instant. It is not a similarity
// score for judging quality - each phrase answers one yes/no question, "is every audible
// moment of this phrase the sound these words make" - and a phrase that fails is refused, not
// described as slightly wrong.
import { readFileSync } from "node:fs";
import { renderParagraph, RATE } from "./synth.mjs";
import { wavSamples } from "./wav.mjs";
import { tokenize, CURRENT_READINGS, READING_SETS } from "./lexicon.mjs";

// The worst frame of a phrase that is still this phrase. An honest take measures 1.000 on
// every frame; any edited phrase measured below zero on its worst frame.
export const SAME_TAKE = 0.5;
// A timeline that rounded its start times to the sample can be off by one. The exact
// position and its two neighbours are tried and the best taken: a realignment of a sample,
// never enough for a phrase to line up with its neighbour, which is a different sound.
const SLIP = 1;

// The same question at the precision the record was actually written to, which is the
// defect a person hit with an honest take: a timeline whose starts are written to two
// decimal places - 4.38 rather than 4.3835147 - is up to half of that last place away from
// the truth, which at 22.05 kHz is 110 samples, not one. The old check searched a single
// sample either side, so such a take was refused as "not the sound these words make" and the
// phrase was blamed for a number that had merely been rounded.
//
// The half-place rule is derived from the number itself rather than assumed, and capped at a
// value that is still a rounding: a record written to whole seconds is not an imprecise
// record of a position, it is a different claim, and searching half a second for a match
// would be fitting the answer to the question.
const COARSEST_SLIP = 0.05;

// How far a number written the way this number was written can be from the truth, in the
// units of the number. `4.38` can be 0.005 away; `4.383514739` cannot be meaningfully wrong
// at all; and `0` is exact, because a phrase that starts at the beginning is not a rounded
// measurement of anything.
export function writtenSlack(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return 0;
  const text = String(Math.abs(n));
  // Exponent form says nothing about how many places were written, only how the value was
  // printed, so it is treated as exact.
  if (/e/i.test(text)) return 0;
  const dot = text.indexOf(".");
  const places = dot === -1 ? 0 : text.length - dot - 1;
  if (!places) return COARSEST_SLIP;
  return Math.min(COARSEST_SLIP, 0.5 * 10 ** -places);
}
// Frames are 25 ms with a 12.5 ms hop. A frame needs to be long enough to contain a pitch
// period of the lowest voice this engine makes (~70 Hz, 14 ms) and short enough that a single
// changed word cannot hide inside one. Half-overlapping hops mean no invented dip falls
// between two frames.
const FRAME_MS = 25, HOP_MS = 12.5;
// A frame is only judged where the phrase's own render has sound in it. A stop consonant is a
// real silence in both signals, and correlating two silences says nothing either way.
const ENERGY = 0.02;

// Published samples are a Buffer and a render is a plain array. `subarray` is the Buffer way
// and `slice` the array way, so this is the one place that knows the difference.
const cut = (samples, from, to) => (typeof samples.subarray === "function" ? samples.subarray(from, to) : samples.slice(from, to));

// Normalised correlation of two sample arrays: 1 is the same signal, 0 is unrelated.
// Compared over the shorter array; lengths are required to match before this is called.
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  const num = sab - (sa * sb) / n;
  const den = Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n));
  return den > 0 ? num / den : 0;
}

// The worst frame agreement between a phrase's own render and the audio published for it.
// Returns the score and where it happened, so a refusal can point at the moment that is not
// the words written for it rather than at the whole sentence.
export function frameAgreement(mine, heard, rate = RATE) {
  const frame = Math.max(1, Math.round(rate * FRAME_MS / 1000)), hop = Math.max(1, Math.round(rate * HOP_MS / 1000));
  let peak = 0;
  for (const v of mine) { const a = Math.abs(v); if (a > peak) peak = a; }
  const floor = peak * ENERGY;
  let worst = { score: null, at: 0 }, judged = 0;
  for (let at = 0; at + frame <= mine.length && at + frame <= heard.length; at += hop) {
    const a = cut(mine, at, at + frame), b = cut(heard, at, at + frame);
    let energy = 0;
    for (const v of a) energy += v * v;
    if (Math.sqrt(energy / frame) < floor) continue;
    judged++;
    const score = correlation(a, b);
    if (worst.score == null || score < worst.score) worst = { score, at: at / rate };
  }
  // A phrase with no audible frame at all cannot be spoken words; the acoustic judge says
  // so. Reporting 0 here keeps this function's answer a number rather than a shrug.
  return { score: worst.score == null ? 0 : Number(worst.score.toFixed(4)), at: Number(worst.at.toFixed(2)), frames: judged };
}

// The words a script claims, lowercased and stripped the way the lexicon strips them, so
// "door." and "door" are the same word in both the audio check and the source check.
export function wordsOf(text) {
  return tokenize(String(text || "")).tokens.map(t => t.word.toLowerCase());
}

// Every word the timeline claims was spoken, in order.
export function spokenWords(timeline) {
  const phrases = Array.isArray(timeline?.phrases) ? timeline.phrases : [];
  return phrases.flatMap(p => wordsOf(p?.text));
}

// Does `spoken` appear inside `source` as an in-order subsequence?
//
// This is the answer to "which card was read": a narration is allowed to be a selection of
// the material - an agent may cut a long paragraph down, and a trailer with one line of a
// script is a legitimate take - but it is not allowed to say words that are in the material
// nowhere. The old check only asked whether each word was pronounceable, so a confident
// script about a different subject passed as long as it spelled its words.
export function appearsInOrder(spoken, source) {
  let at = 0;
  const missing = [];
  for (const word of spoken) {
    while (at < source.length && source[at] !== word) at++;
    if (at >= source.length) { missing.push(word); at = 0; } else at++;
  }
  return { ok: missing.length === 0, missing };
}

// Where else in the file this phrase's own sound appears, when it is nowhere near the place the
// timeline names. Coarse and decimated first, because scanning a whole file at every sample
// would cost more than the check is worth; the answer is only used when the frame test confirms
// an *exact* reproduction somewhere else, so a decimated peak can be dismissed but never
// trusted on its own.
function locateElsewhere({ mine, samples, rate }) {
  // The decimation factor follows the file: a minute of audio at 16x is still a third of a
  // million comparisons per phrase, and a refusal must not become the slowest thing the check
  // does. The coarse pass is only a way to find candidates, and the full-resolution confirmation
  // below is what decides, so a coarser first pass costs accuracy of *placement* only in the
  // sense of trying a few more windows - never of the answer.
  const DEC = Math.max(8, Math.ceil(samples.length / 20000));
  const decimate = arr => {
    const out = [];
    for (let i = 0; i + DEC <= arr.length; i += DEC) {
      let s = 0;
      for (let k = 0; k < DEC; k++) s += arr[i + k];
      out.push(s / DEC);
    }
    return out;
  };
  const want = decimate(mine), file = decimate(samples);
  const W = want.length;
  if (W < 8 || file.length <= W) return null;
  const n = file.length, pre = new Float64Array(n + 1), pre2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { pre[i + 1] = pre[i] + file[i]; pre2[i + 1] = pre2[i] + file[i] * file[i]; }
  let sw = 0, sww = 0;
  for (const v of want) { sw += v; sww += v * v; }
  const peaks = [];
  for (let o = 0; o + W <= n; o++) {
    const sf = pre[o + W] - pre[o], sf2 = pre2[o + W] - pre2[o];
    let sbf = 0;
    for (let k = 0; k < W; k++) sbf += want[k] * file[o + k];
    const den = Math.sqrt((sww - (sw * sw) / W) * (sf2 - (sf * sf) / W));
    const sc = den > 0 ? (sbf - (sw * sf) / W) / den : 0;
    if (peaks.length < 3 || sc > peaks[peaks.length - 1].score) {
      peaks.push({ score: sc, at: o * DEC });
      peaks.sort((a, b) => b.score - a.score);
      if (peaks.length > 3) peaks.pop();
    }
  }
  // Confirm at full resolution, and only report a place where the phrase reproduces exactly:
  // that is what makes it the same recording moved, rather than something that merely resembles
  // it. The window either side is one decimated step.
  for (const p of peaks) {
    for (let d = -DEC; d <= DEC; d += 1) {
      const from = Math.max(0, p.at + d), slice = cut(samples, from, from + mine.length);
      if (Math.abs(slice.length - mine.length) > 2) continue;
      if (frameAgreement(mine, slice, rate).score >= RECOVERED_TAKE) return { seconds: from / rate };
    }
  }
  return null;
}

// A phrase can fail in two very different ways, and an operator who is told the wrong one
// cannot act on it. The words may really be different from the sound (the defect this check
// exists for), or the take may be perfectly honest and the *record* may misstate the rate or
// pitch it was rendered at - which is a bug in whatever wrote the timeline, not a lie about
// the words. Those need different fixes, so a refusal works out which it is: it re-renders
// the same words across a narrow band of speed and pitch, and if one of those reproduces the
// audio it says so instead of accusing the script. This only chooses the wording; `ok` was
// already false, so a near-miss in the band never accepts anything.
function describeMismatch({ index, phrase, mine, slices, samples, rate, start, score, at, voice }) {
  const base = { rate: Number(voice?.rate) || 1, pitch: Number(voice?.pitch) || 112, readings: voice?.readings || CURRENT_READINGS };
  const tried = [];
  for (const dr of [0, -0.0005, 0.0005, -0.001, 0.001, -0.002, 0.002, -0.005, 0.005, -0.01, 0.01, -0.02, 0.02])
    for (const dp of [0, -1, 1, -2, 2])
      tried.push({ rate: base.rate * (1 + dr), pitch: base.pitch + dp, readings: base.readings });
  let near = null;
  for (const options of tried) {
    let alt;
    try { alt = renderParagraph([{ text: phrase.text }], options); } catch { continue; }
    if (Math.abs(alt.samples.length - mine.length) > Math.max(2, mine.length * 0.02)) continue;
    const best = slices.map(slice => frameAgreement(alt.samples, slice, rate)).reduce((w, f) => (f.score > w.score ? f : w));
    if (best.score >= SAME_TAKE) { near = { options, score: best.score }; break; }
  }
  if (near) {
    const was = `rate ${base.rate}, pitch ${base.pitch}`;
    const found = `rate ${near.options.rate.toFixed(6)}, pitch ${near.options.pitch}`;
    return `phrase ${index + 1} ("${phrase.text}") is the right words, but not at the settings the timeline records: the audio matches them at ${found}, while the record says ${was}. Nothing is wrong with the script - the file that describes this take rounded or misstated its rate or pitch, so it cannot reproduce its own audio`;
  }
  // The third case, found by a supervisor: the *words* can be exactly right while the start time
  // written for them is wrong. The audio is a true recording of that sentence, and the record
  // merely says it begins 40 ms away from where it does; the take is honest and the *timeline*
  // is what cannot be trusted. Accusing the script there sends a person to rewrite a sentence
  // that is already correct, so the file is searched for the phrase before the words are
  // blamed. Nothing is accepted by this - it only chooses the sentence on the card.
  const misplaced = samples ? locateElsewhere({ mine, samples, rate }) : null;
  if (misplaced && Math.abs(misplaced.seconds - start) > 0.005) {
    return `phrase ${index + 1} ("${phrase.text}") is the right words, but not where the timeline puts them: the audio holds them at ${misplaced.seconds.toFixed(2)}s, while the record says ${start.toFixed(2)}s. Nothing is wrong with the script or the recording - the start time written for this phrase is wrong, so the record does not describe the file it sits beside`;
  }
  // Every reading table this build has was already tried by `bindTake` before this wording is
  // reached, so the sentence can name that fact instead of implying the script is at fault.
  return `phrase ${index + 1} ("${phrase.text}") is not the sound this voice makes from those words: at ${(start + at).toFixed(2)}s it scores ${score.toFixed(3)}, where the same words re-rendered score 1.000. It does not reproduce under any reading table this build has (${READING_SETS.join(", ")}), so the words written for that moment were not the words spoken there`;
}

// Re-render a timeline's phrases at one set of settings and compare each, frame by frame,
// with the slice of the published WAV that the timeline places it at.
//
// One entry per phrase, so a caller can see which ones agreed, plus the failures themselves.
function compareAt({ samples, rate, phrases, voice }) {
  const report = [];
  const problems = [];
  for (const [i, phrase] of phrases.entries()) {
    let mine;
    try {
      mine = renderParagraph([{ text: phrase.text }], voice);
    } catch (error) {
      problems.push({ kind: "unrenderable", index: i, message: `phrase ${i + 1} ("${phrase.text}") cannot be rendered by this voice (${error.message}), so the audio cannot be shown to match it` });
      report.push({ index: i, text: phrase.text, correlation: 0, matches: false });
      continue;
    }
    // Where the timeline says this phrase is. A phrase with no usable start cannot be
    // located at all; the caller reports that separately, so skip locating it here rather
    // than comparing against offset 0 and blaming the voice for a missing number.
    const start = Number(phrase.start);
    const located = Number.isFinite(start);
    const want = mine.samples.length;
    // The timeline's own claim about how long this phrase is. It is checked as well as the
    // slice, because an interior phrase's slice is always `want` long whenever the file
    // continues past it - only the last phrase can run out of audio.
    const declared = Number(phrase.duration);
    if (Number.isFinite(declared) && Math.abs(declared * rate - want) > Math.max(2, want * 0.02)) {
      problems.push({ kind: "duration", index: i, message: `phrase ${i + 1} ("${phrase.text}") is ${(want / rate).toFixed(2)}s of speech, but the timeline says it takes ${declared.toFixed(2)}s; those words do not fill that stretch of this file` });
      report.push({ index: i, text: phrase.text, correlation: 0, matches: false });
      continue;
    }
    // A phrase that is not the length its own words render to is not those words: there is
    // no overlap to compare, and sliding would only line it up with a neighbour's sound.
    const base = located ? Math.round(start * rate) : null;
    // Where the phrase can actually be, given how the timeline wrote the number down. One
    // sample either side is the floor (a start rounded to the sample), and the record's own
    // written precision widens it: a start of `4.38` permits 4.375-4.385, which is 110 samples
    // at 22.05 kHz. The exact position is always a candidate, so a precise record is searched
    // exactly as it was before and a wide search is never paid for one.
    const slip = located ? Math.max(SLIP, Math.round(writtenSlack(start) * rate)) : 0;
    // Scanning every one of those samples with the frame test is quadratic and was measured to
    // take minutes on a whole-second record. The question is only *where* the phrase is, and a
    // one-number correlation answers that cheaply; the frame test then decides whether the
    // phrase at that place is these words. So: coarse, then fine. A step that divides nothing in
    // particular is fine here because the fine pass re-examines a full step either side.
    const STEP = 8;
    let peak = 0, peakScore = -2;
    for (let d = -slip; d <= slip; d += STEP) {
      const from = Math.max(0, base + d), cand = cut(samples, from, from + want);
      if (Math.abs(cand.length - want) > Math.max(2, want * 0.02)) continue;
      const c = correlation(mine.samples, cand);
      if (c > peakScore) { peakScore = c; peak = d; }
    }
    // The exact position is always examined, so a precise record is treated exactly as it was
    // before this change: no coarse search, no widened window, the same single comparison.
    const centre = slip <= SLIP ? 0 : peak;
    const band = slip <= SLIP ? SLIP : STEP;
    const offsets = located ? [0, ...Array.from({ length: band }, (_, k) => k + 1).flatMap(k => [-k, k]).map(d => d + centre)] : [];
    const unique = [...new Set(offsets.filter(d => Math.abs(d) <= slip))];
    // Each candidate keeps its own offset, so the one that wins can be reported: dropping a
    // window that runs off the end of the file must not shift the others' labels.
    const candidates = unique
      .map(d => ({ d, at: Math.max(0, base + d) }))
      .map(c => ({ ...c, slice: cut(samples, c.at, c.at + want) }))
      .filter(c => Math.abs(c.slice.length - want) <= Math.max(2, want * 0.02));
    const slices = candidates.map(c => c.slice);
    if (!candidates.length) {
      const heard = base == null || base >= samples.length ? "no audio" : `${((samples.length - base) / rate).toFixed(2)}s of audio`;
      problems.push({ kind: "duration", index: i, message: `phrase ${i + 1} ("${phrase.text}") renders to ${(want / rate).toFixed(2)}s of speech, but the timeline places ${heard} at ${located ? `${start}s` : "no usable start"}; this phrase's words are not what is in the file there` });
      report.push({ index: i, text: phrase.text, correlation: 0, matches: false });
      continue;
    }
    // The best alignment within what the record permits, then the worst frame of it: a phrase
    // is its own only if every audible moment of it agrees. Moving the window is not a way to
    // accept a different sentence - a phrase can only slide inside a rounding, and an edited
    // one still disagrees frame for frame wherever it lands - but which offset won is
    // reported, because a nonzero slip is itself the evidence that the record was rounded.
    let best = null, bestAt = null;
    for (const c of candidates) {
      const f = frameAgreement(mine.samples, c.slice, rate);
      if (!best || f.score > best.score) { best = f; bestAt = c.at; }
    }
    const matches = best.score >= SAME_TAKE;
    const slipSamples = base == null || bestAt == null ? 0 : bestAt - base;
    report.push({ index: i, text: phrase.text, correlation: best.score, matches, slices, slip: slipSamples });
    if (!matches) problems.push({ kind: "sound", index: i, phrase, mine: mine.samples, slices, start, score: best.score, at: best.at });
  }
  return { report, problems };
}

// The settings a timeline records are a *hint* for re-rendering, and a lossy one: the CLI used
// to write `--rate 1.23456` down as `1.235`, a record that cannot reproduce its own audio. That
// is a bug in the writer, not a lie about the words, and refusing an honest take for it
// punishes an operator for something they cannot see and did not choose.
//
// The fix is to treat the recorded rate as a value known only to the precision it was written
// at. A rate written to three decimals is within half of that last place of the truth, so a
// search is confined to that interval - and it is a search, not a guess from the phrases'
// durations: this voice quantises every sound to a whole number of samples, so duration is only
// approximately proportional to `rate`, and a rate computed from it lands near but not on the
// truth (measured: 1.234383 for a true 1.23456, which agrees with the audio at 0.76 - the
// difference between "this is the recording" and "this is nearly the recording").
//
// So each failing phrase is re-rendered across the interval its own record permits, and the
// best it can do is the answer. Nothing is accepted on a near miss: `RECOVERED_TAKE` is 0.95,
// and a true rate measures ~0.99 while a neighbouring one measures 0.76-0.88. A different
// sentence cannot be recovered by any rate, so it still fails.
const RECOVERED_TAKE = 0.95;
// How wrong a rate written to 3 decimal places can be, relative to itself: 0.0005 / rate at
// rate 1, which is the largest relative error the rounding can represent at these speeds.
const RATE_PRECISION = 0.0005;

// The best agreement this phrase can reach at a rate near the one recorded, and the rate that
// reaches it. Coarse then fine, so forty renders buy a resolution of a few parts per million.
function recoverRate({ phrase, slices, rate, recorded, recordedPitch, recordedReadings }) {
  const base = Number(recorded) || 1;
  // The pitch is not in question here - only the rate's written-down precision is - so the
  // recorded pitch is used exactly, and a take whose pitch is also wrong is not recovered by
  // this at all. (Hard-coding it is how this first failed: the record said 113.457 and every
  // candidate was rendered at 112.)
  const pitch = Number(recordedPitch) || 112;
  const score = r => {
    let mine;
    try { mine = renderParagraph([{ text: phrase.text }], { rate: r, pitch, readings: recordedReadings }); } catch { return -2; }
    if (Math.abs(mine.samples.length - slices[0].length) > Math.max(2, slices[0].length * 0.02)) return -2;
    return slices.map(slice => frameAgreement(mine.samples, slice, rate)).reduce((w, f) => (f.score > w.score ? f : w)).score;
  };
  const lo = base * (1 - RATE_PRECISION), hi = base * (1 + RATE_PRECISION);
  let best = { rate: base, score: score(base) };
  const sweep = (from, to, steps) => {
    for (let i = 0; i <= steps; i++) {
      const r = from + (to - from) * i / steps;
      const s = score(r);
      if (s > best.score) best = { rate: r, score: s };
    }
  };
  sweep(lo, hi, 16);
  const step = (hi - lo) / 16;
  sweep(Math.max(lo, best.rate - step), Math.min(hi, best.rate + step), 8);
  return best;
}

export function bindTake({ file, timeline }) {
  const phrases = (Array.isArray(timeline?.phrases) ? timeline.phrases : [])
    .map(p => ({ text: String(p?.text ?? "").trim(), start: p?.start, duration: p?.duration })).filter(p => p.text);
  if (!phrases.length) return { ok: false, problems: ["the timeline lists no phrases, so there is no script to compare with the audio"], correlation: 0, phrases: [] };
  const { samples, rate } = wavSamples(readFileSync(file));
  const seconds = Number((samples.length / rate).toFixed(2));
  const worstOf = report => Number((report.reduce((w, p) => (p.correlation < w.correlation ? p : w), report[0])?.correlation ?? 0));
  // A take may be checked by a build that reads words differently from the one that made it.
  // The record says which table made the audio; the sets it names are all tried below, and a
  // take is accepted on an exact reproduction by any of them - never on a near miss.
  const claimed = timeline?.voice?.readings && READING_SETS.includes(timeline.voice.readings)
    ? timeline.voice.readings
    : null;
  // A record with no `readings` field predates the field; this build's own table is the honest
  // first guess for it, and the others are still tried below because it may have been made by
  // any build in this line.
  const tries = claimed
    ? [claimed, ...READING_SETS.filter(s => s !== claimed)]
    : [CURRENT_READINGS, ...READING_SETS.filter(s => s !== CURRENT_READINGS)];
  const voiceWith = readings => ({ ...timeline?.voice, readings });
  const settingsWith = (readings, rate) => ({
    rate: Number(rate ?? timeline?.voice?.rate) || 1,
    pitch: Number(timeline?.voice?.pitch) || 112,
    readings
  });

  // One table at a time, because the two things that can be wrong are independent: *which*
  // table made the audio, and whether the record states that take's rate precisely enough.
  // Doing them in one pass over the same table is what makes a take made by an older table
  // still recoverable when its rate was rounded - trying every table for an exact match first
  // and only then searching rates under the first one would refuse exactly that take.
  const accepted = (report, readings, rate) => ({
    ok: true,
    problems: [],
    correlation: worstOf(report),
    phrases: report,
    seconds,
    // `matched` is reported even when it equals `recorded`, so every accepted take has the
    // same shape of evidence and a caller never has to guess which branch produced it.
    voice: { recorded: settingsWith(tries[0]), matched: settingsWith(readings, rate) }
  });
  // A refusal has to name the right phrases. Whichever table is tried first is the wrong one
  // to explain a refusal with: a record from before `readings` existed is judged first with
  // this build's table, and under that table an honest phrase can look wrong because the
  // *previous* phrase was read differently. Measured on a supervisor's old-rules take with one
  // word changed: judging with this build's table blamed phrases 1 and 3, when only phrase 1
  // was wrong. So every attempt is kept, and the explanation comes from the one that accounts
  // for the most audio - fewest phrases that fail, then the best agreement among them. That
  // only chooses wording: nothing is accepted here, so a wrong script still fails.
  let best = null;
  const better = (a, b) => !b
    || a.problems.length < b.problems.length
    || (a.problems.length === b.problems.length && worstOf(a.report) > worstOf(b.report));
  for (const readings of tries) {
    const at = compareAt({ samples, rate, phrases, voice: voiceWith(readings) });
    if (better(at, best)) best = { ...at, readings };
    // Exact: every phrase reproduces, frame for frame.
    if (!at.problems.length && worstOf(at.report) >= RECOVERED_TAKE) return accepted(at.report, readings);
    // Not exact. If the only complaint is the sound, the same words may still be in the file
    // at a rate the record states imprecisely - so search, and accept nothing on a near miss.
    if (!at.problems.every(p => p.kind === "sound")) continue;
    const targets = at.problems.length
      ? at.problems.map(p => ({ phrase: p.phrase, slices: p.slices }))
      // Nothing failed outright, so the phrases to re-examine are the ones that did not agree
      // exactly - there is no problem object to borrow a slice from.
      : at.report.filter(p => p.correlation < RECOVERED_TAKE).map(p => ({ phrase: phrases[p.index], slices: p.slices }));
    const recovered = [];
    let allFine = targets.length > 0;
    for (const target of targets) {
      const found = recoverRate({ phrase: target.phrase, slices: target.slices, rate, recorded: timeline?.voice?.rate, recordedPitch: timeline?.voice?.pitch, recordedReadings: readings });
      if (found.score < RECOVERED_TAKE) { allFine = false; break; }
      recovered.push(found.rate);
    }
    if (!allFine) continue;
    // The take is the words it claims at a rate the record states imprecisely. Report both, so
    // a card can say what it was told and what the audio actually is.
    recovered.sort((a, b) => a - b);
    const matchedRate = recovered[Math.floor(recovered.length / 2)];
    const verdict = compareAt({ samples, rate, phrases, voice: settingsWith(readings, matchedRate) });
    if (!verdict.problems.length) return accepted(verdict.report, readings, matchedRate);
  }

  // Fourth: it is not the words, at any settings this build can reproduce. Say which phrase,
  // and - when the audio is those words at a nearby rate - say that instead of accusing the
  // script, because the operator's next step is different in the two cases.
  // Explain with the table that fits the audio best, and tell `describeMismatch` which one that
  // was: its "is this the same words at other settings" probe re-renders, and re-rendering with
  // a table other than the one being explained would compare two different recordings.
  const explaining = best?.readings ?? tries[0];
  const problems = best.problems.map(p => p.kind === "sound" ? describeMismatch({ ...p, samples, rate, voice: { ...timeline?.voice, readings: explaining } }) : p.message);
  // A refusal must always say something. It could come back empty in one case: every phrase
  // matched well enough to report no *problem*, yet the take missed `RECOVERED_TAKE` in the loop
  // above - which would leave a card that says it was refused with no reason on it, the exact
  // failure this file exists to prevent. That is a real possibility now that the loop considers
  // several tables rather than one, so it is named instead of left to luck.
  if (!problems.length) {
    return { ok: false, problems: [`this take does not reproduce from its own script at any reading table this build has (${READING_SETS.join(", ")}), and the closest attempt scored ${worstOf(best.report).toFixed(3)} where the same recording scores 1.000; the audio is not the sound these words make`], correlation: worstOf(best.report), phrases: best.report, seconds };
  }
  return { ok: false, problems, correlation: worstOf(best.report), phrases: best.report, seconds };
}
