// Does this WAV say the words its timeline claims?
//
// A reviewer found the hole this closes, on the shipped build: take A's audio and take B's
// `timeline.json` were accepted together, and the card reported B's sentence over A's sound.
// Nothing in the old check was wrong, it was merely insufficient - it compared the timeline
// with the *duration* of the file, so any two takes with the same number of syllables
// matched. A person reopening the card then saw one sentence written down and heard another,
// which is worse than no record at all.
//
// The fix uses the property that makes this voice checkable at all: rendering is
// deterministic. The same words, at the same rate and pitch, produce byte-identical samples,
// because the noise source is seeded from the words themselves. So the server can re-render
// the timeline's own phrases and ask whether the published samples are the sound that script
// makes. If they are, the timeline describes this audio and nothing else; if two sentences
// merely happen to be the same length, they do not correlate.
//
// Measured on this voice (`.tmp/probe-bind.mjs`), which is why the threshold sits where it
// does - the gap between "the script" and "a different script of the same length" is wide,
// and it is a measurement rather than a coefficient chosen to make the test pass:
//
//   same words re-rendered ............ correlation 1.000
//   one word changed, same syllables ... correlation 0.515
//   two clauses swapped (the report) ... correlation 0.166
//   the same words, reordered .......... correlation 0.026
//
// 0.85 is inside that gap on both sides. It is not a similarity score for judging quality:
// it answers one yes/no question - "are these the bytes this script renders to" - and a take
// that fails it is refused rather than described as slightly wrong.
import { readFileSync } from "node:fs";
import { renderParagraph } from "./synth.mjs";
import { wavSamples } from "./wav.mjs";
import { tokenize } from "./lexicon.mjs";

export const SAME_TAKE = 0.85;

// Normalised correlation of two sample arrays: 1 is the same signal, 0 is unrelated.
// Compared over the shorter array, after the lengths have already been required to match.
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

// Re-render the timeline's phrases and compare with the published bytes.
// The timeline records the rate and pitch it was rendered at (`voice`), because the same
// words at a different speed are a different signal; older timelines have no such field and
// were rendered at the defaults, which is what `renderParagraph` falls back to.
export function bindTake({ file, timeline }) {
  const phrases = (Array.isArray(timeline?.phrases) ? timeline.phrases : [])
    .map(p => ({ text: String(p?.text ?? "").trim() })).filter(p => p.text);
  if (!phrases.length) return { ok: false, problems: ["the timeline lists no phrases, so there is no script to compare with the audio"], correlation: 0 };
  let mine;
  try {
    mine = renderParagraph(phrases, { rate: timeline?.voice?.rate, pitch: timeline?.voice?.pitch });
  } catch (error) {
    return { ok: false, problems: [`the recorded script cannot be rendered by this voice (${error.message}), so the audio cannot be shown to match it`], correlation: 0 };
  }
  const { samples, rate } = wavSamples(readFileSync(file));
  const problems = [];
  const mineLength = mine.samples.length;
  // Length first: a file that is nowhere near the length of its own script is not that
  // script, and correlating over a truncated overlap would only blur the answer.
  if (Math.abs(samples.length - mineLength) > Math.max(2, mineLength * 0.02)) {
    problems.push(`the WAV is ${(samples.length / rate).toFixed(2)}s but its own script renders to ${(mineLength / mine.rate).toFixed(2)}s, so it is not that recording`);
  }
  const score = correlation(samples, mine.samples);
  if (!problems.length && score < SAME_TAKE) {
    problems.push(`the audio does not match the script recorded next to it (${score.toFixed(3)} correlation, this voice's own render of those words is 1.000); the words on the card were not the ones spoken in this file`);
  }
  return { ok: problems.length === 0, problems, correlation: Number(score.toFixed(3)), seconds: Number((samples.length / rate).toFixed(2)) };
}
