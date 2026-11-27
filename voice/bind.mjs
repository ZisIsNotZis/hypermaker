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

// A phrase can fail in two very different ways, and an operator who is told the wrong one
// cannot act on it. The words may really be different from the sound (the defect this check
// exists for), or the take may be perfectly honest and the *record* may misstate the rate or
// pitch it was rendered at - which is a bug in whatever wrote the timeline, not a lie about
// the words. Those need different fixes, so a refusal works out which it is: it re-renders
// the same words across a narrow band of speed and pitch, and if one of those reproduces the
// audio it says so instead of accusing the script. This only chooses the wording; `ok` was
// already false, so a near-miss in the band never accepts anything.
function describeMismatch({ index, phrase, mine, slices, rate, start, score, at, voice }) {
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
    const slices = base == null ? [] : [0, -SLIP, SLIP]
      .map(d => Math.max(0, base + d))
      .map(at => cut(samples, at, at + want))
      .filter(slice => Math.abs(slice.length - want) <= Math.max(2, want * 0.02));
    if (!slices.length) {
      const heard = base == null || base >= samples.length ? "no audio" : `${((samples.length - base) / rate).toFixed(2)}s of audio`;
      problems.push({ kind: "duration", index: i, message: `phrase ${i + 1} ("${phrase.text}") renders to ${(want / rate).toFixed(2)}s of speech, but the timeline places ${heard} at ${located ? `${start.toFixed(2)}s` : "no usable start"}; this phrase's words are not what is in the file there` });
      report.push({ index: i, text: phrase.text, correlation: 0, matches: false });
      continue;
    }
    // Best of the exact position and its two one-sample neighbours, then the worst frame of
    // that alignment: a phrase is its own only if every audible moment of it agrees.
    const best = slices.map(slice => frameAgreement(mine.samples, slice, rate)).reduce((w, f) => (f.score > w.score ? f : w));
    const matches = best.score >= SAME_TAKE;
    report.push({ index: i, text: phrase.text, correlation: best.score, matches, slices });
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

  // First: the take as its record describes it.
  const recorded = compareAt({ samples, rate, phrases, voice: voiceWith(tries[0]) });

  // Second: are these words, at a rate the record states imprecisely? This is asked whenever
  // the recorded settings did not reproduce the audio *exactly* - including when they scraped
  // past the bar at 0.89 while the same take at its real rate measures 1.000. Settling for the
  // weaker explanation is how a rounding turns into a card that says "nearly these words".
  const exact = recorded.problems.length === 0 && worstOf(recorded.report) >= RECOVERED_TAKE;
  if (!exact && recorded.problems.every(p => p.kind === "sound")) {
    const targets = recorded.problems.length
      ? recorded.problems.map(p => ({ phrase: p.phrase, slices: p.slices }))
      // Nothing failed outright, so the phrases to re-examine are the ones that did not agree
      // exactly - there is no problem object to borrow a slice from.
      : recorded.report.filter(p => p.correlation < RECOVERED_TAKE).map(p => ({ phrase: phrases[p.index], slices: p.slices }));
    const recovered = [];
    let allFine = targets.length > 0;
    for (const target of targets) {
      const best = recoverRate({ phrase: target.phrase, slices: target.slices, rate, recorded: timeline?.voice?.rate, recordedPitch: timeline?.voice?.pitch, recordedReadings: tries[0] });
      if (best.score < RECOVERED_TAKE) { allFine = false; break; }
      recovered.push(best.rate);
    }
    if (allFine) {
      // The take is the words it claims at a rate the record states imprecisely. Report both,
      // so a card can say what it was told and what the audio actually is.
      recovered.sort((a, b) => a - b);
      const matched = recovered[Math.floor(recovered.length / 2)];
      const pitch = Number(timeline?.voice?.pitch) || 112;
      const verdict = compareAt({ samples, rate, phrases, voice: { rate: matched, pitch, readings: tries[0] } });
      if (!verdict.problems.length) {
        return {
          ok: true,
          problems: [],
          correlation: worstOf(verdict.report),
          phrases: verdict.report,
          seconds,
          voice: { recorded: { rate: Number(timeline?.voice?.rate) || 1, pitch, readings: tries[0] }, matched: { rate: Number(matched.toFixed(6)), pitch, readings: tries[0] } }
        };
      }
    }
  }
  if (exact) {
    // `matched` is reported even when it equals `recorded`, so every accepted take has the
    // same shape of evidence and a caller never has to guess which branch produced it.
    const settings = { rate: Number(timeline?.voice?.rate) || 1, pitch: Number(timeline?.voice?.pitch) || 112, readings: tries[0] };
    return { ok: true, problems: [], correlation: worstOf(recorded.report), phrases: recorded.report, seconds, voice: { recorded: settings, matched: { ...settings } } };
  }

  // Third, and only when the record's own table did not reproduce the audio: a different
  // reading table that does. This is the case a reviewer hit and I reproduced - a take
  // published before the dictionary existed was refused by the build that added it, and told
  // its own honest audio was not the words it had written down.
  //
  // It is narrow on purpose. The table only changes how words are *pronounced*: the phrase
  // texts, their starts, their durations and the file are all still required to be the same
  // arrangement, so a recording of a different sentence cannot be admitted by any table. The
  // test suite pins exactly that: take A's audio against take B's timeline is still refused.
  for (const readings of tries.slice(1)) {
    const alt = compareAt({ samples, rate, phrases, voice: voiceWith(readings) });
    if (!alt.problems.length && worstOf(alt.report) >= RECOVERED_TAKE) {
      return {
        ok: true,
        problems: [],
        correlation: worstOf(alt.report),
        phrases: alt.report,
        seconds,
        voice: { recorded: { rate: Number(timeline?.voice?.rate) || 1, pitch: Number(timeline?.voice?.pitch) || 112, readings: tries[0] }, matched: { rate: Number(timeline?.voice?.rate) || 1, pitch: Number(timeline?.voice?.pitch) || 112, readings } }
      };
    }
  }

  // Fourth: it is not the words, at any settings this build can reproduce. Say which phrase,
  // and - when the audio is those words at a nearby rate - say that instead of accusing the
  // script, because the operator's next step is different in the two cases.
  const problems = recorded.problems.map(p => p.kind === "sound" ? describeMismatch({ ...p, rate, voice: timeline?.voice }) : p.message);
  return { ok: false, problems, correlation: worstOf(recorded.report), phrases: recorded.report, seconds };
}
