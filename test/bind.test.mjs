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
import { renderParagraph, toWav } from "../voice/synth.mjs";
import { appearsInOrder, bindTake, correlation, wordsOf } from "../voice/bind.mjs";
import { verifyNarration } from "../server/narration.mjs";

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
