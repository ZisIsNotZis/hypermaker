// The words under a film: one cue per spoken phrase, and a gate that refuses what cannot be read.
//
// The defect this answers is one a viewer feels rather than sees in a record. A scene used to carry
// one caption for its whole length, truncated at 120 characters. A scene holding eight seconds of
// speech is usually three sentences, so either the caption was cut off (the rest of what is being
// said is never on screen) or it stayed put while the narration moved on (the words on screen stop
// matching the words being heard). And a caption can be truthful and still useless: a sentence on
// screen for half a second is a flash, not a subtitle.
//
// So the cue's on-screen time is the narration's own phrase time, and the rate is measured from the
// cue's own frames. The gate refuses a film whose rate is above the bar, which is the half that
// matters: a number printed on a card is not read by the person who plays the film.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planScenes, verifyCaptions } from "../server/film.mjs";

const root = process.cwd();
const frames = (phrases, seconds) => planScenes({
  pictures: [{ id: 2, artifact: "card.png", frozen: "/nonexistent/a.png" }, { id: 3, artifact: "card.png", frozen: "/nonexistent/b.png" }],
  phrases, seconds
});

// A three-sentence narration, one picture each on two scenes.
const phrases = [
  { text: "The harbour lights come on one by one.", start: 0, duration: 2.5 },
  { text: "A gull complains about the weather.", start: 2.5, duration: 2.5 },
  { text: "The last boat turns for home.", start: 5, duration: 2.5 },
];

test("a scene holds one cue per spoken phrase, in the phrase's own time", () => {
  const scenes = frames(phrases, 7.5);
  assert.equal(scenes.length, 2);
  // Equal spoken durations make the halfway point (3.75 s) exactly as far from the end of phrase
  // one (2.5 s) as from the end of phrase two (5.0 s). The rule is "nearest boundary", and a tie
  // goes to the earlier one: a cut that lands sooner gives the second picture more time rather than
  // leaving the first one on screen while its own sentence is over.
  assert.deepEqual(scenes.map(s => s.phrases.map(p => p.text)), [
    ["The harbour lights come on one by one."],
    ["A gull complains about the weather.", "The last boat turns for home."],
  ]);
  // A scene holds more than one phrase here on purpose: that is exactly the case where one caption
  // for the whole scene covered two different sentences. The scene-level caption is the whole of
  // its words - it is what the record and the pixels are measured against - and the film shows them
  // one cue at a time.
  assert.equal(scenes[1].caption, "A gull complains about the weather. The last boat turns for home.");
  assert.notEqual(scenes[1].phrases.length, 1, "this fixture only tests anything if scene two holds two phrases");
});

test("the readability gate passes what a reader can follow and refuses what they cannot", () => {
  // The shape the cut produces: character count over on-screen seconds.
  const comfortable = verifyCaptions({ cues: [
    { scene: 0, text: "The harbour lights come on one by one.", seconds: 2.97, charactersPerSecond: 12.8 },
    { scene: 1, text: "A gull complains about the weather, and nobody answers it.", seconds: 4.5, charactersPerSecond: 12.9 },
  ] });
  assert.equal(comfortable.ok, true, `an ordinary sentence at an ordinary pace passes: ${comfortable.problems.join("; ")}`);
  assert.equal(comfortable.evidence.worst, 12.9);
  assert.equal(comfortable.evidence.comfortable, 20);

  // NEGATIVE CONTROL: a long sentence crammed into a short window. This is the case the old caption
  // made routine - a whole scene's words over a fast read - and it is the one a viewer cannot follow.
  const tooFast = verifyCaptions({ cues: [
    { scene: 0, text: "A gull complains about the weather and nobody answers it and the boat waits.", seconds: 1.2, charactersPerSecond: 63.3 },
  ] });
  assert.equal(tooFast.ok, false, "a caption nobody could finish was accepted");
  assert.match(tooFast.problems.join(" "), /on screen 1\.2s.*63\.3 characters a second.*above the 20/i, `the refusal says the number and the bar: ${tooFast.problems}`);
  assert.match(tooFast.problems.join(" "), /scene 1/, "the refusal names the scene");

  // The boundary is inclusive, and it is stated: exactly at the bar is comfortable.
  assert.equal(verifyCaptions({ cues: [{ scene: 0, text: "x", seconds: 1, charactersPerSecond: 20 }] }).ok, true);
  assert.equal(verifyCaptions({ cues: [{ scene: 0, text: "x", seconds: 1, charactersPerSecond: 20.1 }] }).ok, false);
  // A film with no cues is not failed by this check: one picture and no phrase times is an honest
  // older film, and the check's job is readability, not to invent captions.
  assert.equal(verifyCaptions({ cues: null }).ok, true);
  assert.equal(verifyCaptions({ cues: [] }).ok, true);
});

// The real film, from real bytes: three phrases, two pictures, and the cues cut from the narration's
// measured times rather than from a guess. Skipped, with the reason, when no browser is available -
// the composition is rendered through Remotion, which needs one.
const { existsSync } = await import("node:fs");
const chrome = process.env.HYPERMAKER_CHROME || process.env.CHROME_BIN;
const skip = chrome && existsSync(chrome) ? null : "no browser for Remotion (set HYPERMAKER_CHROME)";

test("a real two-scene film carries one cue per phrase, and each cue is on screen while it is said", { skip: skip || false }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const { titleCard, firstCut } = await import("../server/offline.mjs");
  const { verifyFilm } = await import("../server/film.mjs");

  const dir = mkdtempSync(join(tmpdir(), "hypermaker-captions-"));
  const script = join(dir, "script.txt");
  writeFileSync(script, phrases.map(p => p.text).join("\n"));
  const narration = join(dir, "narration.wav"), timelinePath = join(dir, "timeline.json");
  execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", script, "--out", narration, "--timeline", timelinePath, "--wpm", "150"], { stdio: "pipe" });
  const timeline = JSON.parse(readFileSync(timelinePath, "utf8"));

  const a = await titleCard({ attemptDir: mkdtempSync(join(dir, "a-")), prompt: "The harbour lights\ncome on one by one.", cancelRef: {} });
  const b = await titleCard({ attemptDir: mkdtempSync(join(dir, "b-")), prompt: "The last boat\nturns for home.", cancelRef: {} });
  const cut = await firstCut({
    attemptDir: mkdtempSync(join(dir, "cut-")),
    sources: [
      { id: 1, type: "audio", artifact: "narration.wav", frozen: narration, phrases: timeline.phrases },
      { id: 2, type: "image", artifact: "card.png", frozen: a.artifact },
      { id: 3, type: "image", artifact: "card.png", frozen: b.artifact },
    ],
    cancelRef: {},
  });

  // One cue per phrase, and every cue's words are one phrase of the narration, in order.
  assert.equal(cut.cues.length, timeline.phrases.length, `one cue per phrase: ${JSON.stringify(cut.cues)}`);
  assert.deepEqual(cut.cues.map(c => c.text), timeline.phrases.map(p => p.text), "the cues are the narration's phrases, in the order they are spoken");
  // The time a cue is on screen is the time its phrase is spoken, to a frame.
  for (const [i, cue] of cut.cues.entries()) {
    const phrase = timeline.phrases[i];
    assert.ok(Math.abs(cue.seconds - Number(phrase.duration)) < 1 / 15, `cue ${i + 1} is on screen ${cue.seconds}s for a phrase spoken ${phrase.duration}s`);
    assert.ok(cue.charactersPerSecond < 20, `cue ${i + 1} reads at ${cue.charactersPerSecond} chars/s, above the comfort bar`);
  }
  // The composition the film publishes names every cue with its time, so the record still explains
  // the bytes without keeping the run directory.
  const source = readFileSync(cut.script, "utf8");
  for (const phrase of timeline.phrases) assert.ok(source.includes(phrase.text.trim()), `the published composition names the cue "${phrase.text.trim()}"`);
  assert.match(source, /cue in scene 1:/, "the composition's header lists the cues");
  assert.match(source, /captionSize/, "the composition sizes a caption by its length, so a long phrase still fits");
  // A comment placed INSIDE a JSX element is a text node, not a comment, and React renders it: a
  // real frame came out with `A picture that is not frame-shaped is shown W...` across its top edge.
  // The published source is checked for that shape, so it cannot come back quietly.
  // The property, stated exactly: between a `return <...>` and the `;` that ends it, a `//` line is
  // not a comment to React - it is a text node, and it is drawn on screen. Outside that range a
  // `//` line is an ordinary comment and is fine.
  const lines = source.split("\n");
  let depth = 0;
  for (const [i, line] of lines.entries()) {
    if (/^\s*return </.test(line)) depth = 1;
    else if (depth && /;\s*$/.test(line)) depth = 0;
    else if (depth && /^\s*\/\//.test(line)) assert.fail(`a comment at line ${i + 1} is inside the JSX that is returned, so React renders it as text on screen: ${line.trim()}`);
  }

  // And the film itself still passes every existing check with cues in place.
  const film = verifyFilm({ file: cut.artifact, soundtrackFile: narration, projectRoot: root, scenes: cut.scenes });
  assert.equal(film.ok, true, `a film with cues is still a film: ${film.problems.join("; ")}`);
  assert.equal(verifyCaptions({ cues: cut.cues }).ok, true);
});
