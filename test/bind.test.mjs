// A take's words and a take's sound have to be the same take.
//
// The reviewer's report, reproduced before the fix (`.tmp/repro-swap2.mjs`): two different
// two-clause sentences render to files of exactly the same length, 3.291 s each, so the old
// check - which compared the timeline with the file's duration - accepted either one's
// timeline beside either one's audio. The card then wrote one sentence over a player that
// spoke another. Every case below is a way that correspondence can break.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { renderParagraph, toWav } from "../voice/synth.mjs";
import { appearsInOrder, bindTake, correlation, wordsOf, writtenSlack } from "../voice/bind.mjs";
import { pronounce } from "../voice/lexicon.mjs";
import { verifyNarration } from "../server/narration.mjs";

const root = process.cwd();
const base = mkdtempSync(join(tmpdir(), "hypermaker-bind-"));
const A = "Open the blue door.\nClose the red gate.";
const B = "Open the red gate.\nClose the blue door.";

// A take exactly as `voice/render.mjs` writes one: a WAV and a timeline beside it.
function take(name, text, voice = {}) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  const phrases = text.split("\n").filter(Boolean).map(t => ({ text: t }));
  const rendered = renderParagraph(phrases, voice);
  const wav = join(dir, "narration.wav");
  writeFileSync(wav, toWav(rendered.samples, rendered.rate));
  // Exactly what `voice/render.mjs` now writes: the effective settings the samples were made
  // with, not the arguments, and not a rounded version of them.
  const timeline = { audio: wav, rate: rendered.rate, seconds: rendered.samples.length / rendered.rate, voice: rendered.voice, phrases: rendered.segments };
  writeFileSync(join(dir, "timeline.json"), JSON.stringify(timeline));
  return { dir, wav, timeline, rendered };
}

test("a narration is bound to the script beside it, not just to its length", () => {
  const a = take("a", A), b = take("b", B);
  // The two sentences really are the same length to the sample: this is why duration could
  // not tell them apart, and it is asserted rather than assumed so a change in the voice
  // that broke the premise would show up here instead of silently weakening the test.
  assert.equal(a.rendered.samples.length, b.rendered.samples.length, "the two takes are the same length, which is exactly what defeated the old check");

  // The honest take passes, and reports how well the bytes agree with their own script.
  const honest = verifyNarration({ attemptDir: a.dir, artifact: "narration.wav", material: A });
  assert.equal(honest.ok, true, `a real narration was refused: ${honest.problems.join("; ")}`);
  assert.equal(honest.evidence.take.correlation, 1, "the same words re-render to the same signal");

  // The reviewer's case: A's audio, B's timeline. Same duration, same syllable count, same
  // pronounceable words - and a different recording.
  const swap = join(base, "swap");
  mkdirSync(swap, { recursive: true });
  writeFileSync(join(swap, "narration.wav"), readFileSync(a.wav));
  writeFileSync(join(swap, "timeline.json"), readFileSync(join(b.dir, "timeline.json")));
  const stolen = verifyNarration({ attemptDir: swap, artifact: "narration.wav", material: B });
  assert.equal(stolen.ok, false, "one take's audio accepted another take's words");
  assert.match(stolen.problems.join(" "), /not the sound this voice makes from those words/, "and says the audio is not that script");
  assert.match(stolen.problems.join(" "), /phrase 1 \("Open the red gate\."\)/, "and names the phrase that was not spoken");
});

test("every way the audio can stop matching its own timeline is refused", () => {
  const a = take("cases", A);
  // 1. A different sentence's timeline, as above. Refused on the bind, not on length.
  const other = take("other", B);
  const swapped = bindTake({ file: a.wav, timeline: other.timeline });
  assert.equal(swapped.ok, false, "another sentence's timeline was accepted");
  assert.ok(swapped.correlation < 0.3, `a different sentence is clearly a different signal, got ${swapped.correlation}`);
  // 2. The same words in a different order. Duration is identical; the recording is not.
  const reordered = take("reordered", "Close the red gate.\nOpen the blue door.");
  assert.equal(reordered.rendered.samples.length, a.rendered.samples.length, "reordering is also length-preserving");
  assert.equal(bindTake({ file: a.wav, timeline: reordered.timeline }).ok, false, "reordered words passed as the same recording");
  // 3. A timeline claiming one word differently, which is the smallest possible edit.
  const oneWord = { ...a.timeline, phrases: [{ ...a.timeline.phrases[0], text: "Open the blue gate." }, a.timeline.phrases[1]] };
  const near = bindTake({ file: a.wav, timeline: oneWord });
  assert.equal(near.ok, false, "a one-word edit passed as the same recording");
  // A one-word edit is refused either because the phrase's words no longer fill the stretch
  // the timeline gives them, or because a *frame* disagrees where they do - never on an
  // average of the shared opening. Whatever the reason, it must be one of those two, and the
  // message has to say which; the length-independent case is the next test.
  assert.match(near.problems.join(" "), /not the sound this voice makes from those words|do not fill that stretch|not what is in the file/, `the refusal names a real disagreement, got: ${near.problems.join("; ")}`);
  // And the case the phrase-level version of this check let through: a word changed at the
  // end of a phrase long enough that the identical opening dominated a whole-phrase average.
  const longA = take("long-a", "The path goes past the old stone wall.");
  const longEdit = { ...longA.timeline, phrases: [{ ...longA.timeline.phrases[0], text: "The path goes past the old stone gate." }] };
  const late = bindTake({ file: longA.wav, timeline: longEdit });
  assert.equal(late.ok, false, "a word changed at the end of a long phrase passed, which is the dilution this check exists to prevent");
  // 4. A script that renders to a different length cannot describe the file at all.
  const longer = take("longer", `${A}\nAnd lock it behind you.`);
  const wrongLength = bindTake({ file: a.wav, timeline: longer.timeline });
  assert.equal(wrongLength.ok, false, "a longer script passed as this recording");
  assert.match(wrongLength.problems.join(" "), /renders to/, "and says the lengths disagree rather than reporting a score");
  // 5. Rate and pitch are part of the recording. A timeline that claims the default speed
  // over audio rendered brisker must not corroborate itself by re-rendering at its own speed.
  const brisk = take("brisk", A, { rate: 1.3 });
  const wrongVoice = bindTake({ file: brisk.wav, timeline: { ...brisk.timeline, voice: { rate: 1, pitch: 112 } } });
  assert.equal(wrongVoice.ok, false, "a timeline that misstates the speed it was rendered at was accepted");
});

// Why the comparison is a frame and not a phrase. These two substitutions produce exactly the
// same number of samples as the words they replace, so no duration check can see them, and a
// whole-phrase correlation rates them at 0.62 and 0.65 - comfortably over the 0.5 bar it
// would have used itself. The frame that covers the changed word is strongly negative in
// both. This is the evidence that the smaller unit is doing work rather than being a
// preference, so it is measured here instead of asserted in a comment.
test("an edit that does not change the length at all is still refused, which only the frames catch", () => {
  const wall = take("same-len", "The path goes past the old stone wall.");
  for (const word of ["hedge", "mill"]) {
    const edited = renderParagraph([{ text: `The path goes past the old stone ${word}.` }], {});
    const heard = wall.rendered.samples, other = edited.samples;
    const n = Math.min(heard.length, other.length);
    // The premise, measured: same length to the sample, and a whole-phrase correlation that
    // would have passed. If the voice changes and this stops being true, this test says so
    // rather than quietly testing nothing.
    assert.ok(Math.abs(heard.length - other.length) <= 2, `the two phrasings are the same length to the sample (${heard.length} vs ${other.length}), which is why duration cannot tell them apart`);
    const whole = correlation(heard.slice(0, n), other.slice(0, n));
    assert.ok(whole >= 0.5, `a whole-phrase correlation would accept this (${whole.toFixed(3)}), so the frames are what refuse it`);
    const r = bindTake({ file: wall.wav, timeline: { ...wall.timeline, phrases: edited.segments } });
    assert.equal(r.ok, false, `"wall" -> "${word}" at the same length was accepted`);
    assert.ok(r.correlation < 0, `the frame over the changed word disagrees, got ${r.correlation}`);
  }
});

// The reviewer's second report, which the phrase-at-a-time version of this check failed: a
// long take whose last two clauses were swapped was accepted at 0.896, because most of the
// file was identical. Length of the shared beginning must not matter, so this asserts the
// property directly at three lengths rather than trusting one example.
test("a long take cannot hide a changed ending behind a long identical beginning", () => {
  const head = [
    "The sea at night is never still.",
    "It carries every colour of the sky.",
    "The light is moving over the water.",
    "The room is silent as the night comes.",
    "Turn and look out at the street.",
    "There is a light under the bridge.",
    "Walk slowly down toward the house.",
    "The garden is quiet in the rain.",
    "A window shines in the distance.",
    "The path goes past the old stone wall."
  ];
  const spoken = [...head, "Open the blue door.", "Close the red gate."];
  const claimed = [...head, "Open the red gate.", "Close the blue door."];
  const truth = take("long-take", spoken.join("\n"));
  const mixed = { ...truth.timeline, phrases: renderParagraph(claimed.map(text => ({ text })), {}).segments };
  // The premise: this is the case that defeated a whole-file correlation, so it is measured
  // rather than assumed. The two recordings are the same length and agree for 90% of it.
  const whole = correlation(truth.rendered.samples, renderParagraph(claimed.map(text => ({ text })), {}).samples);
  assert.ok(whole > 0.85, `the premise is that a whole-file correlation would have accepted this, got ${whole.toFixed(3)}`);
  const r = bindTake({ file: truth.wav, timeline: mixed });
  assert.equal(r.ok, false, `a long take with a swapped ending was accepted (min ${r.correlation})`);
  // The refusal names the two phrases that differ and no others: eleven honest sentences must
  // not be reported as wrong, or a person cannot tell what to fix.
  assert.equal(r.problems.length, 2, `only the changed phrases should fail, got ${r.problems.join("; ")}`);
  assert.match(r.problems[0], /phrase 11 \("Open the red gate\."\)/);
  assert.match(r.problems[1], /phrase 12 \("Close the blue door\."\)/);
  // The honest recording of the same twelve sentences still passes, so the check is not just
  // refusing everything long.
  assert.equal(bindTake({ file: truth.wav, timeline: truth.timeline }).ok, true, "the honest long take was refused");
});

// The reviewer's third report: `voice/render.mjs --rate 1.23456 --pitch 113.45678` wrote a
// timeline recording `1.235`/`113.457`, and the server then refused an honest take - third
// phrase, 0.300 - because a record that cannot reproduce its own audio is a record the
// checker cannot trust. Two things were wrong and both are fixed: the CLI now writes the
// settings the samples were actually made with, and a record written by an older build (or by
// hand) to a few decimal places is recovered inside the interval its precision permits rather
// than refusing an honest take.
test("the tool's own take always verifies, including at parameters it can only write down approximately", () => {
  const scripts = [
    "The sea at night is never still.\nIt carries every colour of the sky.\nThe light is moving over the water.",
    A
  ];
  const voices = [{ rate: 1, pitch: 112 }, { rate: 1.23456, pitch: 113.45678 }, { rate: 0.928, pitch: 162.321 }];
  for (const [i, text] of scripts.entries()) for (const voice of voices) {
    const t = take(`cli-${i}-${voice.rate}`, text, voice);
    // What the fixed CLI writes: the effective settings at full precision.
    assert.equal(t.timeline.voice.rate, voice.rate, `the timeline records the rate the bytes were made with, got ${t.timeline.voice.rate} for ${voice.rate}`);
    const ok = bindTake({ file: t.wav, timeline: t.timeline });
    assert.equal(ok.ok, true, `the tool's own take at rate ${voice.rate} was refused: ${ok.problems.join("; ")}`);
    // And the older shape, which rounded: still accepted, because the words are the same words
    // and rounding a record is not misquoting a script.
    const rounded = { ...t.timeline, voice: { rate: Number(voice.rate.toFixed(3)), pitch: Number(voice.pitch.toFixed(3)) } };
    if (rounded.voice.rate !== voice.rate || rounded.voice.pitch !== voice.pitch) {
      const loose = bindTake({ file: t.wav, timeline: rounded });
      assert.equal(loose.ok, true, `a take whose record was rounded to 3 dp was refused: ${loose.problems.join("; ")}`);
      // When the rounding was small enough that the recorded settings still reproduce the
      // audio, nothing was recovered and there is nothing extra to report. When it was not,
      // the result says both numbers so nobody has to guess later which one the card meant.
      if (loose.voice) {
        assert.notEqual(loose.voice.recorded.rate, loose.voice.matched.rate, "the recorded rate and the matched rate are not the same number");
        assert.ok(loose.correlation >= 0.95, `a recovered take matches its real rate closely, got ${loose.correlation}`);
      } else {
        // The rounding happened to reproduce the audio: then it must agree exactly, not scrape
        // past the bar. Settling for 0.89 when the real rate measures 1.000 is the failure this
        // branch is about.
        assert.equal(loose.correlation, 1, `a take accepted on its record must agree with it exactly, got ${loose.correlation}`);
      }
    }
  }
});

// Recovering a rate must not become a way to accept a different script. The search is confined
// to the interval the recorded precision permits, and a recovery has to reach 0.95, so a real
// edit cannot borrow its way in.
test("recovering an imprecise rate does not accept different words", () => {
  const t = take("recover-negative", "The sea at night is never still.", { rate: 1.23456, pitch: 113.45678 });
  const rounded = { ...t.timeline, voice: { rate: 1.235, pitch: 113.457 }, phrases: renderParagraph([{ text: "The sea at noon is never still." }], { rate: 1.23456, pitch: 113.45678 }).segments };
  const r = bindTake({ file: t.wav, timeline: rounded });
  assert.equal(r.ok, false, `different words passed once a rate search was allowed (min ${r.correlation})`);
  assert.equal(r.voice, undefined, "nothing was recovered, so no matched settings are reported");
});

test("a refusal always says why, even when no phrase failed outright", () => {
  // A subtle window the rewrite opened: now that several reading tables are tried, a take can
  // miss the exact threshold under all of them without any single phrase reporting a problem.
  // The first version returned `ok: false` with an empty list of reasons, which would put a
  // refusal on a card with nothing written on it - the one failure this file exists to prevent.
  // Found by sweeping cross-fades of one sentence with a near-variant of itself rather than by
  // reading the code; 5-15% of the variant lands exactly in that window.
  const real = renderParagraph([{ text: "The sea at night is never still." }]);
  const other = renderParagraph([{ text: "The sea at night is nearly still." }]);
  const mixed = Array.from({ length: real.samples.length }, (_, i) => real.samples[i] * 0.9 + (other.samples[i] ?? 0) * 0.1);
  const file = join(base, "mixed.wav");
  writeFileSync(file, toWav(mixed, real.rate));
  const timeline = { phrases: real.segments.map(s => ({ text: s.text, start: s.start, duration: s.duration })), voice: real.voice };
  const result = bindTake({ file, timeline });
  assert.equal(result.ok, false, "audio that is not quite this sentence is not accepted");
  assert.ok(result.problems.length > 0, "and the refusal carries a reason for a card to show");
  assert.match(result.problems.join(" "), /does not reproduce from its own script|not the sound this voice makes/, `the reason names what is wrong, got ${JSON.stringify(result.problems)}`);
});

test("a script may quote its material but may not invent words", () => {
  const material = "The sea at night is never still. It carries every colour of the sky.";
  const source = wordsOf(material);
  // A selection is ordinary: a trailer uses one line of a long paragraph.
  assert.equal(appearsInOrder(wordsOf("The sea at night is never still."), source).ok, true, "using part of the material is allowed");
  assert.equal(appearsInOrder(wordsOf("It carries every colour."), source).ok, true, "a selection from the middle is allowed");
  // But not in the wrong order, and not words that are absent: a fluent sentence about
  // something else is the failure this check exists for, and it is the one an agent that
  // "improved" the copy would produce.
  const invented = appearsInOrder(wordsOf("The sea at night is never calm."), source);
  assert.equal(invented.ok, false, "a word that is in the material nowhere was accepted");
  assert.deepEqual(invented.missing, ["calm"], "and the refusal names that word");
  assert.equal(appearsInOrder(wordsOf("It carries the sea."), source).ok, false, "words reordered across sentences are not a selection");
  assert.equal(appearsInOrder([], source).ok, true, "an empty script is not an invention, it is a separate problem");
});

test("the card records which card it read, and a take that read nothing is refused", () => {
  const a = take("source", A);
  const from = { id: 2, artifact: "text.txt" };
  const kept = verifyNarration({ attemptDir: a.dir, artifact: "narration.wav", material: A, from });
  assert.equal(kept.ok, true, `a real narration was refused: ${kept.problems.join("; ")}`);
  assert.deepEqual(kept.evidence.source, from, "the reopened card can say whose words were spoken");
  // With no text input a card narrates its own prompt, and that is material too - so the
  // caller passes the prompt and there is no source card to name.
  const own = verifyNarration({ attemptDir: a.dir, artifact: "narration.wav", material: A, from: null });
  assert.equal(own.ok, true);
  assert.equal(own.evidence.source, null, "a card narrating its own prompt names no other card");
  // A card that was given nothing to read cannot have spoken it.
  const empty = verifyNarration({ attemptDir: a.dir, artifact: "narration.wav", material: "   ", from: null });
  assert.equal(empty.ok, false, "a narration was accepted with no material behind it");
  assert.match(empty.problems.join(" "), /no text to read/, "and says the card had nothing to read");
  // An OLD take, written before `voice` was recorded, must still verify at the defaults:
  // refusing every workshop written by an earlier build would break the workspaces a
  // person already has, which is a worse failure than the one this check closes.
  const legacy = take("legacy", A);
  const oldTimeline = { ...legacy.timeline };
  delete oldTimeline.voice;
  writeFileSync(join(legacy.dir, "timeline.json"), JSON.stringify(oldTimeline));
  const old = verifyNarration({ attemptDir: legacy.dir, artifact: "narration.wav", material: A });
  assert.equal(old.ok, true, `a take from before the timeline recorded its settings was refused: ${old.problems.join("; ")}`);
});

// The reviewer's finding, reproduced exactly as it was reported. A take made by the build
// before the dictionary existed was refused by the build that added it:
//
//   phrase 1 ("Science can change the way a machine works.") is 3.71s of speech,
//   but the timeline says it takes 3.52s
//
// The audio was honest. It was the rule engine's reading of those words ("S-S-IY-N-S" for
// `science`), and the checker re-rendered with today's dictionary and got a longer file. So
// an improvement in how the voice pronounces made every older recording look like a lie about
// its own script - the loudest possible false accusation, on the one card a person is most
// likely to have kept. The reading table is a versioned render setting now, and the cases a
// reader can confuse are pinned apart here.
const OLD_TAKE = "Science can change the way a machine works.";

test("a take made by an older reading table still verifies, and a different recording still does not", () => {
  // Rendered the way the pre-dictionary build rendered it, through the frozen `rules-1` set.
  const old = take("readings-old", OLD_TAKE, { readings: "rules-1" });
  assert.equal(old.timeline.voice.readings, "rules-1", "the take records which table made its bytes");
  // The two tables really do produce different audio for this sentence - the premise of the
  // whole test. If a future lexicon made them agree, this would fail rather than pass quietly.
  const today = renderParagraph([{ text: OLD_TAKE }], { readings: "cmudict-1" });
  assert.notEqual(old.rendered.samples.length, today.samples.length, "the two reading tables render this sentence to different lengths, which is why the old check refused it");

  // The honest take verifies, and the evidence says which table made it.
  const verified = verifyNarration({ attemptDir: old.dir, artifact: "narration.wav", material: OLD_TAKE });
  assert.equal(verified.ok, true, `a take from an older reading table was refused: ${verified.problems.join("; ")}`);
  assert.equal(verified.evidence.take.voice.matched.readings, "rules-1", "the evidence names the table the audio was made with");

  // And its timeline still verifies with no `readings` field at all, which is what every
  // workspace written before this change looks like. The take must not be refused just
  // because its record predates the field that explains it.
  const bare = { ...old.timeline, voice: { rate: old.timeline.voice.rate, pitch: old.timeline.voice.pitch } };
  const unlabelled = bindTake({ file: old.wav, timeline: bare });
  assert.equal(unlabelled.ok, true, `an unlabelled take from an older table was refused: ${unlabelled.problems.join("; ")}`);
  assert.equal(unlabelled.voice.matched.readings, "rules-1", "the check works out which table reproduces the audio and says so");

  // The boundary that makes the fix safe. A *different* recording cannot be admitted by any
  // table: the words, their order and the file have to stay the same. This is the reviewer's
  // first finding (take A's audio under take B's timeline) re-asked with the new escape hatch
  // open, and it must still be refused.
  const other = take("readings-other", "Close the red gate and open the blue door.");
  const foreign = bindTake({ file: other.wav, timeline: old.timeline });
  assert.equal(foreign.ok, false, "another take's audio was accepted because some reading table was allowed to match");
  assert.match(foreign.problems.join(" "), /not what is in the file there|not the sound|do not fill that stretch/, "and the refusal still says the audio is not this script");

  // Same sentence, same table, but the timeline misstates the table: it says `cmudict-1` and
  // the audio is `rules-1`. That is not a lie about the words, so it verifies - and the
  // evidence reports both the claim and the truth, so a reader is never told the record was
  // right when the audio says otherwise.
  const mismatch = { ...old.timeline, voice: { ...old.timeline.voice, readings: "cmudict-1" } };
  const relabelled = bindTake({ file: old.wav, timeline: mismatch });
  assert.equal(relabelled.ok, true, `an honest take was refused for a mislabelled table: ${relabelled.problems.join("; ")}`);
  assert.equal(relabelled.voice.recorded.readings, "cmudict-1", "the record's claim is kept, not overwritten");
  assert.equal(relabelled.voice.matched.readings, "rules-1", "and what the audio actually is is reported beside it");
});

test("a reading table is named, so a take cannot be rendered with one the build does not have", () => {
  // A record naming an unknown table is a typo or a newer build's audio. Either way it must
  // not fall back silently to whatever this build happens to default to - that would make the
  // one field that explains the audio into a field that is ignored.
  // `cmudict-2` is a real table in this build (it adds stress), so the name to refuse is one no
  // build has. `.at(-1)` is deliberately not used here: naming a hypothetical *next* table would
  // silently become a valid name the day that table ships, and the test would stop testing.
  assert.throws(() => renderParagraph([{ text: "The sea at night is never still." }], { readings: "cmudict-9" }), /unknown reading set/, "an unknown table must be refused where it is used, not defaulted");
  // A timeline naming an unknown table is still checked, against the tables this build has:
  // refusing to look would strand an old workspace, and accepting without looking would be
  // the old defect. The audio decides.
  const t = take("readings-unknown", OLD_TAKE, { readings: "rules-1" });
  const claim = { ...t.timeline, voice: { ...t.timeline.voice, readings: "cmudict-9" } };
  const r = bindTake({ file: t.wav, timeline: claim });
  assert.equal(r.ok, true, `a good take was refused because its record named a table this build does not have: ${r.problems.join("; ")}`);
  assert.equal(r.voice.matched.readings, "rules-1", "and it reports the table that actually reproduces the sound");
});

test("the frozen rule table is the engine that actually shipped, not a lookalike", () => {
  // `rules-1` exists so that audio published before the dictionary still verifies. That only
  // works if it is the *old engine*, exactly - a table that is merely similar would reproduce
  // yesterday's take closely and then fail the frame check, which is worse than not having it:
  // it would look like the audio was wrong. So the values are pinned, not described.
  //
  // Where they come from: 10e1da6 is the last commit whose `voice/lexicon.mjs` had no
  // dictionary at all. I re-rendered the reviewer's own file through that commit's code and
  // got 77,635 samples with whole-file correlation 1.0000 and worst frame 1.000, which is the
  // same sample count `rules-1` produces today. A change to these numbers means this table
  // stopped being history and became a guess.
  const old = renderParagraph([{ text: OLD_TAKE }], { readings: "rules-1" });
  assert.equal(old.samples.length, 77635, "rules-1 must render the reviewer's sentence to exactly the bytes that were published");
  // Stronger than a length: the whole file, hashed. Re-rendering the reviewer's own take with
  // `node voice/render.mjs --readings rules-1` produced a WAV whose SHA-256 is identical to
  // the one their build published, so this is not "a similar length" - it is the same
  // recording. If the synthesizer or the frozen table ever drifts, this is what notices.
  assert.equal(
    createHash("sha256").update(toWav(old.samples, old.rate)).digest("hex"),
    "364a37535767644d539e39ae36e10f2b9bdc5c69506ce20e4abd3247bc48a6c4",
    "rules-1 must reproduce the published take byte for byte, not merely to the same duration"
  );
  const now = renderParagraph([{ text: OLD_TAKE }], { readings: "cmudict-1" });
  assert.equal(now.samples.length, 81890, "and the dictionary's reading is a different recording, which is why the record has to name its table");

  // The differences are the ones that matter - words read as *different words*, not a stylistic
  // shift. Pinned by phonemes so a subtle drift in the rules is caught, not just a length change.
  const pairs = {
    science: ["S S IY N S", "S AY AH N S"],
    change: ["CH AE NG", "CH EY N JH"],
    machine: ["M AE CH AY N", "M AH SH IY N"],
    colour: ["K AA L AW R", "K AH L ER"],
    every: ["EH V R IY", "EH V ER IY"]
  };
  for (const [word, [was, is]] of Object.entries(pairs)) {
    assert.equal(pronounce(word, "rules-1").join(" "), was, `rules-1 is the historical reading of "${word}"`);
    assert.equal(pronounce(word, "cmudict-1").join(" "), is, `cmudict-1 is the dictionary's reading of "${word}"`);
  }
  // A digit is not a pronunciation question, so both tables must agree on it: if one table
  // refused numbers, an old take with "2" in it would fail for an unrelated reason.
  assert.deepEqual(pronounce("2", "rules-1"), pronounce("2", "cmudict-1"), "both tables read digits the same way");
});

test("a stored take can be re-verified from the command line, which is how an old workspace is checked after an upgrade", () => {
  // Publishing checks a take once. Reopening a workspace serves the bytes without checking
  // them again, which is right - a take you approved should still play tomorrow. The gap that
  // leaves is the one a reviewer asked about: after the voice improves, how does a person find
  // out whether a card they already have is still honest? This command is the answer, and it
  // is checked here rather than only from a terminal so it cannot rot into a script nobody ran.
  const cli = (...args) => {
    try { return { code: 0, out: execFileSync(process.execPath, [join(root, "voice/verify-take.mjs"), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (error) { return { code: error.status, out: `${error.stdout || ""}${error.stderr || ""}` }; }
  };

  // An honest take from the older table: verifies, and says so in a sentence a person can act
  // on, naming the table rather than making them read a correlation.
  const old = take("verify-cli-old", OLD_TAKE, { readings: "rules-1" });
  const ok = cli(old.dir);
  assert.equal(ok.code, 0, `an honest stored take did not verify: ${ok.out}`);
  assert.match(ok.out, /verifies:/, "the command says the result in a word, not only a number");
  assert.match(ok.out, /worst-frame agreement with the words: 1\.000/, "and reports the measurement behind it");
  assert.match(ok.out, /reading table: rules-1/, "and says which reading table made the audio");

  // A take naming a table it was not made with: still honest, and the message must not read
  // like a rejection, because the words and the sound really do match.
  const mislabelled = take("verify-cli-label", OLD_TAKE, { readings: "cmudict-1" });
  const shuffled = { ...mislabelled.timeline, voice: { ...mislabelled.timeline.voice, readings: "rules-1" } };
  writeFileSync(join(mislabelled.dir, "timeline.json"), JSON.stringify(shuffled));
  const relabelled = cli(mislabelled.dir);
  assert.equal(relabelled.code, 0, `an honest take was failed for a mislabelled table: ${relabelled.out}`);
  assert.match(relabelled.out, /only the label is off/, "and the message says the label is the problem, not the words");

  // The case the check exists for: one take's audio under another take's script. It must fail,
  // and the exit code has to say so, so this can be used in a script.
  const other = take("verify-cli-other", "Close the red gate and open the blue door.");
  const stolen = join(base, "verify-cli-stolen");
  mkdirSync(stolen, { recursive: true });
  writeFileSync(join(stolen, "narration.wav"), readFileSync(other.wav));
  writeFileSync(join(stolen, "timeline.json"), JSON.stringify(old.timeline));
  const wrong = cli(stolen);
  assert.equal(wrong.code, 3, `a foreign recording was not rejected: ${wrong.out}`);
  assert.match(wrong.out, /DOES NOT VERIFY/, "and it says so before the detail");
  assert.match(wrong.out, /not what is in the file there|not the sound|do not fill that stretch/, "and names the moment that disagrees");

  // A take with no timeline cannot be checked, and the command must say which file is missing
  // rather than reporting the audio as bad.
  const bare = join(base, "verify-cli-bare");
  mkdirSync(bare, { recursive: true });
  writeFileSync(join(bare, "narration.wav"), readFileSync(old.wav));
  const missing = cli(bare);
  assert.equal(missing.code, 1, "a missing timeline is a usage error, not a bad recording");
  assert.match(missing.out, /no timeline at/, "and it names the file it looked for");
});

// A record written to the precision a person actually sees is not a lie about the audio.
//
// The supervisor's repro, reproduced before the fix (`.tmp/repro-rounding.mjs`): a take of four
// sentences rendered by the *old rules* voice, and a copy of its own timeline with every start
// and duration kept to two decimal places - `4.38` for `4.3835147`, which is what the card
// displays and what `render.mjs` printed on stdout. `bindTake` searched one sample either side
// of the recorded start, so a rounding of up to 110 samples at 22.05 kHz landed outside the
// window and the take was refused as "not the sound these words make", blaming phrases for a
// number that had merely been rounded.
//
// The fix is structural rather than a wider tolerance: phrases are joined with no gap, so a
// start is exactly the sum of the renders before it, and the only thing in doubt is how many
// places the record was written to. `writtenSlack` derives the permitted half-place from the
// number itself, and the alignment is searched inside it - coarse whole-phrase correlation to
// find the position, then the same frame test to decide whether those words are there. Nothing
// is loosened: an edited phrase still disagrees frame for frame wherever it lands.
test("an honest take whose record is written to two decimal places verifies, and a changed word still does not", () => {
  const lines = [
    "Science can change the way a machine works.",
    "The sea at night is never still.",
    "Walk slowly down toward the house.",
    "The garden is quiet in the rain."
  ];
  // The old rules voice, because that is the audio the supervisor used: a record from before
  // `readings` existed, which is the harder case - the table has to be recovered as well.
  const t = take("rounding-rules", lines.join("\n"), { readings: "rules-1" });
  const two = n => Number(n.toFixed(2));

  // The premise, measured: the rounding really does move a start far beyond one sample, so
  // this test is not quietly checking a case that no longer exists.
  assert.ok(Math.abs(t.timeline.phrases[2].start - two(t.timeline.phrases[2].start)) * 22050 > 50, "two decimal places move an interior start by tens of samples");

  const rounded = { ...t.timeline, phrases: t.timeline.phrases.map(p => ({ ...p, start: two(p.start), duration: two(p.duration) })) };
  const ok = bindTake({ file: t.wav, timeline: rounded });
  assert.equal(ok.ok, true, `an honest take was refused for a rounded record: ${ok.problems.join("; ")}`);
  // Accepted on the same recording, not on a near miss: every phrase agrees frame for frame.
  assert.equal(ok.correlation, 1, `a rounded record of the same take must still reproduce exactly, got ${ok.correlation}`);
  // And the slip is reported, because a nonzero slip is the evidence that the record was
  // rounded rather than exact - a later reader should not be told the record was precise.
  const slips = ok.phrases.map(p => p.slip);
  assert.ok(slips.some(s => s !== 0), `the alignment reported the samples it had to move, got ${JSON.stringify(slips)}`);
  assert.ok(slips.every(s => Math.abs(s) <= 110), `no phrase moved further than half of the last written place, got ${JSON.stringify(slips)}`);
  // The table is still recovered, so the record's lack of a `readings` field is not hidden by
  // the rounding fix.
  assert.equal(ok.voice.matched.readings, "rules-1", "the old rules take is still attributed to the table that made it");

  // The control, which is the whole point: the same rounded record with one word changed must
  // still be refused - and must blame the phrase that is wrong *and only that one*. Judging the
  // take with this build's reading table first used to make a following honest phrase look
  // wrong too, which tells a person to fix a sentence that is fine.
  const edited = { ...rounded, phrases: rounded.phrases.map((p, i) => (i === 0 ? { ...p, text: "Science can change the way a machine learns." } : p)) };
  const refused = bindTake({ file: t.wav, timeline: edited });
  assert.equal(refused.ok, false, "a changed word passed once a rounded record was allowed");
  assert.equal(refused.problems.length, 1, `only the phrase that differs should be reported, got: ${refused.problems.join("; ")}`);
  assert.match(refused.problems[0], /phrase 1 \("Science can change the way a machine learns\."\)/, "and it is the phrase whose words were changed");
});

// The precision rule itself, pinned rather than described. These numbers are what decides how
// far a phrase may move, so a change to them is a change to what the check accepts.
test("how far a written-down position may be from the truth is derived from how it was written", () => {
  // Two places: half of 0.01. Three: half of 0.001. A value written to the sample is exact.
  assert.equal(writtenSlack("4.38"), 0.005);
  assert.equal(writtenSlack(4.383), 0.0005);
  // Nine places is 5e-10 s, which is not zero but is far less than one sample at 22.05 kHz,
  // so it costs nothing: the search floor is the single sample a start rounded to the sample
  // could be off by.
  assert.ok(writtenSlack(4.383514739) * 22050 < 0.001, "a value written to many places is exact for every practical purpose");
  assert.equal(writtenSlack(4.3835), 0.00005);
  // A phrase that starts at the beginning is not a rounded measurement, so it is exact. Without
  // this, every first phrase would be searched over a thousand candidates for nothing.
  assert.equal(writtenSlack(0), 0);
  // And the cap: a whole-second record is a different claim about where a phrase is, not an
  // imprecise one, and searching half a second for a match would fit the answer to the question.
  assert.equal(writtenSlack(4), 0.05);
  assert.equal(writtenSlack(4.3), 0.05);
  // A value that arrived as a number, not a string, is read the same way JSON would read it.
  assert.equal(writtenSlack(Number("4.38")), 0.005);
});

// The wider window must not become a way to accept a phrase that is in the wrong place. Two
// cases matter, and they pull in opposite directions: a realignment *inside a rounding* is
// allowed, and a start that is wrong by more than the record could be rounded by is not.
test("a widened alignment accepts a rounding and rejects a start that is simply wrong", () => {
  const lines = ["The sea at night is never still.", "It carries every colour of the sky.", "The light is moving over the water."];
  const t = take("slack", lines.join("\n"));
  const two = n => Number(n.toFixed(2));
  const exact = t.timeline.phrases.map(p => ({ ...p, start: two(p.start), duration: two(p.duration) }));

  // Inside the rounding: accepted, and it is the sound that says so.
  assert.equal(bindTake({ file: t.wav, timeline: { ...t.timeline, phrases: exact } }).ok, true, "rounding within the window was refused");

  // Beyond it: refused. 0.10 s is twenty times what two decimal places can be wrong by, so
  // this is not a rounding and the phrase must not be allowed to slide onto its neighbour.
  for (const shift of [-0.1, 0.1]) {
    const moved = exact.map((p, i) => (i === 1 ? { ...p, start: two(p.start + shift) } : p));
    const r = bindTake({ file: t.wav, timeline: { ...t.timeline, phrases: moved } });
    assert.equal(r.ok, false, `phrase 2 was ${shift > 0 ? "late" : "early"} by 0.10s and still passed`);
  }
});

// The supervisor's last point, and the reason it matters more than it looks: a refusal that
// names the wrong thing sends a person to fix the wrong thing. Two failures look identical to a
// check that only knows "this phrase did not match" - the script is wrong, or the record says the
// phrase is somewhere it is not - and they need opposite repairs. A creator told "the words are
// wrong" will rewrite a sentence that is already correct and then wonder why the take still
// fails; a creator told "the start time is wrong" knows the audio is fine and the file describing
// it is not. The three phrases below are the same audio with the same words and differ only in
// the record, so whatever the message says has to come from the evidence.
test("a refusal says whether the words or the record is what disagrees", () => {
  const lines = ["Science can change the way a machine works.", "The sea at night is never still.", "Walk slowly down toward the house."];
  const t = take("attribution", lines.join("\n"), { readings: "rules-1" });
  const two = n => Number(n.toFixed(2));
  const recorded = t.timeline.phrases.map(p => ({ ...p, start: two(p.start), duration: two(p.duration) }));

  // 1. Right words, wrong start. Refused, and the message says the *record* is what is wrong.
  // 40 ms is well beyond the 110 samples two decimals could be off by, so this is a mistake in
  // the written start rather than a rounding of it.
  const moved = recorded.map((p, i) => (i === 1 ? { ...p, start: two(p.start + 0.04) } : p));
  const late = bindTake({ file: t.wav, timeline: { ...t.timeline, phrases: moved } });
  assert.equal(late.ok, false, "a phrase recorded 40 ms from where it is was accepted");
  assert.equal(late.problems.length, 1, `only the moved phrase should be reported, got: ${late.problems.join("; ")}`);
  assert.match(late.problems[0], /phrase 2 .*the right words, but not where the timeline puts them/, `the refusal must say the words are right and the position is not, got: ${late.problems[0]}`);
  assert.match(late.problems[0], /the start time written for this phrase is wrong/, "and name the record, not the script, as the thing to fix");
  assert.doesNotMatch(late.problems[0], /were not the words spoken there/, "it must not accuse a script that is correct");

  // 2. The same record with a word really changed. Same shape of failure to a byte comparison,
  // and the opposite message - the phrase is not found anywhere in the file, which is what makes
  // the two cases distinguishable rather than guessed.
  const edited = recorded.map((p, i) => (i === 1 ? { ...p, text: "The sea at noon is never still." } : p));
  const wrong = bindTake({ file: t.wav, timeline: { ...t.timeline, phrases: edited } });
  assert.equal(wrong.ok, false, "a changed word was accepted");
  // Either wording is fair here - a changed word can also make the phrase a different length,
  // which is caught before any sound is compared - but whichever it is, it must name the script
  // as the thing that disagrees. The one thing it may never say is that the words are right.
  assert.match(wrong.problems.join(" "), /not the sound this voice makes from those words|do not fill that stretch|not what is in the file there/, "a changed script is described as a changed script, by whichever check caught it");
  assert.doesNotMatch(wrong.problems.join(" "), /but not where the timeline puts them/, "and is not excused as a timing mistake");
});
