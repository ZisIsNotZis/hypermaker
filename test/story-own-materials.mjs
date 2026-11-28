// A short film made from materials the person supplies, through the canvas, and then watched.
//
//   HYPERMAKER_CHROME=/path/to/chrome node test/story-own-materials.mjs
//
// This is the assignment's own sentence, walked: "from a blank canvas, a short film with a clear
// beginning, middle and end, made from two materials I choose, with the pictures and the narration
// readable and audible at ordinary speed". It is deliberately NOT a test of the code in isolation -
// every step below is a gesture a person makes in the browser:
//
//   * two photographs are brought in from the person's own disk (the new + File / drop gesture) -
//     not drawn by the server, because "materials I choose" is the part that was missing;
//   * a three-line narration is typed on a text card, and the narration card reads it out loud;
//   * the pictures and the voice are dragged onto a film card, in the order the story is told;
//   * the film is then *watched*: decoded, played, its sound compared with the take it says it
//     carries, its two scenes compared with the two photographs, and its captions read back at the
//     rate a person has to read them.
//
// THE TWO MATERIALS ARE NOT PHOTOGRAPHS. They are solid-colour PNGs written by `test/png.mjs` (a
// cold blue and a warm orange), because this walk must run with no network, no account and no
// checked-in binary. They are enough to show that *the person's own bytes* reach the film and that
// scene one and scene two are different pictures - the frame check compares the film against the
// exact bytes supplied. They are NOT enough to judge whether a real photograph reads well in a
// scene: that needs a pair of real local pictures and a look at the finished film, and no check in
// this file can stand in for it.
//
// Two things this walk also does not establish, said here so a receipt is not read as more than it
// is: whether a listener *understands* the narration (only a person can answer that; the file's
// sound is a measurement, not comprehension), and how a real model would choose the story (the
// agent binary below is a probe that must never be called).
//
// Exit 0 only if the whole walk passes. The receipt is printed and written to `$STORY_OUT` (or
// `.tmp/story-own-materials/`) so the numbers can be quoted without re-running it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { harbourPng } from "./harbour.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";
import { wavSamples } from "../voice/wav.mjs";
import { correlation } from "../voice/bind.mjs";

const root = process.cwd();
const chrome = process.env.HYPERMAKER_CHROME || process.env.CHROME_BIN;
if (!chrome || !existsSync(chrome)) {
  console.error(`set HYPERMAKER_CHROME to a Chromium build; looked at ${chrome || "nothing"}`);
  process.exit(1);
}
const ff = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg");
const ffprobe = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffprobe");
const out = process.env.STORY_OUT || join(root, ".tmp", "story-own-materials");
mkdirSync(out, { recursive: true });
const base = mkdtempSync(join(tmpdir(), "hyper-story-own-"));

// The story. Beginning, middle, end, and each line short enough to be read at the pace it is said -
// the readability gate measures that below rather than trusting this comment.
const STORY = [
  "The harbour wakes before the sun.",
  "A gull drops a shell on the stones.",
  "The last boat turns for home.",
];
// The person's two photographs: a cold dawn and a warm evening, so the two scenes are visibly
// different pictures rather than two renders of one method.
// Drawn by `test/harbour.mjs`: sky, sun or moon, water with ripples, a headland, harbour lamps, a
// boat and a gull. Not photographs - nothing on this machine is one and this walk must not fetch
// one - but genuinely contentful, so a caption has to stay readable over detail and a picture whose
// framing loses its subject is visible rather than invisible.
const dawn = join(base, "harbour at dawn.png"), dusk = join(base, "harbour at dusk.png");
writeFileSync(dawn, harbourPng("dawn"));
writeFileSync(dusk, harbourPng("dusk"));

const port = await freePort();
const workdir = join(base, "ws");
// No agent at all: CODEX_BIN points at a program that records being called and fails. Nothing in
// this walk is allowed to spend a model, and a receipt that said "no model" while one ran would be
// the exact mistake this project has made before.
const called = join(base, "called.log"), bin = join(base, "codex");
writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(called)}\nexit 1\n`, { mode: 0o755 });
const app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1", HYPERMAKER_CHROME: chrome } });
await waitReady(port);
const browser = await chromium.launch({ headless: true, executablePath: chrome });
const receipt = { story: STORY, materials: [dawn, dusk], steps: [], films: [] };
const note = (name, value) => { receipt.steps.push({ name, value }); console.log(name, JSON.stringify(value)); };
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1900, height: 1100 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector("#cards");
  const ws = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
  const card = id => page.locator(`.card[data-id="${id}"]`);
  const settle = async (id, tries = 3600) => {
    for (let i = 0; i < tries; i++) {
      const n = (await ws()).nodes[id];
      if (n && n.status !== "running" && (n.artifact || n.error)) return n;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`card ${id} never settled: ${JSON.stringify((await ws()).nodes[id])}`);
  };
  const press = async id => {
    const button = card(id).locator("[data-generate]");
    await button.waitFor({ state: "visible" });
    for (let i = 0; i < 200 && !(await button.isEnabled()); i++) await page.waitForTimeout(50);
    if (!(await button.isEnabled())) throw new Error(`the press on card ${id} never became usable`);
    const before = (await ws()).nodes[id];
    await button.click();
    for (let i = 0; i < 200; i++) {
      const n = (await ws()).nodes[id];
      if (n && (n.status === "running" || n.error || n.artifact !== before.artifact)) return;
      await page.waitForTimeout(50);
    }
    throw new Error(`pressing on card ${id} started nothing`);
  };
  const link = async (from, to) => {
    const a = await card(from).locator("header").boundingBox(), b = await card(to).locator("header").boundingBox();
    await page.mouse.move(a.x + 40, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    assert.ok(((await ws()).nodes[to].inputs || []).includes(from), `dragging card ${from} onto ${to} recorded the input`);
  };

  // 1. THE PERSON'S OWN TWO PICTURES, through the + File control. `setInputFiles` is what the
  //    browser does when the file picker returns a file; the hidden input is the control the
  //    person pressed, so the path from the button to the card is the real one.
  //    The chooser the button opens is the gesture: the person presses + File, the system dialog
  //    appears, and they pick both photographs at once. Driving `setInputFiles` on the hidden input
  //    would skip the button and could pass while the button did nothing.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator("#add-file").click(),
  ]);
  assert.equal(chooser.isMultiple(), true, "the picker accepts more than one file, so two materials are one gesture");
  await chooser.setFiles([dawn, dusk]);
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 2, null, { timeout: 30000 });
  const graph = await ws();
  const pictureIds = Object.values(graph.nodes).filter(n => n.type === "image").map(n => n.id);
  assert.equal(pictureIds.length, 2, `two files became two picture cards: ${JSON.stringify(Object.values(graph.nodes).map(n => [n.id, n.type]))}`);
  for (const id of pictureIds) {
    const n = graph.nodes[id];
    assert.equal(n.method, null, `card ${id} is the person's material, not a method's output`);
    assert.ok(n.artifact, `card ${id} holds a file`);
  }
  note("the person's pictures are on the canvas", pictureIds.map(id => ({ id, artifact: graph.nodes[id].artifact, type: graph.nodes[id].type })));
  // One press on a supplied card must refuse with a sentence, not spend a model on material a
  // method did not make - and it must leave the card holding its file.
  await card(pictureIds[0]).locator("[data-generate]").click().catch(() => {});
  await page.waitForTimeout(400);
  const suppliedSays = await card(pictureIds[0]).locator(".supplied, .notice, .error").first().innerText().catch(() => "");
  note("a supplied card says what it is", suppliedSays);
  assert.equal(existsSync(called), false, "no agent was run for the person's own pictures");

  // 2. THE WORDS. A text card with the three lines of the story, written the way a person writes.
  await page.mouse.dblclick(80, 80); await page.waitForTimeout(300);
  const textCard = page.locator(".card").last();
  await textCard.locator("[data-prompt]").click();
  await textCard.locator("[data-prompt]").pressSequentially(STORY.join("\n"));
  await textCard.locator("[data-prompt]").blur();
  await page.waitForTimeout(300);
  const textId = Number(await textCard.getAttribute("data-id"));
  await press(textId);
  const words = await settle(textId);
  assert.equal(words.error, null, `the words: ${words.error}`);
  note("the words", { artifact: words.artifact });

  // 3. THE NARRATION, read by this project's own voice at a pace a person asked for on the card.
  await page.mouse.dblclick(420, 80); await page.waitForTimeout(300);
  const voice = page.locator(".card").last();
  await voice.locator("[data-field=type]").selectOption("audio");
  await page.waitForFunction(() => document.querySelector(".card:last-child [data-field=method]")?.value === "readaloud", null, { timeout: 10000 });
  const voiceId = Number(await voice.getAttribute("data-id"));
  await link(textId, voiceId);
  await card(voiceId).locator(".repace input").fill("150");
  await card(voiceId).locator(".repace input").blur();
  await press(voiceId);
  const take = await settle(voiceId);
  assert.equal(take.error, null, `the narration: ${take.error}`);
  assert.ok(take.narration?.phrases?.length >= 3, `the take has phrase times to cut on: ${JSON.stringify(take.narration?.phrases)}`);
  note("the narration", {
    artifact: take.artifact,
    phrases: take.narration.phrases.map(p => p.text),
    pace: take.narration.pace,
    words: take.narration.words,
    seconds: take.narration.seconds,
    correlation: take.narration.take?.correlation,
  });

  // 4. THE FILM: the two photographs and the voice, linked in the order the story is told.
  await page.mouse.dblclick(760, 520); await page.waitForTimeout(300);
  const filmCard = page.locator(".card").last();
  await filmCard.locator("[data-field=type]").selectOption("video");
  await page.waitForFunction(() => document.querySelector(".card:last-child [data-field=method]")?.value === "firstcut", null, { timeout: 10000 });
  const filmId = Number(await filmCard.getAttribute("data-id"));
  for (const source of [voiceId, ...pictureIds]) await link(source, filmId);
  await press(filmId);
  const cut = await settle(filmId);
  assert.equal(cut.error, null, `the film: ${cut.error}`);
  assert.equal(cut.film.scenes.length, 2, `two pictures make two scenes: ${JSON.stringify(cut.film.scenes)}`);
  note("the film card's own record", {
    artifact: cut.artifact,
    promptUsed: cut.promptUsed,
    seconds: cut.film.seconds,
    scenes: cut.film.scenes.map(s => ({ start: s.start, end: s.end, from: s.from, caption: s.caption, shown: s.shown })),
    captions: cut.film.captions,
    soundtrack: cut.film.soundtrack,
  });

  // 5. WATCHED. The published file is measured against the bytes the person supplied and the
  //    narration it says it used - not against the card's claims.
  const file = join(workdir, String(filmId), cut.artifact);
  const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" }));
  const video = probe.streams.find(s => s.codec_type === "video"), audio = probe.streams.find(s => s.codec_type === "audio");
  const frozenNarration = join(workdir, String(filmId), cut.film.soundtrack.file);
  assert.ok(existsSync(frozenNarration), "the narration the film says it used is beside it");
  const extracted = join(base, "heard.wav");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "22050", extracted]);
  const heard = wavSamples(readFileSync(extracted)).samples, wanted = wavSamples(readFileSync(frozenNarration)).samples;
  let lag = 0, best = -2;
  for (let d = -2205; d <= 2205; d++) {
    const a = 22050, b0 = 22050 + d;
    if (b0 < 0 || b0 + a > heard.length) continue;
    const score = correlation(heard.subarray(22050, 22050 + a), wanted.subarray(b0, b0 + a));
    if (score > best) { best = score; lag = d; }
  }
  const played = await card(filmId).locator("video").evaluate(async v => {
    v.muted = true; v.currentTime = 0;
    await v.play().catch(() => {});
    await new Promise(r => setTimeout(r, 700));
    const at = v.currentTime; v.pause();
    return { at, duration: Number.isFinite(v.duration) ? v.duration : null, paused: v.paused };
  });
  // The frames a viewer sees: one picture in scene one's middle, one in scene two's.
  const shots = [];
  for (const [i, scene] of cut.film.scenes.entries()) {
    const at = (Number(scene.start) + Number(scene.end)) / 2;
    const still = join(out, `scene-${i + 1}.png`);
    execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(at), "-i", file, "-frames:v", "1", still]);
    shots.push(still);
  }
  // Two observations that are NOT the same thing, kept apart on purpose:
  //
  //   * `sound.audioPlays` - the player advances a track that is not silence, and that track is
  //     this take's narration (correlation). That is a fact about the file.
  //   * `sound.wordsUnderstood` - whether a person follows what is being said. No measurement in
  //     this repository can answer that; it needs a listener, and it is left null rather than
  //     quietly answered by the correlation above. `voice/listening-test.mjs` is the sheet for it.
  // Folding the second into the first is the overclaim this project has already had to retract
  // once - a real signal is not a listener understanding it.
  receipt.films.push({
    artifact: cut.artifact,
    materials: "two pictures DRAWN by test/harbour.mjs (sky, sun or moon, water, headland, harbour lamps, a boat, a gull): one cold dawn at 1280x720 and one evening at 1280x720. They are not photographs - nothing here was downloaded or photographed - so this proves the person's own bytes reach the film and that two different scenes are told apart; it does not prove how a real photograph would look.",
    framing: (cut.film.placements || []).map(p => p && ({ scene: p.scene, source: p.source, fit: p.fit, kept: p.kept })),
    seconds: Number(probe.format.duration).toFixed(2),
    streams: `${video?.codec_name}/${audio?.codec_name}`,
    size: `${video?.width}x${video?.height}`,
    sound: {
      audioPlays: { advances: played.at > 0.3, agreementWithNarration: Number(best.toFixed(3)), lagMs: Number((lag / 22.05).toFixed(1)) },
      wordsUnderstood: null,
      note: "audioPlays is a measurement of the file. wordsUnderstood needs a listener and has not been judged; they are two observations, not one.",
    },
    played,
    frames: shots,
  });
  note("the film as a viewer meets it", receipt.films.at(-1));
  assert.equal(video?.codec_name, "h264");
  assert.equal(audio?.codec_name, "aac");
  assert.ok(played.at > 0.3, `the film plays in the browser: ${JSON.stringify(played)}`);
  assert.ok(Number(probe.format.duration) >= cut.film.scenes.at(-1).end - 0.2, "the film runs to the end of its last scene");
  assert.ok(best >= 0.8, `the film's sound is the narration it says it used (agreement ${best.toFixed(3)})`);
  assert.ok(Math.abs(lag / 22.05) <= 100, `the sound starts where the narration would put it (${(lag / 22.05).toFixed(1)} ms)`);

  // 6. AND THE WORDS ARE READABLE AND THE PICTURES ARE THE PERSON'S. Every caption's rate, and every
  //    scene's own frame compared with the exact bytes supplied.
  const captions = cut.film.captions;
  assert.ok(captions, "the film records what its captions measured");
  assert.ok(captions.worst <= captions.comfortable, `every caption is readable at the pace it is said: worst ${captions.worst} chars/s, comfortable ${captions.comfortable}`);
  note("the captions", captions);
  // FRAMING: nothing a person supplied is silently cropped. A picture that is not frame-shaped must
  // be reported as shown whole, and the film's own record must say so - a 640x700 portrait filled
  // into 16:9 once took the heads and feet off a real picture and published anyway.
  for (const [i, p] of (cut.film.placements || []).entries()) {
    assert.ok(p, `scene ${i + 1} records the placement of its picture`);
    if (p.fit === "contain") assert.equal(p.kept, 1, `scene ${i + 1} is shown whole, so nothing of it is lost`);
    else assert.ok(p.kept >= 0.96, `scene ${i + 1} fills the frame, which may crop at most a sliver (kept ${p.kept})`);
  }
  // THE CAPTION BAND over a picture WITH something in it. A flat colour makes any text readable; these
  // frames have water detail and a bright sun, so the band's contrast is worth measuring. The mean
  // luminance of the bottom strip is checked to be dark (the gradient does that) and the caption's
  // own pixels bright, which is the property that keeps it legible over a busy picture.
  for (const [i, file] of shots.entries()) {
    const rgb = join(base, `band-${i}.rgb`);
    execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vf", "crop=iw:ih*0.22:0:ih*0.78", "-pix_fmt", "rgb24", "-c:v", "rawvideo", "-f", "image2", rgb]);
    const band = readFileSync(rgb);
    let sum = 0, bright = 0;
    for (let at = 0; at < band.length; at += 3) {
      const y = 0.2126 * band[at] + 0.7152 * band[at + 1] + 0.0722 * band[at + 2];
      sum += y; if (y > 160) bright += 1;
    }
    const mean = sum / (band.length / 3), share = bright / (band.length / 3);
    note(`caption band in scene ${i + 1}`, { meanLuminance: Number(mean.toFixed(1)), brightPixels: Number(share.toFixed(3)) });
    assert.ok(mean < 90, `the band behind the caption is dark enough to read on (mean luminance ${mean.toFixed(1)})`);
    assert.ok(share > 0.004, `the caption is actually drawn in the band (${(share * 100).toFixed(1)}% bright pixels)`);
  }

  // The scene frames against the supplied photographs, letterbox crop removed, as a coarse grid.
  const grid = (args) => {
    const rgb = join(base, `g-${Math.random().toString(36).slice(2)}.rgb`);
    // The top two-thirds of the frame: where the picture differs most and where no caption covers
    // it. Measuring the whole frame instead compared my text against the picture's picture and
    // squeezed the margin to 0.208 - a bar that close is not evidence of anything.
    execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", ...args, "-vf", "crop=iw:ih*0.6667:0:0,scale=24:14:force_original_aspect_ratio=increase,crop=24:14", "-pix_fmt", "rgb24", "-c:v", "rawvideo", "-f", "image2", rgb]);
    return readFileSync(rgb);
  };
  const supplied = [dawn, dusk].map(f => grid(["-i", f]));
  const shown = shots.map(f => grid(["-i", f]));
  // The bars are the product's own, not ones picked to fit this run: `verifyFilm` refuses a scene
  // below 0.8 agreement with its picture, and decides by ranking each frame against every picture
  // in the film with a margin. The absolute number here is lower than the product measured for
  // these scenes (0.888 and 0.911) because this coarse grid crops the caption band differently.
  for (const [i, frame] of shown.entries()) {
    const scores = supplied.map(s => correlation(frame, s));
    const mine = scores[i], other = scores[1 - i];
    assert.ok(mine > 0.8, `scene ${i + 1} shows the ${i ? "second" : "first"} photograph the person supplied (agreement ${mine.toFixed(3)})`);
    assert.ok(mine > other + 0.2, `and it is that photograph rather than the other one (own ${mine.toFixed(3)}, other ${other.toFixed(3)})`);
    note(`scene ${i + 1} is the person's ${i ? "second" : "first"} photograph`, { own: Number(mine.toFixed(3)), other: Number(other.toFixed(3)) });
  }
  assert.equal(existsSync(called), false, "the whole film was made without running a model");
  note("page errors", errors);
  assert.deepEqual(errors, [], "the canvas raised no script error during the walk");
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  // Keep the workspace and the receipt on failure too: they are what a person needs to see why.
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 1));
  console.log(`receipt: ${join(out, "receipt.json")}`);
  console.log(`workspace: ${workdir}`);
  await browser.close();
  stopServer(app);
  stopAll();
}
process.exit(code);
