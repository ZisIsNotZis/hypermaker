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
import { renderParagraph, toWav, RATE, paceOf, rateForWpm } from "./synth.mjs";
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
    console.error("usage: node voice/render.mjs --text \"...\" --out narration.wav [--timeline out.json] [--wpm 150] [--pitch 112] [--readings rules-1|cmudict-1|cmudict-2|cmudict-3|cmudict-4]\n       node voice/render.mjs --file script.txt --out narration.wav\n       node voice/render.mjs --check narration.wav --words \"...\"\n\n--readings picks the table that decides how each word is read; the take records it, because\nthe same words read by a different table are a different recording. It defaults to this\nbuild's table, and naming one it does not have is an error rather than a fallback.\n\ncmudict-2 is cmudict-1 plus the stress of each word, so the emphasis lands on the syllable the\ndictionary marks instead of always on the first: 'machine' is ma-CHINE, not MA-chine.\ncmudict-3 is cmudict-2 plus numerals read as words: '8:30' is eight thirty, '1990' is nineteen\nninety, '1,200' is one thousand two hundred, '$5' is five dollars, '40%' is forty percent.\ncmudict-4 is cmudict-3 with money, magnitude and signs read faithfully: '$1250' is one\nthousand two hundred fifty dollars (not a year), '£0.50' is fifty pence, '1,000,000,000,000'\nis one trillion, '-3.5' is minus three point five. A shape past a trillion, or a symbol it\ncannot name ('¥', a fraction, a degree sign), is refused by name instead of being dropped.\nrules-1, cmudict-1, cmudict-2 and cmudict-3 are frozen - audio made by them still verifies\nexactly as it did, including their readings that cmudict-4 corrected.\n--wpm is the pace to speak at, in words per minute: 150 is ordinary speech, 200 is brisk, 110 is deliberate. It is measured from the rendered bytes and recorded in the timeline beside the multiplier the samples were made with, so the take can show both what was asked for and what it reads at.\n\n--rate is a duration multiplier, not a speed: 0.8 makes a take 20% shorter in time (25% more words per minute), 1.3 makes it 30% longer (23% fewer). It is stated in duration on purpose - speed percentages are the reciprocals of these and quoting one as the other is exactly how this setting came to be documented backwards. It exists because a published take records the exact multiplier that made its bytes and has to keep reproducing from it. --wpm is the one to reach for when writing a script or a guide.\n\nTo hear which syllable a file actually stresses: node voice/check-stress.mjs --wav file.wav\n--timeline file.json (exit 0 = every word where the dictionary puts it, 4 = read but stressed\nelsewhere, 2 = could not be read).");
    process.exit(1);
  }
  // One phrase per line, blank lines skipped: that is the shape an agent writes a script in,
  // and it is what the timeline records.
  const phrases = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => ({ text: line }));
  const audits = phrases.map(p => audit(p.text));
  const unreadable = audits.flatMap(a => a.unreadable);
  if (unreadable.length) {
    // Two kinds of refusal, and they need different words: a token the reader does not know
    // (a unit, a date) is fixed by writing it out, and a *symbol* it cannot say (`¥`, `½`, `°`)
    // is fixed by replacing that one character. Naming the symbol is what makes the second kind
    // actionable - "¥ is not a word I can say" is a sentence a writer can fix with one keystroke.
    const reasons = [...new Set(audits.flatMap(a => a.reasons || []))];
    const tokens = [...new Set(unreadable)].join(", ");
    // A token usually carries the sentence's own punctuation (`¥500.`), so a full stop is only
    // added when there is not one already - otherwise the message ends `¥500..`.
    console.error(`this voice has no way to say: ${tokens}${/[.!?]$/.test(tokens) ? "" : "."}`);
    // No `The symbols:` label: a writer reading one line wants the fact, and the fact is already
    // a sentence that names the character. The label read `The symbols: ¥ is a currency...`.
    for (const reason of reasons) console.error(reason);
    console.error("It reads English words and the numeral shapes listed above; write the rest in words.");
    process.exit(2);
  }
  // Pace, stated the way a person asks for it. `--rate` is a duration multiplier - higher is
  // slower, which is the opposite of what its name reads as - so it stays as the exact
  // setting a take records, and `--wpm` is what a writer or an agent should reach for.
  //
  // It is met by measuring rather than by a formula: the render is made at 1.0, the words per
  // minute of *that* render are counted from its own segment records, and the duration
  // multiplier is corrected by the ratio. Phrase count and punctuation change how much of a
  // take is speech versus gap, so a fixed constant would land near the target for one script
  // and miss for another; one correction pass lands within a couple of per cent because the
  // renderer scales every duration linearly. The recorded `rate` is still the multiplier the
  // bytes were made with, so every existing check and every past take is unaffected.
  const pitch = Number(arg("pitch")) || 112, readings = arg("readings") || undefined;
  const askedWpm = arg("wpm") == null ? null : Number(arg("wpm"));
  if (askedWpm != null && (!(askedWpm > 0) || !Number.isFinite(askedWpm))) {
    console.error(`--wpm must be a positive number of words per minute, got ${JSON.stringify(arg("wpm"))}`);
    process.exit(1);
  }
  let rendered;
  try {
    if (askedWpm == null) {
      rendered = renderParagraph(phrases, { rate: Number(arg("rate")) || 1, pitch, readings });
    } else {
      const probe = renderParagraph(phrases, { rate: 1, pitch, readings });
      const rate = rateForWpm(probe.segments, askedWpm);
      // Below the multiplier floor the voice stops being the same voice, and saying so is
      // better than silently clamping to a pace nobody asked for.
      if (rate < 0.5 || rate > 2.5) {
        console.error(`${askedWpm} words per minute is outside what this voice can do for this script: it would need a duration multiplier of ${rate.toFixed(2)}, and the voice is limited to 0.5-2.5. It reads this script at ${Math.round(paceOf(probe.segments).wpm)} words per minute as written.`);
        process.exit(2);
      }
      rendered = renderParagraph(phrases, { rate, pitch, readings });
    }
  }
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
  // The pace is part of the record for the same reason the multiplier is: it is what a person
  // asked for and what they will judge, and it is measurable from the bytes. `askedWpm` is
  // kept beside the measured value so a card can say "you asked for 150 and this speaks at
  // 148" rather than silently rounding the request away.
  const pace = paceOf(rendered.segments);
  const timeline = { audio: out, rate: rendered.rate, seconds: rendered.samples.length / rendered.rate, voice: rendered.voice, phrases: rendered.segments, pace: { wpm: Number(pace.wpm.toFixed(1)), words: pace.words, seconds: Number(pace.seconds.toFixed(3)), ...(askedWpm == null ? {} : { askedWpm }) } };
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
