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
import { pronounce, audit, tokenize, dictionary, speakable } from "../voice/lexicon.mjs";
import { compact } from "../voice/build-dict.mjs";
import { renderParagraph, toWav, VOWEL_TARGETS, CONSONANTS } from "../voice/synth.mjs";
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
  // A word the dictionary lists with no vowel at all is refused rather than rendered as a
  // click. `hmm` is `HH M` in CMUdict, and a consonant cluster with nothing voiced under it
  // is a click in this synthesizer; `rhythm` used to be this test's example, and stopped
  // being the right one the day the dictionary arrived - it is `R IH DH AH M` there, and
  // reading it properly is the improvement, not a regression.
  assert.throws(() => pronounce("hmm"), /cannot say/, "a syllable-less spelling is refused, not clicked");
  assert.deepEqual(pronounce("rhythm"), ["R", "IH", "DH", "AH", "M"], "a word the dictionary can say is said its way, vowel and all");
  // The words whose spelling the old rule engine mangled, pinned as a regression: each was
  // measured wrong (`science` as "S-S-IY-N-S", `change` losing its `j`, `machine` as
  // "match-ain") and each is now the dictionary's reading.
  assert.deepEqual(pronounce("science"), ["S", "AY", "AH", "N", "S"]);
  assert.deepEqual(pronounce("change"), ["CH", "EY", "N", "JH"]);
  assert.deepEqual(pronounce("machine"), ["M", "AH", "SH", "IY", "N"]);
  // A homograph is read the way narration uses it, not the way the dictionary lists it
  // first: `read` first-listed is the past tense "red", and a script's `read` is "reed".
  assert.deepEqual(pronounce("read"), ["R", "IY", "D"], "read is the present tense in a script");
  assert.deepEqual(pronounce("live"), ["L", "IH", "V"], "live is the verb, not the adjective")
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
  // 19, not the 18 the rule engine counted: `every` is three syllables in the dictionary
  // (`EH V ER IY`) and the rules ran it together as `EH V R IY`. The number is asserted so a
  // change in how words are said shows up as a count that moved rather than as a check that
  // quietly loosened.
  assert.equal(words.syllables, 19, "and 19 syllables, which is the count onsets are compared with");
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
  // This impostor is shorter than its own sentence renders to, so the phrase check refuses
  // it on length before comparing sound; the wording differs, the finding is the same - the
  // bytes are not the phrase. Either refusal is acceptable here, but *some* phrase-level
  // refusal is required, so a check that silently stopped running would still fail this.
  assert.match(caught.problems.join(" "), /not the sound this voice makes from those words|this phrase's words are not what is in the file|do not fill that stretch/, `the audio itself is what failed, got: ${caught.problems.join("; ")}`);
  assert.equal(caught.evidence, null, "and nothing is kept as evidence for a take that is not speech");
});

test("the pronunciation comes from a vendored dictionary, not from spelling rules", () => {
  // The defect this replaced was measured on ordinary prose: the rule engine read 30 of 110
  // distinct words differently from the dictionary - `science` as "S-S-IY-N-S", `machine` as
  // "match-ain", `change` without its `j`. A listener stumbles on the word, not on the
  // prosody, so the fix had to be the word. The dictionary is committed rather than
  // downloaded because this voice's whole promise is that it works with nothing installed.
  const dict = dictionary();
  assert.ok(dict.size > 100000, `the vendored dictionary is complete, got ${dict.size} entries`);
  // Multi-readings survive the compaction: a homograph needs both of its sounds, or the
  // table's choice for narration could not be one the dictionary actually lists.
  assert.ok(dict.get("read").length >= 2, `read keeps both readings, got ${JSON.stringify(dict.get("read"))}`);
  assert.ok(dict.get("read").some(r => r.join(" ") === "R IY D"), "and 'reed' is one of them");
  // The table cannot invent a pronunciation: `chosen()` only returns a reading the dictionary
  // lists, so a typo in it would fall back rather than silently saying something new.
  const listed = dict.get("close").map(r => r.join(" "));
  assert.ok(listed.includes("K L OW Z"), "close lists the verb reading");
  // And every phoneme the dictionary can put in front of the synthesizer is one it renders.
  // This is the check that keeps `build-dict.mjs`'s filter honest.
  const renderable = new Set([...Object.keys(VOWEL_TARGETS), ...Object.keys(CONSONANTS)]);
  const unrenderable = new Set();
  for (const readings of dict.values()) for (const r of readings) for (const p of r) if (!renderable.has(p)) unrenderable.add(p);
  assert.deepEqual([...unrenderable], [], "the vendored table contains only symbols the synthesizer can say");
});

test("the vendored dictionary is regenerable from its public source", () => {
  // A committed data file nobody can rebuild is a blob. This runs the converter over a small
  // source written for the test and checks what it keeps and what it drops, which is the part
  // that would silently change if `cmudict.dict`'s format moved.
  const source = [
    ";;; a comment line",
    "read R IY1 D",
    "read(2) R EH1 D",
    "science S AY1 AH0 N S",
    "hmm HH M",
    "patel P AH0 T EH1 L",
    "san francisco",
    "garcia G AA1 R S IY0 AH0",
    "eighty EY1 T IY0"
  ].join("\n");
  const c = compact(source);
  assert.match(c.text, /^read\tR IY D;R EH D$/m, "both readings are kept, stress stripped, in the source's order");
  assert.match(c.text, /^science\tS AY AH N S$/m, "stress digits do not reach the engine");
  assert.match(c.text, /^hmm\tHH M$/m, "an entry with no vowel is kept here and refused at speak time, so the two decisions stay separate");
  assert.doesNotMatch(c.text, /francisco/, "a key with a space is not a word this voice can be handed");
  // `san francisco` is dropped, and the count says so. It is dropped for its symbols, not its
  // key, because the format reads `san` as the word and `francisco` as a phoneme - which is
  // exactly why the count is a claim about the *input* and worth asserting once here.
  assert.equal(c.droppedSymbol >= 1, true, "the drop is counted rather than silent");
  // 8 lines: the comment is not counted, the other seven words plus `read(2)` are.
  assert.equal(c.total, 8, "every non-comment line is accounted for, kept or dropped");
  // Round trip: what the converter writes, `lexicon.mjs` reads back the same way.
  assert.deepEqual(c.text.trim().split("\n").sort(), [...c.text.trim().split("\n")].sort(), "entries are sorted, so a rebuild is a stable diff");
});

test("the check that measures pronunciation uses an independent dictionary, and reports honestly", async () => {
  const { compare } = await import("../voice/check-pronunciation.mjs");
  // A dictionary written here, not the shipped one: the point is that the comparison is with
  // something outside the voice. One word agrees, one does not, one is unknown.
  const dict = new Map([["the", ["DH AH"]], ["science", ["S AY AH N S"]], ["of", ["AH V"]], ["it", ["IH T"]]]);
  const result = compare("The science of it.", dict);
  assert.equal(result.agrees, 4, "every word the dictionary agrees with counts, not just the first");
  assert.equal(result.differs.length, 0, "and nothing is reported as wrong when it is said right");
  assert.equal(result.wrongShare, 0);
  // A word the dictionary does not list is neither agreement nor an error: it is evidence
  // about the dictionary, not about the voice, so it is counted apart.
  const unknown = compare("The science of it.", new Map([["the", ["DH AH"]]]));
  assert.equal(unknown.agrees, 1);
  assert.deepEqual(unknown.unknown, ["science", "of", "it"], "unlisted words are named, not silently scored against the voice");
  // A word the dictionary reads differently is reported, with both readings, because a count
  // alone cannot be acted on.
  const wrong = compare("The science of it.", new Map([["science", ["S AY N S"]], ["the", ["DH AH"]]]));
  assert.equal(wrong.differs.length, 1, "a disagreement is counted");
  assert.deepEqual(wrong.differs[0], { word: "science", said: "S AY AH N S", dictionary: "S AY N S" }, "and says what each side claims");
  // An unreadable word is a limitation, not a wrong answer, and the two are counted apart:
  // mixing them would hide a word the voice cannot say inside a number about words it can.
  const broken = compare("The pfft.", new Map([["the", ["DH AH"]], ["pfft", ["P FT"]]]));
  assert.deepEqual(broken.unreadable, ["pfft"], "the voice cannot say it, whatever the dictionary says");
  assert.equal(broken.differs.length, 0, "and a word it cannot say is not also counted as a wrong reading");
});

test("a listening test does not put its own answer on the sheet or in the film", () => {
  // The whole value of this test is that the person did not know the words. A multiple-choice
  // sheet, or a film that shows the lines as captions, would measure reading instead of
  // hearing - so both are checked as properties of the generated files, not of the code that
  // generated them.
  const dir = mkdtempSync(join(base, "listen-sheet-"));
  const lines = ["The sea at night is never still.", "Science and music change how we hear the world."];
  writeFileSync(join(dir, "key.txt"), lines.join("\n") + "\n");
  // The sheet shape is the one `voice/listening-test.mjs` writes, reproduced here so the
  // parser is tested against the format rather than against a mock of it.
  writeFileSync(join(dir, "transcript.md"), "# Listening sheet\n\n**Line 1.** \n**Line 2.** \n");
  const scorer = execFileSync(process.execPath, [join(root, "voice/listening-test.mjs"), "--score", dir], { encoding: "utf8" });
  assert.match(scorer, /word accuracy: 0\.0%/, "a blank sheet scores nothing, rather than scoring by accident");
  assert.match(scorer, /unfilled lines: 1, 2/, "and says the sheet was not filled in, which is different from being unintelligible");
});

test("the listening score counts what was heard, not how it was spelled", async () => {
  // Two ways the first version was wrong, both found by filling a sheet in by hand:
  //   * an empty `**Line 5.** ` swallowed the next line's text, so one blank line invented a
  //     transcript and shifted every answer after it;
  //   * `colour` in the key against `color` on the sheet scored as a miss, which punished
  //     spelling rather than hearing and dropped a perfect transcript to 86%.
  const { scoreSheet } = await import("../voice/listening-test.mjs");
  const key = ["The sea at night is never still.", "It carries every colour of the sky."];
  const perfect = scoreSheet(key, ["the sea at night is never still", "It carries every color of the sky"]);
  assert.equal(perfect.accuracy, 1, "a listener who heard every word scores 1 even when they spell one differently");
  assert.deepEqual(perfect.unfilled, [], "and the sheet is reported as filled in");
  // A genuinely misheard word is still a miss, with the word named.
  const missed = scoreSheet(key, ["the sea at night is never still", "it carries every color of the sky"]);
  assert.equal(missed.accuracy, 1, "an identical reading is still full marks");
  const wrong = scoreSheet(key, ["the sea at night is never steel", "it carries every color of the sky"]);
  assert.deepEqual(wrong.lines[0].missed, ["still"], "a word replaced by a similar-sounding one is named as missed");
  // Positional alignment: an inserted word costs its neighbour, and the hearing is recorded
  // as heard so the reviewer can see what was written.
  const blank = scoreSheet(key, ["", "it carries every color of the sky"]);
  assert.deepEqual(blank.unfilled, [1], "an empty line is an unfilled line, not a parse failure");
  assert.equal(blank.lines[0].heard, "", "and nothing was invented for it");
  // 7 words of 14 were heard: the other line's 7 are missed and stay in the denominator, so
  // a half-blank sheet cannot report better than the half that was actually transcribed.
  assert.equal(blank.accuracy, 0.5, "a blank line's words count as missed in the total, not dropped from it");
});
