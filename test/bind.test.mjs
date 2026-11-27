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
import { appearsInOrder, bindTake, wordsOf } from "../voice/bind.mjs";
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
  const timeline = { audio: wav, rate: rendered.rate, seconds: rendered.samples.length / rendered.rate, voice: { rate: 1, pitch: 112 }, phrases: rendered.segments };
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
  assert.match(stolen.problems.join(" "), /does not match the script recorded next to it/, "and says which file and which script disagree");
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
  // The threshold has to sit between "the script" and "a plausible different script", and
  // that gap is measured rather than assumed: 1.000 against 0.515 here.
  assert.ok(near.correlation < 0.85 && near.correlation > 0.4, `a one-word edit lands between the two, got ${near.correlation}`);
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
