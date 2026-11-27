#!/usr/bin/env node
// Speak a script to a WAV, and write down what was spoken.
//
//   node voice/render.mjs --text "The sea at night is never still." --out out.wav
//   node voice/render.mjs --file script.txt --out out.wav --timeline out.json
//   node voice/render.mjs --check out.wav --words "The sea at night"
//
// The second form is what the `narration` method asks an agent to run, and the third is the
// honest check: it measures a published file and says whether it contains speech, rather
// than whether a function was called.
//
// Exit codes: 0 ok, 2 the text cannot be pronounced by this voice, 3 the file does not look
// like speech.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { audit } from "./lexicon.mjs";
import { renderParagraph, toWav, RATE } from "./synth.mjs";
import { measure } from "./measure.mjs";
import { bindTake } from "./bind.mjs";

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1] ?? null; };

// The measure `--check` uses, in one place so the CLI, the tests and the server cannot
// drift: a file is speech when it is loud, long enough, mostly periodic, has several
// syllable onsets, and its formants visit more than one vowel region.
export function judge(file, words = "") {
  const stats = measure(file);
  const expected = audit(words);
  const problems = [];
  if (stats.peakSample < 2000) problems.push(`the file peaks at ${stats.peakSample}, which is near silence`);
  if (stats.seconds < 0.3) problems.push(`the file is only ${stats.seconds.toFixed(2)} s long`);
  if (stats.voicedShare < 0.25) problems.push(`only ${(stats.voicedShare * 100).toFixed(0)}% of the loud frames are periodic, so this is noise rather than a voice`);
  // A floor, not an equality, and deliberately a loose one. The detector counts rises in the
  // energy envelope, and this synthesizer puts roughly two per syllable (a consonant release
  // and then the vowel peak) - measured, not assumed. Pinning onsets to the syllable count
  // would therefore have to be tuned until the numbers agreed, which is fitting a threshold
  // to its own answer. What the floor is good for is the gross case: a file of one continuous
  // hum, a sweep, or silence has no rises at all, and half a sentence spoken still has many.
  // The check that actually separates speech from a plausible impostor is the vowel regions
  // below - an amplitude-modulated tone rings up 15 onsets, as many as a sentence, but it
  // never leaves one formant pair.
  const want = expected.syllables;
  if (stats.onsets < Math.max(2, Math.round(want * 0.5))) problems.push(`${stats.onsets} syllable onsets for ${want} syllable(s) - the words are not there, or ran together`);
  if (stats.vowelKinds < Math.min(2, expected.words)) problems.push(`the formants visit ${stats.vowelKinds} vowel region(s); speech uses more than one`);
  return { file, words: expected.words, syllables: expected.syllables, ...stats, verdict: problems.length ? "not speech" : "speech", problems };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("render.mjs")) {
  const check = arg("check");
  if (check) {
    const report = judge(check, arg("words") || "");
    console.log(JSON.stringify(report, null, 2));
    if (report.problems.length) { for (const p of report.problems) console.error(`not speech: ${p}`); process.exit(3); }
    process.exit(0);
  }
  const out = arg("out");
  const text = arg("text") ?? (arg("file") ? readFileSync(arg("file"), "utf8") : null);
  if (!out || text == null) {
    console.error("usage: node voice/render.mjs --text \"...\" --out narration.wav [--timeline out.json] [--rate 1.1] [--pitch 112]\n       node voice/render.mjs --file script.txt --out narration.wav\n       node voice/render.mjs --check narration.wav --words \"...\"");
    process.exit(1);
  }
  // One phrase per line, blank lines skipped: that is the shape an agent writes a script in,
  // and it is what the timeline records.
  const phrases = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => ({ text: line }));
  const unreadable = phrases.flatMap(p => audit(p.text).unreadable);
  if (unreadable.length) {
    console.error(`this voice has no way to say: ${[...new Set(unreadable)].join(", ")}. It reads English letters and digits only; rewrite the line in English words.`);
    process.exit(2);
  }
  let rendered;
  try { rendered = renderParagraph(phrases, { rate: Number(arg("rate")) || 1, pitch: Number(arg("pitch")) || 112 }); }
  catch (error) { console.error(error.message); process.exit(2); }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, toWav(rendered.samples, rendered.rate));
  // `voice` records the settings the bytes were made with, because the server rebinds a
  // published WAV to its script by re-rendering it: the same words at a different speed or
  // pitch are a different signal, and a timeline that did not say how it was rendered could
  // only be checked by a tolerance loose enough to accept a different sentence.
  //
  // The values recorded are the ones the samples were actually made with, at full precision
  // and after clamping - not the strings typed on the command line and not a rounded version
  // of them. Rounding here was a real bug: `--rate 1.23456` was written down as `1.235`, the
  // server re-rendered at the rounded speed, and the take's own third phrase failed the check
  // at 0.300. A record that cannot reproduce its own recording is the one thing this file
  // exists to prevent.
  const timeline = { audio: out, rate: rendered.rate, seconds: rendered.samples.length / rendered.rate, voice: rendered.voice, phrases: rendered.segments };
  const timelinePath = arg("timeline");
  if (timelinePath) { mkdirSync(dirname(timelinePath), { recursive: true }); writeFileSync(timelinePath, JSON.stringify(timeline, null, 2)); }
  console.log(JSON.stringify({ out, seconds: Number(timeline.seconds.toFixed(2)), voice: timeline.voice, phrases: timeline.phrases.map(p => ({ text: p.text, start: Number(p.start.toFixed(2)), duration: Number(p.duration.toFixed(2)) })) }, null, 2));
  // The one thing this tool must never do is hand back a take its own server would refuse.
  // `--check` measures the acoustics; this checks the record against the bytes, through the
  // same code the server uses, at the moment they are written. It costs one re-render of a
  // file that was just rendered, and it turns a class of drift into a local failure instead
  // of a rejected take on someone else's canvas.
  const selfCheck = bindTake({ file: out, timeline });
  if (!selfCheck.ok) {
    console.error(`the take this tool just wrote does not verify against its own timeline, which is a bug in the tool rather than in the script:\n  ${selfCheck.problems.join("\n  ")}`);
    process.exit(4);
  }
}
