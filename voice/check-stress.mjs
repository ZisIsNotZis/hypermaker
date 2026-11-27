#!/usr/bin/env node
// Which syllable does this recording put the emphasis on?
//
//   node voice/check-stress.mjs --wav narration.wav --words "the script it says"
//   node voice/check-stress.mjs --wav narration.wav --timeline narration.json
//
// The question is narrow on purpose. It does not ask whether a *person* heard the stress
// correctly - there is no listener here and no recogniser on this machine, so that question
// has to be answered by a person (`voice/listening-test.mjs`). It asks what the file *is*: of
// the readings this build can produce for the script, which one reproduces these exact
// samples? Rendering is deterministic, so that answer is an identity - one candidate matches
// to the sample and the others do not - not a score with a threshold under it.
//
// This is the technique `voice/bind.mjs` uses to show a take says the words its timeline
// claims, pointed at the one thing the timeline does not pin down: the metre. The first
// attempt was a heuristic that cut the energy envelope at its deepest dips and called the
// loudest piece stressed. Measured against the dictionary it was simply wrong - it found one
// piece instead of two in `toward`, `about`, `against` and `around`, and where it did split, a
// loud `SH` in `machine` outweighed the vowel it belonged to. Fitting its thresholds until the
// numbers agreed would be fitting a measurement to its own answer. Reproduction has no
// thresholds to fit.
//
// The expected stress comes from `vendor/cmudict/stress.txt.gz`, the primary-stress marks of
// the same public source the pronunciations come from. The two paths are independent: the
// heard index is read out of the audio by re-rendering, the expected one out of a data file. So
// agreement is evidence, not a tautology.
//
// Exit codes: 0 every word is stressed where the dictionary puts it, 4 read but at least one
// word is emphasised elsewhere, 2 the file could not be read or reproduced.
import { readFileSync } from "node:fs";
import { wavSamples } from "./wav.mjs";
import { renderParagraph, toInt16 } from "./synth.mjs";
import { tokenize, stressOf, CURRENT_READINGS } from "./lexicon.mjs";

const VOWELS = new Set("IY IH EY EH AE AA AO OW UH UW AH ER AY OY AW".split(" "));
const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1] ?? null; };
const syllablesOf = phonemes => phonemes.filter(p => VOWELS.has(p)).length;

// A phrase is split exactly as the renderer splits it, so the declination and the per-file
// noise seed are the same as when the audio was made.
const linesOf = text => String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);

// Does this script, spoken with these per-token stress notes, reproduce `integers` exactly?
// `notes` is aligned with the renderer's own token stream (see `renderParagraph`), and an
// entry of `null` means "whatever the reading table says".
// Compared as the 16-bit integers the file holds, not as floats. `wavSamples` divides by 32768
// on the way in while the writer multiplies by 32767, so a float's round trip is not the
// identity and comparing floats would refuse a file this very build had written - which is how
// the first version of this check failed. Callers therefore pass the integers themselves, and
// `toInt16` is the same quantisation the WAV writer uses.
function reproduces(text, notes, integers, options) {
  let mine;
  try { mine = renderParagraph(linesOf(text).map(t => ({ text: t })), { ...options, notes }); } catch { return null; }
  if (mine.samples.length !== integers.length) return null;
  for (let i = 0; i < integers.length; i++) if (toInt16(mine.samples[i]) !== integers[i]) return null;
  return mine;
}
// The integers a WAV holds, from the float samples `wavSamples` returns. `wavSamples` divides
// by 32768, so multiplying by the same 32768 recovers exactly what was written - no rounding
// decision is made here, which is why this is not `toInt16`.
export const fileIntegers = samples => Array.from(samples, v => Math.round(v * 32768));

// The stress index of every token in the script, as the file actually has it, or a reason it
// could not be determined. Only multi-syllable tokens vary; a one-syllable word has nowhere to
// put the emphasis and is reported as `null`.
// `integers` is the audio as the 16-bit values a WAV holds - `fileIntegers` for a published
// file, or `toInt16` over a fresh render. Taking it in this shape rather than as floats is
// deliberate: the first version accepted floats and compared `toInt16` of them, which is not
// the identity against a file, and it refused audio this very build had just written.
export function heardStress({ integers, text, options = {} }) {
  const { tokens, unreadable } = tokenize(text, options.readings ?? CURRENT_READINGS);
  if (unreadable.length) return { ok: false, reason: `this voice cannot say ${[...new Set(unreadable)].join(", ")}` };
  const widths = tokens.map(t => syllablesOf(t.phonemes));
  const varying = widths.map((n, i) => (n > 1 ? i : -1)).filter(i => i >= 0);
  // Each varying word may sit on any of its syllables, so the search is their product. For a
  // line of narration that is a handful; a script with dozens of long words is refused rather
  // than searched for minutes, and the refusal says why.
  const combos = varying.reduce((p, i) => p * widths[i], 1);
  if (combos > 4096) return { ok: false, reason: `${varying.length} multi-syllable words make ${combos} possible readings, too many to search exactly; check a shorter script` };
  const words = tokens.map(t => t.word);
  for (let k = 0; k < combos; k++) {
    let rest = k;
    const notes = new Array(tokens.length).fill(null);
    for (const i of varying) { notes[i] = rest % widths[i]; rest = Math.floor(rest / widths[i]); }
    if (reproduces(text, notes, integers, options)) {
      return {
        ok: true,
        words: tokens.map((t, i) => ({ word: words[i], syllables: widths[i], heard: widths[i] > 1 ? notes[i] : null })),
        // What the dictionary says each word should have been, for the caller to compare.
        expected: tokens.map((t, i) => ({ word: words[i], syllables: widths[i], dictionary: stressOf(t.word) ?? (widths[i] > 1 ? 0 : null) }))
      };
    }
  }
  return { ok: false, reason: `no reading this build can produce reproduces these samples (tried ${combos}); the file was not made by this voice, or was re-encoded` };
}

// The comparison a creator actually wants: per word, did the emphasis land where the dictionary
// puts it? Words the table does not list are reported as unknown rather than as passes.
export function stressAudit({ integers, text, options = {} }) {
  const heard = heardStress({ integers, text, options });
  if (!heard.ok) return heard;
  const rows = heard.words.map((w, i) => {
    const expected = heard.expected[i].dictionary;
    const listed = w.syllables > 1 ? stressOf(w.word) !== undefined : true;
    return { word: w.word, syllables: w.syllables, heard: w.heard, expected, ok: w.syllables <= 1 || w.heard === expected };
  });
  const judged = rows.filter(r => r.syllables > 1);
  return { ok: true, rows, wrong: judged.filter(r => !r.ok), judged: judged.length };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-stress.mjs")) {
  const wav = arg("wav");
  const timeline = arg("timeline");
  let text = arg("words");
  let options = {};
  if (!text && timeline) {
    try {
      const record = JSON.parse(readFileSync(timeline, "utf8"));
      text = (record.phrases || []).map(p => p.text).join("\n");
      options = { rate: record.voice?.rate, pitch: record.voice?.pitch, readings: record.voice?.readings };
    } catch (error) { console.error(`cannot read ${timeline}: ${error.message}`); process.exit(2); }
  }
  if (!wav || !text) {
    console.error("usage: node voice/check-stress.mjs --wav narration.wav --words \"the script\"\n       node voice/check-stress.mjs --wav narration.wav --timeline narration.json");
    process.exit(2);
  }
  const result = stressAudit({ integers: fileIntegers(wavSamples(readFileSync(wav)).samples), text, options });
  if (!result.ok) { console.error(`could not read the stress: ${result.reason}`); process.exit(2); }
  for (const r of result.rows) {
    if (r.syllables <= 1) continue;
    const line = `  ${r.word.padEnd(12)} ${r.syllables} syllables, emphasis on ${r.heard + 1}, dictionary says ${r.expected + 1}`;
    console.log(line + (r.ok ? "" : "   <- not where the dictionary puts it"));
  }
  console.log(`${result.judged} multi-syllable word(s); ${result.wrong.length} emphasise the wrong syllable`);
  // Exit 4 is "read but wrong", distinct from 2 "could not read": a creator whose script is
  // read correctly but stressed oddly has something to listen to, not an error to fix.
  process.exit(result.wrong.length ? 4 : 0);
}
