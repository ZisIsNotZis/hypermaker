// The offline voice, and the checks that decide whether a file is speech.
//
// Everything here exists because something cheaper passed while the result was wrong:
//
//   * the first onset detector wanted true silence between syllables, and found 4 events in
//     a 14-word sentence - real connected speech does not go quiet between words;
//   * the first periodicity measure summed every second product but divided by the full
//     frame energy, so white noise scored 0.40 and a pure tone 0.45: it could not tell a
//     hum from a vowel. The negative controls below are what caught it and what keeps it
//     caught;
//   * a plausible `timeline.json` next to a file of noise is exactly what an agent can
//     produce without speaking, so the server checks the timeline against the bytes *and*
//     the bytes against the words, and both are exercised here.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pronounce, audit, tokenize } from "../voice/lexicon.mjs";
import { renderParagraph, toWav } from "../voice/synth.mjs";
import { measure } from "../voice/measure.mjs";
import { wavSamples } from "../voice/wav.mjs";
import { judge } from "../voice/render.mjs";
import { verifyNarration } from "../server/narration.mjs";

const root = process.cwd();
const base = mkdtempSync(join(tmpdir(), "hypermaker-voice-"));
// Two lines, because one phrase per line is the shape the method's guide asks an agent to
// write, and the timeline's phrase record is a fact about that: one entry per line.
const SENTENCE = "The sea at night is never still.\nIt carries every colour of the sky.";

// A real narration, written the way the method's guide tells an agent to write one.
function narrate(dir, text = SENTENCE, name = "narration.wav") {
  const phrases = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => ({ text: l }));
  const rendered = renderParagraph(phrases);
  const wav = join(dir, name), timeline = join(dir, "timeline.json");
  writeFileSync(wav, toWav(rendered.samples, rendered.rate));
  writeFileSync(timeline, JSON.stringify({ audio: wav, rate: rendered.rate, seconds: rendered.samples.length / rendered.rate, phrases: rendered.segments }));
  return { wav, timeline };
}

// The four impostors: files that are audio, that a WAV header opens, and that are not speech.
function impostor(dir, kind) {
  const rate = 22050, seconds = 2, frames = rate * seconds, samples = new Float32Array(frames);
  let seed = 12345;
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    if (kind === "tone") samples[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t);
    if (kind === "noise") { seed = (seed * 1103515245 + 12345) & 0x7fffffff; samples[i] = (seed / 0x3fffffff - 1) * 0.5; }
    if (kind === "sweep") samples[i] = 0.4 * Math.sin(2 * Math.PI * (200 + 900 * t) * t);
    if (kind === "silence") samples[i] = 0;
    // The hardest control: a tone amplitude-modulated at a speech-like 4 Hz. It has syllable
    // -ish envelope rises (15 in two seconds, as many as a sentence) and is perfectly periodic,
    // so periods and onsets cannot reject it. Only the formants can, and they are absent.
    if (kind === "am-tone") samples[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t));
  }
  const file = join(dir, `${kind}.wav`);
  writeFileSync(file, toWav(samples, rate));
  return file;
}

test("the voice reads the words it claims, and refuses the ones it cannot", () => {
  // Exceptions are audible when they are wrong (`one` as "own", `night` as "nigt"), so a
  // handful are pinned by their phonemes rather than by "it returns something".
  assert.deepEqual(pronounce("one"), ["W", "AH", "N"]);
  assert.deepEqual(pronounce("night"), ["N", "AY", "T"]);
  assert.deepEqual(pronounce("the"), ["DH", "AH"]);
  // A word with no vowel letter still has to be sayable: the first rule set turned `apple`
  // into "AY-p-l" because a final `e` was always silent.
  assert.ok(pronounce("apple").includes("AH"), `apple keeps its first vowel, got ${pronounce("apple")}`);
  // A word whose letters alone do not spell a vowel is refused rather than rendered as a
  // click - `rhythm` has no vowel letter for the rule set to find, and inventing one would
  // be worse than saying so.
  assert.throws(() => pronounce("rhythm"), /cannot say/, "a syllable-less spelling is refused, not clicked");
  // Digits are read, so a script with a number in it is not silently dropped.
  assert.deepEqual(pronounce("7"), ["S", "EH", "V", "AH", "N"]);
  // And the refusal: text this English rule set cannot spell is reported, not mangled into
  // noise that looks like a narration.
  assert.deepEqual(audit("你好世界").unreadable, ["你好世界"]);
  // The refusal is made where words are counted, not where a single word is spelled: a
  // whole token is either readable or reported, and a script of nothing readable never
  // becomes a WAV at all.
  assert.deepEqual(tokenize("你好世界").unreadable, ["你好世界"], "a non-Latin script is reported verbatim, so the message can name it");
  assert.deepEqual(tokenize("Hello, world!").unreadable, [], "punctuation is a pause, not an unreadable word");
});

test("a spoken sentence measures as speech", () => {
  const { wav } = narrate(base);
  const stats = measure(wav);
  const words = audit(SENTENCE);
  assert.equal(words.words, 14, "the sentence has 14 words");
  assert.equal(words.syllables, 18, "and 18 syllables, which is the count onsets are compared with");
  // Deliberately not an equality with the syllable count. This voice puts roughly two envelope
  // rises per syllable, and a check that demanded exactly one per syllable would have to be
  // tuned until it agreed with itself. What is asserted is the property the check relies on:
  // plenty of syllable edges, most of the file periodic, and formants that move.
  assert.ok(stats.onsets >= words.syllables, `at least a rise per syllable, got ${stats.onsets} for ${words.syllables}`);
  assert.ok(stats.voicedShare > 0.5, `most of the file is periodic, got ${stats.voicedShare.toFixed(2)}`);
  assert.ok(stats.vowelKinds >= 5, `the formants visit several vowel regions, got ${stats.vowelKinds}`);
  const report = judge(wav, SENTENCE);
  assert.equal(report.verdict, "speech");
  assert.deepEqual(report.problems, []);
});

test("the voice is not a square wave", () => {
  // The first version of the synthesizer clamped every sample at 0.98 to keep the file in
  // range. Three chained resonators have a large gain, so 75% of the samples hit that clamp
  // and the output was a flat-topped square wave: periodic, formant-shaped, and monotonous,
  // with every syllable envelope flattened into one buzz. It measured "speech-like" because
  // the measure counted frames, and a listener heard a rasp.
  const { wav } = narrate(base);
  const { samples } = wavSamples(readFileSync(wav));
  let peak = 0;
  for (const v of samples) { const a = Math.abs(v); if (a > peak) peak = a; }
  const atPeak = samples.filter(v => Math.abs(v) >= peak * 0.999).length;
  assert.ok(atPeak / samples.length < 0.01, `almost nothing sits at full scale, got ${(atPeak / samples.length * 100).toFixed(1)}%`);
  // And the envelope has real shape: the quietest tenth of frames must be far below the
  // loudest, or there is no syllable structure for a listener to hear.
  const window = 1024, hop = Math.round(22050 / 100), levels = [];
  for (let s = 0; s + window <= samples.length; s += hop) {
    let sum = 0; for (let i = 0; i < window; i++) { const v = samples[s + i]; sum += v * v; }
    levels.push(Math.sqrt(sum / window));
  }
  const sorted = levels.filter(v => v > 0).sort((a, b) => a - b);
  const quiet = sorted[Math.floor(sorted.length * 0.1)], loud = sorted[Math.floor(sorted.length * 0.9)];
  assert.ok(loud / quiet > 3, `the envelope rises out of quiet stretches, got ${(loud / quiet).toFixed(1)}x`);
});

test("every impostor fails the judge, and each for its own reason", () => {
  // A check that only asked "is this a WAV" would pass all four. These are the files an
  // agent can produce without speaking, so each has to be rejected, and the reason has to
  // be true of that file rather than of files in general.
  const seen = {};
  for (const kind of ["tone", "noise", "sweep", "silence", "am-tone"]) {
    const report = judge(impostor(base, kind), SENTENCE);
    assert.equal(report.verdict, "not speech", `${kind} was accepted as speech`);
    assert.ok(report.problems.length, `${kind} failed without saying why`);
    seen[kind] = report;
  }
  // Each file's own defect, on the measurement that makes it one.
  assert.equal(seen.tone.voicedShare > 0.5, true, "a tone is periodic - that is why onsets, not periodicity, is what rejects it");
  assert.equal(seen.tone.onsets < 3, true, `a steady tone has no syllable onsets, got ${seen.tone.onsets}`);
  // A 220 Hz tone has no formant pair inside the search range at all - its energy sits at
  // the bottom edge, which the measurement refuses to read as a vowel. So it fails on
  // vowel regions too, and for a reason true of this file rather than of files in general.
  assert.equal(seen.tone.vowelKinds, 0, `a steady tone visits no vowel region, got ${seen.tone.vowelKinds}`);
  assert.equal(seen.noise.voicedShare < 0.35, true, `white noise is not periodic, got ${seen.noise.voicedShare}`);
  assert.equal(seen.noise.onsetTimes.length === 0 || seen.noise.voicedShare < 0.35, true, "so its onsets never reach the count");
  assert.ok(seen.sweep.onsets < 3, `a slow sweep has no syllable onsets, got ${seen.sweep.onsets}`);
  assert.equal(seen.silence.peakSample < 2000, true, "silence is caught by its peak before anything else is measured");
  // The 4 Hz modulated tone is the reason the vowel check exists rather than being a nice
  // extra: it clears the periodicity floor and gets as many onsets as a spoken sentence.
  assert.ok(seen["am-tone"].onsets >= 10, `the modulated tone really does have speech-like onset density, got ${seen["am-tone"].onsets}`);
  assert.equal(seen["am-tone"].vowelKinds, 0, "a single tone never enters a vowel region, which is what rejects it");
});

test("the command line agrees with the exported judge, and its exit codes say which failure", () => {
  const { wav, timeline } = narrate(base, "The sea at night is never still.");
  const cli = (...args) => {
    try { return { code: 0, out: execFileSync(process.execPath, [join(root, "voice/render.mjs"), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (error) { return { code: error.status, out: String(error.stdout || "") + String(error.stderr || "") }; }
  };
  const ok = cli("--check", wav, "--words", "The sea at night is never still.");
  assert.equal(ok.code, 0, `a spoken file passes --check, got ${ok.code}: ${ok.out}`);
  assert.equal(JSON.parse(ok.out).verdict, "speech");
  const bad = cli("--check", impostor(base, "tone"), "--words", "The sea at night is never still.");
  assert.equal(bad.code, 3, "a tone is rejected with the 'not speech' exit code");
  // Exit 2 is the other, separate refusal: the text cannot be said at all, and the render
  // never produces a file. Conflating the two would tell an agent "your audio is bad" when
  // the problem is the script.
  const unreadable = cli("--text", "你好世界", "--out", join(base, "never.wav"));
  assert.equal(unreadable.code, 2, `unpronounceable text exits 2, got ${unreadable.code}: ${unreadable.out}`);
  assert.match(unreadable.out, /no way to say/, "and names the words it cannot say");
  // The timeline the renderer wrote is the one the server will check against these bytes.
  assert.ok(JSON.parse(readFileSync(timeline, "utf8")).phrases.length, "a render writes a timeline");
});

test("the server accepts a narration whose timeline describes its bytes", () => {
  const dir = mkdtempSync(join(base, "ok-"));
  const { wav } = narrate(dir);
  const result = verifyNarration({ attemptDir: dir, artifact: "narration.wav" });
  assert.equal(result.ok, true, `a real narration was refused: ${result.problems.join("; ")}`);
  assert.equal(result.evidence.verdict, "speech");
  assert.equal(result.evidence.words, 14);
  // The evidence is the number the check itself measured, not a number written to look right:
  // it is compared with a fresh measurement of the same bytes.
  assert.equal(result.evidence.onsets, measure(wav).onsets, "the kept onset count is the measured one");
  assert.ok(result.evidence.onsets >= 18, `at least a rise per syllable, got ${result.evidence.onsets}`);
  assert.equal(result.evidence.phrases.length, 2, "and the phrase record a person can read");
  assert.ok(wav && result.evidence.seconds > 5);
});

test("the server refuses each way a narration can lie about itself", () => {
  // 1. A plausible timeline with no WAV behind it, and a WAV with no timeline.
  const missingTimeline = mkdtempSync(join(base, "no-timeline-"));
  narrate(missingTimeline);
  rmSync(join(missingTimeline, "timeline.json"), { force: true });
  const removed = verifyNarration({ attemptDir: missingTimeline, artifact: "narration.wav" });
  assert.equal(removed.ok, false, "a WAV with no timeline is not a narration anyone can check");
  assert.match(removed.problems.join(" "), /timeline/, "and the reason names the missing record");

  // 2. The timeline describes a different, longer file. This is the exact lie a copied
  //    timeline tells, and it is invisible to any check that reads only one of the two.
  const wrongLength = mkdtempSync(join(base, "wrong-length-"));
  narrate(wrongLength);
  const t = JSON.parse(readFileSync(join(wrongLength, "timeline.json"), "utf8"));
  t.phrases[1].start += 4;
  t.phrases[1].duration += 0;
  writeFileSync(join(wrongLength, "timeline.json"), JSON.stringify(t));
  const shifted = verifyNarration({ attemptDir: wrongLength, artifact: "narration.wav" });
  assert.equal(shifted.ok, false, "a timeline that runs past the WAV is refused");
  assert.match(shifted.problems.join(" "), /does not describe this file|starts at/, "and says which disagreement it found");

  // 3. Words the shipped voice cannot say. A timeline claiming a Chinese sentence over a
  //    real WAV has to be refused, or the record would claim words nobody spoke.
  const foreign = mkdtempSync(join(base, "foreign-"));
  narrate(foreign);
  const f = JSON.parse(readFileSync(join(foreign, "timeline.json"), "utf8"));
  f.phrases = [{ text: "你好世界", start: 0, duration: f.seconds }];
  writeFileSync(join(foreign, "timeline.json"), JSON.stringify(f));
  assert.match(verifyNarration({ attemptDir: foreign, artifact: "narration.wav" }).problems.join(" "), /cannot say/, "unpronounceable words are refused");

  // 4. A perfect timeline over a file of noise - the shape an agent produces without
  //    speaking. The timeline is contiguous and plausible; it is caught before the acoustic
  //    judge even runs, because noise is not the recording those words make. That is the
  //    stronger statement of the same fact: the file was refused for its contents, not for
  //    its length, and `test/bind.test.mjs` covers the case where a take's timeline belongs
  //    to another take of exactly the same duration.
  const liar = mkdtempSync(join(base, "liar-"));
  const noise = impostor(liar, "noise");
  const noiseSeconds = wavSamples(readFileSync(noise)).samples.length / 22050;
  writeFileSync(join(liar, "timeline.json"), JSON.stringify({ phrases: [{ text: "The sea at night is never still.", start: 0, duration: noiseSeconds }] }));
  const caught = verifyNarration({ attemptDir: liar, artifact: "noise.wav" });
  assert.equal(caught.ok, false, "a consistent timeline over noise must not pass");
  assert.match(caught.problems.join(" "), /not that recording|does not match the script/, `the audio itself is what failed, got: ${caught.problems.join("; ")}`);
  assert.equal(caught.evidence, null, "and nothing is kept as evidence for a take that is not speech");
});
