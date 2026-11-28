import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserPath } from "./browser.mjs";
import { planScenes, verifyFilm } from "../server/film.mjs";
import { firstCut, titleCard } from "../server/offline.mjs";

// A film of more than one picture, cut by the server, with each scene checked against the picture
// it says it shows.
//
// The project index's next step was "continue with independently editable scenes", and the release
// build could not reach one: a video card laid its linked pictures one after another, but an image
// card's only methods handed the work to an agent, and the model route on this machine does not
// answer. So a film could only ever have the pictures a person already had on disk. Two things are
// tested here, and the second is the one that matters:
//
//   1. A second picture is now reachable with no model (`titlecard`), and two of them become a film
//      of two scenes whose captions are their own words rather than the take's first line.
//   2. The film's *pictures* are checked, scene by scene, on the pixels. Every cheaper check passes
//      a film that shows scene one's picture for both scenes: it is a real h264 file, its duration
//      is right, and it carries the whole narration. That is the negative control below.
const root = process.cwd();
const chrome = browserPath();
const skip = existsSync(chrome) ? null : `no browser for Remotion (set HYPERMAKER_CHROME); looked at ${chrome}`;
const ff = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg");

// The plan is a rule, so it is tested as one: where the cuts fall, given the phrase times the voice
// actually produced. Testing only the rendered film would let a wrong rule pass by luck of where
// one script's sentences happened to end.
test("scenes are cut at phrase boundaries, apportioned by spoken time", () => {
  const phrases = [
    { text: "one", start: 0, duration: 3 },
    { text: "two", start: 3, duration: 1 },
    { text: "three", start: 4, duration: 1 },
    { text: "four", start: 5, duration: 5 }
  ];
  const pictures = [{ id: 1, artifact: "a.png" }, { id: 2, artifact: "b.png" }];
  const scenes = planScenes({ pictures, phrases, seconds: 10 });
  assert.equal(scenes.length, 2);
  // Half the spoken time is 5 s, and the phrase starting at 5 s is where the second scene begins.
  assert.equal(scenes[0].start, 0);
  assert.equal(scenes[1].start, 5, `the cut belongs at the phrase that reaches half the spoken time, got ${scenes[1].start}`);
  assert.equal(scenes[1].end, 10);
  // Each scene is captioned by *its own* words. A film whose second picture still carries the first
  // sentence's caption is a film that says one thing over another, and nothing else records it.
  // Three phrases end exactly at the half-way point (3+1+1 = 5 s), so they belong to scene one.
  assert.equal(scenes[0].caption, "one two three");
  assert.equal(scenes[1].caption, "four");

  // A cut never lands inside a phrase, for any split: every boundary is one of the phrase starts.
  for (const count of [2, 3, 4]) {
    const many = planScenes({ pictures: pictures.concat([{ id: 3, artifact: "c.png" }, { id: 4, artifact: "d.png" }]).slice(0, count), phrases, seconds: 10 });
    const starts = new Set(phrases.map(p => p.start));
    for (const scene of many.slice(1)) assert.ok(starts.has(scene.start), `a scene starts at ${scene.start}, which is not a phrase boundary`);
    assert.equal(many[0].start, 0, "the first scene starts at the beginning of the film");
    assert.equal(many.at(-1).end, 10, "the last scene runs to the end of the film");
  }

  // One picture is one scene covering the film - the shape every film had before this change.
  const single = planScenes({ pictures: [pictures[0]], phrases, seconds: 10 });
  assert.equal(single.length, 1);
  assert.deepEqual([single[0].start, single[0].end], [0, 10]);
  // An older take with no phrase times is one scene too, and says it has no caption rather than
  // borrowing a line the take never recorded.
  const old = planScenes({ pictures: [pictures[0]], phrases: [], seconds: 7 });
  assert.deepEqual([old.length, old[0].end, old[0].caption], [1, 7, ""]);
  // Two pictures and no phrase times cannot be cut honestly: rather than placing a seam inside a
  // sentence, the plan declines and the caller refuses with the reason.
  assert.equal(planScenes({ pictures, phrases: [], seconds: 7 }), null);
});

test("two pictures become a film of two checked scenes, with no model in the path", async t => {
  if (skip) return t.skip(skip);
  const dir = mkdtempSync(join(tmpdir(), "hypermaker-scenes-"));
  // The narration: three lines, so the take has measurable phrase times to cut on.
  const script = join(dir, "script.txt");
  writeFileSync(script, "The harbour lights come on one by one.\nA gull complains about the weather.\nThe last boat turns for home.");
  const narration = join(dir, "narration.wav"), timelinePath = join(dir, "timeline.json");
  execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", script, "--out", narration, "--timeline", timelinePath, "--wpm", "150"], { stdio: "pipe" });
  const timeline = JSON.parse(readFileSync(timelinePath, "utf8"));

  // The two pictures, each made by the server from words - the thing a person with no account
  // could not do before. They are rendered for real, through Remotion.
  const first = await titleCard({ attemptDir: mkdtempSync(join(dir, "p1-")), prompt: "The harbour lights\ncome on one by one.", cancelRef: {} });
  const second = await titleCard({ attemptDir: mkdtempSync(join(dir, "p2-")), prompt: "The last boat turns\nfor home before the rain.", cancelRef: {} });
  const sources = [
    { id: 1, type: "audio", artifact: "narration.wav", frozen: narration, phrases: timeline.phrases },
    { id: 2, type: "image", artifact: "card.png", frozen: first.artifact },
    { id: 3, type: "image", artifact: "card.png", frozen: second.artifact }
  ];

  const attempt = mkdtempSync(join(dir, "cut-"));
  const cut = await firstCut({ attemptDir: attempt, sources, cancelRef: {} });
  assert.equal(cut.scenes.length, 2, `two pictures should make two scenes, got ${cut.scenes.length}`);
  assert.ok(cut.scenes[0].end <= cut.scenes[1].start + 1e-6, "scene one ends no later than scene two begins");
  // The cut is at a phrase boundary the voice made, and each caption is that scene's own words.
  const starts = new Set(timeline.phrases.map(p => Number(Number(p.start).toFixed(2))));
  assert.ok(starts.has(Number(cut.scenes[1].start.toFixed(2))), `scene two starts at ${cut.scenes[1].start}s, which is not a phrase boundary: ${[...starts].join(", ")}`);
  assert.match(cut.scenes[0].caption, /harbour lights/);
  assert.match(cut.scenes[1].caption, /last boat/, `scene two is captioned with its own words, got "${cut.scenes[1].caption}"`);

  // The published composition names both pictures and each scene's window, so the record is still
  // the source that rendered the bytes rather than a description of them.
  const source = readFileSync(cut.script, "utf8");
  assert.match(source, /scene-1\.png/);
  assert.match(source, /scene-2\.png/);
  assert.match(source, /Sequence/, "the composition shows the scenes in sequence");

  // Measured from the published file: two scenes, each compared with its own picture's pixels.
  const passed = verifyFilm({ file: cut.artifact, soundtrackFile: narration, projectRoot: root, scenes: cut.scenes });
  assert.equal(passed.ok, true, `a correct two-scene film must pass: ${passed.problems.join("; ")}`);
  assert.equal(passed.evidence.scenes.length, 2, "both scenes were measured");
  for (const scene of passed.evidence.scenes) assert.ok(scene.agreement > 0.8, `scene ${scene.scene + 1} shows its picture, agreement ${scene.agreement}`);

  // NEGATIVE CONTROL 1: the film plays scene one's picture where scene two's belongs. Nothing but
  // the picture check can see this - the container, the duration and the whole narration are right.
  // Built by rendering the same composition with the second picture replaced by the first, which is
  // what a composition that lost track of its scenes does. Re-rendering from the cut's own source
  // would be the ideal fixture, but the source's picture files live in the attempt directory, so
  // the honest minimal change is a fresh cut whose two pictures are the same file.
  const sameTwice = mkdtempSync(join(dir, "cut-same-"));
  const doubled = await firstCut({ attemptDir: sameTwice, sources: sources.map(s => s.id === 3 ? { ...s, frozen: first.artifact } : s), cancelRef: {} });
  const relabelled = verifyFilm({ file: doubled.artifact, soundtrackFile: narration, projectRoot: root, scenes: doubled.scenes.map(s => s.index === 1 ? { ...s, picture: sources[2] } : s) });
  assert.equal(relabelled.ok, false, "a film playing the first picture in its second scene was accepted");
  assert.match(relabelled.problems.join(" "), /scene 2 shows the picture from card #2 rather than the one it was cut from, card #3/, `the refusal names the scene: ${relabelled.problems.join("; ")}`);
  // And it is not reported as a sound problem: the narration in that film is perfect.
  assert.doesNotMatch(relabelled.problems.join(" "), /not the narration|plays nothing/, `a picture defect must not be described as a sound defect: ${relabelled.problems.join("; ")}`);

  // NEGATIVE CONTROL 1b: the near miss a fixed threshold would have passed.
  //
  // The control above is easy - the film shows picture one twice, and a picture is 0.94 from itself.
  // The harder case is a film re-cut with its second picture replaced by a *different real picture*
  // made the same way. Measured on a real two-scene film: the replacement agreed 0.950 with its own
  // picture and 0.865 with the first one, while the check refused below 0.8. Two pictures drawn by
  // one method have the same layout and differ only in words and hue, so no absolute number
  // separates them. The check ranks the frame against every picture in the film instead, and this
  // control is what that ranking exists for.
  const rivalPicture = await titleCard({ attemptDir: mkdtempSync(join(dir, "p3-")), prompt: "An entirely different sentence\nabout a lighthouse instead.", cancelRef: {} });
  const withRival = { id: 4, type: "image", artifact: "card.png", frozen: rivalPicture.artifact };
  const nearMiss = await firstCut({ attemptDir: mkdtempSync(join(dir, "cut-near-")), sources: [...sources.filter(s => s.id !== 3), withRival], cancelRef: {} });
  // The film itself is honest: it shows picture two and picture three, each in its own scene.
  const honest = verifyFilm({ file: nearMiss.artifact, soundtrackFile: narration, projectRoot: root, scenes: nearMiss.scenes });
  assert.equal(honest.ok, true, `two different pictures must each pass in their own scene: ${honest.problems.join("; ")}`);
  // Now the real mix-up: a film cut with ONE picture in both scenes - which is what a composition
  // that lost track of its scenes renders - while the plan says it shows two different pictures. The
  // plan keeps both, so the check has something to rank against, which is the point: relabelling a
  // scene to the picture it is already showing would leave nothing to compare and is not a defect.
  const mixed = await firstCut({ attemptDir: mkdtempSync(join(dir, "cut-mixed-")), sources: [...sources.filter(s => s.id !== 3), { ...withRival, frozen: first.artifact }], cancelRef: {} });
  const claims = mixed.scenes.map((s, i) => i === 1 ? { ...s, picture: withRival } : s);
  const ranked = verifyFilm({ file: mixed.artifact, soundtrackFile: narration, projectRoot: root, scenes: claims });
  assert.equal(ranked.ok, false, `a scene showing the film's other picture was accepted, when the two agree closely: the honest film's scenes measured ${JSON.stringify(honest.evidence.scenes)}`);
  assert.match(ranked.problems.join(" "), /scene 2 shows the picture from card #\d+ rather than the one it was cut from/, `the refusal names the scene and both cards: ${ranked.problems.join("; ")}`);

  // NEGATIVE CONTROL 2: a film made with one picture is not made to claim two scenes. The cut is
  // the one that decides, and it decides from the pictures it was actually given.
  const one = await firstCut({ attemptDir: mkdtempSync(join(dir, "cut-one-")), sources: sources.filter(s => s.id !== 3), cancelRef: {} });
  assert.equal(one.scenes.length, 1, "one picture is one scene");
  assert.ok(!readFileSync(one.script, "utf8").includes("scene-2"), "a one-picture film does not claim a second scene");

  // NEGATIVE CONTROL 3: more pictures than phrase times is refused rather than cut inside a
  // sentence, and nothing is rendered.
  await assert.rejects(
    () => firstCut({ attemptDir: mkdtempSync(join(dir, "cut-old-")), sources: sources.map(s => ({ ...s, phrases: undefined })), cancelRef: {} }),
    /no measured phrase times/,
    "two pictures with a narration that has no phrase times must be refused with the reason"
  );

  // The picture check itself refuses what it is for.
  const { verifyPicture } = await import("../server/film.mjs");
  const wrongSize = join(dir, "small.png");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", first.artifact, "-vf", "scale=320:180", wrongSize], { stdio: "pipe" });
  const sized = verifyPicture({ file: wrongSize, projectRoot: root, width: 1280, height: 720 });
  assert.equal(sized.ok, false, "a picture of the wrong size was accepted for a scene");
  assert.match(sized.problems.join(" "), /320x180.*1280x720/, `the refusal names both sizes: ${sized.problems.join("; ")}`);
  assert.equal(verifyPicture({ file: first.artifact, projectRoot: root, width: 1280, height: 720 }).ok, true, "the real picture passes");
  assert.equal(verifyPicture({ file: join(dir, "nothing.png"), projectRoot: root }).ok, false, "a missing picture is refused");
});
